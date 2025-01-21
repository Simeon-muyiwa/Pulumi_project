// securityGroups.ts (or your relevant file)
import * as aws from "@pulumi/aws";
import { vpcId } from "./vpc_networking"; // Import vpcId from network.ts

// Create security group for master nodes
export const masterSecurityGroup = new aws.ec2.SecurityGroup("masterSecurityGroup", {
    vpcId: vpcId, // Use the imported vpcId here
    ingress: [
        { protocol: "tcp", fromPort: 6443, toPort: 6443, cidrBlocks: ["0.0.0.0/0"] }, // API server
        { protocol: "tcp", fromPort: 2379, toPort: 2380, self: true }, // etcd
        { protocol: "tcp", fromPort: 10250, toPort: 10250, self: true }, // Kubelet
        { protocol: "tcp", fromPort: 10251, toPort: 10251, self: true }, // Scheduler
        { protocol: "tcp", fromPort: 10252, toPort: 10252, self: true }, // Controller manager
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
});

// Create security group for worker nodes  
export const workerSecurityGroup = new aws.ec2.SecurityGroup("workerSecurityGroup", {
    vpcId: vpcId, // Use the imported vpcId here
    ingress: [
        { protocol: "tcp", fromPort: 10250, toPort: 10250, self: true }, // Kubelet
        { protocol: "tcp", fromPort: 10255, toPort: 10255, self: true }, // Read-only Kubelet
        { protocol: "tcp", fromPort: 30000, toPort: 32767, cidrBlocks: ["0.0.0.0/0"] }, // NodePort Services
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
});

// Define security group rules for master node communication
new aws.ec2.SecurityGroupRule("masterNodeApiIngress", {
    type: "ingress",
    fromPort: 6443,
    toPort: 6443,
    protocol: "tcp",
    securityGroupId: masterSecurityGroup.id,
    sourceSecurityGroupId: workerSecurityGroup.id, // Allow communication from worker nodes
});

new aws.ec2.SecurityGroupRule("workerNodeKubeletIngress", {
    type: "ingress",
    fromPort: 10250,
    toPort: 10250,
    protocol: "tcp",
    securityGroupId: workerSecurityGroup.id,
    sourceSecurityGroupId: masterSecurityGroup.id, // Allow communication from master nodes
});

// Create security group for bastion host
export const bastionSecurityGroup = new aws.ec2.SecurityGroup("bastionSecurityGroup", {
    vpcId: vpcId,
    description: "Security group for bastion host",
});

// Add ingress rule for SSH access to bastion host
new aws.ec2.SecurityGroupRule("bastionSshIngress", {
    type: "ingress",
    fromPort: 22,
    toPort: 22,
    protocol: "tcp",
    securityGroupId: bastionSecurityGroup.id,
    cidrBlocks: ["0.0.0.0/0"], // Allow SSH access from anywhere
});

// Add egress rule for bastion host
new aws.ec2.SecurityGroupRule("bastionEgress", {
    type: "egress",
    fromPort: 0,
    toPort: 0,
    protocol: "-1",
    securityGroupId: bastionSecurityGroup.id,
    cidrBlocks: ["0.0.0.0/0"], // Allow all outbound traffic
});

// Update masterSecurityGroup to allow SSH access from bastion host
new aws.ec2.SecurityGroupRule("masterBastionSshIngress", {
    type: "ingress",
    fromPort: 22,
    toPort: 22,
    protocol: "tcp",
    securityGroupId: masterSecurityGroup.id,
    sourceSecurityGroupId: bastionSecurityGroup.id,
});

// Update workerSecurityGroup to allow SSH access from bastion host
new aws.ec2.SecurityGroupRule("workerBastionSshIngress", {
    type: "ingress",
    fromPort: 22,
    toPort: 22,
    protocol: "tcp",
    securityGroupId: workerSecurityGroup.id,
    sourceSecurityGroupId: bastionSecurityGroup.id,
});