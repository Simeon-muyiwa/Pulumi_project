import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { publicSubnetBastion } from "../network.ts/vpc_networking";
import { bastionSecurityGroup} from "../network.ts/security_group"
import { instanceProfiles } from "../network.ts/iam_instance";

const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";


// Bastion Host Instance
const bastionHost = new aws.ec2.Instance("bastion-host", {
    ami: "ami-0c55b159cbfafe1f0", // Use an appropriate AMI (e.g., Amazon Linux 2 or Ubuntu)
    instanceType: "t2.micro", // Adjust instance type as necessary
    iamInstanceProfile: (await instanceProfiles).bastionHostInstanceProfile.name,
    subnetId: publicSubnetBastion.id,
    securityGroups: [bastionSecurityGroup.name],
    associatePublicIpAddress: true, // Bastion host needs a public IP
    tags: {
        Name: `${clusterName}-bastion-host`,
    },
});


 export const bastionHostPublicIp = bastionHost.publicIp;