import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

import { privateSubnetMaster } from "../network.ts/vpc_networking";
import { masterSecurityGroup } from "../network.ts/security_group"
import { instanceProfiles } from "../network.ts/iam_instance";

const config = new pulumi.Config("myproject");


// pulumi config set --secret sshPublicKey "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD3F6tyPEFEzV0LX3X8BsXdMsQz1x2cEikKDEY0aIj41qgxMCP/iteneqXSIFZBp5vizPvaoIR3Um9xK7PGoW8giupGn+EPuxIA4cDM4vzOqOkiMPhz5XK0whEjkVzTo4+S0puvDZuwIsdiW9mxhJc7tgBNL0cYlWSYVkz4G/fslNfRPW5mYAM49f4fhtxPb5ok4Q2Lg9dPKVHO/Bgeu5woMc7RY0p1ej6D4CKFE6lymSDJpW0YHX/wqE9+cfEauh7xZcG0q9t2ta6F6fmX0agvpFy"
const publicKey = config.requireSecret("sshPublicKey");

// Create EC2 Key Pair
const deployer = new aws.ec2.KeyPair("deployer", {
    keyName: "deployer-key",
    publicKey: publicKey,
});

const clusterName = config.get("cluster_name") || "kubeadm-cluster";


const amiId = fs.readFileSync(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8").trim();


// Define the base instance configuration for both master and worker nodes
async function createInstance(role: string): Promise<aws.ec2.Instance> {
    return new aws.ec2.Instance(`kubernetes-${role}-node`, {
        instanceType: "t3.medium",  
        ami: amiId,  
        securityGroups: [masterSecurityGroup.name],  // Reference security group
        subnetId: privateSubnetMaster.id,
        iamInstanceProfile: (await instanceProfiles).masterInstanceProfile.name,
        keyName: deployer.keyName,
        tags: {
            Name: `kubernetes-${role}`,
            [`kubernetes.io/cluster/${clusterName}`]: "shared",
            Role: role,
            Environment: "kubernetes", // Optional environment tag
        },
    });
}

 export { createInstance  as masterInstance };

