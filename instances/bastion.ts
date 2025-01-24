import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

import { publicSubnetBastion } from "../network/vpc_networking";
import { bastionSecurityGroup} from "../network/security_group"
import { resourceSetup } from "../network/iam_instance"
import * as keyPair from "../network/key_pairs"; 


const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";

// Read the AMI ID from the file (ensure the file path is correct)
const amiId = fs.readFileSync(path.join(__dirname, "bastion_ami_id.txt"), "utf8").trim();

// Bastion Host Instance
export const bastionHost = new aws.ec2.Instance("bastion-host", {
    ami: amiId, 
    instanceType: "t2.micro", // Adjust instance type as necessary
    iamInstanceProfile: ( await resourceSetup).bastionHostInstanceProfile,
    subnetId: publicSubnetBastion.id,
    keyName: keyPair.deployer.keyName,
    securityGroups: [bastionSecurityGroup.name],
    associatePublicIpAddress: true, // Bastion host needs a public IP
    tags: {
        Name: `${clusterName}-bastion-host`,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        Role: "Worker",
    },
});


 export const bastionHostPublicIp = bastionHost.publicIp;