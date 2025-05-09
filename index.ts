import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { masterResources } from "./instances/master";
import { workerResources } from "./instances/worker";
import { bastionResources } from "./instances/bastion";
import { imdsPolicy, securityTags, baseConfig, coreExports } from "./shared2"; // Changed import

const config = new pulumi.Config("myproject");



// Updated OIDC Policy using baseConfig
const oidcPolicy = new aws.iam.Policy("oidc-policy", {
  policy: pulumi.all([baseConfig.accountId, coreExports.oidcDomain])
    .apply(([accountId, oidcDomain]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { 
          Federated: coreExports.clusterOidcArn
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            [`${oidcDomain}:sub`]: [
              "system:serviceaccount:kube-system:ebs-csi-controller",
              "system:serviceaccount:default:cluster-autoscaler"
            ]
          }
        }
      }]
    }))
});

// IMDS policy attachment remains unchanged
[masterResources.iamProfile, workerResources.iamProfile, bastionResources.iamProfile]
  .forEach((profile, index) => {
    new aws.iam.RolePolicyAttachment(`${profile.name}-imds`, {
      role: profile.arn,
      policyArn: imdsPolicy.arn
    });
  });

// Updated exports using baseConfig
export const clusterId = baseConfig.clusterName;
export const domain = baseConfig.domain;
export const accountId = baseConfig.accountId;
export const clusterTag = securityTags.clusterTag(clusterId);
export const roleName = pulumi.output(masterResources.iamProfile.role).apply(r => r?.valueOf.name);

// Remaining exports unchanged
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

export const githubActionsConfig = pulumi.all([
  coreExports.githubOidcArn,
  baseConfig.accountId
]).apply(([arn, account]) => ({
  AWS_ROLE_ARN: `arn:aws:iam::${account}:role/GitHubActionsRole`,
  AWS_OIDC_PROVIDER: arn
}));

// Updated OIDC exports
export const oidcRoleArn = coreExports.permissionBoundaryArn;
export const clusterIssuer = pulumi.interpolate`oidc.${baseConfig.domain}`; 
export const githubActionsOidcArn = coreExports.githubOidcArn;
