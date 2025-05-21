import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { networkOutputs } from "../network/vpc_networking";
import { securityGroupIds } from "../network/security_group";
import * as keyPair from "../network/key_pairs";
import { 
  baseConfig, 
  securityTags, 
  permissionBoundary, 
  coreExports,
  imdsPolicy
} from "../shared2";
import { getAmiId } from "./ami";

// IAM Role using shared configuration
const masterRole = new aws.iam.Role("master-role", {
  name: pulumi.interpolate`${baseConfig.clusterName}-master-role`,
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ...securityTags.baseTags,
    [securityTags.clusterTag(baseConfig.clusterName)]: "owned",
    Role: securityTags.roleTags.master,
    ansible_group: "kube_control_plane"
  },
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ec2.amazonaws.com"
  })
});

// Core master policy aligned with IRSA workflow
const masterPolicy = new aws.iam.Policy("master-policy", {
  policy: pulumi.all([coreExports.clusterOidcArn])
    .apply(([oidcArn]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "ec2:Describe*",
            "autoscaling:Describe*",
            "elasticloadbalancing:*",
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
          Resource: coreExports.irsaConfig.apply(c => [
            c.ebsCSI, 
            c.clusterAutoscaler
          ])
        }
      ]
    }))
});

// Attach policies
new aws.iam.RolePolicyAttachment("master-imds-policy", {
  role: masterRole.name,
  policyArn: imdsPolicy.arn
});

new aws.iam.RolePolicyAttachment("master-custom-policy", {
  role: masterRole.name,
  policyArn: masterPolicy.arn
});

const masterInstanceProfile = new aws.iam.InstanceProfile("master-profile", {
  name: pulumi.interpolate`${baseConfig.clusterName}-master-profile`,
  role: masterRole.name
});

// Master Instance with unified AMI handling
const masterNode = new aws.ec2.Instance("master-node", {
  instanceType: "t3.medium",
  ami: getAmiId("master"),
  subnetId: pulumi.all(networkOutputs.privateSubnetIds).apply(
    (subnets: string[]) => subnets[0]
  ),
  vpcSecurityGroupIds: [securityGroupIds.master],
  iamInstanceProfile: masterInstanceProfile.name,
  keyName: keyPair.deployer.keyName,
  tags: {
    ...securityTags.baseTags,
    role: "master",
    Name: pulumi.interpolate`${baseConfig.clusterName}-master`,
    [securityTags.clusterTag(baseConfig.clusterName)]: "shared",
    Role: securityTags.roleTags.master,
    component: "control_plane"
  },
  metadataOptions: {
    httpTokens: "required",
    httpEndpoint: "enabled",
    httpPutResponseHopLimit: 2,  // Prevent metadata leakage
    instanceMetadataTags: "enabled"
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
    instanceProfileArn: masterInstanceProfile.arn
  },
  iamProfile: masterInstanceProfile
};

export const masterPublicIp = masterNode.publicIp;
export const masterPrivateIp = masterNode.privateIp;
export const masterInstanceProfileName = masterInstanceProfile.name;