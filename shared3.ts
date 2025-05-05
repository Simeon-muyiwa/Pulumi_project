import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// =====================
// Security Validations
// =====================
const validateThumbprint = (secret: pulumi.Output<string>, expected: string) => {
  return secret.apply(t => {
    if (t !== expected) throw new Error(`Invalid thumbprint, expected ${expected}`);
    return t;
  });
};

const githubThumbprint = validateThumbprint(
  config.requireSecret("githubOidcThumbprint"),
  "1c58a3a8518e8759bf075b76b750d4f2df264fcd"
);

const clusterThumbprint = validateThumbprint(
  config.requireSecret("clusterOidcThumbprint"),
  "a8e1b2c3d4e5f67890abc123def4567890fedcba"
);

const clusterCert = config.requireSecret("clusterOidcCert");
const clusterKey = config.requireSecret("clusterOidcKey");

// ===================
// Base Configuration
// ===================
export const baseConfig = {
  domain: config.require("domain"),
  clusterName: config.require("clusterName"),
  accountId: pulumi.output(aws.getCallerIdentity({})).accountId,
  dnsZoneId: config.require("dnsZoneId"),
  region: aws.getRegionOutput().name,
  githubOrg: config.require("githubOrg"),
  mainBranch: config.require("mainBranch"),
  clusterCert,
  clusterKey
};

// ================
// Security Tags
// ================
export const securityTags = {
  clusterTag: (clusterName: string) => `kubernetes.io/cluster/${clusterName}`,
  roleTags: {
    master: "master",
    worker: "worker",
    irsa: "irsa"
  },
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
      }
    ]
  }),
  tags: securityTags.baseTags
});

// ========================
// IMDS Security Policy
// ========================
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

// ========================
// Namespace Policies
// ========================
const namespacePolicies = {
  storage: new aws.iam.Policy("namespace-storage", {
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["ec2:*Volume", "ec2:Attach*", "ec2:Detach*"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestTag/ManagedBy": "pulumi"
          }
        }
      }]
    })
  }),
  autoscaling: new aws.iam.Policy("namespace-autoscaling", {
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "autoscaling:*",
        Resource: pulumi.interpolate`arn:aws:autoscaling:*:${baseConfig.accountId}:*`
      }]
    })
  })
};

// ========================
// Managed Policy Refs
// ========================
const managedPolicies = {
  ebsCSI: pulumi.output(aws.iam.ManagedPolicy.AmazonEBSCSIDriverPolicy),
  cloudWatch: pulumi.output(aws.iam.ManagedPolicy.CloudWatchAgentServerPolicy),
  readOnly: pulumi.output(aws.iam.ManagedPolicy.ReadOnlyAccess)
};

// ===================
// OIDC Providers
// ===================
const githubOidc = new aws.iam.OpenIdConnectProvider("github", {
  url: "https://token.actions.githubusercontent.com",
  clientIdLists: ["sts.amazonaws.com"],
  thumbprintLists: [githubThumbprint],
  tags: securityTags.baseTags
});

const clusterOidc = new aws.iam.OpenIdConnectProvider("cluster", {
  url: pulumi.interpolate`https://oidc.${baseConfig.domain}`,
  clientIdLists: ["sts.amazonaws.com"],
  thumbprintLists: [clusterThumbprint],
  tags: securityTags.baseTags
});

// ====================
// IRSA Role Factory
// ====================
const createIRSARole = (
  serviceName: string,
  serviceAccount: string,
  policies: (aws.iam.Policy | pulumi.Output<string>)[]
) => {
  const role = new aws.iam.Role(`irsa-${serviceName}`, {
    name: pulumi.interpolate`${baseConfig.clusterName}-${serviceName}`,
    assumeRolePolicy: pulumi.all([clusterOidc.arn, baseConfig.domain]).apply(([arn, domain]) => 
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              [`oidc.${domain}:sub`]: `system:serviceaccount:${serviceAccount}`,
              [`oidc.${domain}:aud`]: "sts.amazonaws.com"
            }
          }
        }]
      })
    ),
    permissionsBoundary: permissionBoundary.arn,
    tags: {
      ...securityTags.baseTags,
      [securityTags.clusterTag(baseConfig.clusterName)]: "shared",
      ServiceAccount: serviceAccount
    }
  });

  // Attach security baseline policies
  new aws.iam.RolePolicyAttachment(`${serviceName}-imds`, {
    role: role.name,
    policyArn: imdsPolicy.arn
  });

  // Attach custom policies with proper Output handling
  policies.forEach((policy, index) => {
    const policyArn = policy instanceof aws.iam.Policy 
      ? policy.arn 
      : policy;
      
    new aws.iam.RolePolicyAttachment(`${serviceName}-policy-${index}`, {
      role: role.name,
      policyArn
    });
  });

  return role;
};

// =====================
// IRSA Role Definitions
// =====================
export const irsaRoles = {
  ebsCSI: createIRSARole(
    "ebs-csi",
    "kube-system:ebs-csi-controller",
    [namespacePolicies.storage.arn, managedPolicies.ebsCSI]
  ),
  clusterAutoscaler: createIRSARole(
    "cluster-autoscaler",
    "kube-system:cluster-autoscaler",
    [namespacePolicies.autoscaling.arn, managedPolicies.readOnly]
  ),
  cloudwatchAgent: createIRSARole(
    "cloudwatch-agent",
    "monitoring:cloudwatch-agent",
    [managedPolicies.cloudWatch]
  )
};

// ======================
// GitHub Actions Role
// ======================
export const githubActionsRole = new aws.iam.Role("github-actions", {
  name: pulumi.interpolate`${baseConfig.clusterName}-github-actions`,
  assumeRolePolicy: pulumi.all([githubOidc.arn, baseConfig.githubOrg]).apply(([arn, org]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Federated: arn },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `repo:${org}/${baseConfig.clusterName}:ref:refs/heads/${baseConfig.mainBranch}`
          }
        }
      }]
    })
  ),
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ...securityTags.baseTags,
    Integration: "GitHubActions",
    [securityTags.clusterTag(baseConfig.clusterName)]: "shared"
  }
});

// =================
// Core Exports
// =================
export const coreExports = {
  clusterOidcUrl: pulumi.interpolate`https://oidc.${baseConfig.domain}`,
  githubOidcArn: githubOidc.arn,
  irsaRoleARNs: pulumi.output({
    ebsCSI: irsaRoles.ebsCSI.arn,
    clusterAutoscaler: irsaRoles.clusterAutoscaler.arn,
    cloudwatchAgent: irsaRoles.cloudwatchAgent.arn
  }),
  permissionBoundaryArn: permissionBoundary.arn,
  imdsPolicyArn: imdsPolicy.arn,
  githubActionsRoleArn: githubActionsRole.arn,
  managedPolicyARNs: {
    readOnly: managedPolicies.readOnly,
    cloudWatch: managedPolicies.cloudWatch
  },
  accountId: baseConfig.accountId,
  region: baseConfig.region,
  clusterTag: securityTags.clusterTag(baseConfig.clusterName)
};

// =================
// Validations
// =================
pulumi.all([coreExports.clusterOidcUrl, baseConfig.domain]).apply(([oidcUrl, domain]) => {
  if (!oidcUrl.includes(domain)) {
    throw new Error("OIDC domain must match cluster base domain");
  }
});

pulumi.all(Object.values(irsaRoles).map(r => r.arn)).apply(arns => {
  if (new Set(arns).size !== arns.length) {
    throw new Error("Duplicate IRSA role ARNs detected");
  }
});

pulumi.all([permissionBoundary.arn, imdsPolicy.arn]).apply(([pbArn, imdsArn]) => {
  if (!pbArn.includes(baseConfig.clusterName)) {
    throw new Error("Permission boundary name mismatch");
  }
  if (!imdsArn.includes("imds-control")) {
    throw new Error("IMDS policy naming convention violation");
  }
});