/**
 * #860 — `actor-ts.cluster.bootstrap.new-cluster-enabled`.
 *
 * A bootstrapped node that finds nobody to join forms a cluster of its own.
 * That is exactly right on a deployment's first start and exactly the split
 * brain on every start after it: a node that cannot reach its peers — a
 * partition, a discovery outage, a DNS answer that lags pod readiness — comes
 * up as the founder of a second cluster beside the running one.  The flag is
 * the deployment's way to say "the cluster exists now": off, no bootstrapped
 * node founds one, on either bootstrap path, and an explicit `seeds: []` —
 * which says "I am the first node" — is refused rather than obeyed.  On, every
 * start says so once, because a deployment that leaves the first-deploy
 * setting on is the case the flag exists for.
 *
 * "Does not found a cluster" is observed through the node's own readiness
 * wait timing out, not through a sleep: a node that may not self-elect and
 * has nobody to promote it stays `joining`, which is what the timeout reports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ActorSystem } from '../../../src/ActorSystem.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import type { BootstrappedCluster } from '../../../src/cluster/ClusterBootstrap.js';
import {
  ClusterBootstrapOptions,
  DEFAULT_NEW_CLUSTER_ENABLED,
  readClusterBootstrapDiscoveryFromConfig,
} from '../../../src/cluster/ClusterBootstrapOptions.js';
import type { ClusterBootstrapOptionsBuilder } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { ClusterReadyTimeoutError } from '../../../src/cluster/ClusterReadiness.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import type { SeedProvider } from '../../../src/discovery/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { expectExactOptions } from '../../util/ExactOptions.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const KEY = ConfigKeys.cluster.bootstrap.newClusterEnabled;
const OFF = Config.parseString(`${KEY} = off`);
const NOBODY: SeedProvider = { lookup: async () => [] };

/** Tunings that settle an empty discovery answer — self alone — in a few milliseconds. */
const FAST_OBSERVATION = {
  pollIntervalMs: 5,
  stableMarginMs: 0,
  maxWaitMs: 2_000,
  requiredContactPoints: 1,
  selfElectionGraceMs: 50,
};

/**
 * Every variable the bootstrap path reads, cleared so a developer's
 * `CLUSTER_SEEDS` cannot hand one of these lone nodes a peer.
 */
const BOOTSTRAP_VARIABLES = [
  'CLUSTER_HOST',
  'POD_IP',
  'HOSTNAME',
  'CLUSTER_PORT',
  'CLUSTER_SEEDS',
  'CLUSTER_SERVICE_NAME',
  'CLUSTER_NAMESPACE',
  'KUBERNETES_SERVICE_HOST',
] as const;

const savedVariables = new Map<string, string | undefined>();
const started: ActorSystem[] = [];

beforeEach(() => {
  for (const name of BOOTSTRAP_VARIABLES) {
    savedVariables.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  for (const [name, value] of savedVariables) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedVariables.clear();
});

/** A `RecordingLogger` that records `close()` — `terminate()` calls it, so it says a system was torn down. */
class ClosingLogger extends RecordingLogger {
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A node on loopback with the in-memory transport, which does not wait for readiness unless told to. */
function lone(name: string, port: number): ClusterBootstrapOptionsBuilder {
  return ClusterBootstrapOptions.create(name)
    .withHost('127.0.0.1')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, '127.0.0.1', port)))
    .withAwaitReady(false)
    .withReceptionist(false)
    .withShutdownOnSignals(false)
    .withLogger(new RecordingLogger());
}

async function bootstrap(options: ClusterBootstrapOptionsBuilder): Promise<BootstrappedCluster> {
  const bootstrapped = await bootstrapCluster(options);
  started.push(bootstrapped.system);
  return bootstrapped;
}

/**
 * The node never becomes ready within `timeoutMs` — long past every grace
 * these tests configure — and is still `joining` afterwards.
 */
async function expectNeverFounds(bootstrapped: BootstrappedCluster, timeoutMs: number): Promise<void> {
  let caught: unknown;
  try {
    await bootstrapped.cluster.awaitReady({ timeoutMs });
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the node became ready: it founded a cluster of its own').toBeInstanceOf(ClusterReadyTimeoutError);
  expect(bootstrapped.formedNewCluster).toBe(false);
  expect(bootstrapped.cluster.selfMember()?.status).toBe('joining');
}

function warningsNamingTheKey(log: RecordingLogger): string[] {
  return log.records
    .filter((record) => record.level === 'warn' && record.message.includes(KEY))
    .map((record) => record.message);
}

/* -------------------------------------------------------------------------- */
/* The reader                                                                  */
/* -------------------------------------------------------------------------- */

describe('actor-ts.cluster.bootstrap.new-cluster-enabled is read (#860)', () => {
  test('the key reads through, and an absent one stays absent', () => {
    expectExactOptions(readClusterBootstrapDiscoveryFromConfig(OFF), { newClusterEnabled: false });
    expectExactOptions(
      readClusterBootstrapDiscoveryFromConfig(Config.parseString(`${KEY} = on`)),
      { newClusterEnabled: true },
    );
    expectExactOptions(readClusterBootstrapDiscoveryFromConfig(Config.parseString('actor-ts.cluster.bootstrap {}')), {});
  });

  test('the shipped default is on', () => {
    expect(Config.loadReference().getBoolean(KEY)).toBe(true);
    expect(DEFAULT_NEW_CLUSTER_ENABLED).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Off: no bootstrapped node founds a cluster                                  */
/* -------------------------------------------------------------------------- */

describe('new-cluster-enabled = off (#860)', () => {
  test('a node that finds nobody does not form a cluster — the plain path', async () => {
    const offOptions = lone('formation-off-plain', 58301)
      .withDiscovery(NOBODY)
      .withConfig(OFF);
    const off = await bootstrap(offOptions);
    await expectNeverFounds(off, 400);
  }, 15_000);

  test('the control: on, the same node forms one at once', async () => {
    // Without it the case above would pass for a node that could not start
    // a cluster for any reason at all.
    const onOptions = lone('formation-on-plain', 58302).withDiscovery(NOBODY);
    const on = await bootstrap(onOptions);
    expect(on.formedNewCluster).toBe(true);
  });

  test('the stable-observation winner does not form a cluster either', async () => {
    // Discovery answers nothing, so this node is the whole settled set and wins
    // the election.  On, its deferred self-election fires after the grace; off,
    // it is handed `'never'` like every node that lost.
    const offOptions = lone('formation-off-observed', 58303)
      .withDiscovery(NOBODY)
      .withStableObservation(FAST_OBSERVATION)
      .withConfig(OFF);
    const off = await bootstrap(offOptions);
    await expectNeverFounds(off, 500);
  }, 15_000);

  test('the control: on, the elected node forms one after its grace', async () => {
    const onOptions = lone('formation-on-observed', 58304)
      .withDiscovery(NOBODY)
      .withStableObservation(FAST_OBSERVATION);
    const on = await bootstrap(onOptions);
    await awaitCondition(() => on.formedNewCluster, {
      timeoutMs: 3_000,
      label: 'the elected node self-elected once its grace ran out',
    });
  }, 15_000);

  test('an explicit seeds: [] is refused, and the system is torn down', async () => {
    // `seeds: []` is "there is nobody else, I am the first node" — founding a
    // cluster, which is what the flag forbids.  Obeying it would route around
    // the guard with one option; ignoring it would turn an explicit answer
    // into silence.  A refusal inside the bootstrap's guard is the third way.
    const log = new ClosingLogger();
    const options = lone('formation-off-empty-seeds', 58305)
      .withSeeds([])
      .withConfig(OFF)
      .withLogger(log);

    let caught: unknown;
    try {
      await bootstrapCluster(options);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('seeds');
    expect((caught as Error).message).toContain(KEY);
    expect(log.closed, 'the refused bootstrap left its ActorSystem running').toBe(true);
  }, 15_000);

  test('a node with it off still joins a cluster that exists', async () => {
    // The flag forbids founding, not joining: a running cluster's leader
    // promotes the newcomer exactly as before.
    const founderOptions = lone('formation-join', 58306).withSeeds([]);
    const founder = await bootstrap(founderOptions);
    expect(founder.formedNewCluster).toBe(true);

    const joinerOptions = lone('formation-join', 58307)
      .withSeeds(['formation-join@127.0.0.1:58306'])
      .withConfig(OFF);
    const joiner = await bootstrap(joinerOptions);
    await joiner.cluster.awaitReady({ timeoutMs: 4_000 });
    expect(joiner.formedNewCluster).toBe(false);
    expect(joiner.cluster.selfMember()?.status).toBe('up');
  }, 15_000);

  test('the option outranks the file, in both directions', async () => {
    const enabledInCodeOptions = lone('formation-code-on', 58308)
      .withDiscovery(NOBODY)
      .withConfig(OFF)
      .withNewClusterEnabled(true);
    const enabledInCode = await bootstrap(enabledInCodeOptions);
    expect(enabledInCode.formedNewCluster).toBe(true);

    const disabledInCodeOptions = lone('formation-code-off', 58309)
      .withDiscovery(NOBODY)
      .withNewClusterEnabled(false);
    const disabledInCode = await bootstrap(disabledInCodeOptions);
    await expectNeverFounds(disabledInCode, 400);
  }, 15_000);

  test('through Cluster.bootstrap with its readiness wait, the start fails and tears down', async () => {
    // The whole path as a deployment meets it: nothing to discover, the flag
    // off, the default awaitReady — here with a short budget — and the start
    // rejects instead of resolving a node that founded a cluster of one.
    const log = new ClosingLogger();
    const options = lone('formation-off-ready', 58310)
      .withDiscovery(NOBODY)
      .withConfig(OFF)
      .withAwaitReady(300)
      .withLogger(log);

    let caught: unknown;
    try {
      await Cluster.bootstrap(options);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClusterReadyTimeoutError);
    expect(log.closed, 'the timed-out bootstrap left its ActorSystem running').toBe(true);
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* On: every start says so, once                                               */
/* -------------------------------------------------------------------------- */

describe('new-cluster-enabled = on (#860)', () => {
  test('each start warns once, naming the key and saying to turn it off', async () => {
    const log = new RecordingLogger();
    const firstOptions = lone('formation-warn-1', 58311)
      .withSeeds([])
      .withLogger(log);
    await bootstrap(firstOptions);
    expect(warningsNamingTheKey(log)).toHaveLength(1);
    expect(warningsNamingTheKey(log)[0]).toMatch(/off/);

    const secondOptions = lone('formation-warn-2', 58312)
      .withSeeds([])
      .withLogger(log);
    await bootstrap(secondOptions);
    expect(warningsNamingTheKey(log)).toHaveLength(2);
  });

  test('off, nothing warns about it', async () => {
    const log = new RecordingLogger();
    const quietOptions = lone('formation-quiet', 58313)
      .withDiscovery(NOBODY)
      .withConfig(OFF)
      .withLogger(log);
    await bootstrap(quietOptions);
    expect(warningsNamingTheKey(log)).toEqual([]);
  });
});
