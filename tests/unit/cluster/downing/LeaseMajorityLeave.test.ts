/**
 * #1454 — a node that leaves gives back what its downing provider holds.
 *
 * A won lease-majority arbitration keeps the lease, and its backend renews the
 * record until something releases it.  The provider can: `shutdown()` releases
 * the lease and, for one built from configuration, stops the scheduler the
 * renewal runs on.  Nothing called it, though.  A node that left and terminated
 * went on renewing a record nobody would act on, the renewal held its process
 * open, and the members it left behind found the lease taken at their next even
 * split — both halves lost the arbitration and downed themselves.
 *
 * The first case is that, end to end: two in-process nodes, an even split only
 * the lease decides, `lease-majority` selected in configuration over the
 * in-memory store, a leave and a terminate.  The second runs the same in a
 * child process, whose exit is the assertion.  The rest pin the hook from the
 * cluster's side with a stub provider: both routes a leave takes reach it — the
 * ordinary one and the at-once leave of a node its own decision downed or that
 * gave its join up — once each, after the failure-detector tick that calls
 * `decide()` has stopped; and a hook that fails is logged and fails nothing.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import type {
  ClusterPartitionView,
  DowningDecision,
  DowningProvider,
} from '../../../../src/cluster/downing/DowningProvider.js';
import type { FailureDetectorOptionsType } from '../../../../src/cluster/FailureDetectorOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { Config } from '../../../../src/config/Config.js';
import { _substituteLeaseBackendForTest } from '../../../../src/coordination/LeaseFromConfig.js';
import type { ConfiguredLeaseOptions } from '../../../../src/coordination/LeaseFromConfig.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../src/coordination/leases/InMemoryLease.js';
import { LogLevel } from '../../../../src/Logger.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

/** Fast enough to see a peer go unreachable inside a test; `down-after` stays out of reach. */
const DETECTOR: FailureDetectorOptionsType = { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 4_000 };

const SYSTEM = 'lease-leave';
const RECORD = `${SYSTEM}-split-brain-resolver`;

/** The lease's `ttl` below, and the renewal cadence the in-memory backend derives from it: a third. */
const TTL_MS = 2_000;
const RENEWAL_INTERVAL_MS = Math.floor(TTL_MS / 3);

/** `lease-majority` over a `kubernetes` lease, which the backend seam below turns into an in-memory one. */
const LEASE_MAJORITY = `
  actor-ts.coordination.lease { backend = kubernetes, ttl = ${TTL_MS}ms }
  actor-ts.cluster.split-brain-resolver.active-strategy = lease-majority
`;

type Node = { readonly system: ActorSystem; readonly cluster: Cluster };

type NodeSpec = {
  readonly seeds?: string[];
  /** Layered over `reference.conf`; absent selects no strategy. */
  readonly hocon?: string;
  readonly downing?: DowningProvider;
  readonly logger?: RecordingLogger;
  readonly seedRetryIntervalMs?: number;
  readonly shutdownAfterUnsuccessfulJoinMs?: number;
};

/** Every system a case started, terminated after it whatever the case did. */
let systems: ActorSystem[] = [];
/** What the backend seam was handed per lease it built — the renewal's scheduler among it. */
const handed: ConfiguredLeaseOptions[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  inMemoryLeaseStore._clear();
  handed.length = 0;
  restore = _substituteLeaseBackendForTest((options, config) => {
    handed.push(options);
    return new InMemoryLease(options, config);
  });
});

afterEach(async () => {
  restore();
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  systems = [];
  // A lease nobody released renews on its provider's scheduler for as long as
  // the process runs.  Stopped here so that a red run ends with its summary
  // instead of being held open by the defect it reports.
  for (const options of handed) options.scheduler.shutdown();
});

/**
 * One node on an in-memory transport, auto-down off so a silent peer stays
 * unreachable until a provider decides (auto-down ships on since #1426), and a
 * stability window shorter than one detector round, so a provider is asked at
 * once.
 */
async function startNode(systemName: string, port: number, spec: NodeSpec = {}): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(spec.logger ?? new RecordingLogger())
    .withLogLevel(LogLevel.Info);
  if (spec.hocon !== undefined) systemOptions.withConfig(Config.parseString(spec.hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector(DETECTOR)
    .withFailureDetectorAutoDown(false)
    .withSplitBrainResolver({ stableAfterMs: 1 })
    .withGossipIntervalMs(80);
  if (spec.seeds !== undefined) clusterOptions.withSeeds(spec.seeds);
  if (spec.downing !== undefined) clusterOptions.withDowning(spec.downing);
  if (spec.seedRetryIntervalMs !== undefined) clusterOptions.withSeedRetryIntervalMs(spec.seedRetryIntervalMs);
  if (spec.shutdownAfterUnsuccessfulJoinMs !== undefined) {
    clusterOptions.withShutdownAfterUnsuccessfulJoinMs(spec.shutdownAfterUnsuccessfulJoinMs);
  }
  return { system, cluster: await Cluster.join(system, clusterOptions) };
}

/** `seed` with `seedSpec`, and a plain peer that joins through it; resolved once both see two `up` members. */
async function formPair(systemName: string, seedPort: number, seedSpec: NodeSpec): Promise<{ seed: Node; peer: Node }> {
  const seed = await startNode(systemName, seedPort, seedSpec);
  const peer = await startNode(systemName, seedPort + 1, { seeds: [`${systemName}@h:${seedPort}`] });
  await awaitCondition(
    () => seed.cluster.upMembers().length === 2 && peer.cluster.upMembers().length === 2,
    { timeoutMs: 3_000, label: 'both nodes saw a two-member cluster' },
  );
  return { seed, peer };
}

function selfStatusOf(node: Node): MemberStatus | undefined {
  return node.cluster.getMembers().find((member) => member.address.equals(node.cluster.selfAddress))?.status;
}

/** Whether another owner could take the record right now; a record it takes is given straight back. */
function foreignOwnerCanTake(): boolean {
  const now = Date.now();
  const version = inMemoryLeaseStore.tryAcquire(RECORD, 'foreign-owner', now + 1_000, now);
  if (version > 0) inMemoryLeaseStore.release(RECORD, 'foreign-owner');
  return version > 0;
}

describe('a node that won a lease-majority arbitration gives the lease back when it leaves (#1454)', () => {
  test('after leave + terminate the record is free at once and nothing renews it', async () => {
    const a = await startNode(SYSTEM, 64_601, { hocon: LEASE_MAJORITY });
    const b = await startNode(SYSTEM, 64_602, { seeds: [`${SYSTEM}@h:64601`] });
    await awaitCondition(() => a.cluster.upMembers().length === 2, { label: 'both members up on a' });
    // b goes silent without leaving: an even split only the lease decides.  b
    // runs no strategy, so a's arbitration is the only one and a wins it.
    await b.cluster.transport.shutdown();
    await awaitCondition(
      () => inMemoryLeaseStore.peek(RECORD)?.owner.startsWith(`${SYSTEM}@h:64601`) === true,
      { timeoutMs: 4_000, label: 'a won the arbitration' },
    );
    expect(foreignOwnerCanTake()).toBe(false);
    expect(handed).toHaveLength(1);
    const schedulerShutdown = spyOn(handed[0]!.scheduler, 'shutdown');
    const renewals = spyOn(inMemoryLeaseStore, 'renew');
    try {
      await a.cluster.leave();

      // The leave gave it back, before anything terminated.
      expect(inMemoryLeaseStore.peek(RECORD)).toBeUndefined();
      expect(schedulerShutdown).toHaveBeenCalledTimes(1);
      // Renewals counted from here: one may legitimately have run while the
      // leave was still handing shards off, before the release.
      renewals.mockClear();
      await a.system.terminate();
      await b.system.terminate();

      expect(foreignOwnerCanTake()).toBe(true);
      // An absence, so a fixed wait: two renewal rounds, in which a lease still
      // armed would have renewed the record at least once.
      await sleep(2 * RENEWAL_INTERVAL_MS);
      expect(renewals.mock.calls.filter(([name]) => name === RECORD)).toEqual([]);
      expect(inMemoryLeaseStore.peek(RECORD)).toBeUndefined();
    } finally {
      schedulerShutdown.mockRestore();
      renewals.mockRestore();
    }
  }, 10_000);

  /**
   * The property the record stands in for, asserted the only way it can be:
   * from outside the process.  The fixture plays the case above and returns;
   * with the lease still renewing, the process ran until the spawn timeout
   * killed it.
   */
  test('the process the winner left from exits on its own', () => {
    const fixture = join(import.meta.dir, 'LeaseMajorityLeave.fixture.ts');
    const child = spawnSync(process.execPath, ['run', fixture], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      // Generous against a loaded runner; the fixture's own work takes a second
      // or two, so a run that reaches this limit is the held process, not
      // slowness.
      timeout: 15_000,
    });
    expect(child.stdout, `the fixture never reached its arbitration:\n${child.stderr}`).toContain('won=true');
    expect(child.stdout, 'the leave did not free the record').toContain('released=true');
    expect(child.signal, 'the fixture had to be killed — something kept its event loop alive').toBeNull();
    expect(child.status).toBe(0);
  }, 25_000);
});

/**
 * A provider that records, in order, every `decide()` the cluster asked of it
 * and every `shutdown()`, and decides what `verdict` says.  Its `shutdown()`
 * takes `releaseMs` to settle, as a release that has to reach a backend does: a
 * failure-detector tick still armed meanwhile would decide again.
 */
class RecordingProvider implements DowningProvider {
  readonly calls: Array<'decide' | 'shutdown'> = [];

  constructor(
    private readonly verdict: (view: ClusterPartitionView) => DowningDecision = () => new Set(),
    private readonly releaseMs = 0,
  ) {}

  decide(view: ClusterPartitionView): DowningDecision {
    this.calls.push('decide');
    return this.verdict(view);
  }

  async shutdown(): Promise<void> {
    this.calls.push('shutdown');
    // Stands in for the round trip of a release; see the class comment.
    if (this.releaseMs > 0) await sleep(this.releaseMs);
  }

  get shutdowns(): number {
    return this.calls.filter((call) => call === 'shutdown').length;
  }

  /** The `decide()` calls made after the first `shutdown()`. */
  get decisionsAfterShutdown(): number {
    const first = this.calls.indexOf('shutdown');
    return first < 0 ? 0 : this.calls.slice(first).filter((call) => call === 'decide').length;
  }
}

/** Four detector rounds: long enough for a tick still armed to show up, short enough for a test. */
const RELEASE_MS = 4 * DETECTOR.heartbeatIntervalMs;

describe('both leave routes reach the provider\'s shutdown hook (#1454)', () => {
  test('an ordinary leave calls it once, after the last decide()', async () => {
    const provider = new RecordingProvider(() => new Set(), RELEASE_MS);
    const node = await startNode('hook-leave', 64_611, { downing: provider });
    await awaitCondition(() => provider.calls.includes('decide'), { label: 'the failure-detector tick asked the provider' });

    await node.cluster.leave();
    await node.cluster.leave();

    expect(provider.shutdowns).toBe(1);
    expect(provider.decisionsAfterShutdown).toBe(0);
  });

  test('a node its own decision downed leaves at once, and that leave calls it too', async () => {
    // Downs every member, this node included, as soon as anyone is unreachable.
    const downsEveryone = (view: ClusterPartitionView): DowningDecision => (view.unreachable.size === 0
      ? new Set()
      : new Set(view.allMembers.map((member) => member.address.toString())));
    const provider = new RecordingProvider(downsEveryone, RELEASE_MS);
    const { seed, peer } = await formPair('hook-self-down', 64_621, { downing: provider });

    await peer.cluster.transport.shutdown();

    await awaitCondition(() => provider.shutdowns > 0, { timeoutMs: 3_000, label: 'the at-once leave called the hook' });
    expect(selfStatusOf(seed)).toBe('leaving');
    // An absence, so a fixed wait: several detector rounds past the release, in
    // which a tick still armed would decide again and a second leave would
    // call the hook again.
    await sleep(RELEASE_MS + 4 * DETECTOR.heartbeatIntervalMs);
    expect(provider.shutdowns).toBe(1);
    expect(provider.decisionsAfterShutdown).toBe(0);
  });

  test('a node that gave its join up leaves at once, and that leave calls it too', async () => {
    const provider = new RecordingProvider();
    // Its one seed is an address no transport answers on, so nothing can ever
    // promote it, and the deadline gives the join up.
    const node = await startNode('hook-give-up', 64_631, {
      downing: provider,
      seeds: ['hook-give-up@h2:64631'],
      seedRetryIntervalMs: 50,
      shutdownAfterUnsuccessfulJoinMs: 300,
    });

    await awaitCondition(() => provider.shutdowns > 0, { timeoutMs: 3_000, label: 'the give-up leave called the hook' });
    expect(selfStatusOf(node)).toBe('leaving');
    expect(provider.shutdowns).toBe(1);
  });

  test('a hook that rejects is logged, and the leave completes all the same', async () => {
    const logger = new RecordingLogger();
    const rejecting: DowningProvider = {
      decide: () => new Set(),
      shutdown: () => Promise.reject(new Error('the lease API is unreachable')),
    };
    const node = await startNode('hook-rejects', 64_641, { downing: rejecting, logger });
    const transportShutdown = spyOn(node.cluster.transport, 'shutdown');

    await node.cluster.leave();

    expect(transportShutdown).toHaveBeenCalledTimes(1);
    expect(selfStatusOf(node)).toBe('leaving');
    expect(logger.records.filter((record) => record.level === 'warn' && record.message.includes('downing provider')))
      .toHaveLength(1);
  });

  test('a hook that throws before it returns a promise is caught the same way', async () => {
    const logger = new RecordingLogger();
    const throwing: DowningProvider = {
      decide: () => new Set(),
      shutdown: () => { throw new Error('no backend configured'); },
    };
    const node = await startNode('hook-throws', 64_651, { downing: throwing, logger });
    const transportShutdown = spyOn(node.cluster.transport, 'shutdown');

    await node.cluster.leave();

    expect(transportShutdown).toHaveBeenCalledTimes(1);
    expect(logger.records.filter((record) => record.level === 'warn' && record.message.includes('downing provider')))
      .toHaveLength(1);
  });
});
