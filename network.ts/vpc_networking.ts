
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// Retrieve configuration values
const config = new pulumi.Config("kubernetes");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";
const vpcCidr = config.get("vpc_cidr") || "10.1.0.0/16";
const availabilityZones = JSON.parse(config.get("availability_zones") || '["eu-west-2a", "eu-west-2b"]');
const k8sVersion = config.get("k8s_project_version") || "1.10";

// VPC
const vpc = new aws.ec2.Vpc("k8s-vpc", {
    cidrBlock: vpcCidr,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: {
        Name: clusterName,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
    },
});

// Internet Gateway
const internetGateway = new aws.ec2.InternetGateway("gateway", {
    vpcId: vpc.id,
    tags: {
        Name: clusterName,
    },
});

// Elastic IP for NAT Gateway
const eip = new aws.ec2.Eip("nat", {
    vpc: true,
});

// Public Subnet for Bastion Host
export const publicSubnetBastion = new aws.ec2.Subnet("public-subnet-bastion", {
    availabilityZone: availabilityZones[0],
    cidrBlock: "10.0.1.0/24",
    vpcId: vpc.id,
    mapPublicIpOnLaunch: true,
    tags: {
        Name: `${clusterName}-public-subnet-bastion`,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
    },
});

// NAT Gateway
const natGateway = new aws.ec2.NatGateway("nat-gateway", {
    allocationId: eip.id,
    subnetId: publicSubnetBastion.id, // Use the public subnet for NAT gateway
});

// Public Route Table for Public Subnet
const publicRouteTable = new aws.ec2.RouteTable("public", {
    vpcId: vpc.id,
    routes: [{
        cidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id,
    }],
    tags: {
        Name: `${clusterName}-public`,
    },
});

// Associate Public Subnet with Route Table
new aws.ec2.RouteTableAssociation("public-route-table-association", {
    subnetId: publicSubnetBastion.id,
    routeTableId: publicRouteTable.id,
});

// Private Subnets for Master and Worker Nodes
export const privateSubnetMaster = new aws.ec2.Subnet("private-subnet-master", {
    availabilityZone: availabilityZones[0],
    cidrBlock: "10.0.2.0/24",
    vpcId: vpc.id,
    tags: {
        Name: `${clusterName}-private-subnet-master`,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
    },
});

export const privateSubnetWorker = new aws.ec2.Subnet("private-subnet-worker", {
    availabilityZone: availabilityZones[1],
    cidrBlock: "10.0.3.0/24",
    vpcId: vpc.id,
    tags: {
        Name: `${clusterName}-private-subnet-worker`,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
    },
});

// Private Route Table for Master/Worker Subnets (uses NAT Gateway for outbound internet access)
const privateRouteTable = new aws.ec2.RouteTable("private", {
    vpcId: vpc.id,
    routes: [{
        cidrBlock: "0.0.0.0/0",
        natGatewayId: natGateway.id,
    }],
    tags: {
        Name: `${clusterName}-private`,
    },
});

// Associate Private Subnets with Route Table
new aws.ec2.RouteTableAssociation("private-master-route-table-association", {
    subnetId: privateSubnetMaster.id,
    routeTableId: privateRouteTable.id,
});

new aws.ec2.RouteTableAssociation("private-worker-route-table-association", {
    subnetId: privateSubnetWorker.id,
    routeTableId: privateRouteTable.id,
});



// Export VPC ID and Bastion Host Public IP for later use
export const vpcId = vpc.id;
