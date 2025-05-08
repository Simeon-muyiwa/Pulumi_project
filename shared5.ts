import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// =====================
// Security Validations
// =====================
const validateThumbprint = (secret: pulumi.Output<string>) => {
  return secret.apply(t => {
    if (!t) throw new Error("Missing required thumbprint");
    return t.replace(/:/g, "").toLowerCase();
  });
};

const githubThumbprint = validateThumbprint(
  config.requireSecret("githubOidcThumbprint")
);

const clusterCaThumbprint = validateThumbprint(
  config.requireSecret("clusterCaThumbprint")
);

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
  oidcProviderUrl: pulumi.interpolate`oidc.${config.require("domain")}`
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

const clusterOidc = clusterCaThumbprint.apply(thumbprint => 
  new aws.iam.OpenIdConnectProvider("cluster", {
    url: pulumi.interpolate`https://${baseConfig.oidcProviderUrl}`,
    clientIdLists: ["sts.amazonaws.com"],
    thumbprintLists: [thumbprint],
    tags: securityTags.baseTags
  })
);

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
    assumeRolePolicy: pulumi.all([clusterOidc.arn, baseConfig.oidcProviderUrl])
      .apply(([arn, providerUrl]) => 
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`${providerUrl}:sub`]: `system:serviceaccount:${serviceAccount}`,
                [`${providerUrl}:aud`]: "sts.amazonaws.com"
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

  policies.forEach((policy, index) => {
    const policyArn = policy instanceof aws.iam.Policy ? policy.arn : policy;
    new aws.iam.RolePolicyAttachment(`${serviceName}-policy-${index}`, {
      role: role.name,
      policyArn: policyArn
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
  assumeRolePolicy: pulumi.all([githubOidc.arn, baseConfig.githubOrg, baseConfig.mainBranch])
    .apply(([arn, org, branch]) => 
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub": 
                `repo:${org}/${baseConfig.clusterName}:ref:refs/heads/${branch}`
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
export const coreExports = pulumi.all([
  clusterOidc.arn,
  githubOidc.arn,
  baseConfig.oidcProviderUrl
]).apply(([clusterArn, githubArn, providerUrl]) => ({
  clusterOidcArn: clusterArn,
  githubOidcArn: githubArn,
  clusterOidcUrl: pulumi.interpolate`https://${providerUrl}`,
  irsaRoleARNs: {
    ebsCSI: irsaRoles.ebsCSI.arn,
    clusterAutoscaler: irsaRoles.clusterAutoscaler.arn,
    cloudwatchAgent: irsaRoles.cloudwatchAgent.arn
  },
  permissionBoundaryArn: permissionBoundary.arn,
  imdsPolicyArn: imdsPolicy.arn,
  githubActionsRoleArn: githubActionsRole.arn,
  accountId: baseConfig.accountId,
  region: baseConfig.region,
  clusterTag: securityTags.clusterTag(baseConfig.clusterName),
  oidcReady: pulumi.output(true)
}));

// =================
// Validations
// =================
pulumi.all([coreExports.clusterOidcUrl, baseConfig.domain]).apply(([oidcUrl, domain]) => {
  if (!oidcUrl.includes(domain)) {
    throw new Error(`OIDC domain mismatch: ${oidcUrl} vs ${domain}`);
  }
});

pulumi.all([clusterCaThumbprint]).apply(([thumbprint]) => {
  if (!thumbprint || thumbprint.length !== 40) {
    throw new Error("Invalid cluster CA thumbprint format");
  }
});