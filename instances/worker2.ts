import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { securityGroupIds } from "../network/security_group";
import { networkOutputs } from "../network/vpc_networking";
import * as keyPair from "../network/key_pairs";
import { 
  baseConfig, 
  securityTags, 
  permissionBoundary, 
  coreExports,
  imdsPolicy
} from "../shared2";

// IAM Role using shared configuration
const workerRole = new aws.iam.Role("worker-role", {
  name: pulumi.interpolate`${baseConfig.clusterName}-worker-role`,
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ...securityTags.baseTags,
    [securityTags.clusterTag(baseConfig.clusterName)]: "owned",
    Role: securityTags.roleTags.worker,
    ansible_group: "kube_node"
  },
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ec2.amazonaws.com"
  })
});

// Worker policy aligned with IRSA workflow
const workerPolicy = new aws.iam.Policy("worker-policy", {
  policy: pulumi.all([coreExports.irsaConfig])
    .apply(([irsaConfig]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "ec2:Describe*",
            "autoscaling:*",
            "ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "elasticloadbalancing:Describe*",
            "route53:ChangeResourceRecordSets"
          ],
          Resource: "*",
          Condition: {
            StringEquals: {
              [`aws:ResourceTag/${securityTags.clusterTag(baseConfig.clusterName)}`]: "shared"
            }
          }
        },
        {
          Effect: "Allow",
          Action: ["sts:AssumeRole"],
          Resource: [
            irsaConfig.ebsCSI,
            irsaConfig.clusterAutoscaler
          ]
        }
      ]
    }))
});

// IMDS Policy Attachment
new aws.iam.RolePolicyAttachment("worker-imds-policy", {
  role: workerRole.name,
  policyArn: imdsPolicy.arn
});

const workerInstanceProfile = new aws.iam.InstanceProfile("worker-profile", {
  name: pulumi.interpolate`${baseConfig.clusterName}-worker-profile`,
  role: workerRole.name
});

// Launch Template with unified OIDC config
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

  tagSpecifications: [{
    resourceType: "instance",
    tags: {
      ...securityTags.baseTags,
      Name: pulumi.interpolate`${baseConfig.clusterName}-worker`,
      [securityTags.clusterTag(baseConfig.clusterName)]: "shared",
      Role: securityTags.roleTags.worker,
      component: "worker_node"
    },
  }],
});

// Security Group Rule with shared OIDC domain
new aws.ec2.SecurityGroupRule("worker-oidc-egress", {
  securityGroupId: securityGroupIds.worker,
  type: "egress",
  fromPort: 443,
  toPort: 443,
  protocol: "tcp",
  cidrBlocks: ["0.0.0.0/0"],
  description: "OIDC provider communication"
});

// Autoscaling Group with unified tagging
export const workerAsg = new aws.autoscaling.Group("worker-asg", {
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
        { instanceType: "t3a.medium" }
      ],
    },
    instancesDistribution: {
      onDemandBaseCapacity: 1,
      onDemandPercentageAboveBaseCapacity: 30,
      spotAllocationStrategy: "capacity-optimized"
    },
  },
  tags: [
    {
      key: "Name",
      value: pulumi.interpolate`${baseConfig.clusterName}-worker`,
      propagateAtLaunch: true,
    },
    {
      key: securityTags.clusterTag(baseConfig.clusterName),
      value: "owned",
      propagateAtLaunch: true,
    },
    {
      key: "k8s.io/cluster-autoscaler/enabled",
      value: "true",
      propagateAtLaunch: true
    }
  ].concat(Object.entries(securityTags.baseTags).map(([k, v]) => ({
    key: k,
    value: v.toString(),
    propagateAtLaunch: true
  })))
});

export const workerResources = {
  launchTemplate: workerLaunchTemplate,
  autoScalingGroup: workerAsg,
  iamProfile: workerInstanceProfile
};

// Aligned exports with index.ts expectations
export const workerIamProfileArn = workerInstanceProfile.arn;
export const workerAsgName = workerAsg.name;
