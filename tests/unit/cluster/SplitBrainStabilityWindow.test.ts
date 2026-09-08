/**
 * #839 — the split-brain stability window, at the seams the integration test
 * cannot reach: the options triad, the validator, the escalation derivation,
 * the config reader, and the window's own guards with the clock supplied.
 *
 * The last of those is why `StabilityWindow` is a class rather than three
 * fields on `Cluster`.  Four of its lines were load-bearing and bound by
 * nothing — each could be deleted with the whole cluster suite green — because
 * the difference they make is one tick wide, or is a state a live cluster
 * cannot be steered into on demand.  With `now` passed in they are ordinary
 * assertions, and every one of them below was watched failing against the line
 * removed.
 *
 * The rest of the *behaviour* — a provider that is not consulted mid-churn, a
 * settled partition that still resolves, and a partitioned peer arbitrated
 * despite churn — lives in
 * `tests/integration/in-process/cluster/downing/DowningWiring.test.ts`, which
 * needs a live cluster and a failure detector to have any of it happen at all.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  DEFAULT_DOWN_ALL_WHEN_UNSTABLE,
  DEFAULT_STABLE_AFTER_MS,
  DEFAULT_UNREACHABLE_ARBITRATION_FACTOR,
  DEFAULT_UNSTABLE_ESCALATION_FACTOR,
  SplitBrainResolverOptions,
  SplitBrainResolverOptionsValidator,
  readSplitBrainResolverOptionsFromConfig,
  unreachableArbitrationDeadlineMs,
  unstableEscalationDeadlineMs,
} from '../../../src/cluster/downing/SplitBrainResolverOptions.js';
import type { SplitBrainResolverOptionsType } from '../../../src/cluster/downing/SplitBrainResolverOptions.js';
import { StabilityWindow } from '../../../src/cluster/downing/StabilityWindow.js';

describe('SplitBrainResolverOptions — the triad (#839)', () => {
  test('a builder is structurally the plain settings object', () => {
    const resolverPolicy = SplitBrainResolverOptions.create()
      .withStableAfterMs(30_000)
      .withDownAllWhenUnstable(true);

    expect({ ...resolverPolicy })
      .toEqual({ stableAfterMs: 30_000, downAllWhenUnstable: true });
  });

  test('the validator refuses a zero window rather than reading it as "no window"', () => {
    // `off` already spells "do not arbitrate", and it lives one key over on
    // `active-strategy`.  A second spelling here would mean the same
    // deployment could ask for a strategy and get a verdict computed on the
    // first mid-partition tick — the state the window exists to remove.
    expect(() => new SplitBrainResolverOptionsValidator().validate({ stableAfterMs: 0 }))
      .toThrow(OptionsError);
    expect(() => new SplitBrainResolverOptionsValidator().validate({ stableAfterMs: -1 }))
      .toThrow(OptionsError);
  });

  test('an unset window passes, so the built-in default still applies', () => {
    expect(() => new SplitBrainResolverOptionsValidator().validate({})).not.toThrow();
    expect(() => new SplitBrainResolverOptionsValidator()
      .validate({ downAllWhenUnstable: true })).not.toThrow();
  });

  test('the escalation deadline is derived from the window, not configured beside it', () => {
    // A fourth key would be a number an operator has to keep consistent with
    // this one, and a margin below the window could never observe a single
    // quiet window before escalating.
    expect(unstableEscalationDeadlineMs(DEFAULT_STABLE_AFTER_MS))
      .toBe(DEFAULT_STABLE_AFTER_MS * DEFAULT_UNSTABLE_ESCALATION_FACTOR);
    expect(unstableEscalationDeadlineMs(1_000)).toBe(3_000);
    expect(Config.loadReference().hasPath('actor-ts.cluster.split-brain-resolver.unstable-margin'))
      .toBe(false);
  });

  test('escalation ships off — the posture, stated where it is decided', () => {
    // Pinned rather than left to the docs: this is the one action in the
    // subsystem that ends the whole cluster, and flipping the shipped value
    // is a decision, not a tidy-up.
    expect(DEFAULT_DOWN_ALL_WHEN_UNSTABLE).toBe(false);
    expect(Config.loadReference()
      .getBoolean(ConfigKeys.cluster.splitBrainResolver.downAllWhenUnstable)).toBe(false);
  });
});

describe('StabilityWindow — the ordinary window (#839)', () => {
  const WINDOW_MS = 1_000;
  const ONE_PEER: ReadonlySet<string> = new Set(['peer@h:1']);

  test('the view has to hold still for a whole window, and then it settles', () => {
    const window = new StabilityWindow(WINDOW_MS, false);

    // The first observation is not a settled view — there is nothing yet for
    // it to have held still *against*.
    expect(window.observe('view-a', ONE_PEER, 0)).toBe(false);
    expect(window.observe('view-a', ONE_PEER, WINDOW_MS - 1)).toBe(false);
    expect(window.observe('view-a', ONE_PEER, WINDOW_MS)).toBe(true);

    // …and one change resets it, however long it had held before.
    expect(window.observe('view-b', ONE_PEER, WINDOW_MS + 1)).toBe(false);
    expect(window.observe('view-b', ONE_PEER, WINDOW_MS * 2)).toBe(false);
    expect(window.observe('view-b', ONE_PEER, WINDOW_MS * 2 + 1)).toBe(true);
  });
});

describe('StabilityWindow — the ceiling on the window (#839)', () => {
  const WINDOW_MS = 1_000;
  const ONE_PEER: ReadonlySet<string> = new Set(['peer@h:1']);

  test('the ceiling sits above one window and below the escalation deadline', () => {
    // The whole ordering rationale, pinned: strictly above one window, so a
    // view that does settle is always arbitrated through the ordinary path
    // first and the ceiling never becomes the normal case; strictly below the
    // escalation deadline, so a strategy is asked before the switch that stops
    // the cluster can fire.
    expect(DEFAULT_UNREACHABLE_ARBITRATION_FACTOR).toBeGreaterThan(1);
    expect(DEFAULT_UNREACHABLE_ARBITRATION_FACTOR)
      .toBeLessThan(DEFAULT_UNSTABLE_ESCALATION_FACTOR);
    expect(unreachableArbitrationDeadlineMs(WINDOW_MS))
      .toBe(WINDOW_MS * DEFAULT_UNREACHABLE_ARBITRATION_FACTOR);
  });

  test('churn cannot starve a peer that has been unreachable the whole time', () => {
    const window = new StabilityWindow(WINDOW_MS, false);
    const ceilingMs = unreachableArbitrationDeadlineMs(WINDOW_MS);
    expect(window.observe('view-0', ONE_PEER, 0)).toBe(false);

    // A change every 100 ms: the view never once holds still, so the ordinary
    // window can never elapse — this is the shipped tree's behaviour, and on
    // its own it is a resolver that is never consulted at all.
    for (let now = 100; now < ceilingMs; now += 100) {
      expect(window.observe(`view-${now}`, ONE_PEER, now)).toBe(false);
      expect(window.hasOutlastedChurn(now)).toBe(false);
    }

    // The peer's own silence, though, has been uninterrupted throughout, and
    // at the ceiling that is a settled fact whatever else is moving.
    expect(window.observe(`view-${ceilingMs}`, ONE_PEER, ceilingMs)).toBe(false);
    expect(window.hasOutlastedChurn(ceilingMs)).toBe(true);
  });

  test('a peer that recovers starts its clock over rather than resuming it', () => {
    // Otherwise a flapping peer would accumulate its way past the ceiling out
    // of intervals none of which was long enough to mean anything.
    const window = new StabilityWindow(WINDOW_MS, false);
    const ceilingMs = unreachableArbitrationDeadlineMs(WINDOW_MS);

    window.observe('view-0', ONE_PEER, 0);
    window.observe('view-1', ONE_PEER, ceilingMs - 100);
    expect(window.hasOutlastedChurn(ceilingMs - 100)).toBe(false);

    window.observe('view-2', new Set(), ceilingMs - 50);
    window.observe('view-3', ONE_PEER, ceilingMs);
    expect(window.hasOutlastedChurn(ceilingMs * 2 - 1)).toBe(false);
    expect(window.hasOutlastedChurn(ceilingMs * 2)).toBe(true);
  });
});

describe('StabilityWindow — down-all-when-unstable (#839)', () => {
  const WINDOW_MS = 1_000;
  const DEADLINE_MS = unstableEscalationDeadlineMs(WINDOW_MS);
  const ONE_PEER: ReadonlySet<string> = new Set(['peer@h:1']);
  const NOTHING_UNREACHABLE: ReadonlySet<string> = new Set();

  test('an empty unreachable set never escalates, however long the churn runs', () => {
    // Churn is not a partition.  A rolling deploy whose replacements arrive
    // faster than the window looks exactly like a cluster that will not
    // settle, and stopping it would answer a question nobody asked.
    const window = new StabilityWindow(WINDOW_MS, true);
    window.observe('view-0', NOTHING_UNREACHABLE, 0);
    for (let now = 100; now <= DEADLINE_MS * 2; now += 100) {
      window.observe(`view-${now}`, NOTHING_UNREACHABLE, now);
      expect(window.takeEscalation(NOTHING_UNREACHABLE, now)).toBeNull();
    }

    // Not vacuous: the very same run, at the very same instant, escalates the
    // moment one member is unreachable — so the empty set was the only thing
    // holding it back, not a deadline that had never been reached.
    expect(window.takeEscalation(ONE_PEER, DEADLINE_MS * 2)).toBe(DEADLINE_MS * 2 - 100);
  });

  test('the deadline is three whole windows of uninterrupted churn', () => {
    const window = new StabilityWindow(WINDOW_MS, true);
    window.observe('view-0', ONE_PEER, 0);
    // The run starts at the first *change*, so every span below is measured
    // from 10 rather than from 0.
    window.observe('view-1', ONE_PEER, 10);

    for (let now = 100; now <= DEADLINE_MS + 10; now += 10) {
      window.observe(`view-${now}`, ONE_PEER, now);
      // `<=` and not `<`: at exactly the deadline the run has lasted three
      // windows, not longer than three.
      expect(window.takeEscalation(ONE_PEER, now)).toBeNull();
    }

    window.observe(`view-${DEADLINE_MS + 20}`, ONE_PEER, DEADLINE_MS + 20);
    expect(window.takeEscalation(ONE_PEER, DEADLINE_MS + 20)).toBe(DEADLINE_MS + 10);
  });

  test('escalating consumes the run, so the announcement happens once', () => {
    const window = new StabilityWindow(WINDOW_MS, true);
    window.observe('view-0', ONE_PEER, 0);
    window.observe('view-1', ONE_PEER, 10);
    const firedAt = DEADLINE_MS + 100;
    window.observe(`view-${firedAt}`, ONE_PEER, firedAt);

    expect(window.takeEscalation(ONE_PEER, firedAt)).toBe(firedAt - 10);
    // Applying that decision downs this node too; a second escalation on the
    // way out would announce the whole thing again from a cluster that is
    // already leaving.
    expect(window.takeEscalation(ONE_PEER, firedAt)).toBeNull();
  });

  test('one quiet window ends the run, so the deadline measures uninterrupted churn', () => {
    const window = new StabilityWindow(WINDOW_MS, true);
    expect(window.observe('view-0', ONE_PEER, 0)).toBe(false);

    // Two windows' worth of churn — not enough on its own.
    for (let now = 100; now <= WINDOW_MS * 2 + 100; now += 100) {
      expect(window.observe(`first-run-${now}`, ONE_PEER, now)).toBe(false);
      expect(window.takeEscalation(ONE_PEER, now)).toBeNull();
    }

    // Then one whole window in which the view does hold still.
    expect(window.observe('settled', ONE_PEER, 2_200)).toBe(false);
    expect(window.observe('settled', ONE_PEER, 3_100)).toBe(false);
    expect(window.observe('settled', ONE_PEER, 3_200)).toBe(true);

    // …and two more windows of churn.  Nothing escalates: the quiet window
    // ended the first run, so the second one is only two windows old — even
    // though *five* windows have now passed since the first change.
    for (let now = 3_300; now <= 5_400; now += 100) {
      expect(window.observe(`second-run-${now}`, ONE_PEER, now)).toBe(false);
      expect(window.takeEscalation(ONE_PEER, now)).toBeNull();
    }
  });

  test('the first observation is not a change, so a node does not start inside a run', () => {
    // A node that has just started has no previous view to differ from.
    // Counting that as churn would begin every node's life inside an
    // instability run, and `down-all-when-unstable` would then be measuring
    // cluster formation.  The difference is exactly the gap between the first
    // observation and the first real change — 500 ms here, one tick in a live
    // cluster, which is why this assertion cannot be made against one.
    const window = new StabilityWindow(WINDOW_MS, true);
    const FIRST_CHANGE_MS = 500;
    expect(window.observe('view-0', ONE_PEER, 0)).toBe(false);
    expect(window.observe('view-1', ONE_PEER, FIRST_CHANGE_MS)).toBe(false);

    // Past three windows measured from the first observation, still inside
    // three measured from the first change.
    for (let now = 600; now <= DEADLINE_MS + 400; now += 100) {
      expect(window.observe(`view-${now}`, ONE_PEER, now)).toBe(false);
      expect(window.takeEscalation(ONE_PEER, now)).toBeNull();
    }

    const firedAt = DEADLINE_MS + FIRST_CHANGE_MS + 100;
    window.observe(`view-${firedAt}`, ONE_PEER, firedAt);
    expect(window.takeEscalation(ONE_PEER, firedAt)).toBe(DEADLINE_MS + 100);
  });

  test('the switch off means no escalation, whatever the run', () => {
    const window = new StabilityWindow(WINDOW_MS, false);
    window.observe('view-0', ONE_PEER, 0);
    for (let now = 100; now <= DEADLINE_MS * 3; now += 100) {
      window.observe(`view-${now}`, ONE_PEER, now);
      expect(window.takeEscalation(ONE_PEER, now)).toBeNull();
    }
  });
});

describe('readSplitBrainResolverOptionsFromConfig (#839)', () => {
  test('reads both leaves, and only the ones written', () => {
    // `Config.parseString`, never `Config.fromObject` with a dotted key: that
    // keeps the dotted string as a literal top-level key, so `hasPath` would
    // resolve the *reference* value behind it and this would assert the
    // shipped default rather than what is written here.
    expect(readSplitBrainResolverOptionsFromConfig(Config.parseString(`
      actor-ts.cluster.split-brain-resolver {
        stable-after           = 90s
        down-all-when-unstable = on
      }
    `))).toEqual({ stableAfterMs: 90_000, downAllWhenUnstable: true });

    expect(readSplitBrainResolverOptionsFromConfig(
      Config.parseString('actor-ts.cluster.split-brain-resolver.stable-after = 5s'),
    )).toEqual({ stableAfterMs: 5_000 });
  });

  test('an empty config yields nothing, so an absent leaf falls through', () => {
    expect(readSplitBrainResolverOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('the reference block reads back as the built-in defaults', () => {
    expect(readSplitBrainResolverOptionsFromConfig(Config.loadReference())).toEqual({
      stableAfterMs: DEFAULT_STABLE_AFTER_MS,
      downAllWhenUnstable: DEFAULT_DOWN_ALL_WHEN_UNSTABLE,
    });
  });

  test('the switch is a boolean, so HOCON\'s three spellings of one all work', () => {
    for (const spelling of ['true', 'on', 'yes']) {
      expect(readSplitBrainResolverOptionsFromConfig(Config.parseString(
        `actor-ts.cluster.split-brain-resolver.down-all-when-unstable = ${spelling}`,
      ))).toEqual({ downAllWhenUnstable: true });
    }
  });
});

describe('Cluster.join validates the resolver policy (#839)', () => {
  /**
   * The validator has to run in the consumer, or a bad value reaches the tick
   * loop instead of the operator: `Cluster` is where the merged block is
   * resolved, which is the same place `FailureDetector` validates its own.
   */
  async function joinWith(
    splitBrainResolver: Partial<SplitBrainResolverOptionsType>,
    port: number,
  ): Promise<Cluster> {
    const systemName = 'sbr-policy-validation';
    const system = ActorSystem.create(
      systemName,
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
      .withSplitBrainResolver(splitBrainResolver);
    try {
      return await Cluster.join(system, clusterOptions);
    } finally {
      await system.terminate();
    }
  }

  test('a zero window is refused at join, not at the first tick', async () => {
    await expect(joinWith({ stableAfterMs: 0 }, 64_301)).rejects.toThrow(OptionsError);
  });

  test('a positive window joins', async () => {
    const cluster = await joinWith({ stableAfterMs: 1 }, 64_302);
    expect(cluster.selfAddress.port).toBe(64_302);
  });
});
