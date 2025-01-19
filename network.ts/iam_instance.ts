import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from 'fs/promises';

// Define the assume role policy
const masterAssumeRole = new aws.iam.Role("master-role", {
    name: "kubeadm-role",
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

// Asynchronous function to create the IAM policy and other resources
export async function createResources() {
    // Read the contents of the policy file asynchronously
    const policyContent = await fs.readFile("policy.json", "utf-8");

    // Create the IAM policy resource
    const policy = new aws.iam.Policy("my-policy", {
        policy: pulumi.output(policyContent),  // Wrap policy content with pulumi.output
    });

    // Attach policy to the role
    const rolePolicyAttachment = new aws.iam.PolicyAttachment("my-role-policyattachment", {
        policyArn: policy.arn,
        roles: [masterAssumeRole.name],
    });

    // Create the instance profile
    const instanceProfile = new aws.iam.InstanceProfile("my-instance-profile", {
        role: masterAssumeRole.name,
    });

    // Return the instanceProfile so it can be imported
    return instanceProfile;
}

// Export the instanceProfile, since it's a Pulumi resource
export const instanceProfile = createResources().then(profile => profile);