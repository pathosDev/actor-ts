/**
 * KubernetesLease + ClusterSingleton — split-brain-safe singleton
 * election by leaning on the K8s API server as the arbitrator.  At
 * most one process across your cluster can hold the lease, therefore
 * at most one process runs the guarded workload — even under network
 * partitions where two cluster-gossip protocols *think* they should
 * both run.
 *
 * **Pattern: pass the lease to ClusterSingleton.start().**  The
 * singleton manager handles the acquire-loop, the onLost-stop, and
 * the release-on-shutdown internally — user code reduces to the
 * actor itself plus a one-line lease config.
 *
 * **In-cluster usage (default — no env vars):**
 *
 *   1. Deploy with a ServiceAccount that has RBAC for
 *      coordination.k8s.io/v1/leases (verbs: get, create, update,
 *      delete) in the target namespace — see the role definition at
 *      the bottom of this file.
 *   2. The lease auto-loads its credentials from the standard
 *      ServiceAccount mount points — no further config needed.
 *
 * **Local development (out-of-cluster):**
 *
 *   K8S_API_URL=https://127.0.0.1:6443 \
 *   K8S_TOKEN=$(kubectl get secret <sa-token> -o jsonpath='{.data.token}' | base64 -d) \
 *   K8S_CA_CERT="$(kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d)" \
 *   K8S_NAMESPACE=default \
 *   bun run examples/coordination/k8s-lease-singleton.ts
 *
 * **Cluster join is required** — ClusterSingleton needs a Cluster
 * extension to drive its leader election.  In a real K8s deploy
 * each pod's seed list is configured via env vars or a discovery
 * mechanism (DNS SRV / K8s API); this example uses InMemoryTransport
 * because it's standalone.
 */
import {
  Actor, ActorSystem, Cluster, ClusterOptions, ClusterSingletonId, InMemoryTransport,
  NodeAddress, Props, StartSingletonOptions,
} from '../../src/index.js';
import { KubernetesLease } from '../../src/coordination/leases/KubernetesLease.js';
import { KubernetesLeaseOptions } from '../../src/coordination/leases/KubernetesLeaseOptions.js';

const NAMESPACE = process.env.K8S_NAMESPACE ?? 'default';
const POD_NAME = process.env.HOSTNAME ?? `local-${process.pid}`;

class CronActor extends Actor<{ kind: 'tick' }> {
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  override async preStart(): Promise<void> {
    console.log(`[${POD_NAME}] CronActor STARTED — I am the elected singleton`);
    this.timer = setInterval(() => this.context.self.tell({ kind: 'tick' }), 2_000);
  }
  override async postStop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    console.log(`[${POD_NAME}] CronActor STOPPED — singleton released or lost`);
  }
  override onReceive(message: { kind: 'tick' }): void {
    if (message.kind === 'tick') {
      this.ticks++;
      console.log(`[${POD_NAME}] tick #${this.ticks}`);
    }
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('app');

  // The cluster is what drives leader election; the lease arbitrates
  // ties under split-brain.  In a real deploy you'd point seeds at
  // the other pods' addresses (resolved via K8s API or DNS SRV).
  const selfAddr = new NodeAddress('app', '127.0.0.1', 30_000);
  const clusterOptions = ClusterOptions.create()
    .withHost(selfAddr.host)
    .withPort(selfAddr.port)
    .withTransport(new InMemoryTransport(selfAddr));
  const cluster = await Cluster.join(system, clusterOptions);

  const leaseOptions = KubernetesLeaseOptions.create()
    .withName('app-cron-singleton')
    .withNamespace(NAMESPACE)
    .withOwner(POD_NAME)
    .withTtlMs(30_000)
    .withRenewalIntervalMs(10_000);
  if (process.env.K8S_API_URL) leaseOptions.withApiServerUrl(process.env.K8S_API_URL);
  if (process.env.K8S_TOKEN) leaseOptions.withAuthToken(process.env.K8S_TOKEN);
  if (process.env.K8S_CA_CERT) leaseOptions.withCaCert(process.env.K8S_CA_CERT);
  const lease = new KubernetesLease(leaseOptions);

  // That's it.  The singleton manager handles every lifecycle
  // concern: acquire on becoming leader, retry on contention, stop
  // child on lease loss, release on graceful shutdown.
  const singletonOptions = StartSingletonOptions.create<{ kind: 'tick' }>()
    .withTypeName('cron')
    .withProps(Props.create(() => new CronActor()))
    .withLease(lease)
    .withAcquireRetryIntervalMs(5_000);
  const handle = system.extension(ClusterSingletonId).start(cluster, singletonOptions);
  void handle;   // we never tell the proxy in this example — the actor
                 // self-ticks via setInterval.
  console.log(`[${POD_NAME}] running guarded workload — stop with Ctrl-C`);

  const shutdown = async (): Promise<void> => {
    console.log(`\n[${POD_NAME}] shutting down`);
    handle.stop();           // releases the lease + stops the manager
    await cluster.leave();
    await system.terminate();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err) => {
  console.error('K8s-lease example failed:', err);
  process.exit(1);
});

/* -----------------------------------------------------------------------
 * Required RBAC (apply once into your target namespace):
 *
 *   apiVersion: rbac.authorization.k8s.io/v1
 *   kind: Role
 *   metadata:
 *     name: actor-ts-lease-holder
 *     namespace: default
 *   rules:
 *     - apiGroups: ["coordination.k8s.io"]
 *       resources: ["leases"]
 *       verbs: ["get", "create", "update", "delete"]
 *   ---
 *   apiVersion: rbac.authorization.k8s.io/v1
 *   kind: RoleBinding
 *   metadata: { name: actor-ts-lease-holder, namespace: default }
 *   roleRef:
 *     apiGroup: rbac.authorization.k8s.io
 *     kind: Role
 *     name: actor-ts-lease-holder
 *   subjects:
 *     - kind: ServiceAccount
 *       name: <your-sa-name>
 *       namespace: default
 * --------------------------------------------------------------------- */
