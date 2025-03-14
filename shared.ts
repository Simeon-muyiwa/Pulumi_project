import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// Phase 1: Declare base configuration values first
const baseConfig = {
  domain: config.require("domain"),
  clusterName: config.require("clusterName"),
  accountId: pulumi.output(aws.getCallerIdentity({})).accountId,
  dnsZoneId: config.require("dnsZoneId"),
  region: aws.getRegionOutput().name,
  
};

// Phase 2: Declare security tags early
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
    ManagedBy: "pulumi"
  }
};

// Phase 3: Declare resources needed in configValues
export const oidcCert = new aws.acm.Certificate("oidc-cert", {
  domainName: pulumi.interpolate`oidc.${baseConfig.domain}`,
  validationMethod: "DNS",
  tags: securityTags.baseTags
});

const kmsKey = new aws.kms.Key("clusterSecretsKey", {
  description: "Encryption key for Kubernetes secrets",
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: ["kms:*"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:PrincipalTag/Environment": securityTags.environmentTag
          }
        }
      }
    ]
  })
});

// Phase 4: Build final configValues with resource ARNs
export const configValues = {
  ...baseConfig,
  kmsKeyArn: kmsKey.arn,
  oidcCertificateArn: oidcCert.arn
};

// Phase 5: Declare remaining resources using configValues
export const permissionBoundary = new aws.iam.Policy("k8sPermissionBoundary", {
  name: pulumi.interpolate`${configValues.clusterName}-boundary`,
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
            [`aws:ResourceTag/${securityTags.clusterTag(configValues.clusterName)}`]: "shared"
          }
        }
      },
      {
        Effect: "Allow",
        Action: ["route53:ChangeResourceRecordSets"],
        Resource: pulumi.interpolate`arn:aws:route53:::hostedzone/${configValues.dnsZoneId}`
      }
    ]
  })
});

export const oidcProvider = new aws.iam.OpenIdConnectProvider("clusterOIDC", {
  clientIdLists: ["sts.amazonaws.com"],
  thumbprintLists: [config.requireSecret("oidcThumbprint")],
  url: pulumi.interpolate`https://oidc.${configValues.domain}`
});

// Phase 6: Maintain existing exports and functions
export const k8sRole = (roleType: "master" | "worker", service: string) => {
  return new aws.iam.Role(`${roleType}-role`, {
    name: pulumi.interpolate`${configValues.clusterName}-${roleType}-role`,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: `${service}.amazonaws.com`
    }),
    permissionsBoundary: permissionBoundary.arn,
    tags: {
      ...securityTags.baseTags,
      Role: roleType
    }
  });
};

export const coreExports = {
  clusterTag: securityTags.clusterTag(configValues.clusterName),
  oidcProviderArn: oidcProvider.arn,
  kmsKeyArn: configValues.kmsKeyArn,
};

export const imdsPolicy = new aws.iam.Policy("imds-control", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny",
      Action: ["ec2:ModifyInstanceMetadataOptions"],
      Resource: "*"
    }]
  })
});

// Validation remains at bottom
pulumi.all([configValues.dnsZoneId]).apply(([zoneId]) => {
  if (!zoneId.startsWith("Z")) {
    throw new Error("DNS Zone ID must start with 'Z'");
  }
});