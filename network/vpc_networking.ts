import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("kubernetes");
const clusterName = config.require("cluster_name");
const vpcCidr = config.get("vpc_cidr") || "10.0.0.0/16";
const availabilityZones = config.requireObject<string[]>("availability_zones");

// Precompute AZ index map with proper typing
const azIndexMap = availabilityZones.reduce<Record<string, number>>(
    (acc, az, idx) => ({ ...acc, [az]: idx }),
    {}
);

const clusterTagKey = pulumi.interpolate`kubernetes.io/cluster/${clusterName}`;

// VPC
const vpc = new aws.ec2.Vpc("k8s-vpc", {
    cidrBlock: vpcCidr,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: pulumi.all([clusterName, clusterTagKey]).apply(([name, tagKey]) => ({
        Name: name,
        [tagKey]: "shared",
        Environment: "production",
    })),
});

// Internet Gateway
const internetGateway = new aws.ec2.InternetGateway("igw", {
    vpcId: vpc.id,
    tags: pulumi.all([clusterName, clusterTagKey]).apply(([name, tagKey]) => ({
        Name: `${name}-igw`,
        [tagKey]: "shared",
    })),
});

// NAT Gateways
const natGateways: pulumi.Output<string>[] = [];
const natPublicSubnets: aws.ec2.Subnet[] = [];

availabilityZones.forEach((az, index) => {
    const eip = new aws.ec2.Eip(`nat-eip-${az}`, { 
        vpc: true,
        tags: { Name: pulumi.interpolate`${clusterName}-nat-eip-${az}` },
    });

    const publicSubnet = new aws.ec2.Subnet(`nat-public-${az}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${index}.0/28`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: pulumi.all([clusterName, clusterTagKey]).apply(([name, tagKey]) => ({
            Name: `${name}-nat-public-${az}`,
            Tier: "public",
            [tagKey]: "shared",
        })),
    });

    const natGateway = new aws.ec2.NatGateway(`nat-${az}`, {
        allocationId: eip.id,
        subnetId: publicSubnet.id,
        tags: { Name: pulumi.interpolate`${clusterName}-nat-gw-${az}` },
    });

    natPublicSubnets.push(publicSubnet);
    natGateways.push(natGateway.id);
});

// Subnets
const subnetConfig = [
    { type: "public", cidr: "10.0.16.0/24", az: availabilityZones[0], role: "bastion" },
    { type: "public", cidr: "10.0.17.0/24", az: availabilityZones[1], role: "bastion" },
    { type: "private", cidr: "10.0.32.0/20", az: availabilityZones[0], role: "master" },
    { type: "private", cidr: "10.0.48.0/20", az: availabilityZones[1], role: "master" },
    { type: "private", cidr: "10.0.64.0/20", az: availabilityZones[0], role: "worker" },
    { type: "private", cidr: "10.0.80.0/20", az: availabilityZones[1], role: "worker" },
];

const subnets: Record<string, aws.ec2.Subnet> = {};

subnetConfig.forEach((cfg) => {
    const subnet = new aws.ec2.Subnet(`subnet-${cfg.role}-${cfg.az}`, {
        vpcId: vpc.id,
        cidrBlock: cfg.cidr,
        availabilityZone: cfg.az,
        mapPublicIpOnLaunch: cfg.type === "public",
        tags: pulumi.all([clusterName, clusterTagKey]).apply(([name, tagKey]) => ({
            Name: `${name}-${cfg.role}-${cfg.az}`,
            [tagKey]: "shared",
            "kubernetes.io/role/internal-elb": "1",
            Tier: cfg.type,
        })),
    });
    subnets[`${cfg.role}-${cfg.az}`] = subnet;
});

// Route Tables
const publicRouteTable = new aws.ec2.RouteTable("public-rt", {
    vpcId: vpc.id,
    routes: [{
        cidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id,
    }],
    tags: { Name: pulumi.interpolate`${clusterName}-public-rt` },
});

const privateRouteTables = availabilityZones.map((az, index) => 
    new aws.ec2.RouteTable(`private-rt-${az}`, {
        vpcId: vpc.id,
        routes: [{
            cidrBlock: "0.0.0.0/0",
            natGatewayId: natGateways[index],
        }],
        tags: { Name: pulumi.interpolate`${clusterName}-private-rt-${az}` },
    })
);

// Route Table Associations
Object.values(subnets).forEach((subnet) => {
    const azIndex = subnet.availabilityZone.apply(az => azIndexMap[az] ?? 0);
    const privateRouteTableIds = pulumi.all(privateRouteTables.map(rt => rt.id));
    
    const routeTableId = pulumi.all([
        subnet.tags,
        publicRouteTable.id,
        azIndex,
        privateRouteTableIds
    ]).apply(([tags, publicId, index, privateIds]) => 
        tags?.Tier === "public" ? publicId : privateIds[index]
    );

    new aws.ec2.RouteTableAssociation(`rt-assoc-${subnet.id}`, {
        subnetId: subnet.id,
        routeTableId: routeTableId as pulumi.Input<string>,
    });
});

// VPC Endpoint Security Group
const vpcEndpointSg = new aws.ec2.SecurityGroup("vpc-endpoint-sg", {
    vpcId: vpc.id,
    description: "VPC Endpoint Security Group",
    ingress: [{
        description: "HTTPS from VPC",
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        cidrBlocks: [vpcCidr],
    }],
    tags: { Name: pulumi.interpolate`${clusterName}-vpce-sg` },
});

// Exports
export const networkOutputs = {
    vpcId: vpc.id,
    vpcCidr: vpcCidr, 
    publicSubnetIds: Object.values(subnets)
        .filter(s => s.tags?.apply(t => t?.Tier === "public"))
        .map(s => s.id),
    privateSubnetIds: Object.values(subnets)
        .filter(s => s.tags?.apply(t => t?.Tier === "private"))
        .map(s => s.id),
    natGatewayIds: natGateways,
    availabilityZones: availabilityZones,
    clusterName: clusterName,
    vpcEndpointSecurityGroupId: vpcEndpointSg.id,
};
