#!/usr/bin/env python3
import json
import os
import time
from typing import Dict, Any, List
import boto3
from botocore.exceptions import ClientError
import subprocess
import hashlib

class CacheManager:
    def __init__(self, cache_ttl=300):
        self.cache_dir = "/tmp/ansible_cache"
        self.cache_file = os.path.join(self.cache_dir, "inventory_cache.json")
        self.cache_ttl = cache_ttl
        self._ensure_cache_dir()

    def _ensure_cache_dir(self):
        os.makedirs(self.cache_dir, exist_ok=True)
        os.chmod(self.cache_dir, 0o700)

    def read_cache(self):
        try:
            if os.path.exists(self.cache_file):
                if time.time() - os.path.getmtime(self.cache_file) < self.cache_ttl:
                    with open(self.cache_file, 'r') as f:
                        return json.load(f)
        except Exception as e:
            print(f"Cache read warning: {e}", file=sys.stderr)
        return None

    def write_cache(self, data):
        try:
            temp_file = self.cache_file + ".tmp"
            with open(temp_file, 'w') as f:
                json.dump(data, f)
            os.replace(temp_file, self.cache_file)
            os.chmod(self.cache_file, 0o600)
        except Exception as e:
            print(f"Cache write warning: {e}", file=sys.stderr)

class Ec2Inventory:
    def __init__(self, master_tag, worker_tag, bastion_public_ip, asg_name):
        self.master_tag = master_tag
        self.worker_tag = worker_tag
        self.bastion_public_ip = bastion_public_ip
        self.asg_name = asg_name
        self.ssh_key_path = os.environ.get('SSH_KEY_PATH', '~/.ssh/deployer_key')
        self.common_args = self._build_ssh_args()
        self.ec2_client = boto3.client('ec2', region_name='eu-west-2')
        self.asg_client = boto3.client('autoscaling', region_name='eu-west-2')
        self.ec2_paginator = self.ec2_client.get_paginator('describe_instances')
        self.cache = CacheManager(cache_ttl=int(os.environ.get('CACHE_TTL', '300')))
        self._verify_bastion_connection()

    def _build_ssh_args(self):
        return (
            f"-o StrictHostKeyChecking=no "
            f"-o UserKnownHostsFile=/dev/null "
            f"-o ProxyCommand='ssh -W %h:%p -i {self.ssh_key_path} ec2-user@{self.bastion_public_ip}'"
        )

    def _verify_bastion_connection(self):
        try:
            subprocess.run(
                ["ssh", "-q", "-i", self.ssh_key_path, 
                 f"ec2-user@{self.bastion_public_ip}", "exit"],
                check=True, 
                timeout=10,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            raise SystemExit(f"Bastion connection failed: {e}")

    def get_inventory(self):
        cached_data = self.cache.read_cache()
        if cached_data and not self._cache_invalid(cached_data):
            return cached_data
        
        fresh_data = self._generate_fresh_inventory()
        self.cache.write_cache(fresh_data)
        return fresh_data

    def _cache_invalid(self, cached_data):
        try:
            asg_update_time = self.asg_client.describe_auto_scaling_groups(
                AutoScalingGroupNames=[self.asg_name]
            )['AutoScalingGroups'][0]['CreatedTime'].timestamp()
            
            cache_time = os.path.getmtime(self.cache.cache_file)
            return asg_update_time > cache_time or any(
                instance['_meta']['launch_time'] > cache_time
                for group in cached_data.values()
                for instance in group.get('hosts', {}).values()
            )
        except Exception as e:
            print(f"Cache validation error: {e}", file=sys.stderr)
            return True

    def _generate_fresh_inventory(self):
        inventory = {
            "k8s_master": {"hosts": [], "vars": {}},
            "k8s_worker": {"hosts": [], "vars": {}},
            "_meta": {"hostvars": {}}
        }
        
        common_vars = {
            "ansible_user": "ec2-user",
            "ansible_ssh_common_args": self.common_args,
            "ansible_ssh_private_key_file": self.ssh_key_path
        }
        
        instances = self._collect_instances()
        
        for instance in instances.values():
            role = self._determine_role(instance['tags'])
            if not role:
                continue
            
            group_key = f"k8s_{role}"
            private_ip = instance['private_ip']
            
            inventory[group_key]["hosts"].append(private_ip)
            inventory[group_key]["vars"] = common_vars
            inventory["_meta"]["hostvars"][private_ip] = instance
            
        return inventory

    def _collect_instances(self):
        instances = {}
        
        # Process ASG instances
        if self.asg_name:
            try:
                asg_instances = self.asg_client.describe_auto_scaling_instances(
                    MaxRecords=100
                )
                for instance in asg_instances['AutoScalingInstances']:
                    if instance['AutoScalingGroupName'] == self.asg_name:
                        self._add_instance(instance['InstanceId'], instances, 'worker')
            except ClientError as e:
                print(f"ASG error: {e}", file=sys.stderr)

        # Process tagged instances
        roles = [
            ('master', self.master_tag),
            ('worker', self.worker_tag)
        ]
        
        for role, tag in roles:
            try:
                paginator = self.ec2_paginator.paginate(
                    Filters=[
                        {'Name': 'tag:Role', 'Values': [tag]},
                        {'Name': 'instance-state-name', 'Values': ['running']}
                    ]
                )
                for page in paginator:
                    for reservation in page['Reservations']:
                        for instance in reservation['Instances']:
                            self._add_instance(instance['InstanceId'], instances, role)
            except ClientError as e:
                print(f"EC2 {role} error: {e}", file=sys.stderr)
                
        return instances

    def _add_instance(self, instance_id, instances, role):
        if instance_id in instances:
            return
            
        instance_data = self._get_instance_details(instance_id)
        if instance_data:
            instances[instance_id] = instance_data

    def _get_instance_details(self, instance_id):
        try:
            response = self.ec2_client.describe_instances(InstanceIds=[instance_id])
            instance = response['Reservations'][0]['Instances'][0]
            return self._format_instance(instance)
        except (ClientError, KeyError) as e:
            print(f"Instance {instance_id} error: {e}", file=sys.stderr)
            return None

    def _format_instance(self, instance):
        tags = {t['Key']: t['Value'] for t in instance.get('Tags', [])}
        return {
            "private_ip": instance.get('PrivateIpAddress', ''),
            "public_ip": instance.get('PublicIpAddress', ''),
            "tags": tags,
            "_meta": {
                "az": instance['Placement']['AvailabilityZone'],
                "launch_time": instance['LaunchTime'].timestamp(),
                "image_id": instance['ImageId'],
                "id": instance['InstanceId']
            }
        }

    def _determine_role(self, tags):
        role = tags.get('Role', '')
        if self.master_tag in role:
            return 'master'
        elif self.worker_tag in role:
            return 'worker'
        return None

def main():
    if len(sys.argv) != 5:
        print("Usage: ./dynamic_inventory.py <master_tag> <worker_tag> <bastion_ip> <asg_name>")
        sys.exit(1)
        
    inventory = Ec2Inventory(
        master_tag=sys.argv[1],
        worker_tag=sys.argv[2],
        bastion_public_ip=sys.argv[3],
        asg_name=sys.argv[4]
    ).get_inventory()
    
    print(json.dumps(inventory, indent=2))

if __name__ == "__main__":
    import sys
    main()
