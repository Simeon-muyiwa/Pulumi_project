import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { securityGroupIds } from "../network/security_group";
import { networkOutputs } from "../network/vpc_networking";
import * as keyPair from "../network/key_pairs";
import { permissionBoundary, configValues, securityTags, oidcProvider } from "../shared";

const workerRole = new aws.iam.Role("worker-role", {
  name: pulumi.interpolate`k8s-${configValues.clusterName}-iam-worker-role`,
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ansible_group: "kube_node",
    cluster_id: configValues.clusterName,
    permission_boundary: permissionBoundary.arn,
  },
  assumeRolePolicy: pulumi.all([oidcProvider.arn, configValues.clusterName, configValues.domain])
    .apply(([oidcArn, clusterName, domain]) => 
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

const workerPolicy = new aws.iam.Policy("worker-policy", {
  policy: pulumi.all([
    configValues.region, 
    configValues.clusterName, 
    configValues.kmsKeyArn, 
    configValues.oidcCertificateArn
  ]).apply(([region, clusterName, kmsArn, oidcCertArn]) => 
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "ec2:DescribeInstances",
            "ec2:DescribeVolumes",
            "ec2:AttachVolume",
            "ec2:DetachVolume",
            "ec2:CreateTags",
            "ec2:DescribeAvailabilityZones",
            "ec2:DescribeSubnets",
            "autoscaling:SetInstanceProtection",
            "autoscaling:UpdateAutoScalingGroup"
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
          Action: [
            "ec2:CreateVolume",
            "ec2:DeleteVolume",
            "ec2:ModifyVolume",
            "ec2:DescribeVolumeStatus",
            "ec2:DescribeVolumesModifications"
          ],
          Resource: "*",
          Condition: {
            StringEquals: {
              "aws:RequestedRegion": region
            }
          }
        },
        {
          Effect: "Allow",
          Action: [
            "ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage"
          ],
          Resource: "*"
        },
        {
          Effect: "Allow",
          Action: [
            "ec2:CreateSnapshot",
            "ec2:DeleteSnapshot",
            "ec2:DescribeSnapshots"
          ],
          Resource: "*",
          Condition: {
            StringEquals: {
              "aws:RequestedRegion": region
            }
          }
        },
        {
          Effect: "Allow",
          Action: ["kms:Decrypt", "kms:DescribeKey"],
          Resource: kmsArn,
          Condition: {
            StringEquals: {
              "aws:ResourceTag/cluster": clusterName
            }
          }
        },
        {
          Effect: "Allow",
          Action: ["autoscaling:DescribeAutoScalingGroups"],
          Resource: "*"
        },
        {
          Effect: "Allow",
          Action: [
            "elasticloadbalancing:Describe*",
            "elasticloadbalancing:DescribeListeners"
          ],
          Resource: "*"
        },
        {
          Effect: "Allow",
          Action: ["acm:DescribeCertificate", "acm:ExportCertificate"],
          Resource: oidcCertArn,
          Condition: {
            StringEquals: {
              "aws:ResourceTag/cluster": clusterName
            }
          }
        },
        {
          Effect: "Allow",
          Action: [
            "sts:TagSession",
            "iam:GetRole",
            "iam:GetInstanceProfile"
          ],
          Resource: "*"
        }
      ]
    })
  )
});

new aws.iam.RolePolicyAttachment("worker-policy-attach", {
  role: workerRole.name,
  policyArn: workerPolicy.arn
});

const workerInstanceProfile = new aws.iam.InstanceProfile("worker-instance-profile", {
  name: pulumi.interpolate`k8s-${configValues.clusterName}-iam-worker-profile`,
  role: workerRole.name
});

const workerLaunchTemplate = new aws.ec2.LaunchTemplate("worker-launch-template", {
  imageId: pulumi.output(fs.promises.readFile(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8"))
    .apply(amiId => amiId.trim()),
  instanceType: "t3.medium",
  keyName: keyPair.deployer.keyName,
  vpcSecurityGroupIds: [securityGroupIds.worker],
  iamInstanceProfile: { name: workerInstanceProfile.name },
  metadataOptions: {
    httpEndpoint: "enabled",
    httpTokens: "required",
    httpPutResponseHopLimit: 2
  },
  userData: pulumi.all([configValues.clusterName, configValues.domain])
    .apply(([clusterName, domain]) => 
      Buffer.from(`#!/bin/bash
      echo "OIDC_ISSUER_URL=https://oidc.${domain}/clusters/${clusterName}" >> /etc/kubernetes/kubelet.env
      systemctl restart kubelet
      `).toString("base64")
    ),
  tagSpecifications: [{
    resourceType: "instance",
    tags: {
      Name: pulumi.interpolate`k8s-${configValues.clusterName}-worker`,
      [securityTags.clusterTag(configValues.clusterName)]: "shared",
      role: "worker",
      component: "worker_node",
      oidc_enabled: "true",
      Environment: securityTags.environmentTag
    },
  }],
});

new aws.ec2.SecurityGroupRule("worker-oidc-https", {
  type: "egress",
  fromPort: 443,
  toPort: 443,
  protocol: "tcp",
  securityGroupId: securityGroupIds.worker,
  cidrBlocks: ["0.0.0.0/0"],
  description: "OIDC HTTPS egress"
});

export const workerAsg = new aws.autoscaling.Group("worker-autoscaling-group", {
  minSize: 2,
  maxSize: 10,
  desiredCapacity: 2,
  vpcZoneIdentifiers: networkOutputs.privateSubnetIds,
  mixedInstancesPolicy: {
    launchTemplate: {
      launchTemplateSpecification: {
        launchTemplateId: workerLaunchTemplate.id,
        version: "$Latest",
      },
      overrides: [
        { instanceType: "t3.medium" },
        { instanceType: "t3a.medium" },
        { instanceType: "t2.medium" }
      ],
    },
    instancesDistribution: {
      onDemandBaseCapacity: 1,
      onDemandPercentageAboveBaseCapacity: 30,
      spotAllocationStrategy: "capacity-optimized",
      spotInstancePools: 3
    },
  },
  initialLifecycleHooks: [{
    name: pulumi.interpolate`${configValues.clusterName}-termination-hook`, // Added unique name
    lifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
    defaultResult: "CONTINUE",
    heartbeatTimeout: 300,
    notificationTargetArn: pulumi.interpolate`arn:aws:sns:${configValues.region}:${configValues.accountId}:${configValues.clusterName}-termination-notify`
  }],
  tags: [
    {
      key: "Name",
      value: pulumi.interpolate`${configValues.clusterName}-worker`,
      propagateAtLaunch: true,
    },
    {
      key: `kubernetes.io/cluster/${configValues.clusterName}`,
      value: "owned",
      propagateAtLaunch: true,
    },
    {
      key: "Role",
      value: "worker",
      propagateAtLaunch: true,
    },
    {
      key: "k8s.io/cluster-autoscaler/enabled",
      value: "true",
      propagateAtLaunch: true
    }
  ],
});

const scaleOutPolicy = new aws.autoscaling.Policy("worker-scale-out", {
  scalingAdjustment: 1,
  adjustmentType: "ChangeInCapacity",
  cooldown: 300,
  autoscalingGroupName: workerAsg.name,
});

const scaleInPolicy = new aws.autoscaling.Policy("worker-scale-in", {
  scalingAdjustment: -1,
  adjustmentType: "ChangeInCapacity",
  cooldown: 300,
  autoscalingGroupName: workerAsg.name,
});

const scaleUpAlarm = new aws.cloudwatch.MetricAlarm("scale-up-alarm", {
  alarmActions: [scaleOutPolicy.arn],
  comparisonOperator: "GreaterThanThreshold",
  evaluationPeriods: 2,
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  period: 300,
  statistic: "Average",
  threshold: 75,
  dimensions: { AutoScalingGroupName: workerAsg.name },
});

const scaleDownAlarm = new aws.cloudwatch.MetricAlarm("scale-down-alarm", {
  alarmActions: [scaleInPolicy.arn],
  comparisonOperator: "LessThanThreshold",
  evaluationPeriods: 2,
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  period: 300,
  statistic: "Average",
  threshold: 25,
  dimensions: { AutoScalingGroupName: workerAsg.name },
});

export const workerResources = {
  launchTemplate: workerLaunchTemplate,
  autoScalingGroup: workerAsg,
  scalingPolicies: {
    scaleOut: scaleOutPolicy,
    scaleIn: scaleInPolicy,
  },
  scalingAlarms: {
    scaleUp: scaleUpAlarm,
    scaleDown: scaleDownAlarm,
  },
  iamProfile: workerInstanceProfile
};

export const workerIamProfileArn = workerInstanceProfile.arn;
export const workerAsgName = workerAsg.name;
export const workerInstanceProfileName = workerInstanceProfile.name;
export const workerRoleArn = workerRole.arn;