/**
 * #1660 — survival after a lease-arbitrated split stays conditional on keeping
 * the lease.
 *
 * `LeaseMajority` consults its lease only while it is deciding, and `Cluster`
 * stops asking once a decision was applied: the winner's next view has no
 * unreachable members, the strategy resets, and nothing looks at the lease for
 * that partition again.  A winner that then stalls past the TTL loses the lease
 * to the other side, which may still arbitrate — and win — while this side goes
 * on running.  So once a win has been handed out, losing the lease takes this
 * node out through `DowningProvider.bindSelfDown`, and `Cluster` turns that
 * into the same leave a decision naming this node causes.
 *
 * The strategy cases run two real `InMemoryLease`s on one store and on virtual
 * time, the shape of the #937 split test: nothing here waits on a wall clock.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { readDowningFromConfig } from '../../../../src/cluster/downing/DowningFromConfig.js';
import { LeaseMajority, LeaseMajorityOptions } from '../../../../src/cluster/downing/index.js';
import type { ClusterPartitionView, DowningProvider } from '../../../../src/cluster/downing/index.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { Config } from '../../../../src/config/Config.js';
import type { Lease } from '../../../../src/coordination/Lease.js';
import { _substituteLeaseBackendForTest } from '../../../../src/coordination/LeaseFromConfig.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../src/coordination/LeaseOptions.js';
import { LogLevel } from '../../../../src/Logger.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
import { sleep } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

const address = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);
const member = (port: number, status: 'up' | 'removed' = 'up'): Member =>
  new Member(address(port), status, 0, []);

/** The 2/2 split, seen from the left (`sys@h:1`) and from the right (`sys@h:3`). */
const leftSplit: ClusterPartitionView = {
  allMembers: [member(1), member(2), member(3), member(4)],
  unreachable: new Set([address(3).toString(), address(4).toString()]),
  self: address(1),
};
const rightSplit: ClusterPartitionView = {
  allMembers: [member(1), member(2), member(3), member(4)],
  unreachable: new Set([address(1).toString(), address(2).toString()]),
  self: address(3),
};
/** The left side's view once its decision was applied: the right side tombstoned. */
const leftAfterApplying: ClusterPartitionView = {
  allMembers: [member(1), member(2), member(3, 'removed'), member(4, 'removed')],
  unreachable: new Set(),
  self: address(1),
};

/**
 * A zero-length turn boundary: `decide()` starts an `acquire()` whose `.then`
 * has to run before the next `decide()` can read its result.
 */
const flushMicrotasks = (): Promise<void> => sleep(0);

/** Records every self-down a provider asks for. */
function bindRecorder(provider: DowningProvider): string[] {
  const reasons: string[] = [];
  provider.bindSelfDown?.((reason) => { reasons.push(reason); });
  return reasons;
}

/**
 * The left holder's renewal comes round once an hour — the stall: armed, and
 * not running while the TTL passes.  The right one renews every 10 s and so
 * keeps whatever it takes for the length of the test.
 */
function strategyOver(owner: string, renewalIntervalMs: number, scheduler: ManualScheduler): LeaseMajority {
  const leaseOptions = LeaseOptions.create()
    .withName('split-1660')
    .withOwner(owner)
    .withTtlMs(30_000)
    .withRenewalIntervalMs(renewalIntervalMs)
    .withScheduler(scheduler);
  const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(new InMemoryLease(leaseOptions));
  return new LeaseMajority(leaseMajorityOptions);
}

/** A lease whose acquire wins at once and whose loss the test announces. */
class AnnouncedLease implements Lease {
  private held = false;
  private readonly handlers = new Set<(reason: string) => void>();
  async acquire(): Promise<boolean> { this.held = true; return true; }
  async release(): Promise<void> { this.held = false; }
  checkAlive(): boolean { return this.held; }
  onLost(handler: (reason: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  /** What a backend's renewal does once it finds the lease gone. */
  lose(reason: string): void {
    this.held = false;
    for (const handler of this.handlers) handler(reason);
  }
}

describe('LeaseMajority — an applied win that loses its lease (#1660)', () => {
  test('the winner that stalls past the TTL downs itself once the other side took the lease', async () => {
    inMemoryLeaseStore._clear();
    try {
      const scheduler = new ManualScheduler();
      const left = strategyOver('left', 3_600_000, scheduler);
      const right = strategyOver('right', 10_000, scheduler);
      const leftDowns = bindRecorder(left);
      const rightDowns = bindRecorder(right);

      // The left side wins, and its decision is applied: the right side is
      // tombstoned in its view, so the next tick sees no partition at all.
      expect(left.decide(leftSplit).size).toBe(0);
      await flushMicrotasks();
      expect(left.decide(leftSplit)).toEqual(new Set([address(3).toString(), address(4).toString()]));
      expect(left.decide(leftAfterApplying)).toEqual(new Set());

      // The left holder stalls past the TTL; the right side arbitrates late and
      // takes the lapsed lease legitimately.
      scheduler.advance(30_000);
      expect(right.decide(rightSplit).size).toBe(0);
      await flushMicrotasks();
      expect(right.decide(rightSplit)).toEqual(new Set([address(1).toString(), address(2).toString()]));
      expect(leftDowns).toEqual([]);

      // The left holder resumes; its renewal finds the lease gone.  Nothing asks
      // the left strategy to decide again — the left node takes itself out.
      scheduler.advance(3_600_000 - 30_000);
      expect(leftDowns).toHaveLength(1);
      expect(leftDowns[0]).toMatch(/lease/);
      expect(rightDowns).toEqual([]);
    } finally {
      inMemoryLeaseStore._clear();
    }
  });

  test('a win that was never handed out takes nobody out when its lease goes', async () => {
    const lease = new AnnouncedLease();
    const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(lease);
    const strategy = new LeaseMajority(leaseMajorityOptions);
    const downs = bindRecorder(strategy);

    // The acquire resolved, but no decide() returned the win, so no cluster acted
    // on it: there is no survival to revoke.
    expect(strategy.decide(leftSplit).size).toBe(0);
    await flushMicrotasks();
    lease.lose('renewal failed');

    expect(downs).toEqual([]);
  });

  test('a lost lease after shutdown takes nobody out', async () => {
    const lease = new AnnouncedLease();
    const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(lease);
    const strategy = new LeaseMajority(leaseMajorityOptions);
    const downs = bindRecorder(strategy);
    expect(strategy.decide(leftSplit).size).toBe(0);
    await flushMicrotasks();
    expect(strategy.decide(leftSplit).size).toBe(2);

    await strategy.shutdown();
    lease.lose('renewal failed');

    expect(downs).toEqual([]);
  });

  test('the loss is reported once, however often the backend repeats it', async () => {
    const lease = new AnnouncedLease();
    const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(lease);
    const strategy = new LeaseMajority(leaseMajorityOptions);
    const downs = bindRecorder(strategy);
    expect(strategy.decide(leftSplit).size).toBe(0);
    await flushMicrotasks();
    expect(strategy.decide(leftSplit).size).toBe(2);

    lease.lose('lease expired before it could be renewed');
    lease.lose('lease lost during renewal');

    expect(downs).toEqual(['the lease behind an applied lease-majority win was lost: lease expired before it could be renewed']);
  });

  test('selected from configuration, the strategy built at its first decision gets the binding', async () => {
    inMemoryLeaseStore._clear();
    const lease = new AnnouncedLease();
    const restore = _substituteLeaseBackendForTest(() => lease);
    const configured = Config.parseString(`
      actor-ts.coordination.lease { backend = kubernetes, ttl = 30s }
      actor-ts.cluster.split-brain-resolver.active-strategy = lease-majority
    `);
    const provider = readDowningFromConfig(configured)!;
    try {
      // Bound before the strategy exists, as `Cluster` does at construction.
      const downs = bindRecorder(provider);
      expect(provider.decide(leftSplit).size).toBe(0);
      await flushMicrotasks();
      expect(provider.decide(leftSplit).size).toBe(2);

      lease.lose('renewal failed');

      expect(downs).toHaveLength(1);
    } finally {
      await provider.shutdown?.();
      restore();
      inMemoryLeaseStore._clear();
    }
  });
});

describe('Cluster — a provider that downs this node between decisions (#1660)', () => {
  /** A provider that never decides, and keeps the binding `Cluster` hands it. */
  class BindingProvider implements DowningProvider {
    downSelf: ((reason: string) => void) | null = null;
    decide(): ReadonlySet<string> { return new Set(); }
    bindSelfDown(downSelf: (reason: string) => void): void { this.downSelf = downSelf; }
  }

  async function startSingleNode(systemName: string, provider: DowningProvider, log: RecordingLogger): Promise<{
    system: ActorSystem; cluster: Cluster;
  }> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Info);
    const system = ActorSystem.create(systemName, systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(1)
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', 1, 'test-run')))
      .withDowning(provider)
      .withRunCoordinatedShutdownWhenDown(false);
    const cluster = await Cluster.join(system, clusterOptions);
    return { system, cluster };
  }

  const selfStatus = (cluster: Cluster): string | undefined => cluster.selfMember()?.status;

  test('the binding makes this node leave exactly as a decision naming it would, and says why', async () => {
    const provider = new BindingProvider();
    const log = new RecordingLogger(LogLevel.Info);
    const { system, cluster } = await startSingleNode('bound-self-down', provider, log);
    try {
      expect(provider.downSelf).not.toBeNull();

      provider.downSelf!('the lease behind an applied lease-majority win was lost: renewal failed');

      // The departure is synchronous, and the downing route ends in `removed`.
      expect(selfStatus(cluster)).toBe('removed');
      expect(log.records.some((record) => record.level === 'warn'
        && record.message.includes('the lease behind an applied lease-majority win was lost: renewal failed')))
        .toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('after the node left, the binding does nothing', async () => {
    const provider = new BindingProvider();
    const log = new RecordingLogger(LogLevel.Info);
    const { system, cluster } = await startSingleNode('bound-self-down-after-leave', provider, log);
    try {
      await cluster.leave();
      const warningsBefore = log.records.filter((record) => record.level === 'warn').length;

      provider.downSelf!('too late');

      expect(selfStatus(cluster)).toBe('leaving');
      expect(log.records.filter((record) => record.level === 'warn')).toHaveLength(warningsBefore);
    } finally {
      await system.terminate();
    }
  });
});
