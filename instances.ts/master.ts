import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

import { privateSubnetMaster } from "../network.ts/vpc_networking";
import { masterSecurityGroup } from "../network.ts/security_group"
import { instanceProfiles } from "../network.ts/iam_instance";

const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";


const amiId = fs.readFileSync(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8").trim();


// Define the base instance configuration for both master and worker nodes
async function createInstance(role: string, ami: string, securityGroup: aws.ec2.SecurityGroup): Promise<aws.ec2.Instance> {
    return new aws.ec2.Instance(`kubernetes-${role}-node`, {
        instanceType: "t3.medium",  
        ami: amiId,  
        securityGroups: [masterSecurityGroup.name],  // Reference security group
        subnetId: privateSubnetMaster.id,
        keyName: "my-key-pair", // Replace with your SSH key pair name
        iamInstanceProfile: (await instanceProfiles).masterInstanceProfile.name,
        tags: {
            Name: `kubernetes-${role}`,
            [`kubernetes.io/cluster/${clusterName}`]: "shared",
            Role: role,
            Environment: "kubernetes", // Optional environment tag
        },
    });
}

 export const masterInstance = createInstance("Master", "ami-12345678", masterSecurityGroup);

