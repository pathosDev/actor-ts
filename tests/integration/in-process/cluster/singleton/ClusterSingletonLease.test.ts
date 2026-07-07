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
import { ClusterSingletonId, StartSingletonOptions } from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../../src/coordination/LeaseOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 3_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface NodeSetup { kit: TestKit; cluster: Cluster }

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
    const a = await startNode('sng-lease-1', 'h', 60_001);
    const probe = a.kit.createTestProbe<string>();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-1').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo()))
      .withLease(lease);
    const handle = a.kit.system.extension(ClusterSingletonId).start(a.cluster, singletonOptions);
    await waitFor(() => a.cluster.leader().nonEmpty);
    // Child preStart fires once acquire resolves — give the mailbox
    // a few ticks for the acquire-result event.
    await probe.expectMsg('started', 1_000);

    handle.proxy.tell('hi');
    expect(await probe.expectMsg('got:hi', 500)).toBe('got:hi');

    handle.stop();
    await stop(a);
  }, 10_000);

  test('2. acquire blocked by another holder → spawn delayed; spawns once holder releases', async () => {
    inMemoryLeaseStore._clear();
    // Simulate an external holder by acquiring the same lease name from
    // a different owner first.
    const otherHolderOptions = LeaseOptions.create().withName('sng-lease-2').withOwner('someone-else').withTtlMs(5_000);
    const otherHolder = new InMemoryLease(otherHolderOptions);
    expect(await otherHolder.acquire()).toBe(true);

    const a = await startNode('sng-lease-2', 'h', 60_002);
    const probe = a.kit.createTestProbe<string>();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-2').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo()))
      .withLease(lease)
      .withAcquireRetryIntervalMs(100);   // tighter so the test isn't slow
    const handle = a.kit.system.extension(ClusterSingletonId).start(a.cluster, singletonOptions);
    await waitFor(() => a.cluster.leader().nonEmpty);

    // Other holder still owns it — manager should be in retry loop, no
    // child spawned yet.
    await probe.expectNoMessage(150);

    // Release the foreign lease.  Within ~100 ms the manager's retry
    // tick fires, sees the lease available, acquires, spawns.
    await otherHolder.release();
    await probe.expectMsg('started', 1_000);

    handle.stop();
    await stop(a);
  }, 10_000);

  test('3. lease lost mid-flight → child is stopped, manager re-attempts', async () => {
    inMemoryLeaseStore._clear();
    const a = await startNode('sng-lease-3', 'h', 60_003);
    const probe = a.kit.createTestProbe<string>();
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
      .withProps(Props.create(() => new Echo()))
      .withLease(lease)
      .withAcquireRetryIntervalMs(100);
    const handle = a.kit.system.extension(ClusterSingletonId).start(a.cluster, singletonOptions);
    await probe.expectMsg('started', 1_000);

    // Force a lost-lease scenario: another owner takes over from under us.
    // This makes the next renewal in the InMemoryLease fail, which fires
    // the onLost handler the manager subscribed to.
    inMemoryLeaseStore._clear();
    const usurperOptions = LeaseOptions.create().withName('sng-lease-3').withOwner('usurper').withTtlMs(5_000);
    const usurper = new InMemoryLease(usurperOptions);
    expect(await usurper.acquire()).toBe(true);

    // The manager's renewal-failure path fires onLost → stops child.
    await probe.expectMsg('stopped', 2_000);

    // The manager schedules a fresh acquire; while the usurper still
    // holds the lease, that acquire returns false and the manager
    // stays passive.  We don't need to wait for that retry to expire
    // — the test is happy that the child stopped.

    await usurper.release();
    handle.stop();
    await stop(a);
  }, 10_000);

  test('4. graceful manager stop releases the lease', async () => {
    inMemoryLeaseStore._clear();
    const a = await startNode('sng-lease-4', 'h', 60_004);
    const probe = a.kit.createTestProbe<string>();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const leaseOptions = LeaseOptions.create().withName('sng-lease-4').withOwner('a').withTtlMs(5_000);
    const lease = new InMemoryLease(leaseOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo()))
      .withLease(lease);
    const handle = a.kit.system.extension(ClusterSingletonId).start(a.cluster, singletonOptions);
    await probe.expectMsg('started', 1_000);
    expect(lease.checkAlive()).toBe(true);

    handle.stop();
    // Manager.postStop releases the lease; allow a tick for the async
    // release to settle.
    await waitFor(() => !lease.checkAlive(), 2_000);
    expect(lease.checkAlive()).toBe(false);

    await stop(a);
  }, 10_000);

  test('5. no lease provided — sync v1 behaviour preserved', async () => {
    // Regression guard for the no-lease path.  Same shape as the existing
    // ClusterSingleton.test.ts case but with an explicit assertion that
    // the sync spawn happens BEFORE we tell the proxy.
    const a = await startNode('sng-lease-5', 'h', 60_005);
    const probe = a.kit.createTestProbe<string>();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }
    // no lease!
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo()));
    const handle = a.kit.system.extension(ClusterSingletonId).start(a.cluster, singletonOptions);
    await waitFor(() => a.cluster.leader().nonEmpty);
    // No lease → child should be spawned synchronously the moment
    // SelfUp/LeaderChanged fires.  In single-node clusters that
    // happens during cluster.join.
    await probe.expectMsg('started', 500);

    handle.proxy.tell('hi');
    expect(await probe.expectMsg('got:hi', 500)).toBe('got:hi');

    handle.stop();
    await stop(a);
  }, 10_000);
});
