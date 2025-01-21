import json
from typing import Dict, Any
import boto3
from botocore.exceptions import ClientError

class Ec2Inventory:
    def __init__(self, master_tag, worker_tag, bastion_public_ip):
        self.master_tag = master_tag
        self.worker_tag = worker_tag
        self.bastion_public_ip = bastion_public_ip
        self.common_args = f"-o ProxyCommand='ssh -W %h:%p {self.bastion_public_ip}'"
        self.ec2_client = boto3.client('ec2', region_name='us-west-2')  # Adjust region if needed
        self.asg_client = boto3.client('autoscaling', region_name='us-west-2')

    def get_inventory(self) -> Dict[str, Dict[str, Any]]:
        inventory = {}

        try:
            # Get instances from the Auto Scaling Group using worker_tag
            asg_response = self.asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=["workerAutoScalingGroup"])
            asg = asg_response['AutoScalingGroups'][0]  # Assuming only one Auto Scaling Group
            
            # Process each instance in the Auto Scaling Group
            for instance in asg['Instances']:
                if instance['LifecycleState'] == "InService":
                    instance_id = instance['InstanceId']
                    instance_data = self._get_instance_data(instance_id)
                    if instance_data:
                        inventory[instance_data['hostname']] = instance_data

        except ClientError as e:
            print(f"Error fetching Auto Scaling Group instances: {e}")

        try:
            # Get master instances using EC2 filter
            master_instances = self.ec2_client.describe_instances(
                Filters=[
                    {'Name': 'tag:Role', 'Values': [self.master_tag]},
                    {'Name': 'instance-state-name', 'Values': ['running']}
                ]
            )

            # Process each master instance
            for reservation in master_instances['Reservations']:
                for instance in reservation['Instances']:
                    hostname = self._get_instance_hostname(instance)
                    inventory[hostname] = self._format_instance_data(instance)

        except ClientError as e:
            print(f"Error fetching master instances: {e}")

        return inventory

    def _get_instance_data(self, instance_id: str) -> Dict[str, Any]:
        """Helper function to retrieve instance data for both worker and master instances."""
        try:
            response = self.ec2_client.describe_instances(InstanceIds=[instance_id])
            instance = response['Reservations'][0]['Instances'][0]
            return self._format_instance_data(instance)
        except ClientError as e:
            print(f"Error fetching instance data for {instance_id}: {e}")
            return None

    def _format_instance_data(self, instance) -> Dict[str, Any]:
        """Formats instance data to be added to the inventory."""
        return {
            'id': instance['InstanceId'],
            'state': instance['State']['Name'],
            'type': instance['InstanceType'],
            'private_ip': instance.get('PrivateIpAddress', ''),
            'public_ip': instance.get('PublicIpAddress', ''),
            'ansible_ssh_common_args': self.common_args,
        }

    def _get_instance_hostname(self, instance) -> str:
        """Helper function to retrieve the hostname of the instance based on its tags."""
        name_tag = next((tag['Value'] for tag in instance['Tags'] if tag['Key'] == 'Name'), None)
        return name_tag if name_tag else f"Instance-{instance['InstanceId']}"

def generate_inventory(master_tag, worker_tag, bastion_public_ip):
    inventory = Ec2Inventory(master_tag, worker_tag, bastion_public_ip)
    
    inventory_content = json.dumps(inventory.get_inventory(), indent=4)

    return inventory_content
