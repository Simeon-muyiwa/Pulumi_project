import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { networkOutputs } from "../network/vpc_networking";
import { securityGroupIds } from "../network/security_group";
import * as keyPair from "../network/key_pairs";
import { permissionBoundary, configValues, securityTags, oidcProvider } from "../shared";

// IAM Resources with enhanced cloud provider permissions
const masterRole = new aws.iam.Role("master-role", {
  name: pulumi.interpolate`k8s-${configValues.clusterName}-iam-master-role`,
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ansible_group: "kube_control_plane",
    cluster_id: configValues.clusterName,
    permission_boundary: permissionBoundary.arn
  },
  assumeRolePolicy: pulumi.all([oidcProvider.arn, configValues.domain, configValues.clusterName])
    .apply(([oidcArn, domain, clusterName]) => 
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole"
          },
          {
            Effect: "Allow",
            Principal: { Federated: oidcArn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`oidc.${domain}/clusters/${clusterName}:aud`]: "sts.amazonaws.com"
              }
            }
          }
        ]
      })
    )
});

// Enhanced Policy for kubeadm AWS integration
const masterPolicy = new aws.iam.Policy("master-policy", {
  policy: pulumi.all([configValues.oidcCertificateArn, configValues.kmsKeyArn])
    .apply(([certArn, kmsArn]) => 
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          // Core Kubernetes permissions
          {
            Effect: "Allow",
            Action: ["autoscaling:DescribeAutoScalingGroups"],
            Resource: "*"
          },
          {
            Effect: "Allow",
            Action: ["ec2:Describe*"],
            Resource: "*"
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:AttachVolume",
              "ec2:DetachVolume",
              "ec2:CreateTags",
              "ec2:CreateSecurityGroup",
              "ec2:AuthorizeSecurityGroupIngress",
              "ec2:RevokeSecurityGroupIngress"
            ],
            Resource: "*",
            Condition: {
              StringEquals: {
                [`aws:RequestTag/${securityTags.clusterTag(configValues.clusterName)}`]: "shared"
              }
            }
          },
          // Load Balancer permissions
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:DescribeLoadBalancers",
              "elasticloadbalancing:DescribeTargetGroups",
              "elasticloadbalancing:CreateLoadBalancer",
              "elasticloadbalancing:DeleteLoadBalancer",
              "elasticloadbalancing:ModifyLoadBalancerAttributes"
            ],
            Resource: "*",
            Condition: {
              StringEquals: {
                [`aws:ResourceTag/${securityTags.clusterTag(configValues.clusterName)}`]: "shared"
              }
            }
          },
          // Route53 permissions
          {
            Effect: "Allow",
            Action: ["route53:ChangeResourceRecordSets"],
            Resource: pulumi.interpolate`arn:aws:route53:::hostedzone/${configValues.dnsZoneId}`,
            Condition: {
              StringEquals: {
                [`aws:RequestTag/${securityTags.clusterTag(configValues.clusterName)}`]: "shared"
              }
            }
          },
          // ACM Certificate permissions
          {
            Effect: "Allow",
            Action: ["acm:DescribeCertificate", "acm:ExportCertificate"],
            Resource: certArn,
            Condition: {
              StringEquals: {
                "aws:ResourceTag/cluster": configValues.clusterName
              }
            }
          },
          // Enhanced KMS permissions
          {
            Effect: "Allow",
            Action: ["kms:Decrypt", "kms:DescribeKey"],
            Resource: kmsArn,
            Condition: {
              StringEquals: {
                "kms:ViaService": `ec2.${configValues.region}.amazonaws.com`
              }
            }
          }
        ]
      })
    )
});

// Rest of the file remains unchanged
new aws.iam.RolePolicyAttachment("master-policy-attach", {
  role: masterRole.name,
  policyArn: masterPolicy.arn
});

const masterInstanceProfile = new aws.iam.InstanceProfile("master-instance-profile", {
  name: pulumi.interpolate`k8s-${configValues.clusterName}-iam-master-profile`,
  role: masterRole.name
});

new aws.ec2.SecurityGroupRule("master-oidc-egress", {
  securityGroupId: securityGroupIds.master,
  type: "egress",
  fromPort: 443,
  toPort: 443,
  protocol: "tcp",
  cidrBlocks: ["0.0.0.0/0"],
  description: "OIDC HTTPS egress"
});

const masterNode = new aws.ec2.Instance("master-node", {
  instanceType: "t3.medium",
  ami: pulumi.output(fs.promises.readFile(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8"))
    .apply(amiId => amiId.trim()),
  subnetId: pulumi.all(networkOutputs.privateSubnetIds).apply(
    (subnets: string[]) => subnets[0]
  ),
  vpcSecurityGroupIds: [securityGroupIds.master],
  iamInstanceProfile: masterInstanceProfile.name,
  keyName: keyPair.deployer.keyName,
  userData: pulumi.interpolate`#!/bin/bash
  echo "OIDC_ISSUER_URL=https://oidc.${configValues.domain}/clusters/${configValues.clusterName}" >> /etc/kubernetes/apiserver.env
  systemctl restart kube-apiserver
  `,
  tags: {
    Name: pulumi.interpolate`k8s-${configValues.clusterName}-master`,
    [securityTags.clusterTag(configValues.clusterName)]: "shared",
    role: "master",
    permissionsBoundary: permissionBoundary.arn,
    Environment: securityTags.environmentTag,
    oidc_enabled: "true",
    component: "control_plane"
  },
  metadataOptions: {
    httpTokens: "required",
    httpEndpoint: "enabled"
  },
  rootBlockDevice: {
    volumeSize: 50,
    volumeType: "gp3",
    encrypted: true
  },
});

export const masterResources = {
  instance: masterNode,
  details: {
    id: masterNode.id,
    privateIp: masterNode.privateIp,
    publicIp: masterNode.publicIp,
    asgName: pulumi.output(""),
    instanceProfileArn: masterInstanceProfile.arn,
    oidcConfig: {
      issuerUrl: pulumi.interpolate`https://oidc.${configValues.domain}/clusters/${configValues.clusterName}`,
      roleArn: masterRole.arn
    }
  },
  iamProfile: masterInstanceProfile
};

export const masterPublicIp = masterNode.publicIp;
export const masterPrivateIp = masterNode.privateIp;
export const masterInstanceProfileName = masterInstanceProfile.name;