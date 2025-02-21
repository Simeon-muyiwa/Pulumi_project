import * as pulumi from "@pulumi/pulumi";
import { masterResources } from "./instances/master";
import { workerAsg } from "./instances/worker";
import { bastionResources } from "./instances/bastion";

// Core resource exports
export const master = masterResources.instance;
export const workers = workerAsg;
export const bastion = bastionResources.instance;

// Explicit role tag exports
export const roleTags = pulumi.all([
    master.tags,
    workers.tags
]).apply(([masterTags, workerTags]) => ({
    master: (masterTags as pulumi.Unwrap<typeof master.tags>)?.Role || "master",
    worker: ((workerTags as pulumi.Unwrap<typeof workers.tags>) || [])
        .find(t => t.key === "Role")?.value || "worker"
}));

// Bastion connection details
export const bastionPublicIp = bastion.publicIp;

// ASG details export
export const asgName = workers.name;

// Consolidated outputs
export const outputs = pulumi.all([
    roleTags,
    bastionPublicIp,
    asgName
]).apply(([tags, ip, asg]) => ({
    roleTags: tags,
    bastionPublicIp: ip,
    asgName: asg
}));