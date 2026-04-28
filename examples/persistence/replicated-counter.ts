/**
 * Replicated event-sourced counter — demonstrates multi-master
 * writes converging without coordination.
 *
 * Three nodes in one process (via `MultiNodeSpec` for brevity, but
 * any cluster wiring works).  Each node persists a few local
 * increments; events ride DistributedPubSub to the other two
 * replicas; vector clocks let every replica recognise the divergent
 * histories and the canonical sort+fold produces the same final
 * state on each.
 *
 *   bun run examples/persistence/replicated-counter.ts
 *
 * Output (the values may interleave):
 *
 *   [a] persisted: amount=10
 *   [b] persisted: amount=100
 *   [c] persisted: amount=1000
 *   [a] state.value = 1110
 *   [b] state.value = 1110
 *   [c] state.value = 1110
 *   convergence reached: every replica sees value=1110
 */
import { match } from 'ts-pattern';
import {
  Actor,
  Props,
  ReplicatedEventSourcedActor,
  type Cluster,
} from '../../src/index.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';

type Cmd = { kind: 'add'; amount: number };
type Event = { kind: 'added'; amount: number };
interface State { value: number }

class ReplicatedCounter extends ReplicatedEventSourcedActor<Cmd, Event, State> {
  readonly persistenceId = 'counter-1';
  readonly replicaId: string;
  readonly label: string;

  constructor(cluster: Cluster, label: string) {
    super(cluster);
    this.replicaId = cluster.selfAddress.toString();
    this.label = label;
  }

  initialState(): State { return { value: 0 }; }

  onEvent(s: State, e: Event): State {
    return match(e)
      .with({ kind: 'added' }, (a) => ({ value: s.value + a.amount }))
      .exhaustive();
  }

  async onCommand(_s: State, c: Cmd): Promise<void> {
    await match(c)
      .with({ kind: 'add' }, async (cmd) => {
        await this.persist({ kind: 'added', amount: cmd.amount }, () => {
          // eslint-disable-next-line no-console
          console.log(`[${this.label}] persisted: amount=${cmd.amount}`);
        });
      })
      .exhaustive();
  }

  /** Test/example hook to read the local view of the value. */
  getValue(): number { return this.state.value; }

  /** Faster gossip than production default so the example wraps quickly. */
  protected override pubsubGossipIntervalMs(): number { return 80; }
}

async function main(): Promise<void> {
  const spec = new MultiNodeSpec({
    roles: ['a', 'b', 'c'],
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });

  await spec.start();
  await Promise.all([
    spec.awaitMembers('a', 3),
    spec.awaitMembers('b', 3),
    spec.awaitMembers('c', 3),
  ]);

  // Spawn one ReplicatedCounter per role.  They share a persistenceId,
  // so every event any replica writes lands in every other replica's
  // canonical history via PubSub.
  const instances = new Map<string, ReplicatedCounter>();
  for (const role of ['a', 'b', 'c'] as const) {
    const cluster = spec.clusterFor(role);
    const ref = spec.systemFor(role).actorOf(
      Props.create<Cmd>(() => {
        const inst = new ReplicatedCounter(cluster, role);
        instances.set(role, inst);
        return inst as unknown as Actor<Cmd>;
      }),
      `counter-${role}`,
    );
    // Wait for subscriptions to propagate (push-to-random-peer
    // gossip in a 3-node mesh — 2 s is plenty for the example).
    if (role === 'c') await Bun.sleep(2_000);
    void ref;  // keep reference alive
  }

  // Each replica issues one persist; they fan out via PubSub and
  // every replica's state should converge to 10 + 100 + 1000 = 1110.
  for (const role of ['a', 'b', 'c'] as const) {
    const ref = spec.systemFor(role).actorSelection(`/user/counter-${role}`);
    await ref.resolveOne(2_000).then((r) =>
      r.tell({ kind: 'add', amount: role === 'a' ? 10 : role === 'b' ? 100 : 1_000 }),
    );
  }

  // Wait for convergence.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const all = ['a', 'b', 'c'].map((r) => instances.get(r)!.getValue());
    if (all.every((v) => v === 1_110)) break;
    await Bun.sleep(50);
  }

  for (const role of ['a', 'b', 'c'] as const) {
    // eslint-disable-next-line no-console
    console.log(`[${role}] state.value = ${instances.get(role)!.getValue()}`);
  }

  const allConverged = ['a', 'b', 'c'].every((r) => instances.get(r)!.getValue() === 1_110);
  // eslint-disable-next-line no-console
  console.log(allConverged
    ? 'convergence reached: every replica sees value=1110'
    : 'WARNING: replicas did not converge — re-run or increase the wait');

  await spec.stop();
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('replicated-counter example failed:', err);
  process.exit(1);
});
