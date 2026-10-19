import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import type { BootstrappedCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions, DEFAULT_AWAIT_READY_MS } from '../../../src/cluster/ClusterBootstrapOptions.js';
import type { ClusterBootstrapOptionsBuilder } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

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
  readonly shutdownAfterUnsuccessfulJoinMs: number;
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

/* -------------------------------------------------------------------------- */
/* The join give-up behind stable observation                                  */
/* -------------------------------------------------------------------------- */

/** Counts `start()` — what says a refused bootstrap never reached the join. */
class CountingTransport extends InMemoryTransport {
  startCalls = 0;

  override async start(): Promise<void> {
    this.startCalls++;
    await super.start();
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the bootstrap to reject, and it resolved');
}

/**
 * Every system `bootstrapCluster` creates while `run` runs.  The bootstrap
 * builds its system itself, so the one way to ask afterwards whether it is
 * still up is to see it created: `ActorSystem.create` is spied for the
 * duration and restored after (`spyOn` puts the property back;
 * `mock.module` would not).  Anything an assertion left running is
 * terminated on the way out.
 */
async function observingSystems<T>(run: (created: ActorSystem[]) => Promise<T>): Promise<T> {
  const created: ActorSystem[] = [];
  const create = ActorSystem.create.bind(ActorSystem);
  const spy = spyOn(ActorSystem, 'create').mockImplementation((...args: Parameters<typeof ActorSystem.create>) => {
    const system = create(...args);
    created.push(system);
    return system;
  });
  try {
    return await run(created);
  } finally {
    spy.mockRestore();
    for (const system of created) {
      if (!system.isTerminated) await system.terminate().catch(() => {});
    }
  }
}

describe('the give-up refusal reads the deadline the join will arm (#1500, #860)', () => {
  // Behind stable observation every node but the elected one waits out the
  // founder's grace with nothing able to promote it, so a give-up that does
  // not clear the grace plus the readiness budget is refused before the join.
  // The deadline the join arms is the caller's value over the file's — the
  // bootstrap forwards it — so that is the value the refusal has to judge:
  // judging the file alone would refuse a deadline the join never sees and
  // pass one it arms.
  const graceMs = 250;
  const budgetMs = graceMs + DEFAULT_AWAIT_READY_MS;
  const tuning = { pollIntervalMs: 5, stableMarginMs: 0, maxWaitMs: 2_000, selfElectionGraceMs: graceMs };

  /**
   * One node of a two-node seed list, the lower address, so it wins the
   * election — the refusal holds on the winner too — and, unrefused, returns
   * at once: `awaitReady: false` leaves the pending self-election behind it.
   */
  function electedNode(name: string, port: number, transport: InMemoryTransport): ClusterBootstrapOptionsBuilder {
    return ClusterBootstrapOptions.create(name)
      .withHost('h')
      .withPort(port)
      .withSeeds([`${name}@h:${port}`, `${name}@h:${port + 1}`])
      .withStableObservation(tuning)
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger());
  }

  function fileGiveUp(ms: number): Config {
    return Config.parseString(`actor-ts.cluster.shutdown-after-unsuccessful-join = ${ms}ms`);
  }

  test('a give-up on the bootstrap options inside the budget is refused before anything starts', async () => {
    // The budget exactly, which "does not exceed" includes.  The file says
    // nothing beyond the shipped `0s`, so only the explicit value can trip it.
    const name = 'forwarding-give-up-refused';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_821));
    const bootstrapOptions = electedNode(name, 45_821, transport)
      .withShutdownAfterUnsuccessfulJoinMs(budgetMs);

    const { caught, systems } = await observingSystems(async (created) => ({
      caught: await rejectionOf(bootstrapCluster(bootstrapOptions)),
      systems: [...created],
    }));

    expect(caught).toBeInstanceOf(OptionsError);
    const refusal = caught as OptionsError;
    expect(refusal.field).toBe('shutdownAfterUnsuccessfulJoinMs');
    expect(refusal.message).toContain('actor-ts.cluster.bootstrap.self-election-grace');
    expect(transport.startCalls).toBe(0);
    expect(systems.map((system) => system.isTerminated)).toEqual([true]);
  });

  test('a give-up on the bootstrap options past the budget overrides a file inside it', async () => {
    const name = 'forwarding-give-up-past-budget';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_831));
    const bootstrapOptions = electedNode(name, 45_831, transport)
      .withConfig(fileGiveUp(budgetMs))
      .withShutdownAfterUnsuccessfulJoinMs(budgetMs + 1);

    const node = await bootstrapCluster(bootstrapOptions);
    started.push(node);

    // Accepted, joined, and armed with the caller's deadline, not the file's.
    expect(transport.startCalls).toBe(1);
    expect(mergedSettingsOf(node.cluster).shutdownAfterUnsuccessfulJoinMs).toBe(budgetMs + 1);
  });

  test('a give-up of 0 on the bootstrap options overrides a file inside the budget', async () => {
    // `0` arms no deadline, so there is nothing to refuse — a refusal that
    // read truthiness would fall through to the file's value and refuse it.
    const name = 'forwarding-give-up-zero';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_841));
    const bootstrapOptions = electedNode(name, 45_841, transport)
      .withConfig(fileGiveUp(budgetMs))
      .withShutdownAfterUnsuccessfulJoinMs(0);

    const node = await bootstrapCluster(bootstrapOptions);
    started.push(node);

    expect(transport.startCalls).toBe(1);
    expect(mergedSettingsOf(node.cluster).shutdownAfterUnsuccessfulJoinMs).toBe(0);
  });

  test('with nothing on the bootstrap options, the file\'s give-up inside the budget is still refused', async () => {
    const name = 'forwarding-give-up-file-refused';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_851));
    const bootstrapOptions = electedNode(name, 45_851, transport)
      .withConfig(fileGiveUp(budgetMs));

    const { caught, systems } = await observingSystems(async (created) => ({
      caught: await rejectionOf(bootstrapCluster(bootstrapOptions)),
      systems: [...created],
    }));

    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('shutdownAfterUnsuccessfulJoinMs');
    expect(transport.startCalls).toBe(0);
    expect(systems.map((system) => system.isTerminated)).toEqual([true]);
  });

  test('a give-up that is not a non-negative number is refused before any system exists', async () => {
    // The bootstrap judges the deadline itself, before the join's validator
    // ever sees it, so it holds the value to that validator's rule first —
    // otherwise `NaN` would reach the election rule and be refused for the
    // wrong reason, after a system had been built.
    const invalidCases = [
      { label: 'nan', giveUpMs: Number.NaN },
      { label: 'negative', giveUpMs: -1 },
    ] as const;
    for (const { label, giveUpMs } of invalidCases) {
      const name = `forwarding-give-up-${label}`;
      const transport = new CountingTransport(new NodeAddress(name, 'h', 45_861));
      const bootstrapOptions = electedNode(name, 45_861, transport)
        .withShutdownAfterUnsuccessfulJoinMs(giveUpMs);

      const { caught, systems } = await observingSystems(async (created) => ({
        caught: await rejectionOf(bootstrapCluster(bootstrapOptions)),
        systems: [...created],
      }));

      expect(caught).toBeInstanceOf(OptionsError);
      const refusal = caught as OptionsError;
      expect(refusal.field).toBe('shutdownAfterUnsuccessfulJoinMs');
      expect(refusal.message).toContain('must be a non-negative finite number');
      expect(systems).toEqual([]);
    }
  });
});
