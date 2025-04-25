import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { 
    baseConfig, 
  } from "../shared2";

  export const getAmiId = (role: "master" | "worker"): pulumi.Output<string> => {
    // 1. Try environment variable
    const envVar = `${role.toUpperCase()}_AMI_ID`;
    const envAmiId = process.env[envVar]?.trim();
  
    // 2. Try Packer artifact file
    const fileAmiId = pulumi.output(
      fs.promises.readFile(
        path.join(__dirname, `../../build-artifacts/${role}/kubeadm_ami_id.txt`), 
        "utf8"
      ).then(c => c.trim()).catch(() => undefined)
    );
  
    // 3. Fallback to AWS API lookup (corrected)
    const awsAmi = pulumi.output(aws.ec2.getAmi({
      filters: [{ 
        name: "tag:Name",
        values: [`k8s-${baseConfig.clusterName}-${role}-*`] 
      }],
      owners: ["self"],
      mostRecent: true
    }));
  
    return pulumi.all([envAmiId, fileAmiId, awsAmi])
      .apply(([envId, fileId, awsAmi]) => {
        const amiId = envId || fileId || awsAmi.id;
        if (!amiId) throw new Error(
          `Missing ${role} AMI ID. Check:\n` +
          `1. ${envVar} environment variable\n` +
          `2. Packer artifact file\n` +
          `3. AWS EC2 AMIs with tag Name=k8s-${baseConfig.clusterName}-${role}-*`
        );
        return amiId;
      });
  };