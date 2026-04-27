/**
 * KubernetesLease — split-brain-safe singleton election by leaning on
 * the K8s API server as the arbitrator.  At most one process across
 * your cluster can hold the lease, therefore at most one process runs
 * the guarded workload — even under network partitions where two
 * cluster-gossip protocols *think* they should both run.
 *
 * Pattern shown here: **manual acquire-and-guard.**  The process
 * blocks on `lease.acquire()`, starts a "cron" actor only on success,
 * stops the cron actor on `onLost(reason)`, retries acquire on a
 * loop.  This is the same pattern Akka's `ClusterSingleton` uses
 * internally with a `LeaseUsage` config — we just spell it out here
 * so the integration is visible.
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
 */
import { Actor, ActorSystem, Props } from '../../src/index.js';
import { KubernetesLease } from '../../src/coordination/leases/KubernetesLease.js';
import type { ActorRef } from '../../src/index.js';

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
  override onReceive(msg: { kind: 'tick' }): void {
    if (msg.kind === 'tick') {
      this.ticks++;
      console.log(`[${POD_NAME}] tick #${this.ticks}`);
    }
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('app');

  const lease = new KubernetesLease({
    name: 'app-cron-singleton',
    namespace: NAMESPACE,
    owner: POD_NAME,
    ttlMs: 30_000,
    renewalIntervalMs: 10_000,
    acquireRetries: 1,                  // we drive retries ourselves below
    apiServerUrl: process.env.K8S_API_URL,
    authToken: process.env.K8S_TOKEN,
    caCert: process.env.K8S_CA_CERT,
  });

  let cronRef: ActorRef<{ kind: 'tick' }> | null = null;

  // Bind onLost first so a renewal failure during start gets caught.
  lease.onLost((reason) => {
    console.log(`[${POD_NAME}] LOST lease: ${reason}`);
    if (cronRef) {
      cronRef.stop();
      cronRef = null;
    }
    // Re-enter the acquire loop so the process can pick up again
    // after the previous holder finally releases (or its renew expires).
    void runAcquireLoop();
  });

  async function runAcquireLoop(): Promise<void> {
    while (true) {
      const got = await lease.acquire();
      if (got) {
        cronRef = system.actorOf(Props.create(() => new CronActor()), 'cron');
        return;
      }
      console.log(`[${POD_NAME}] another holder owns the lease — backing off 5 s`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  await runAcquireLoop();
  console.log(`[${POD_NAME}] running guarded workload — stop with Ctrl-C`);

  const shutdown = async (): Promise<void> => {
    console.log(`\n[${POD_NAME}] shutting down — releasing lease`);
    if (cronRef) cronRef.stop();
    await lease.release();
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
