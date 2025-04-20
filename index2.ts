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
  githubActionsRole
} from "./shared2";

const config = new pulumi.Config("myproject");

// IMDS policy attachment
[masterResources.iamProfile, workerResources.iamProfile, bastionResources.iamProfile]
  .forEach((profile, index) => {
    new aws.iam.RolePolicyAttachment(`${profile.name}-imds`, {
      role: profile.arn,
      policyArn: imdsPolicy.arn
    });
  });

// Exports
export const clusterId = baseConfig.clusterName;
export const domain = baseConfig.domain;
export const accountId = baseConfig.accountId;
export const clusterTag = securityTags.clusterTag(clusterId);
export const roleName = pulumi.output(masterResources.iamProfile.role).apply(r => r?.valueOf.name);

// Infrastructure exports
export const masterPublicIp = masterResources.details.publicIp;
export const masterPrivateIp = masterResources.details.privateIp;
export const workerAsgName = workerResources.autoScalingGroup;
export const bastionIp = bastionResources.details.publicIp;

export const infrastructure = {
  master: masterResources,
  worker: workerResources,
  bastion: bastionResources,
  _tags: securityTags.baseTags
};

// OIDC exports
export const githubActionsConfig = {
  AWS_ROLE_ARN: githubActionsRole.arn,
  AWS_OIDC_PROVIDER: coreExports.githubOidcArn,
  AWS_REGION: baseConfig.region
};

// Consolidated IRSA exports
export const irsaConfig = pulumi.output({
  ebsCSI: irsaRoles.ebsCSI.arn,
  clusterAutoscaler: irsaRoles.clusterAutoscaler.arn,
  externalDNS: irsaRoles.externalDNS?.arn, // Optional role
  // Add any additional IRSA roles here
});

export const oidcRoleArn = irsaRoles.ebsCSI.arn; // Backward compatibility
export const clusterIssuer = pulumi.interpolate`oidc.${baseConfig.domain}`;
export const githubActionsOidcArn = coreExports.githubOidcArn;

// Additional utility exports
export const oidcConfiguration = {
  issuerUrl: pulumi.interpolate`https://oidc.${baseConfig.domain}`,
  arn: coreExports.clusterOidcArn,
  // thumbprint: coreExports.clusterThumbprint
};