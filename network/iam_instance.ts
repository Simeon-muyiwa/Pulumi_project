import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from 'fs/promises';

// Define the assume role policy
const masterAssumeRole = new aws.iam.Role("master-role", {
    name: "master-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: "ec2.amazonaws.com"
            },
            Action: "sts:AssumeRole"
        }]
    }),
});

const workerAssumeRole = new aws.iam.Role("worker-role", {
    name: "worker-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: "ec2.amazonaws.com"
            },
            Action: "sts:AssumeRole"
        }]
    }),
});

const bastionHostAssumeRole = new aws.iam.Role("bastion-host-role", {
    name: "bastion-host-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: "ec2.amazonaws.com"
            },
            Action: "sts:AssumeRole"
        }]
    }),
});

// Asynchronous function to create the IAM policy and attach it to the corresponding role
async function createResources() {
    // Read the contents of the policy file asynchronously
    const policyContent = await fs.readFile("policy.json", "utf-8");
    const policies = JSON.parse(policyContent);

    // Create the IAM policies for master, worker, and bastion host
    const masterPolicy = new aws.iam.Policy("master-policy", {
        name: "master-policy",
        policy: pulumi.output(JSON.stringify(policies.masterPolicy)),
    });

    const workerPolicy = new aws.iam.Policy("worker-policy", {
        name: "worker-policy",
        policy: pulumi.output(JSON.stringify(policies.workerPolicy)),
    });

    const bastionHostPolicy = new aws.iam.Policy("bastion-policy", {
        name: "bastion-policy",
        policy: pulumi.output(JSON.stringify(policies.bastionHostPolicy)),
    });

    // Attach the respective policies to the roles
    const masterRolePolicyAttachment = new aws.iam.RolePolicyAttachment("master-role-policyattachment", {
        role: masterAssumeRole.name,
        policyArn: masterPolicy.arn,
    });

    const workerRolePolicyAttachment = new aws.iam.RolePolicyAttachment("worker-role-policyattachment", {
        role: workerAssumeRole.name,
        policyArn: workerPolicy.arn,
    });

    const bastionHostRolePolicyAttachment = new aws.iam.RolePolicyAttachment("bastion-role-policyattachment", {
        role: bastionHostAssumeRole.name,
        policyArn: bastionHostPolicy.arn,
    });

    // Create instance profiles for each role
    const masterInstanceProfile = new aws.iam.InstanceProfile("master-instance-profile", {
        role: masterAssumeRole.name,
    });

    const workerInstanceProfile = new aws.iam.InstanceProfile("worker-instance-profile", {
        role: workerAssumeRole.name,
    });

    const bastionHostInstanceProfile = new aws.iam.InstanceProfile("bastion-instance-profile", {
        role: bastionHostAssumeRole.name,
    });

    // Return the instance profiles so they can be exported
    return {
        masterInstanceProfile,
        workerInstanceProfile,
        bastionHostInstanceProfile
    };
}

// Call the async function and export the instance profiles
export const resourceSetup = createResources();