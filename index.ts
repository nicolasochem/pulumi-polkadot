import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as digitalocean from "@pulumi/digitalocean";
import * as kubernetes from "@pulumi/kubernetes";

import * as docluster from "./cluster/digitalocean";

// Function to fail on non-truthy variable.
const getEnvVariable = (name: string): string => {
  const env = process.env[name];
  if (!env) {
    pulumi.log.error(`${name} environment variable is not set`);
    throw Error;
  }
  return env;
};

// A given name for all resources that may overlap
const projectRandId = getEnvVariable('PROJECT_RAND_ID');

// Define facts for the midl polkadot cluster.
const midlProject = {
    name: `${projectRandomId}-polkadot`,
    description: "Project to confine midl polkadot/ksm resources",
    environment: "Production",
    purpose: "Other",
};

const midlVPC = {
    name: `${projectRandomId}-polkadot-vpc`,
    region: "ams3",
};

const midlKubernetes = {
    name: `${projectRandomId}-polkadot-k8s`,
    version: "1.21.2-do.2",
    region: "ams3",
    nodePool: {
        name: `${projectRandomId}-polkadot-nodes`,
        // size could be found via do url:
        // https://cloud.digitalocean.com/kubernetes/clusters/new?i=xxxx&nodePools=s-4vcpu-8gb:1&clusterVersion=1.21.2-do.2&region=nyc1
        size: "s-4vcpu-8gb",
        nodeCount: 1,
    },
};

// Create polkadot cluster on digitalocean.
const polkadotCluster = new docluster.MIDLCluster(`${projectRandomId}-polkadot-cluster`, {
    project: midlProject,
    vpc: midlVPC,
    k8s: midlKubernetes,
    description: "Cluster on digitalocean to host polkadot/ksm validators."
});

// Deploy helm charts on k8s cluster on DO
// Declarations of validators.
// Get k8s config
const kubecluster = polkadotCluster.doK8s;
const kubeconfig = kubecluster.kubeConfigs[0].rawConfig;
const provider = new kubernetes.Provider("do-k8s", { kubeconfig });

// Polkadot validators
const testValidatorNamespace = new kubernetes.core.v1.Namespace("test-validator-ns", {
    metadata: {
        name: "test-validator-ns",
    }
},{
    provider: provider,
    dependsOn: [provider, kubecluster]
});

const loadBalancer = new kubernetes.core.v1.Service("midl-polkadot-lb", {
    metadata: {
        namespace: testValidatorNamespace.metadata.name,
        name: "midl-polkadot-lb",
        annotations: {
            // we need to create the load balancer to get the ip
            // so we can pass the ip to polkadot node
            // to advertise as its main external ip
            // so it can take ingress connections from the network.
            // But the service won't be created if it's not matched by pods.
            // To break the loop, we ignore service's readiness
            "pulumi.com/skipAwait": "true"
        },
        labels: {
            app: "polkadot-node"
        }
    },
    spec: {
        ports: [ {
            port: 31333,
            protocol: "TCP",
            name: "dot-p2p-port"
        } ],
        selector: {
            app: "polkadot-node"
        },
        type: "LoadBalancer"
    }
},{
    provider: provider,
    dependsOn: [testValidatorNamespace, provider, kubecluster],
});

export let lbIp = loadBalancer.status.loadBalancer.ingress[0].ip;

const midlPolkaValidator01 = new kubernetes.helm.v3.Chart("midl-polkadot-test-validtor", {
    path: "./charts/polkadot/",
    values: {
        "images": {
            "polkadot_node": "parity/polkadot:v0.9.8",
        },
        "polkadot_k8s_images": {
            "polkadot_archive_downloader": "midl/polkadot_archive_downloader",
            "polkadot_node_key_configurator": "midl/polkadot_node_key_configurator",
        },
        "polkadot_archive_url": "https://ksm-rocksdb.polkashots.io/snapshot",
        "chain": "kusama",
        "polkadot_validator_name": "midl-polkadot-test-validtor",
        "p2p_ip": lbIp,
        "p2p_port": 31333
    },
    namespace: testValidatorNamespace.metadata.name,
},{
    provider: provider,
    dependsOn: [testValidatorNamespace, provider, kubecluster],
});
