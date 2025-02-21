import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { networkOutputs } from "./vpc_networking";

// Security Groups
const bastionSecurityGroup = new aws.ec2.SecurityGroup("bastion-sg", {
    vpcId: networkOutputs.vpcId,
    description: "Bastion host security group",
    tags: { Name: pulumi.interpolate`${networkOutputs.clusterName}-bastion-sg` },
});

const masterSecurityGroup = new aws.ec2.SecurityGroup("master-sg", {
    vpcId: networkOutputs.vpcId,
    description: "Kubernetes master node security group",
    tags: { Name: pulumi.interpolate`${networkOutputs.clusterName}-master-sg` },
});

const workerSecurityGroup = new aws.ec2.SecurityGroup("worker-sg", {
    vpcId: networkOutputs.vpcId,
    description: "Kubernetes worker node security group",
    tags: { Name: pulumi.interpolate`${networkOutputs.clusterName}-worker-sg` },
});

// Bastion Rules
new aws.ec2.SecurityGroupRule("bastionSshIngress", {
    type: "ingress",
    fromPort: 22,
    toPort: 22,
    protocol: "tcp",
    securityGroupId: bastionSecurityGroup.id,
    cidrBlocks: ["YOUR_TRUSTED_IP/32"], // REPLACE WITH ACTUAL IP
});

new aws.ec2.SecurityGroupRule("bastionEgress", {
    type: "egress",
    fromPort: 0,
    toPort: 0,
    protocol: "-1",
    securityGroupId: bastionSecurityGroup.id,
    cidrBlocks: ["0.0.0.0/0"],
});

// Master Node Rules
const masterRules = [
    { port: 6443, sourceSecurityGroupId: workerSecurityGroup.id, description: "Kubernetes API from Workers" },
    { port: 6443, sourceSecurityGroupId: bastionSecurityGroup.id, description: "Kubernetes API from Bastion" },
    { port: 2379, sourceSecurityGroupId: masterSecurityGroup.id, description: "ETCD client" },
    { port: 2380, sourceSecurityGroupId: masterSecurityGroup.id, description: "ETCD peer" },
    { port: 10250, sourceSecurityGroupId: masterSecurityGroup.id, description: "Kubelet API" },
    { port: 10251, sourceSecurityGroupId: masterSecurityGroup.id, description: "kube-scheduler" },
    { port: 10252, sourceSecurityGroupId: masterSecurityGroup.id, description: "kube-controller-manager" },
    { port: 22, sourceSecurityGroupId: bastionSecurityGroup.id, description: "SSH from Bastion" },
    { port: 8472, sourceSecurityGroupId: workerSecurityGroup.id, protocol: "udp", description: "Flannel VXLAN" },
    { port: 8472, sourceSecurityGroupId: masterSecurityGroup.id, protocol: "udp", description: "Flannel intra-master" },
];

masterRules.forEach((rule, idx) => {
    new aws.ec2.SecurityGroupRule(`master-rule-${idx}`, {
        securityGroupId: masterSecurityGroup.id,
        type: "ingress",
        fromPort: rule.port,
        toPort: rule.port,
        protocol: rule.protocol || "tcp",
        sourceSecurityGroupId: rule.sourceSecurityGroupId,
    });
});

// Worker Node Rules
const workerRules = [
    { port: 10250, sourceSecurityGroupId: masterSecurityGroup.id, description: "Kubelet API from Masters" },
    { 
        port: 30000, 
        endPort: 32767, 
        cidrBlocks: [pulumi.interpolate`${networkOutputs.vpcCidr}`], 
        description: "NodePort Services" 
    },
    { port: 22, sourceSecurityGroupId: bastionSecurityGroup.id, description: "SSH from Bastion" },
    { port: 8472, sourceSecurityGroupId: workerSecurityGroup.id, protocol: "udp", description: "Flannel VXLAN" },
    { port: 8472, sourceSecurityGroupId: masterSecurityGroup.id, protocol: "udp", description: "Flannel from Masters" },
];

workerRules.forEach((rule, idx) => {
    new aws.ec2.SecurityGroupRule(`worker-rule-${idx}`, {
        securityGroupId: workerSecurityGroup.id,
        type: "ingress",
        fromPort: rule.port,
        toPort: rule.endPort || rule.port,
        protocol: rule.protocol || "tcp",
        ...(rule.sourceSecurityGroupId ? {
            sourceSecurityGroupId: rule.sourceSecurityGroupId
        } : {
            cidrBlocks: rule.cidrBlocks
        })
    });
});

// VPC Endpoint Access
[masterSecurityGroup, workerSecurityGroup].forEach((sg, idx) => {
    new aws.ec2.SecurityGroupRule(`vpce-https-${idx}`, {
        securityGroupId: sg.id,
        type: "ingress",
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        sourceSecurityGroupId: networkOutputs.vpcEndpointSecurityGroupId,
    });
});

// Flow Logs (unchanged)
const flowLogsBucket = new aws.s3.Bucket("vpc-flow-logs", {
    acl: "private",
    forceDestroy: false,
    tags: { 
        Name: pulumi.interpolate`${networkOutputs.clusterName}-flow-logs`,
        "auto-delete": "never"
    },
});

new aws.ec2.FlowLog("vpcFlowLogs", {
    logDestination: pulumi.interpolate`arn:aws:s3:::${flowLogsBucket.id}/`,
    trafficType: "ALL",
    vpcId: networkOutputs.vpcId,
    maxAggregationInterval: 60,
    logFormat: "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}",
});

// Exports
export const securityGroupIds = {
    bastion: bastionSecurityGroup.id,
    master: masterSecurityGroup.id,
    worker: workerSecurityGroup.id,
    vpcEndpoint: networkOutputs.vpcEndpointSecurityGroupId,
};