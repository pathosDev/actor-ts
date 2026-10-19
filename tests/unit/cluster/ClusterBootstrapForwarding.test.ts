import { afterEach, describe, expect, test } from 'bun:test';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import type { BootstrappedCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import type { ClusterBootstrapOptionsBuilder } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { NoopLogger } from '../../../src/Logger.js';

/**
 * #860 — the settings `Cluster.bootstrap` forwards to `Cluster.join` beside
 * the ones it always had.  The app version is pinned in
 * `MemberAppVersion.test.ts`, next to its HOCON route.
 *
 * Every field is pinned in both directions, because forwarding goes wrong in
 * two opposite ways.  Not forwarded, an explicit value never reaches the node
 * and the file decides — where the bootstrap stood while these were reachable
 * only through `withConfig`.  Forwarded whether or not it was set, an unset
 * field arrives as an explicit default, which outranks the file in the join's
 * merge and shadows it without a word — what an unconditional `.withSeeds([])`
 * did to `actor-ts.cluster.seed-nodes` (#836).  So each case sets the same
 * setting in HOCON as well: an explicit value has to win over it, and an unset
 * one has to leave it standing.
 *
 * `false` gets a case of its own: it is an answer, and a forward guarded by
 * truthiness would drop it and hand the decision back to the file.
 */

const HOST = '127.0.0.1';

const started: BootstrappedCluster[] = [];

afterEach(async () => {
  for (const node of started.splice(0)) {
    try { await node.shutdown(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * A single node on `InMemoryTransport` that founds its own cluster at once —
 * `seeds: []` is the explicit "I am the first", so discovery and the
 * environment it reads are never consulted — and returns without waiting.
 * The case adds the setting under test, its HOCON and a logger.
 */
function singleNode(name: string, port: number): ClusterBootstrapOptionsBuilder {
  return ClusterBootstrapOptions.create(name)
    .withHost(HOST)
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, HOST, port)))
    .withSeeds([])
    .withReceptionist(false)
    .withShutdownOnSignals(false)
    .withAwaitReady(false);
}

async function start(bootstrapOptions: ClusterBootstrapOptionsBuilder): Promise<BootstrappedCluster> {
  const node = await bootstrapCluster(bootstrapOptions);
  started.push(node);
  return node;
}

/**
 * The merged values `Cluster` keeps for the settings read here.  Private, and
 * read anyway: nothing public reports them, and the merge that decides them —
 * explicit over `actor-ts.cluster.*` over the built-in — runs once, in
 * `Cluster.join`, so these fields are the one place its answer is kept.  Every
 * case asserts a definite value in each direction, so a renamed field fails
 * here rather than passing on an `undefined`.
 */
type MergedClusterSettings = {
  readonly failureDetectorAutoDown: boolean;
  readonly stabilityWindow: {
    readonly stableAfterMs: number;
    readonly downAllWhenUnstable: boolean;
  };
};

function mergedSettingsOf(cluster: Cluster): MergedClusterSettings {
  return cluster as unknown as MergedClusterSettings;
}

describe('failureDetectorAutoDown reaches the join only when set (#860)', () => {
  test('an explicit true outranks the file', async () => {
    const autoDownOff = Config.parseString('actor-ts.cluster.failure-detector.auto-down = off');
    const bootstrapOptions = singleNode('forwarding-auto-down-true', 45_801)
      .withConfig(autoDownOff)
      .withLogger(new NoopLogger())
      .withFailureDetectorAutoDown(true);

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).failureDetectorAutoDown).toBe(true);
  });

  test('an explicit false outranks a file that turns it on', async () => {
    const autoDownOn = Config.parseString('actor-ts.cluster.failure-detector.auto-down = on');
    const bootstrapOptions = singleNode('forwarding-auto-down-false', 45_802)
      .withConfig(autoDownOn)
      .withLogger(new NoopLogger())
      .withFailureDetectorAutoDown(false);

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).failureDetectorAutoDown).toBe(false);
  });

  test('unset, the file decides', async () => {
    const autoDownOn = Config.parseString('actor-ts.cluster.failure-detector.auto-down = on');
    const bootstrapOptions = singleNode('forwarding-auto-down-unset', 45_803)
      .withConfig(autoDownOn)
      .withLogger(new NoopLogger());

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).failureDetectorAutoDown).toBe(true);
  });
});

describe('splitBrainResolver reaches the join only when set (#860)', () => {
  /** Both leaves of the policy, neither at its shipped value. */
  const resolverPolicy = Config.parseString(`actor-ts.cluster.split-brain-resolver {
    stable-after           = 9s
    down-all-when-unstable = on
  }`);

  test('an explicit field outranks the file, and the field it leaves out still comes from the file', async () => {
    // The join merges the policy per field, so the bootstrap must hand it the
    // caller's object as written: one that filled the missing field with a
    // default would turn off an escalation the deployment asked for.
    const bootstrapOptions = singleNode('forwarding-resolver-explicit', 45_811)
      .withConfig(resolverPolicy)
      .withLogger(new NoopLogger())
      .withSplitBrainResolver({ stableAfterMs: 7_000 });

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).stabilityWindow.stableAfterMs).toBe(7_000);
    expect(mergedSettingsOf(cluster).stabilityWindow.downAllWhenUnstable).toBe(true);
  });

  test('an explicit false outranks a file that turns the escalation on', async () => {
    const bootstrapOptions = singleNode('forwarding-resolver-false', 45_812)
      .withConfig(resolverPolicy)
      .withLogger(new NoopLogger())
      .withSplitBrainResolver({ downAllWhenUnstable: false });

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).stabilityWindow.downAllWhenUnstable).toBe(false);
    expect(mergedSettingsOf(cluster).stabilityWindow.stableAfterMs).toBe(9_000);
  });

  test('unset, the file decides both fields', async () => {
    const bootstrapOptions = singleNode('forwarding-resolver-unset', 45_813)
      .withConfig(resolverPolicy)
      .withLogger(new NoopLogger());

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).stabilityWindow.stableAfterMs).toBe(9_000);
    expect(mergedSettingsOf(cluster).stabilityWindow.downAllWhenUnstable).toBe(true);
  });
});
