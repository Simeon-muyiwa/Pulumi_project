import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { networkOutputs } from "../network/vpc_networking";
import { securityGroupIds } from "../network/security_group";
import { resourceSetup } from "../network/iam_instance";
import * as keyPair from "../network/key_pairs";

const config = new pulumi.Config("myproject");
const clusterName = config.require("cluster_name");

// Read AMI ID using Pulumi's output system
const amiId = pulumi.output(fs.promises.readFile(path.join(__dirname, "bastion_ami_id.txt"), "utf8"))
    .apply(amiId => amiId.trim());

// Create bastion host instance
const bastionHost = new aws.ec2.Instance("bastion-host", {
    instanceType: "t2.micro",
    ami: amiId,
    subnetId: pulumi.all(networkOutputs.privateSubnetIds).apply(
      (subnets: string[]) => subnets[0]
  ),
    vpcSecurityGroupIds: [securityGroupIds.bastion],
    iamInstanceProfile: pulumi.output(resourceSetup).apply(res => 
        res.bastionHostInstanceProfile.name
    ),
    keyName: keyPair.deployer.keyName,
    associatePublicIpAddress: true,
    tags: {
        Name: pulumi.interpolate`${clusterName}-bastion`,
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        Role: "Bastion",
    },
});

// In bastion.ts
export const bastionResources = {
  instance: bastionHost,  // The actual Instance resource
  details: pulumi.all({
      id: bastionHost.id,
      publicIp: bastionHost.publicIp
  }),
  sshCommand: pulumi.interpolate`ssh -i ${keyPair.deployer.keyName}.pem ec2-user@${bastionHost.publicIp}`
};