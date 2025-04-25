import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { networkOutputs } from "../network/vpc_networking";
import { securityGroupIds } from "../network/security_group";
import * as keyPair from "../network/key_pairs";
import { permissionBoundary, configValues, securityTags, oidcProvider } from "../shared";

// IAM Role with Minimal Trust Policy
const bastionRole = new aws.iam.Role("bastion-role", {
  name: pulumi.interpolate`k8s-${configValues.clusterName}-iam-bastion-role`,
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ansible_group: "bastion_hosts",
    cluster_id: configValues.clusterName,
    permission_boundary: permissionBoundary.arn
  },
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { 
        Service: "ec2.amazonaws.com" 
      },
      Action: "sts:AssumeRole"
    }]
  })
});

// Minimal Bastion Policy (SSH + Ansible requirements only)
const bastionPolicy = new aws.iam.Policy("bastion-policy", {
  policy: pulumi.all([configValues.region, configValues.clusterName, configValues.kmsKeyArn])
    .apply(([region, clusterName, kmsKeyArn]) => 
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ec2:DescribeInstances",       // For Ansible dynamic inventory
              "ec2:DescribeSecurityGroups"  // For connection validation
            ],
            Resource: "*",
            Condition: {
              StringEquals: {
                "aws:RequestedRegion": region,
                [`ec2:ResourceTag/${securityTags.clusterTag(clusterName)}`]: "owned"
              }
            }
          },
          {
            Effect: "Allow",
            Action: ["kms:Decrypt"],         
            Resource: kmsKeyArn,
            Condition: {
              StringEquals: {
                "aws:ResourceTag/cluster": clusterName
              }
            }
          },
          {
            Effect: "Allow",
            Action: [
              "ssm:StartSession",           
              "ssm:TerminateSession"
            ],
            Resource: pulumi.interpolate`arn:aws:ssm:*:*:session/${clusterName}-bastion/*`
          }
        ]
      })
    )
});


new aws.iam.RolePolicyAttachment("bastion-policy-attach", {
  role: bastionRole.name,
  policyArn: bastionPolicy.arn
});

const bastionInstanceProfile = new aws.iam.InstanceProfile("bastion-instance-profile", {
  name: pulumi.interpolate`k8s-${configValues.clusterName}-iam-bastion-profile`,
  role: bastionRole.name
});

// Security Group (No Changes Needed - Already Correct)
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
});

// Bastion Instance Configuration (No Changes Needed)
const bastionHost = new aws.ec2.Instance("bastion-host", 
  {
    instanceType: "t3.micro",
    ami: pulumi.output(fs.promises.readFile(path.join(__dirname, "bastion_ami_id.txt"), "utf8"))
      .apply(amiId => amiId.trim()),
    subnetId: pulumi.all(networkOutputs.publicSubnetIds).apply(
      (subnets: string[]) => subnets[0]
    ),
    vpcSecurityGroupIds: [securityGroupIds.bastion],
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
      Name: pulumi.interpolate`k8s-${configValues.clusterName}-bastion`,
      [securityTags.clusterTag(configValues.clusterName)]: "shared",
      role: "bastion",
      component: "bastion",
      backup_schedule: "daily-0300-utc"
    },
    disableApiTermination: true
  },
  {
    deleteBeforeReplace: false
  }
);

// Snapshot and Exports (No Changes Needed)
new aws.ebs.Snapshot("bastion-snapshot", {
  volumeId: bastionHost.rootBlockDevice.apply(b => b.volumeId),
  tags: { 
    AutoSnapshot: "true",
    RetentionDays: "7",
    cluster: configValues.clusterName,
    [securityTags.environmentTag]: "true"
  }
});

export const bastionResources = {
  instance: bastionHost,
  securityGroup: bastionSecurityGroup,
  details: pulumi.all([
    bastionHost.id,
    bastionHost.publicIp,
    bastionInstanceProfile.arn
  ]).apply(([id, publicIp, profileArn]) => ({
    id,
    publicIp,
    instanceProfileArn: profileArn
  })),
  iamProfile: bastionInstanceProfile,
  sshCommand: pulumi.interpolate`ssh -i ${keyPair.deployer.keyName}.pem ubuntu@${bastionHost.publicIp}`,
  ssmCommand: pulumi.interpolate`aws ssm start-session --target ${bastionHost.id} --region ${configValues.region}`,
};

export const bastionPublicIp = bastionHost.publicIp;
export const bastionInstanceId = bastionHost.id;
export const bastionInstanceProfileName = bastionInstanceProfile.name;