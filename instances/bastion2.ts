import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { networkOutputs } from "../network/vpc_networking";
import { securityGroupIds } from "../network/security_group";
import * as keyPair from "../network/key_pairs";
import { 
  baseConfig, 
  securityTags, 
  permissionBoundary,
  imdsPolicy
} from "../shared2";

const ami = pulumi.output(aws.ec2.getAmi({
    filters: [{ 
      name: "tag:Name",
      values: [`k8s-${baseConfig.clusterName}-bastion-*`] 
    }],
    owners: ["self"]
  },{ async: true} ).then(result => result.id));

// Minimal IAM Role without OIDC
const bastionRole = new aws.iam.Role("bastion-role", {
  name: pulumi.interpolate`${baseConfig.clusterName}-bastion-role`,
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ...securityTags.baseTags,
    [securityTags.clusterTag(baseConfig.clusterName)]: "owned",
    Role: "bastion",
    ansible_group: "bastion_hosts"
  },
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ec2.amazonaws.com"
  })
});

// Simplified Policy without cluster-specific credentials
const bastionPolicy = new aws.iam.Policy("bastion-policy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ec2:DescribeInstances",
          "ec2:DescribeSecurityGroups"
        ],
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": baseConfig.region
          }
        }
      },
      {
        Effect: "Allow",
        Action: ["ssm:StartSession", "ssm:TerminateSession"],
        Resource: pulumi.interpolate`arn:aws:ssm:*:*:session/${baseConfig.clusterName}-bastion/*`
      }
    ]
  })
});

// IMDS Policy Attachment (Security Hardening)
new aws.iam.RolePolicyAttachment("bastion-imds-policy", {
  role: bastionRole.name,
  policyArn: imdsPolicy.arn
});

const bastionInstanceProfile = new aws.iam.InstanceProfile("bastion-profile", {
  name: pulumi.interpolate`${baseConfig.clusterName}-bastion-profile`,
  role: bastionRole.name
});

// Security Group (Aligned with Shared Tags)
const bastionSecurityGroup = new aws.ec2.SecurityGroup("bastion-sg", {
  vpcId: networkOutputs.vpcId,
  ingress: [{
    fromPort: 22,
    toPort: 22,
    protocol: "tcp",
    cidrBlocks: ["0.0.0.0/0"],
  }],
  egress: [
    {
      fromPort: 443,
      toPort: 443,
      protocol: "tcp",
      cidrBlocks: ["0.0.0.0/0"],
      description: "HTTPS egress for cluster API"
    },
    {
      fromPort: 22,
      toPort: 22,
      protocol: "tcp",
      cidrBlocks: [networkOutputs.vpcCidr],
      description: "SSH to cluster nodes"
    }
  ],
  tags: securityTags.baseTags
});

// Bastion Instance with Unified Configuration
const bastionHost = new aws.ec2.Instance("bastion-host", {
  instanceType: "t3.micro",
  ami: ami,
  subnetId: pulumi.all(networkOutputs.publicSubnetIds).apply(
    (subnets: string[]) => subnets[0]
  ),
  vpcSecurityGroupIds: [bastionSecurityGroup.id],
  iamInstanceProfile: bastionInstanceProfile.name,
  keyName: keyPair.deployer.keyName,
  associatePublicIpAddress: true,
  metadataOptions: {
    httpEndpoint: "enabled",
    httpTokens: "required",
    httpPutResponseHopLimit: 2
  },
  rootBlockDevice: {
    encrypted: true,
    volumeType: "gp3",
    volumeSize: 10,
    deleteOnTermination: true
  },
  tags: {
    ...securityTags.baseTags,
    Name: pulumi.interpolate`${baseConfig.clusterName}-bastion`,
    [securityTags.clusterTag(baseConfig.clusterName)]: "shared",
    Role: "bastion",
    component: "bastion"
  }
});

export const bastionResources = {
  instance: bastionHost,
  securityGroup: bastionSecurityGroup,
  details: {
    id: bastionHost.id,
    publicIp: bastionHost.publicIp,
    instanceProfileArn: bastionInstanceProfile.arn
  },
  iamProfile: bastionInstanceProfile,
  sshCommand: pulumi.interpolate`ssh -i ${keyPair.deployer.keyName}.pem ubuntu@${bastionHost.publicIp}`
};

// Aligned exports with index.ts expectations
export const bastionPublicIp = bastionHost.publicIp;
export const bastionInstanceId = bastionHost.id;
