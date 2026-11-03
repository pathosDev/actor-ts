/**
 * What a DistributedData subscriber costs a read queued behind a burst of
 * changes (#1468).
 *
 * Every actor runs on the one thread, the replicator included, so work that
 * runs between a burst of changes and the answer to a read told after it is
 * time the read waits — whether that work runs inside the replicator's turn
 * or on another actor's.  The documentation quotes what that came to in
 * milliseconds, with 10 ms of work per change.  These cases pin the counts
 * those milliseconds come from, because a count does not move with the
 * machine: how much of the work had run by the time the caller of the read
 * got its answer, how much ran in all, and on which value.
 *
 *  - A listener that does the work runs it inside the merge, once per change.
 *  - A listener that only re-arms a trailing timer — a debounce — still runs
 *    once per change, but none of the work has run when the read is answered,
 *    and it runs once, on the final value.
 *  - A listener that tells an actor each change takes the work out of the
 *    merge but not off the thread: the actor is told once per change, and its
 *    turns run between the replicator's own, so the read waits for that work.
 *  - An actor subscribed with `subscribe(key, ref)` is told the latest value,
 *    once per hand-over, so the same burst costs it two units of work at most
 *    — not none, since its turns share the thread too.
 *
 * Single node on `InMemoryTransport`, as the other suites in this directory
 * run it.  The read is `getAsync(key, { consistency: 'local' })`, answered on
 * the replicator's turn after every update told before it, and the count is
 * taken in its continuation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { NoopLogger } from '../../../src/Logger.js';
import { DistributedDataChanged, DistributedDataId, GCounter } from '../../../src/crdt/index.js';
// Not re-exported by any entry point yet (#1307); the helpers below only need its type.
import type { DistributedDataHandle } from '../../../src/crdt/DistributedData.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/* ============================== fixtures ================================ */

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

type Node = { readonly system: ActorSystem; readonly data: DistributedDataHandle };

async function startNode(name: string, port: number): Promise<Node> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { system, data: system.extension(DistributedDataId).start(cluster) };
}

const KEY = 'hits';
/** The burst the documentation measured: twenty changes, more than one replicator turn takes. */
const BURST = 20;
const EVERY_VALUE = Array.from({ length: BURST }, (_, index) => index + 1);

/**
 * Tell the replicator the burst and then the read, and return how many units
 * of work had run when the read's caller got the answer.  `worked` holds the
 * value each unit ran on, in the order they ran.
 */
async function burstThenRead(data: DistributedDataHandle, worked: readonly number[]): Promise<number> {
  for (let change = 1; change <= BURST; change++) {
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
  }
  await data.getAsync(KEY, { consistency: 'local' });
  return worked.length;
}

/** Does one unit of work per message it is handed: a value told to it, or a change it subscribed to. */
class Worker extends Actor<number | DistributedDataChanged<GCounter>> {
  constructor(
    private readonly worked: number[],
    private readonly started: () => void,
  ) { super(); }

  override preStart(): void {
    this.started();
  }

  override onReceive(message: number | DistributedDataChanged<GCounter>): void {
    this.worked.push(typeof message === 'number' ? message : message.value.value());
  }
}

/**
 * Spawn a {@link Worker} and wait until it has started: a start still in
 * flight when the burst lands is turns of its own in between the
 * replicator's, which is not the steady state the documentation measured.
 */
async function startedWorker(system: ActorSystem, worked: number[]): Promise<ActorRef<number | DistributedDataChanged<GCounter>>> {
  let started = false;
  const worker = system.spawn(() => new Worker(worked, () => { started = true; }), 'worker');
  await awaitCondition(() => started, { label: 'the worker started' });
  return worker;
}

/* ================================ cases ================================= */

describe('a read queued behind twenty changes', () => {
  test('waits for all of the work a listener does itself: it runs inside the merge, once per change', async () => {
    const { data } = await startNode('ddata-cost-a', 49_101);
    const worked: number[] = [];
    // What the replica held each time the listener ran.
    const heldAtCall: number[] = [];
    data.subscribe<GCounter>(KEY, (counter) => {
      heldAtCall.push(data.get<GCounter>(KEY)!.value());
      worked.push(counter.value());
    });

    const workedWhenAnswered = await burstThenRead(data, worked);

    expect(workedWhenAnswered).toBe(BURST);
    expect(worked).toEqual(EVERY_VALUE);
    // Inside each merge, before the next: the replica held exactly the value
    // the listener was handed, every time.
    expect(heldAtCall).toEqual(EVERY_VALUE);
  });

  test('waits for none of it when the listener only re-arms a trailing timer, and the work runs once, on the final value', async () => {
    // The timer is the case's own, fired by hand once the read is answered:
    // a clock-driven one would have the case wait on wall time, and could
    // fire inside the burst on a loaded machine.
    const { data } = await startNode('ddata-cost-b', 49_111);
    const worked: number[] = [];
    let listenerCalls = 0;
    let armed: GCounter | null = null;
    const fireTimer = (): void => {
      if (armed === null) return;
      worked.push(armed.value());
      armed = null;
    };
    data.subscribe<GCounter>(KEY, (counter) => {
      listenerCalls++;
      armed = counter;
    });

    const workedWhenAnswered = await burstThenRead(data, worked);

    // Still called once per change — only the work moved.
    expect(listenerCalls).toBe(BURST);
    expect(workedWhenAnswered).toBe(0);
    fireTimer();
    expect(worked).toEqual([BURST]);
  });

  test('still waits for the work when the listener tells an actor each change: it is told once per change, between the replicator\'s turns', async () => {
    const { system, data } = await startNode('ddata-cost-c', 49_121);
    const worked: number[] = [];
    const worker = await startedWorker(system, worked);
    // How much the actor had done each time the replicator ran the listener.
    const workedAtMerge: number[] = [];
    data.subscribe<GCounter>(KEY, (counter) => {
      workedAtMerge.push(worked.length);
      worker.tell(counter.value());
    });

    const workedWhenAnswered = await burstThenRead(data, worked);

    // The burst took more than one replicator turn, and the actor worked in
    // between: when the last change was merged, the replicator had already
    // waited for the work on the changes before it.  The read came after that.
    expect(workedAtMerge.at(-1)).toBeGreaterThan(0);
    expect(workedWhenAnswered).toBeGreaterThanOrEqual(workedAtMerge.at(-1)!);
    // Far more than an actor subscribed to the key does for the same burst.
    expect(workedWhenAnswered).toBeGreaterThan(2);
    await awaitCondition(() => worked.length === BURST, { label: 'the actor worked off every change' });
    expect(worked).toEqual(EVERY_VALUE);
  });

  test('waits for at most two units of work from an actor subscribed to the key: told the latest value, not every one', async () => {
    const { system, data } = await startNode('ddata-cost-d', 49_131);
    const worked: number[] = [];
    const worker = await startedWorker(system, worked);
    data.subscribe<GCounter>(KEY, worker);
    // The subscription is handled before the burst: it was told first.
    await data.getAsync(KEY, { consistency: 'local' });

    const workedWhenAnswered = await burstThenRead(data, worked);

    // Not free — its turns share the thread — but bounded by the hand-overs.
    expect(workedWhenAnswered).toBeGreaterThanOrEqual(1);
    expect(workedWhenAnswered).toBeLessThanOrEqual(2);
    await awaitCondition(() => worked.at(-1) === BURST, { label: 'the actor was told the final value' });
    expect(worked.length).toBeLessThanOrEqual(2);
    // Each unit ran on the latest value as of its hand-over.
    expect(worked).toEqual([...new Set(worked)].sort((a, b) => a - b));
  });
});
