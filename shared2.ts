import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// =====================
// Secrets Configuration
// =====================
const githubThumbprint = config.requireSecret("githubOidcThumbprint");
const clusterThumbprint = config.requireSecret("clusterOidcThumbprint");
const clusterCert = config.requireSecret("clusterOidcCert");
const clusterKey = config.requireSecret("clusterOidcKey");

// ===================
// Base Configuration
// ===================
const baseConfig = {
  domain: config.require("domain"),
  clusterName: config.require("clusterName"),
  accountId: pulumi.output(aws.getCallerIdentity({})).accountId,
  dnsZoneId: config.require("dnsZoneId"),
  region: aws.getRegionOutput().name,
  clusterCert,
  clusterKey
};

// ================
// Security Tags
// ================
const securityTags = {
  clusterTag: (clusterName: string) => `kubernetes.io/cluster/${clusterName}`,
  roleTags: {
    master: "master",
    worker: "worker"
  },
  environmentTag: "production",
  baseTags: {
    Project: pulumi.getProject(),
    Stack: pulumi.getStack(),
    ManagedBy: "pulumi",
    SecurityTier: "tier1"
  }
};

// ========================
// Permission Boundary
// ========================
export const permissionBoundary = new aws.iam.Policy("k8sPermissionBoundary", {
  name: pulumi.interpolate`${baseConfig.clusterName}-boundary`,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ec2:Describe*",
          "autoscaling:Describe*",
          "iam:ListInstanceProfilesForRole"
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
        Action: ["route53:ChangeResourceRecordSets"],
        Resource: pulumi.interpolate`arn:aws:route53:::hostedzone/${baseConfig.dnsZoneId}`
      },
      {
        Effect: "Allow",
        Action: "sts:AssumeRoleWithWebIdentity",
        Resource: pulumi.interpolate`arn:aws:iam::${baseConfig.accountId}:oidc-provider/oidc.${baseConfig.domain}`
      }
    ]
  }),
  tags: securityTags.baseTags
});

// ===================
// OIDC Providers
// ===================
const githubOidc = new aws.iam.OpenIdConnectProvider("github", {
  url: "https://token.actions.githubusercontent.com",
  clientIdLists: ["sts.amazonaws.com"],
  thumbprintLists: [githubThumbprint],
  tags: {
    ...securityTags.baseTags,
    Purpose: "GitHubActions"
  }
});

const clusterOidc = new aws.iam.OpenIdConnectProvider("cluster", {
  url: pulumi.interpolate`https://oidc.${baseConfig.domain}`,
  clientIdLists: ["sts.amazonaws.com"],
  thumbprintLists: [clusterThumbprint],
  tags: {
    ...securityTags.baseTags,
    Purpose: "ClusterIRSA"
  }
});

// ====================
// IMDS Security Policy
// ====================
export const imdsPolicy = new aws.iam.Policy("imds-control", {
  name: pulumi.interpolate`${baseConfig.clusterName}-imds`,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny",
      Action: ["ec2:ModifyInstanceMetadataOptions"],
      Resource: "*",
      Condition: {
        StringNotEquals: {
          "ec2:MetadataHttpTokens": "required"
        }
      }
    }]
  }),
  tags: securityTags.baseTags
});

// ======================
// IAM Role Construction
// ======================
export const k8sRole = (roleType: "master" | "worker", service: string) => {
  return new aws.iam.Role(`${roleType}-role`, {
    name: pulumi.interpolate`${baseConfig.clusterName}-${roleType}-role`,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: `${service}.amazonaws.com`
    }),
    permissionsBoundary: permissionBoundary.arn,
    tags: {
      ...securityTags.baseTags,
      Role: roleType,
      [securityTags.clusterTag(baseConfig.clusterName)]: "owned"
    }
  });
};

// ==============
// Core Exports
// ==============
export const coreExports = {
  clusterTag: securityTags.clusterTag(baseConfig.clusterName),
  githubOidcArn: githubOidc.arn,
  clusterOidcArn: clusterOidc.arn,
  oidcDomain: pulumi.interpolate`oidc.${baseConfig.domain}`,
  permissionBoundaryArn: permissionBoundary.arn,
  imdsPolicyArn: imdsPolicy.arn,
  clusterCert,
  clusterKey
};