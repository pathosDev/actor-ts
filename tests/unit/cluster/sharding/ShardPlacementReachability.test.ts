/**
 * Shard placement against the membership view (#1467).
 *
 * A node that stops answering is marked `unreachable` and stays a member until
 * something decides about it — a split-brain strategy, the failure detector's
 * opt-in auto-down, or an operator.  The coordinator's candidate set used to be
 * the region registry and nothing else, so for that whole stretch the parked
 * node kept being handed newly allocated shards, whose first messages then
 * waited on a home that could not answer.
 *
 * The window the coordinator waits for the set of `up` members to hold still is
 * derived from those same downing timings, and the cluster is where they are
 * resolved — so that is where it is read from.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../../src/cluster/ClusterOptions.js';
import { KeepMajority } from '../../../../src/cluster/downing/KeepMajority.js';
import type { FailureDetectorOptionsType } from '../../../../src/cluster/FailureDetectorOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { Config } from '../../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

/**
 * All three thresholds, always: the join layers an explicit failure-detector
 * block over the file's per field, so naming only `downAfterMs` would leave
 * `unreachableAfterMs` at the file's 2 s and above the down-after under test.
 */
const SHORT_FAILURE_DETECTOR: FailureDetectorOptionsType = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 300,
  downAfterMs: 700,
};

type Joined = { readonly system: ActorSystem; readonly cluster: Cluster };

const joined: Joined[] = [];
let nextPort = 48_700;

afterEach(async () => {
  for (const node of joined.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
});

/** What a case may set about the joining node; unset means the shipped configuration. */
type JoinFixture = {
  readonly hocon?: string;
  readonly configure?: (options: ClusterOptionsBuilder) => void;
};

/** A single-node cluster, configured the way the case says and joined the way an application joins. */
async function joinCluster(systemName: string, fixture: JoinFixture = {}): Promise<Cluster> {
  const port = nextPort++;
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  // `Config.parseString`, not `Config.fromObject` with dotted keys: the latter
  // keeps the dotted string as one literal key and the case would read the
  // shipped value instead of the one it set.
  if (fixture.hocon !== undefined) systemOptions.withConfig(Config.parseString(fixture.hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  fixture.configure?.(clusterOptions);
  const cluster = await Cluster.join(system, clusterOptions);
  joined.push({ system, cluster });
  return cluster;
}

describe('the membership settle window is derived from the downing timings (#1467)', () => {
  test('with no downing provider it is the failure detector\'s down-after', async () => {
    // Without a provider `down-after` is the detector's own verdict: auto-down
    // removes the member then, and with auto-down off it stays parked.  The
    // resolver's `stable-after` is still configured — 20 s from the shipped
    // file — and must not be what the answer follows, since nothing reads it.
    const cluster = await joinCluster('settle-window-no-provider', {
      configure: (options) => { options.withFailureDetector(SHORT_FAILURE_DETECTOR); },
    });

    expect(cluster._membershipSettleWindowMs).toBe(SHORT_FAILURE_DETECTOR.downAfterMs);
  });

  test('the shipped configuration answers the shipped down-after', async () => {
    const cluster = await joinCluster('settle-window-shipped');

    expect(cluster._membershipSettleWindowMs).toBe(5_000);
  });

  test('with a provider it is stable-after when that is the longer of the two', async () => {
    // The resolver is consulted only once the view has held still for
    // `stable-after`, so no member is decided about any sooner.
    const cluster = await joinCluster('settle-window-provider-stable', {
      configure: (options) => {
        options.withFailureDetector(SHORT_FAILURE_DETECTOR);
        options.withDowning(new KeepMajority());
        options.withSplitBrainResolver({ stableAfterMs: 2_000 });
      },
    });

    expect(cluster._membershipSettleWindowMs).toBe(2_000);
  });

  test('with a provider it is down-after when that is the longer of the two', async () => {
    // A detector slower than the resolver's window: the member is not even
    // handed to the resolver before `down-after`, so the larger value wins.
    const cluster = await joinCluster('settle-window-provider-down', {
      configure: (options) => {
        options.withFailureDetector(SHORT_FAILURE_DETECTOR);
        options.withDowning(new KeepMajority());
        options.withSplitBrainResolver({ stableAfterMs: 300 });
      },
    });

    expect(cluster._membershipSettleWindowMs).toBe(SHORT_FAILURE_DETECTOR.downAfterMs);
  });

  test('a strategy selected through HOCON alone counts as a provider', async () => {
    // No `withDowning` anywhere: the strategy exists only in the config file,
    // which is how most deployments select one.  The answer has to move with it.
    const cluster = await joinCluster('settle-window-hocon-strategy', {
      hocon: [
        'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
        'actor-ts.cluster.split-brain-resolver.stable-after = 9s',
      ].join('\n'),
    });

    expect(cluster._membershipSettleWindowMs).toBe(9_000);
  });
});
