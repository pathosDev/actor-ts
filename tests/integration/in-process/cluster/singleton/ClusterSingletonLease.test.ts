/**
 * ClusterSingleton + Lease integration tests (#38).
 *
 * Five scenarios cover the state machine:
 *
 *   1. acquire-success → child spawned.
 *   2. acquire-fail (other holder) → no child; eventual retry succeeds
 *      after the holder releases.
 *   3. lease lost mid-flight → child stopped, manager re-attempts.
 *   4. graceful leader-loss → child stopped + lease released.
 *   5. no lease (regression guard) → behaves like the v1 sync path.
 *
 * All scenarios run on a single-node cluster — the lease state machine
 * is intra-manager; the cluster only triggers reconciles via leader/role
 * events, no MultiNodeSpec needed.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { StartSingletonOptions } from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../../src/coordination/LeaseOptions.js';
import type { Lease } from '../../../../../src/coordination/Lease.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 25,
  label = 'the awaited singleton-lease state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

/**
 * A lease whose `acquire()` stays pending until the test lets it through.
 *
 * The point is to hold the "elected host, no instance yet" window open for as
 * long as an assertion needs, instead of guessing at how long a real backend
 * takes and hoping the sends land inside it.  `acquiring` is what makes the
 * window observable from the test rather than inferred from a delay.
 */
class GatedLease implements Lease {
  private letThrough: (() => void) | null = null;
  private held = false;

  acquire(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.letThrough = () => { this.held = true; resolve(true); };
    });
  }

  async release(): Promise<void> { this.held = false; }
  checkAlive(): boolean { return this.held; }
  onLost(): () => void { return () => { /* never lost in this fixture */ }; }

  /** Whether an `acquire()` is currently blocked, waiting to be granted. */
  get acquiring(): boolean { return this.letThrough !== null; }

  /** Let the pending `acquire()` succeed. */
  grant(): void {
    const go = this.letThrough;
    this.letThrough = null;
    go?.();
  }
}

type NodeSetup = { kit: TestKit; cluster: Cluster };

async function startNode(
  systemName: string, host: string, port: number,
): Promise<NodeSetup> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { kit, cluster };
}

async function stop(node: NodeSetup): Promise<void> {
  await node.cluster.leave();
  await node.kit.system.terminate();
}

describe('ClusterSingleton + Lease', () => {
  test('1. acquire success → child is spawned', async () => {
    inMemoryLeaseStore._clear();
    const nodeA = await startNode('sng-lease-1', 'h', 60_001);
    const probe = nodeA.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-1').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withLease(lease);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);
    await waitFor(() => nodeA.cluster.leader().nonEmpty);
    // Child preStart fires once acquire resolves — give the mailbox
    // a few ticks for the acquire-result event.
    await probe.expectMessage('started', 1_000);

    singletonRef.tell('hi');
    expect(await probe.expectMessage('got:hi', 500)).toBe('got:hi');

    nodeA.cluster.singleton.stop('echo');
    await stop(nodeA);
  }, 10_000);

  test('2. acquire blocked by another holder → spawn delayed; spawns once holder releases', async () => {
    inMemoryLeaseStore._clear();
    // Simulate an external holder by acquiring the same lease name from
    // a different owner first.
    const otherHolderOptions = LeaseOptions.create().withName('sng-lease-2').withOwner('someone-else').withTtlMs(5_000);
    const otherHolder = new InMemoryLease(otherHolderOptions);
    expect(await otherHolder.acquire()).toBe(true);

    const nodeA = await startNode('sng-lease-2', 'h', 60_002);
    const probe = nodeA.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-2').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withLease(lease)
      .withAcquireRetryIntervalMs(100);   // tighter so the test isn't slow
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);
    await waitFor(() => nodeA.cluster.leader().nonEmpty);

    // Other holder still owns it — manager should be in retry loop, no
    // child spawned yet.
    await probe.expectNoMessage(150);

    // Release the foreign lease.  Within ~100 ms the manager's retry
    // tick fires, sees the lease available, acquires, spawns.
    await otherHolder.release();
    await probe.expectMessage('started', 1_000);

    nodeA.cluster.singleton.stop('echo');
    await stop(nodeA);
  }, 10_000);

  test('3. lease lost mid-flight → child is stopped, manager re-attempts', async () => {
    inMemoryLeaseStore._clear();
    const nodeA = await startNode('sng-lease-3', 'h', 60_003);
    const probe = nodeA.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override postStop(): void { probe.tell('stopped'); }
      override onReceive(): void {}
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-3').withOwner('a').withTtlMs(5_000)
      // Tight renewal so the simulated "lost" path fires fast.
      .withRenewalIntervalMs(60);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withLease(lease)
      .withAcquireRetryIntervalMs(100);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);
    await probe.expectMessage('started', 1_000);

    // Force a lost-lease scenario: another owner takes over from under us.
    // This makes the next renewal in the InMemoryLease fail, which fires
    // the onLost handler the manager subscribed to.
    inMemoryLeaseStore._clear();
    const usurperOptions = LeaseOptions.create().withName('sng-lease-3').withOwner('usurper').withTtlMs(5_000);
    const usurper = new InMemoryLease(usurperOptions);
    expect(await usurper.acquire()).toBe(true);

    // The manager's renewal-failure path fires onLost → stops child.
    await probe.expectMessage('stopped', 2_000);

    // The manager schedules a fresh acquire; while the usurper still
    // holds the lease, that acquire returns false and the manager
    // stays passive.  We don't need to wait for that retry to expire
    // — the test is happy that the child stopped.

    await usurper.release();
    nodeA.cluster.singleton.stop('echo');
    await stop(nodeA);
  }, 10_000);

  test('4. graceful manager stop releases the lease', async () => {
    inMemoryLeaseStore._clear();
    const nodeA = await startNode('sng-lease-4', 'h', 60_004);
    const probe = nodeA.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-4').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withLease(lease);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);
    await probe.expectMessage('started', 1_000);
    expect(lease.checkAlive()).toBe(true);

    nodeA.cluster.singleton.stop('echo');
    // Manager.postStop releases the lease; allow a tick for the async
    // release to settle.
    await waitFor(() => !lease.checkAlive(), 2_000);
    expect(lease.checkAlive()).toBe(false);

    await stop(nodeA);
  }, 10_000);

  test('5. no lease provided — sync v1 behaviour preserved', async () => {
    // Regression guard for the no-lease path.  Same shape as the existing
    // ClusterSingleton.test.ts case but with an explicit assertion that
    // the sync spawn happens BEFORE we tell the proxy.
    const nodeA = await startNode('sng-lease-5', 'h', 60_005);
    const probe = nodeA.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }
    // no lease!
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);
    await waitFor(() => nodeA.cluster.leader().nonEmpty);
    // No lease → child should be spawned synchronously the moment
    // SelfUp/LeaderChanged fires.  In single-node clusters that
    // happens during cluster.join.
    await probe.expectMessage('started', 500);

    singletonRef.tell('hi');
    expect(await probe.expectMessage('got:hi', 500)).toBe('got:hi');

    nodeA.cluster.singleton.stop('echo');
    await stop(nodeA);
  }, 10_000);

  test('6. messages routed while the acquire is in flight are held, not dead-lettered', async () => {
    // #637's *"zero dropped messages"* clause, in the one window where it can
    // be reproduced without racing gossip.
    //
    // The manager is the elected host, so every proxy routes here — and it has
    // no child, because `lease.acquire()` has not resolved yet.  #949's
    // hand-over buffer does not cover this: it holds messages only while a
    // hand-over *this node started* is outstanding, and the acquire happens
    // before that.  So every message sent across the acquire went to dead
    // letters, and the acquire is a round trip to a coordination backend —
    // Kubernetes, etcd, Redis — not a microsecond.
    //
    // A gated lease rather than a slow one: the window is opened and closed by
    // the test, so the measurement does not depend on a timing guess and the
    // assertion cannot pass by being early.  The same hole is reachable through
    // gossip lag on the no-lease path — a joining node is `up` in its peers'
    // views before it is in its own, so it is routed to while `wantHosted()`
    // still answers `false` — but that one is a race no in-process fixture can
    // hold open (a transport with controllable latency is #1023), which is why
    // the deterministic half is bound here.
    const acquireGate = new GatedLease();
    const nodeA = await startNode('sng-lease-6', 'h', 60_006);
    const received: string[] = [];
    class Recorder extends Actor<string> {
      override onReceive(message: string): void { received.push(message); }
    }
    const dead: unknown[] = [];
    class DeadLetterCollector extends Actor<DeadLetter> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }
      override onReceive(message: DeadLetter): void { dead.push(message.message); }
    }
    nodeA.kit.system.spawn(() => new DeadLetterCollector(), 'dead-letter-collector');

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('gated')
      .withActor(Recorder)
      .withLease(acquireGate);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);

    // The manager is now blocked inside `acquire()`.  Waited on rather than
    // slept past, so the sends below are guaranteed to land in the window
    // instead of merely probably.
    await waitFor(() => acquireGate.acquiring);
    expect(received).toEqual([]);

    const sent = ['a', 'b', 'c', 'd', 'e'];
    for (const message of sent) singletonRef.tell(message);

    // Still nothing hosted, so nothing can have been delivered — and, with the
    // hold in place, nothing can have been dead-lettered either.
    expect(received).toEqual([]);
    expect(dead).toEqual([]);
    expect(acquireGate.acquiring).toBe(true);

    acquireGate.grant();

    // All five, in the order they were sent: the hold is a queue, and a
    // singleton that receives its backlog out of order is a different defect
    // wearing this one's clothes.
    await waitFor(() => received.length === sent.length, 5_000);
    expect(received).toEqual(sent);
    expect(dead).toEqual([]);

    nodeA.cluster.singleton.stop('gated');
    await stop(nodeA);
  }, 15_000);
});
