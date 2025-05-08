import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { masterResources } from "./instances/master";
import { workerResources } from "./instances/worker";
import { bastionResources } from "./instances/bastion";
import { 
  imdsPolicy, 
  securityTags, 
  baseConfig, 
  coreExports,
  irsaRoles,
  githubActionsRole,
  permissionBoundary
} from "./shared5";

const config = new pulumi.Config("myproject");

// ======================
// IMDS Policy Enforcement
// ======================
[masterResources.iamProfile, workerResources.iamProfile, bastionResources.iamProfile]
  .forEach((profile, index) => {
    new aws.iam.RolePolicyAttachment(`${baseConfig.clusterName}-imds-${index}`, {
      role: profile.arn,
      policyArn: imdsPolicy.arn
    });
  });

// ==============
// Core Exports
// ==============
export const clusterId = baseConfig.clusterName;
export const domain = baseConfig.domain;
export const accountId = baseConfig.accountId;
export const region = baseConfig.region;
export const clusterTag = securityTags.clusterTag(clusterId);

// ======================
// Infrastructure Outputs
// ======================
// export const infrastructure = {
//   master: {
//     publicIp: masterResources.details.publicIp,
//     privateIp: masterResources.details.privateIp,
//     // roleName: masterResources.iamProfile.role.name,
//     roleName: pulumi.output(masterResources.iamProfile.role).apply(r => r?.valueOf.name)
//   },
//   worker: {
//     asgName: workerResources.autoScalingGroup.name
//   },
//   bastion: {
//     publicIp: bastionResources.details.publicIp
//   }
// };

// Infrastructure exports
export const masterPublicIp = masterResources.details.publicIp;
export const masterPrivateIp = masterResources.details.privateIp;
export const workerAsgName = workerResources.autoScalingGroup;
export const bastionIp = bastionResources.details.publicIp;
export const roleName = pulumi.output(masterResources.iamProfile.role).apply(r => r?.valueOf.name);

export const infrastructure = {
  master: masterResources,
  worker: workerResources,
  bastion: bastionResources,
  _tags: securityTags.baseTags
};

// ====================
// OIDC Configuration
// ====================
export const clusterIssuer = pulumi.interpolate`https://oidc.${baseConfig.domain}`;
export const oidcConfiguration = pulumi.all([coreExports.clusterOidcUrl, coreExports.clusterOidcArn])
  .apply(([url, arn]) => ({
    issuerUrl: url,
    arn: arn,
    thumbprint: config.requireSecret("clusterCaThumbprint")
  }));

// ========================
// GitHub Actions Integration
// ========================
export const githubActionsConfig = pulumi.all([githubActionsRole.arn, coreExports.githubOidcArn])
  .apply(([roleArn, oidcArn]) => ({
    AWS_ROLE_ARN: roleArn,
    AWS_OIDC_PROVIDER: oidcArn,
    AWS_REGION: baseConfig.region
  }));

// ====================
// IRSA Configuration
// ====================
export const irsaConfig = pulumi.all([irsaRoles.ebsCSI.arn, irsaRoles.clusterAutoscaler.arn])
  .apply(([ebsArn, autoscalerArn]) => ({
    ebsCSI: ebsArn,
    clusterAutoscaler: autoscalerArn,
    // Add new IRSA roles here as they're defined in shared2.ts
  }));

// ========================
// Security Exports
// ========================
export const securityConfiguration = {
  permissionBoundaryArn: permissionBoundary.arn,
  imdsPolicyArn: imdsPolicy.arn,
  baseTags: securityTags.baseTags
};

// ========================
// Validation Exports
// ========================
export const validation = {
  oidcReady: coreExports.oidcReady,
  clusterEndpoint: clusterIssuer
};