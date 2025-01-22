
import { masterInstance } from "./master";
import { workerAsg } from "./worker";
import { bastionHost } from "./bastion";



async function main() {
    const master = await masterInstance("Master");
    const worker = workerAsg
    const bastion = bastionHost

   
    // Return all instances for use in other parts of your Pulumi program
    return { master, worker, bastion };
}

export const instances = main();