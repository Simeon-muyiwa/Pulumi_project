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

// Get AMI ID from file
const amiId = pulumi.output(fs.promises.readFile(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8"))
    .apply(amiId => amiId.trim());

// Single master instance
const masterNode = new aws.ec2.Instance("master-node", {
  instanceType: "t3.medium",
  ami: amiId,
  subnetId: pulumi.all(networkOutputs.privateSubnetIds).apply(
      (subnets: string[]) => subnets[0]
  ),
  vpcSecurityGroupIds: [securityGroupIds.master],
  iamInstanceProfile: pulumi.output(resourceSetup).apply(res => 
      res.masterInstanceProfile.name
  ),
  keyName: keyPair.deployer.keyName,
  tags: {
      Name: pulumi.interpolate`${clusterName}-master`,
      [`kubernetes.io/cluster/${clusterName}`]: "shared",
      Role: "master",
      Environment: "production",
  },
  rootBlockDevice: {
      volumeSize: 50,
      volumeType: "gp3",
  },
});

// Export critical information
// In master.ts
export const masterResources = {
  instance: masterNode,  // The actual Instance resource
  details: pulumi.all({
      id: masterNode.id,
      privateIp: masterNode.privateIp,
      publicIp: masterNode.publicIp
  }),
  sshCommand: pulumi.interpolate`ssh -i ${keyPair.deployer.keyName}.pem ubuntu@${masterNode.publicIp}`
};