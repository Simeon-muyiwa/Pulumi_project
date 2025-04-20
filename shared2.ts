import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// =====================
// Secrets Configuration
// =====================
const githubThumbprint = config.requireSecret("githubOidcThumbprint");
const githubKnownPrint = "1c58a3a8518e8759bf075b76b750d4f2df264fcd";
pulumi.all([githubThumbprint]).apply(([thumb]) => {
  if (thumb !== githubKnownPrint) throw new Error("Invalid GitHub OIDC thumbprint");
});
const clusterThumbprint = config.requireSecret("clusterOidcThumbprint");
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

// ====================
// IRSA Roles Factory
// ====================
const createIRSARole = (serviceName: string, serviceAccount: string, additionalPolicies?: aws.iam.Policy[]) => {
  const role = new aws.iam.Role(`irsa-${serviceName}`, {
    name: pulumi.interpolate`${baseConfig.clusterName}-irsa-${serviceName}`,
    assumeRolePolicy: pulumi.all([clusterOidc.arn, baseConfig.domain])
      .apply(([arn, domain]) => JSON.stringify({
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
      })),
    permissionsBoundary: permissionBoundary.arn,
    tags: {
      ...securityTags.baseTags,
      IRSAComponent: serviceName,
      Cluster: baseConfig.clusterName,
      ServiceAccount: serviceAccount.replace(':', '-')
    }
  });

  // Attach additional policies if provided
  if (additionalPolicies) {
    additionalPolicies.forEach((policy, index) => {
      new aws.iam.RolePolicyAttachment(`irsa-${serviceName}-policy-${index}`, {
        role: role.name,
        policyArn: policy.arn
      });
    });
  }

  return role;
};

// =====================
// IRSA Role Definitions
// =====================
export const irsaRoles = {
  ebsCSI: createIRSARole("ebs-csi", "kube-system:ebs-csi-controller"),
  clusterAutoscaler: createIRSARole("cluster-autoscaler", "kube-system:cluster-autoscaler"),
  externalDNS: createIRSARole("external-dns", "kube-system:external-dns"),
  // Add new IRSA roles here as needed
};

// ======================
// GitHub Actions Role
// ======================
export const githubActionsRole = new aws.iam.Role("GitHubActionsRole", {
  name: pulumi.interpolate`${baseConfig.clusterName}-github-actions`,
  assumeRolePolicy: githubOidc.arn.apply(arn => JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: arn },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:*",
          "token.actions.githubusercontent.com:ref": "refs/heads/${{ github.event.inputs.branch }}"
        }
      }
    }]
  })),
  permissionsBoundary: permissionBoundary.arn,
  tags: {
    ...securityTags.baseTags,
    Purpose: "GitHubActions",
    Cluster: baseConfig.clusterName
  }
});

// ==============
// Core Exports
// ==============
export const coreExports = {
  // Infrastructure
  clusterTag: securityTags.clusterTag(baseConfig.clusterName),
  accountId: baseConfig.accountId,
  region: baseConfig.region,
  
  // OIDC
  githubOidcArn: githubOidc.arn,
  clusterOidcArn: clusterOidc.arn,
  oidcDomain: pulumi.interpolate`oidc.${baseConfig.domain}`,
  
  // Security
  permissionBoundaryArn: permissionBoundary.arn,
  imdsPolicyArn: imdsPolicy.arn,
  
  // Certificates
  clusterCert,
  clusterKey,
  
  // Consolidated IRSA
  irsaConfig: pulumi.output(irsaRoles).apply(roles => ({
    ebsCSI: roles.ebsCSI.arn,
    clusterAutoscaler: roles.clusterAutoscaler.arn,
    externalDNS: roles.externalDNS.arn,
    // Add new exports here
  })),
  
  // Discovery Tags
  irsaRoleTags: {
    Cluster: baseConfig.clusterName,
    ManagedBy: "pulumi",
    IRSAComponent: ""
  },
  
  // GitHub Actions
  githubActionsRoleArn: githubActionsRole.arn
};

// =================
// Validations
// =================
pulumi.all([
  coreExports.oidcDomain,
  coreExports.clusterOidcArn,
  coreExports.irsaConfig
]).apply(([domain, arn, irsaConfig]) => {
  // Validate OIDC configuration
  if (!domain.includes(baseConfig.domain)) {
    throw new Error("OIDC domain must match cluster domain");
  }
  if (!arn.includes("oidc-provider")) {
    throw new Error("Invalid OIDC provider ARN format");
  }
  
  // Validate required IRSA roles
//   const requiredRoles = ["ebsCSI", "clusterAutoscaler"];
//   requiredRoles.forEach(role => {
//     if (!irsaConfig[role]) {
//       throw new Error(`Missing required IRSA role: ${role}`);
//     }
//   });
  
  // Validate GitHub OIDC
  if (!githubOidc.arn.apply(arn => arn.includes("oidc-provider"))) {
    throw new Error("Invalid GitHub OIDC provider ARN");
  }
});