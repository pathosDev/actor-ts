/**
 * #1454 — which lease a cluster singleton uses when the configuration switches
 * one on: `actor-ts.cluster.singleton.use-lease = on` builds a lease from
 * `actor-ts.coordination.lease`, and two things in code outrank it.
 *
 * - An explicit `withLease(…)` is the lease used, and nothing is built from
 *   the file beside it.
 * - `withUseLease(false)` opts the one singleton out, so it hosts without any
 *   lease at all.
 *
 * Both were claimed by the CHANGELOG, the JSDoc and the docs, and neither was
 * held by a test: a consumer that preferred the configured lease, or that read
 * the switch from the file a second time, passed every lease suite.  Each case
 * here puts a foreign holder on the record the configured lease is named
 * after, so a node that took the configured lease after all could not host —
 * the singleton never starts, which is the failure a reader of the result can
 * see.
 *
 * The backend seam builds an `InMemoryLease` from exactly what the Kubernetes
 * backend would be handed, and records every build, for the reason
 * `LeaseFromConfig.test.ts` gives.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { StartSingletonOptions } from '../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { _substituteLeaseBackendForTest } from '../../../src/coordination/LeaseFromConfig.js';
import type { ConfiguredLeaseOptions } from '../../../src/coordination/LeaseFromConfig.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../src/coordination/LeaseOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type NodeSetup = { readonly kit: TestKit; readonly cluster: Cluster };

/** The switch on, and a backend with a TTL behind it: what makes a configured lease buildable at all. */
const LEASE_FROM_CONFIG = `
  actor-ts.coordination.lease { backend = kubernetes, ttl = 5s }
  actor-ts.cluster.singleton { use-lease = on, acquire-retry-interval = 100ms }
`;

const built: ConfiguredLeaseOptions[] = [];
let restore: () => void = () => {};
const nodes: NodeSetup[] = [];
const foreignHolders: InMemoryLease[] = [];

beforeEach(() => {
  inMemoryLeaseStore._clear();
  built.length = 0;
  restore = _substituteLeaseBackendForTest((options, config) => {
    built.push(options);
    return new InMemoryLease(options, config);
  });
});

afterEach(async () => {
  restore();
  for (const node of nodes.splice(0)) {
    try { node.cluster.singleton.stop('echo'); } catch { /* a case that failed before starting it */ }
    await node.cluster.leave();
    await node.kit.system.terminate();
  }
  for (const holder of foreignHolders.splice(0)) await holder.release();
});

async function startNodeFromConfig(systemName: string, port: number): Promise<NodeSetup> {
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(LEASE_FROM_CONFIG));
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const node = { kit, cluster };
  nodes.push(node);
  return node;
}

/** Hold the record the singleton's configured lease is named after, as somebody else. */
async function holdConfiguredRecordElsewhere(systemName: string): Promise<void> {
  const foreignOptions = LeaseOptions.create()
    .withName(`${systemName}-singleton-echo`)
    .withOwner('someone-else')
    .withTtlMs(5_000);
  const foreign = new InMemoryLease(foreignOptions);
  foreignHolders.push(foreign);
  expect(await foreign.acquire()).toBe(true);
}

describe('a singleton under use-lease = on, and the code that outranks it (#1454)', () => {
  test('an explicit withLease(…) is the lease used, and none is built from the file', async () => {
    const systemName = 'sng-precedence-explicit';
    await holdConfiguredRecordElsewhere(systemName);
    const node = await startNodeFromConfig(systemName, 60_101);
    const probe = node.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const explicitOptions = LeaseOptions.create()
      .withName(`${systemName}-explicit`)
      .withOwner('this-node')
      .withTtlMs(5_000);
    const explicit = new InMemoryLease(explicitOptions);
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withLease(explicit);

    node.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => node.cluster.leader().nonEmpty, { label: 'the node became leader' });

    await probe.expectMessage('started', 3_000);
    expect(explicit.checkAlive()).toBe(true);
    expect(built).toEqual([]);
  }, 10_000);

  test('withUseLease(false) opts the singleton out: it hosts with no lease, and none is built', async () => {
    const systemName = 'sng-precedence-opt-out';
    await holdConfiguredRecordElsewhere(systemName);
    const node = await startNodeFromConfig(systemName, 60_102);
    const probe = node.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo)
      .withUseLease(false);

    node.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => node.cluster.leader().nonEmpty, { label: 'the node became leader' });

    await probe.expectMessage('started', 3_000);
    expect(built).toEqual([]);
  }, 10_000);

  test('the configured record a foreign holder owns does block a singleton that asked for nothing in code', async () => {
    // The control for both cases above: without either override the switch
    // in the file is in force, so the foreign holder keeps this singleton from
    // starting — which is what makes "it started" mean something there.
    const systemName = 'sng-precedence-control';
    await holdConfiguredRecordElsewhere(systemName);
    const node = await startNodeFromConfig(systemName, 60_103);
    const probe = node.kit.createTestProbe();
    class Echo extends Actor<string> {
      override preStart(): void { probe.tell('started'); }
      override onReceive(): void {}
    }
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo);

    node.cluster.singleton.start(singletonOptions);
    await awaitCondition(() => node.cluster.leader().nonEmpty, { label: 'the node became leader' });

    expect(built.map((options) => options.name)).toEqual([`${systemName}-singleton-echo`]);
    await probe.expectNoMessage(300);
  }, 10_000);
});
