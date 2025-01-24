import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";


// example set - pulumi config set --secret sshPublicKey "ssh-rsa t2ta6F6fmX0agvpFy"
// Load the SSH public key from configuration
const config = new pulumi.Config();
const publicKey = config.requireSecret("sshPublicKey");

// Create EC2 Key Pair
export const deployer = new aws.ec2.KeyPair("deployer", {
    keyName: "deployer-key",
    publicKey: publicKey,
});