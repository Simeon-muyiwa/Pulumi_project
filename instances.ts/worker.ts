import * as aws from "@pulumi/aws";

import { workerSecurityGroup } from "../network.ts/security_group";
import { privateSubnetWorker } from "../network.ts/vpc_networking";
import { instanceProfiles } from "../network.ts/iam_instance";

const workerInstanceProfile = (await instanceProfiles).workerInstanceProfile.name;


// Create a launch template for the worker instances
const workerLaunchTemplate = new aws.ec2.LaunchTemplate("worker-launch-template", {
    imageId: "ami-12345678", // Replace with your desired AMI ID
    iamInstanceProfile: {
        arn: workerInstanceProfile,
    },
    instanceType: "t3.medium", // Instance type
    securityGroupNames: [workerSecurityGroup.name],  
    networkInterfaces: [{
        subnetId: privateSubnetWorker.id, // Use subnetId here, not Subnet
    }],

    tags: {
        Name: "kubernetes-worker",
        Role: "Worker",
        Environment: "kubernetes", // Optional environment tag
    },
});

// Create the worker Auto Scaling Group (ASG)
const workerAsg = new aws.autoscaling.Group("worker-autoscaling-group", {
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