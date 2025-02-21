import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { securityGroupIds } from "../network/security_group";
import { networkOutputs } from "../network/vpc_networking";
import { resourceSetup } from "../network/iam_instance";
import * as keyPair from "../network/key_pairs";

const config = new pulumi.Config("myproject");
const clusterName = config.require("cluster_name");

// Interface for worker configuration
interface WorkerResourceConfig {
    amiId: pulumi.Output<string>;
    instanceType: string;
    profileArn: pulumi.Output<string>;
    securityGroupId: pulumi.Output<string>;
    keyName: string;
    subnetIds: pulumi.Output<string>[];
}

// Get AMI ID from file
function getAmiId(): pulumi.Output<string> {
    return pulumi.output(fs.promises.readFile(path.join(__dirname, "kubeadm_ami_id.txt"), "utf8"))
        .apply(amiId => amiId.trim());
}

// Get worker instance profile
const workerProfile = pulumi.output(resourceSetup).apply(res => res.workerInstanceProfile.arn);

// Create launch template with explicit type assertions
const workerLaunchTemplate = new aws.ec2.LaunchTemplate("worker-launch-template", {
    imageId: getAmiId(),
    instanceType: "t3.medium" as const, // Explicit type assertion
    keyName: keyPair.deployer.keyName,
    vpcSecurityGroupIds: [securityGroupIds.worker],
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: pulumi.interpolate`${clusterName}-worker`,
            [`kubernetes.io/cluster/${clusterName}`]: "shared",
            Role: "Worker",
            Environment: "production",
        },
    }],
    iamInstanceProfile: {
        arn: workerProfile,
    },
});

// Create Auto Scaling Group with type-safe tags
export const workerAsg = new aws.autoscaling.Group("worker-autoscaling-group", {
    minSize: 2,
    maxSize: 10,
    desiredCapacity: 2,
    launchTemplate: {
        id: workerLaunchTemplate.id,
        version: "$Latest",
    },
    vpcZoneIdentifiers: networkOutputs.privateSubnetIds,
    tags: [
        {
            key: "Name",
            value: pulumi.interpolate`${clusterName}-worker`,
            propagateAtLaunch: true,
        },
        {
            key: `kubernetes.io/cluster/${clusterName}`,
            value: "owned",
            propagateAtLaunch: true,
        },
    ],
});

// CloudWatch Alarms with proper ARN handling
const scaleUpAlarm = new aws.cloudwatch.MetricAlarm("scale-up-alarm", {
    alarmActions: workerAsg.arn.apply(arn => [`${arn}/scale-up`]),
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 2,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 300,
    statistic: "Average",
    threshold: 70,
    dimensions: { AutoScalingGroupName: workerAsg.name },
});

const scaleDownAlarm = new aws.cloudwatch.MetricAlarm("scale-down-alarm", {
    alarmActions: workerAsg.arn.apply(arn => [`${arn}/scale-down`]),
    comparisonOperator: "LessThanThreshold",
    evaluationPeriods: 2,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 300,
    statistic: "Average",
    threshold: 30,
    dimensions: { AutoScalingGroupName: workerAsg.name },
});

// Exports with type-safe instance type
export const workerResources = {
    launchTemplate: workerLaunchTemplate,
    autoScalingGroup: workerAsg,
    scalingAlarms: {
        scaleUp: scaleUpAlarm,
        scaleDown: scaleDownAlarm,
    },
};

// Explicit type assertion for instance type
export const workerInstanceType = pulumi.output(workerLaunchTemplate.instanceType).apply(v => v as string);