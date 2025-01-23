import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";

const amiId = fs.readFileSync(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8").trim();

import { workerSecurityGroup } from "../network.ts/security_group";
import { privateSubnetWorker } from "../network.ts/vpc_networking";
import { instanceProfiles } from "../network.ts/iam_instance";

const workerInstanceProfile = (await instanceProfiles).workerInstanceProfile.name;
// pulumi config set --secret sshPublicKey "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD3F6tyPEFEzV0LX3X8BsXdMsQz1x2cEikKDEY0aIj41qgxMCP/iteneqXSIFZBp5vizPvaoIR3Um9xK7PGoW8giupGn+EPuxIA4cDM4vzOqOkiMPhz5XK0whEjkVzTo4+S0puvDZuwIsdiW9mxhJc7tgBNL0cYlWSYVkz4G/fslNfRPW5mYAM49f4fhtxPb5ok4Q2Lg9dPKVHO/Bgeu5woMc7RY0p1ej6D4CKFE6lymSDJpW0YHX/wqE9+cfEauh7xZcG0q9t2ta6F6fmX0agvpFy"
const publicKey = config.requireSecret("sshPublicKey");

// Create EC2 Key Pair
const deployer = new aws.ec2.KeyPair("deployer", {
    keyName: "deployer-key",
    publicKey: publicKey,
});

// Create a launch template for the worker instances
const workerLaunchTemplate = new aws.ec2.LaunchTemplate("worker-launch-template", {
    imageId:amiId,
    iamInstanceProfile: {
        arn: workerInstanceProfile,
    },
    instanceType: "t3.medium", // Instance type
    securityGroupNames: [workerSecurityGroup.name], 
    keyName: deployer.keyName,
    networkInterfaces: [{
        subnetId: privateSubnetWorker.id, // Use subnetId here, not Subnet
    }],

    tags: {
        Name: "kubernetes-worker",
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        Role: "Worker",
        Environment: "kubernetes", // Optional environment tag
    },
});

// Create the worker Auto Scaling Group (ASG)
export const workerAsg = new aws.autoscaling.Group("worker-autoscaling-group", {
    minSize: 0,
    maxSize: 10,
    desiredCapacity: 0,
    launchTemplate: {
        id: workerLaunchTemplate.id,  // Reference the launch template
    },
    tags: [
        { key: "Name", value: "worker-autoscaling-group", propagateAtLaunch: true },
        { key: "Environment", value: "kubernetes", propagateAtLaunch: true },
    ],
});

// Create a CloudWatch alarm to scale up the worker ASG when CPU utilization exceeds 80%
const scaleUpAlarm = new aws.cloudwatch.MetricAlarm("scale-up-alarm", {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 80, // Scale up when CPU utilization is > 80%
    alarmDescription: "Scale up when CPU utilization is greater than 80%",
    dimensions: { AutoScalingGroupName: workerAsg.name },
});

// Create a CloudWatch alarm to scale down the worker ASG when CPU utilization drops below 20%
const scaleDownAlarm = new aws.cloudwatch.MetricAlarm("scale-down-alarm", {
    comparisonOperator: "LessThanThreshold",
    evaluationPeriods: 1,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 20, // Scale down when CPU utilization is < 20%
    alarmDescription: "Scale down when CPU utilization is less than 20%",
    dimensions: { AutoScalingGroupName: workerAsg.name },
});