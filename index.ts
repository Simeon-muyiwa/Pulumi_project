import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { masterResources } from "./instances/master";
import { workerResources } from "./instances/worker";
import { bastionResources } from "./instances/bastion";
import { imdsPolicy, securityTags, configValues } from "./shared";


const config = new pulumi.Config("myproject");


// Core Security Policies (now using shared IMDS policy)
const oidcPolicy = new aws.iam.Policy("oidc-policy", {
  policy: pulumi.all([configValues.accountId, config.require("cluster_issuer")])
    .apply(([accountId, issuer]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { 
          Federated: pulumi.interpolate`arn:aws:iam::${accountId}:oidc-provider/${issuer}`
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            [`${issuer}:sub`]: [
              "system:serviceaccount:kube-system:ebs-csi-controller",
              "system:serviceaccount:default:cluster-autoscaler"
            ]
          }
        }
      }]
    }))
});

// Apply shared IMDS policy to all profiles
[masterResources.iamProfile, workerResources.iamProfile, bastionResources.iamProfile]
  .forEach((profile, index) => {
    new aws.iam.RolePolicyAttachment(`${profile.name}-imds`, {
      role: profile.arn,
      policyArn: imdsPolicy.arn
    });
  });

// GitHub Action-aligned Exports
export const clusterId = configValues.clusterName;
export const domain = config.require("domain");
export const accountId = configValues.accountId;
export const clusterTag = securityTags.clusterTag(clusterId);
export const roleName = pulumi.output(masterResources.iamProfile.role).apply(r => r?.valueOf.name);

// Infrastructure Exports
export const masterPublicIp = masterResources.details.publicIp;
export const masterPrivateIp = masterResources.details.privateIp;
export const workerAsgName = workerResources.autoScalingGroup
export const bastionIp = bastionResources.details.publicIp;

// Structured Exports (preserved for internal use)
export const infrastructure = {
  master: masterResources,
  worker: workerResources,
  bastion: bastionResources
};

// OIDC Exports for Ansible
export const oidcRoleArn = oidcPolicy.arn;
export const clusterIssuer = config.require("cluster_issuer");
