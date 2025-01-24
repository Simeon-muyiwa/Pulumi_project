import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as path from "path";

import { workerSecurityGroup } from "../network/security_group";
import { privateSubnetWorker } from "../network/vpc_networking";
import { resourceSetup } from "../network/iam_instance";
import * as keyPair from "../network/key_pairs"; 

const config = new pulumi.Config("myproject");

const clusterName = config.get("cluster_name") || "kubeadm-cluster";

const amiId = fs.readFileSync(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8").trim();

const Profile = (await resourceSetup).workerInstanceProfile.arn


// Create a launch template for the worker instances
const workerLaunchTemplate = new aws.ec2.LaunchTemplate("worker-launch-template", {
    imageId:amiId,
    iamInstanceProfile: {
        arn: Profile,
    },
    instanceType: "t3.medium", 
    securityGroupNames: [workerSecurityGroup.name], 
    keyName: keyPair.deployer.keyName,
    networkInterfaces: [{
        subnetId: privateSubnetWorker.id, 
    }],

    tags: {
        Name: "kubernetes-worker",
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        Role: "Worker",
        Environment: "kubernetes", 
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