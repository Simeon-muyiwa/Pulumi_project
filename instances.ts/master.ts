import * as aws from "@pulumi/aws";

import { privateSubnetMaster } from "../network.ts/vpc_networking";
import { masterSecurityGroup } from "../network.ts/security_group"
import { instanceProfiles } from "../network.ts/iam_instance";



// // Create EC2 Instance for Master Node
// const masterInstance = new aws.ec2.Instance("master-node", {
//     ami: "ami-0c55b159cbfafe1f0",
//     instanceType: "t3.medium",
//     securityGroups: [masterSecurityGroup.name],
//     subnetId: privateSubnetMaster.id,
//     keyName: "my-key-pair", // Replace with your SSH key pair name
//     tags: {
//         Name: `${clusterName}-master`,
//         [`kubernetes.io/role/master`]: "yes",
//     }
   
// });


// Define the base instance configuration for both master and worker nodes
async function createInstance(role: string, ami: string, securityGroup: aws.ec2.SecurityGroup): Promise<aws.ec2.Instance> {
    return new aws.ec2.Instance(`kubernetes-${role}-node`, {
        instanceType: "t3.medium",  // Adjust as necessary
        ami: ami,  // Dynamic AMI ID for each instance
        securityGroups: [masterSecurityGroup.name],  // Reference security group
        subnetId: privateSubnetMaster.id,
        iamInstanceProfile: (await instanceProfiles).masterInstanceProfile.name,
        tags: {
            Name: `kubernetes-${role}`,
            Role: role,
            Environment: "kubernetes", // Optional environment tag
        },
    });
}

 const masterInstance = createInstance("Master", "ami-12345678", masterSecurityGroup);

