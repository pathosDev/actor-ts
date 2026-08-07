/**
 * DistributedData bounds its unsettled quorum requests (#140).
 *
 * The issue was filed as a leak — pending maps that are never cleaned — and
 * that half does not reproduce: every path clears them (timeout, success,
 * `postStop`).  What is missing is a *bound*: nothing limited how many quorum
 * requests could be in flight at once, and nothing limited how long a caller
 * could ask one to stay there.
 *
 * The failure that bound prevents is not an out-of-memory.  The replicator
 * runs on the default mailbox (`DEFAULT_MAILBOX_CAPACITY` = 10 000,
 * `drop-head`), so the 100 000-pending arithmetic in the report cannot happen
 * — the mailbox drops first.  Which is worse: the discarded envelope is a
 * `ddata-update` carrying the caller's `resolve`/`reject`, so `updateAsync`
 * returns a promise that never settles and nothing is logged.  A cap below
 * the mailbox's capacity converts that silent drop into an explicit
 * rejection; a cap *at* it would never fire first.
 *
 * The harness is the two-node shape the other DistributedData unit tests use.
 * Node B joins the cluster but never starts the extension, so it registers no
 * `ddata-*` wire handlers and never acks — which is exactly what a quorum
 * request that stays pending needs, without any timing games.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { DistributedDataId, DistributedDataOptions, GCounter } from '../../../src/crdt/index.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, config?: ConfigObject): Promise<Cluster> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) systemOptions.withConfig(config);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

/**
 * Park a quorum request in the pending map and stop caring about it.
 *
 * The rejection is swallowed rather than awaited: these deliberately outlive
 * the assertion — that is what makes them occupy a slot — and `afterEach`
 * settles them by terminating the system, whose `postStop` rejects everything
 * still pending.  Awaiting one would mean waiting out its full deadline.
 */
function park(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

/**
 * A two-node cluster where only the first node runs DistributedData.  The
 * second is a real up-member — so `'all'` needs its ack — that can never give
 * one, because without the extension it registers no `ddata-*` wire handlers.
 * Returns the first node's cluster.
 */
async function twoNodeCluster(prefix: string, basePort: number, config?: ConfigObject): Promise<Cluster> {
  const a = await startNode(`${prefix}-a`, basePort, config);
  const bOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const bSystem = ActorSystem.create(`${prefix}-b`, bOptions);
  systems.push(bSystem);
  const b = await Cluster.join(bSystem, ClusterOptions.create()
    .withHost('h')
    .withPort(basePort + 1)
    .withTransport(new InMemoryTransport(new NodeAddress(`${prefix}-b`, 'h', basePort + 1)))
    .withGossipIntervalMs(80)
    .withSeeds([`${prefix}-a@h:${basePort}`]));
  clusters.push(b);
  await awaitCondition(() => a.upMembers().length >= 2, {
    timeoutMs: 4_000,
    intervalMs: 25,
    label: 'the two-node cluster converged',
  });
  return a;
}

describe('DistributedData pending-quorum cap', () => {
  test('a quorum write past the cap is refused, naming the knob', async () => {
    const a = await twoNodeCluster('cap-write', 47_301);
    const distributedDataOptions = DistributedDataOptions.create()
      .withMaxPendingQuorumRequests(2)
      .withMaxQuorumTimeout(0);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    // Node b never acks, so each of these occupies a slot for its full
    // deadline.  The first two fit the cap; the third has nowhere to go.
    park(handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 30_000 }));
    park(handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 30_000 }));
    const third = handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 30_000 });

    // Refused, not hung: the whole value of the cap is that the caller gets an
    // error instead of a promise the mailbox quietly orphaned.
    await expect(third).rejects.toThrow(/refused a quorum write .*max-pending-quorum-requests = 2/);
  });

  test('the local write still lands when the quorum is refused', async () => {
    // Same contract as a quorum timeout: the value is applied locally before
    // the quorum starts, and a refusal does not roll it back.
    const a = await twoNodeCluster('cap-local', 47_311);
    const distributedDataOptions = DistributedDataOptions.create()
      .withMaxPendingQuorumRequests(1)
      .withMaxQuorumTimeout(0);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    park(handle.updateAsync('parked', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 30_000 }));
    const refused = handle.updateAsync('counted', GCounter.empty,
      (c) => c.increment('a', 5), { consistency: 'all', timeoutMs: 30_000 });

    await expect(refused).rejects.toThrow(/refused a quorum write/);
    expect(handle.get<GCounter>('counted')?.value()).toBe(5);
  });

  test('reads and writes share one budget', async () => {
    // Two half-budgets would only make the reachable total harder to state:
    // what the cap bounds is unsettled promises, and both flavours cost one.
    const a = await twoNodeCluster('cap-shared', 47_321);
    const distributedDataOptions = DistributedDataOptions.create()
      .withMaxPendingQuorumRequests(1)
      .withMaxQuorumTimeout(0);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    park(handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 30_000 }));
    const refusedRead = handle.getAsync<GCounter>('k', { consistency: 'all', timeoutMs: 30_000 });

    await expect(refusedRead).rejects.toThrow(/refused a quorum read/);
  });

  test('0 disables the cap — the requests park instead of being refused', async () => {
    const a = await twoNodeCluster('cap-off', 47_331);
    const distributedDataOptions = DistributedDataOptions.create()
      .withMaxPendingQuorumRequests(0)
      .withMaxQuorumTimeout(0);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    const attempts = [0, 1, 2].map((n) => handle.updateAsync(`k${n}`, GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 150 }));

    // All three were tracked, so all three fail the *deadline* rather than the
    // cap — the distinction the error message carries.
    const reasons = await Promise.all(attempts.map((p) => p.then(() => '', (e: Error) => e.message)));
    for (const reason of reasons) expect(reason).toMatch(/timed out after 150ms/);
  });

  test('the cap is readable from HOCON alone, with no options passed', async () => {
    // The end-to-end half of #856: `actor-ts.distributed-data.*` has to reach
    // the actor through `start(cluster)` with no second argument at all.
    const a = await twoNodeCluster('cap-hocon', 47_341, {
      'actor-ts': {
        'distributed-data': {
          'max-pending-quorum-requests': 1,
          'max-quorum-timeout': '30s',
        },
      },
    });
    const handle = a.system.extension(DistributedDataId).start(a);

    park(handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 20_000 }));
    const refused = handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 20_000 });

    await expect(refused).rejects.toThrow(/max-pending-quorum-requests = 1/);
  });
});

describe('DistributedData quorum-timeout ceiling', () => {
  test('an oversized caller timeout is clamped to the ceiling', async () => {
    const a = await twoNodeCluster('ceiling', 47_351);
    const distributedDataOptions = DistributedDataOptions.create().withMaxQuorumTimeout(120);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    // Ten minutes asked for; 120 ms is what the replica is willing to hold a
    // slot for.  Without the ceiling this test would hang for the ten.
    const started = Date.now();
    const clamped = handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 600_000 });

    await expect(clamped).rejects.toThrow(/timed out after 120ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('a timeout under the ceiling is left alone', async () => {
    const a = await twoNodeCluster('ceiling-under', 47_361);
    const distributedDataOptions = DistributedDataOptions.create().withMaxQuorumTimeout(30_000);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    const shorter = handle.getAsync<GCounter>('k', { consistency: 'all', timeoutMs: 120 });

    // Reads resolve best-effort on their deadline rather than rejecting, so
    // the observable is that it settles at all — promptly, not in 30 s.
    const started = Date.now();
    await expect(shorter).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('DistributedData quorum metrics', () => {
  test('pending depth, timeouts and refusals are all observable', async () => {
    const a = await twoNodeCluster('metrics', 47_371);
    const registry = a.system.extension(MetricsExtensionId).enable();
    const distributedDataOptions = DistributedDataOptions.create()
      .withMaxPendingQuorumRequests(1)
      .withMaxQuorumTimeout(0);
    const handle = a.system.extension(DistributedDataId).start(a, distributedDataOptions);

    const parked = handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 150 });
    park(parked);
    await awaitCondition(
      () => registry.gauge('distributed_data_quorum_pending').value === 1,
      { timeoutMs: 4_000, intervalMs: 10, label: 'the pending gauge rose' },
    );

    await expect(handle.updateAsync('k', GCounter.empty,
      (c) => c.increment('a', 1), { consistency: 'all', timeoutMs: 150 }))
      .rejects.toThrow(/refused a quorum write/);
    expect(registry.counter('distributed_data_quorum_rejected_total', { operation: 'write' }).value)
      .toBe(1);

    // The timeout path both counts and releases the slot, so a replica that
    // is merely slow does not look like one that is stuck.
    await awaitCondition(
      () => registry.gauge('distributed_data_quorum_pending').value === 0,
      { timeoutMs: 4_000, intervalMs: 10, label: 'the pending gauge fell back' },
    );
    expect(registry.counter('distributed_data_quorum_timeouts_total', { operation: 'write' }).value)
      .toBe(1);
  });
});
