import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

import { privateSubnetMaster } from "../network/vpc_networking";
import { masterSecurityGroup } from "../network/security_group"
import { resourceSetup } from "../network/iam_instance"
import * as keyPair from "../network/key_pairs"; 

const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";

const amiId = fs.readFileSync(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8").trim();


// Define the base instance configuration for both master and worker nodes
async function createInstance(role: string): Promise<aws.ec2.Instance> {
    return new aws.ec2.Instance(`kubernetes-${role}-node`, {
        instanceType: "t3.medium",  
        ami: amiId,
        securityGroups: [masterSecurityGroup.name],  // Reference security group
        subnetId: privateSubnetMaster.id,
        iamInstanceProfile: (await resourceSetup).masterInstanceProfile,
        keyName: keyPair.deployer.keyName,
        tags: {
            Name: `kubernetes-${role}`,
            [`kubernetes.io/cluster/${clusterName}`]: "shared",
            Role: role,
            Environment: "kubernetes", // Optional environment tag
        },
    });
}

 export { createInstance  as masterInstance };

