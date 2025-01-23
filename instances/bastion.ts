import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

import { publicSubnetBastion } from "../network.ts/vpc_networking";
import { bastionSecurityGroup} from "../network.ts/security_group"
import { resourceSetup } from "../network.ts/iam_instance"

const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";
// Read the AMI ID from the file (ensure the file path is correct)
const amiId = fs.readFileSync(path.join(__dirname, "bastion_ami_id.txt"), "utf8").trim();

// example - pulumi config set --secret sshPublicKey "ssh-rsa t2ta6F6fmX0agvpFy"
const publicKey = config.requireSecret("sshPublicKey");

// Create EC2 Key Pair
const deployer = new aws.ec2.KeyPair("deployer", {
    keyName: "deployer-key",
    publicKey: publicKey,
});

// Bastion Host Instance
export const bastionHost = new aws.ec2.Instance("bastion-host", {
    ami: amiId, 
    instanceType: "t2.micro", // Adjust instance type as necessary
    iamInstanceProfile: ( await resourceSetup).bastionHostInstanceProfile,
    subnetId: publicSubnetBastion.id,
    keyName: deployer.keyName,
    securityGroups: [bastionSecurityGroup.name],
    associatePublicIpAddress: true, // Bastion host needs a public IP
    tags: {
        Name: `${clusterName}-bastion-host`,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        Role: "Worker",
    },
});


 export const bastionHostPublicIp = bastionHost.publicIp;