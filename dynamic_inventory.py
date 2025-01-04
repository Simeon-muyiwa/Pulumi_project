import pulumi
import pulumi_aws as aws
from botocore.exceptions import ClientError
import json

class Ec2Inventory:
    def __init__(self, master_tag, worker_tag, bastion_public_ip):
        self.master_tag = master_tag
        self.worker_tag = worker_tag
        self.bastion_public_ip = bastion_public_ip
        self.common_args = f"-o ProxyCommand='ssh -W %h:%p {self.bastion_public_ip}'"

    def get_inventory(self):
        inventory = {}
        
        try:
            # Get instances using EC2 filter
            paginator = aws.ec2.get_instances(filters=[
                {'name': 'tag:Role', 'values': [self.master_tag, self.worker_tag]}
            ]).paginate('All')
            
            for page in paginator:
                for reservation in page['Reservations']:
                    for instance in reservation['Instances']:
                        if instance['State']['Name'] == "running":
                            hostname = instance['Tags'].get("Name", f"EC2-{instance['InstanceId']}")
                            inventory[hostname] = self._format_instance_data(instance)
        except ClientError as e:
            print(f"Error fetching instances: {e}")

        return inventory

    def _format_instance_data(self, instance):
        return {
            'id': instance['InstanceId'],
            'state': instance['State']['Name'],
            'type': instance['InstanceType'],
            'private_ip': instance['PrivateIpAddress'],
            'ansible_ssh_common_args': self.common_args,
            'security_groups': [sg['GroupId'] for sg in instance.get('SecurityGroups', [])],
        }

def generate_inventory(master_tag, worker_tag, bastion_public_ip):
    # Create an instance of the Ec2Inventory class
    inventory = Ec2Inventory(master_tag, worker_tag, bastion_public_ip)
    
    # Generate initial inventory content
    inventory_content = json.dumps(inventory.get_inventory(), indent=4)
    
    # Generate a unique filename based on the Pulumi stack name
    stack_name = pulumi.get_stack()
    unique_filename = f"{stack_name}_inventory.json"
    
    # Save the inventory content as a Pulumi output
    inventory_output = pulumi.Output.all(unique_filename, inventory_content)
    pulumi.export("inventoryContent", inventory_output)
    
    # Track changes in EC2 instances
    ec2_instances = aws.ec2.get_instances(filters=[
        {'name': 'tag:Role', 'values': [master_tag, worker_tag]}
    ])
    instance_changes = pulumi.All(ec2_instances.id)

    # Function to update inventory when EC2 instances change
    def update_inventory():
        nonlocal inventory_content
        new_inventory = json.dumps(inventory.get_inventory(), indent=4)
        if new_inventory != inventory_content:
            inventory_content = new_inventory
    
    # Trigger updates when EC2 instances change
    instance_changes.add(update_inventory)
    
    # Return the generated inventory content
    return inventory_content

# Example usage: Initialize EC2 inventory and generate the content
inventory_content = generate_inventory(
    master_tag="kubernetes.io/role/master",
    worker_tag="kubernetes.io/role/node",
    bastion_public_ip="your-bastion-ip"
)

# Print the generated inventory (for debugging purposes)
print(inventory_content)

# Now you can use this inventory with Ansible
ansible_command = f"ansible-playbook -i /tmp/{pulumi.get_stack()}_inventory.json playbook.yml"
print(f"Running Ansible command: {ansible_command}")