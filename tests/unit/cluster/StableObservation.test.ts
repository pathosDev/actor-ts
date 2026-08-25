import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  StableObservation,
  StableObservationError,
} from '../../../src/cluster/bootstrap/StableObservation.js';
import {
  readStableObservationOptionsFromConfig,
  StableObservationOptions,
} from '../../../src/cluster/bootstrap/StableObservationOptions.js';
import { isWildcardHost } from '../../../src/cluster/ClusterOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { SeedProvider } from '../../../src/discovery/SeedProvider.js';

/**
 * Contact-point discovery under test control: each `lookup()` consumes the
 * next step of a script, and the last step repeats forever.  A step is either
 * the addresses the provider returns or an `Error` it throws — the two cases
 * the observation must keep apart (an exception is *no* observation, not an
 * empty one).
 */
class ScriptedSeedProvider implements SeedProvider {
  lookups = 0;

  constructor(private readonly script: ReadonlyArray<NodeAddress[] | Error>) {}

  async lookup(): Promise<NodeAddress[]> {
    const step = this.script[Math.min(this.lookups, this.script.length - 1)]!;
    this.lookups++;
    if (step instanceof Error) throw step;
    return [...step];
  }
}

const address = (host: string, port = 2552): NodeAddress => new NodeAddress('app', host, port);

/** Fast timings — the behaviour under test is ordering, not duration. */
const fast = {
  pollIntervalMs: 5,
  stableMarginMs: 20,
  maxWaitMs: 2_000,
} as const;

const nodeA = address('10.0.0.1');
const nodeB = address('10.0.0.2');
const nodeC = address('10.0.0.3');

function observationOf(
  self: NodeAddress,
  provider: SeedProvider,
  overrides: Record<string, unknown> = {},
): StableObservation {
  return new StableObservation({
    seedProvider: provider,
    selfAddress: self,
    ...fast,
    ...overrides,
  });
}

describe('StableObservation — election', () => {
  test('the lowest-addressed contact point is elected initial seed', async () => {
    const provider = new ScriptedSeedProvider([[nodeA, nodeB, nodeC]]);

    const targets = await observationOf(nodeA, provider).resolveJoinTargets();

    expect(targets.isInitialSeed).toBe(true);
    // A grace, not 'immediate': the winner still dials its seeds first, so an
    // existing cluster gets the chance to promote it before it forms its own.
    expect(typeof targets.selfElection).toBe('number');
    expect(targets.contactPoints.map((a) => a.toString())).toEqual([
      'app@10.0.0.1:2552', 'app@10.0.0.2:2552', 'app@10.0.0.3:2552',
    ]);
    // Seeds exclude self and include the peers — the winner joins like everyone else.
    expect(targets.seeds.map((a) => a.toString())).toEqual([
      'app@10.0.0.2:2552', 'app@10.0.0.3:2552',
    ]);
  });

  test('every other node is forbidden from self-electing', async () => {
    const provider = new ScriptedSeedProvider([[nodeA, nodeB, nodeC]]);

    const targets = await observationOf(nodeC, provider).resolveJoinTargets();

    expect(targets.isInitialSeed).toBe(false);
    expect(targets.selfElection).toBe('never');
    expect(targets.seeds.map((a) => a.toString())).toEqual([
      'app@10.0.0.1:2552', 'app@10.0.0.2:2552',
    ]);
  });

  test('all three observers elect the same node from the same stable set', async () => {
    const elected = await Promise.all([nodeA, nodeB, nodeC].map(async (self) => {
      const provider = new ScriptedSeedProvider([[nodeA, nodeB, nodeC]]);
      const targets = await observationOf(self, provider).resolveJoinTargets();
      return targets.isInitialSeed ? self.toString() : targets.contactPoints[0]!.toString();
    }));

    expect(new Set(elected)).toEqual(new Set(['app@10.0.0.1:2552']));
  });

  test('self is a contact point even when discovery never mentions it', async () => {
    const provider = new ScriptedSeedProvider([[nodeB]]);

    const targets = await observationOf(nodeA, provider).resolveJoinTargets();

    expect(targets.contactPoints.map((a) => a.toString()))
      .toEqual(['app@10.0.0.1:2552', 'app@10.0.0.2:2552']);
    expect(targets.isInitialSeed).toBe(true);
  });

  test('a lone node elects itself and gets an empty seed list', async () => {
    const provider = new ScriptedSeedProvider([[]]);

    const targets = await observationOf(nodeA, provider).resolveJoinTargets();

    expect(targets.isInitialSeed).toBe(true);
    expect(targets.seeds).toEqual([]);
  });
});

describe('StableObservation — stability', () => {
  test('a growing view restarts the margin and settles on the full set', async () => {
    // The issue's DNS race: A sees only itself, then [A,B], then [A,B,C].
    const provider = new ScriptedSeedProvider([
      [], [nodeB], [nodeB, nodeC],
    ]);

    const targets = await observationOf(nodeA, provider).resolveJoinTargets();

    expect(targets.contactPoints.map((a) => a.toString())).toEqual([
      'app@10.0.0.1:2552', 'app@10.0.0.2:2552', 'app@10.0.0.3:2552',
    ]);
    // Three distinct views were seen, so the margin cannot have been satisfied
    // by the first two — settling took more polls than the script has steps.
    expect(targets.polls).toBeGreaterThan(3);
  });

  test('the order discovery returns addresses in does not count as a change', async () => {
    const provider = new ScriptedSeedProvider([
      [nodeB, nodeC], [nodeC, nodeB], [nodeB, nodeC],
    ]);

    const targets = await observationOf(nodeA, provider, { stableMarginMs: 0 })
      .resolveJoinTargets();

    // stableMarginMs: 0 settles on the first repeat, which only happens if
    // both orderings normalised to the same key.
    expect(targets.polls).toBe(2);
  });

  test('a lookup failure is not an empty observation', async () => {
    // The #943 shape: a discovery outage degraded to `[]` would settle here as
    // "I am alone" and self-elect.  It must instead run out of budget.
    const provider = new ScriptedSeedProvider([new Error('DNS SERVFAIL')]);

    const promise = observationOf(nodeA, provider, { maxWaitMs: 120 }).resolveJoinTargets();

    await expect(promise).rejects.toBeInstanceOf(StableObservationError);
    expect(provider.lookups).toBeGreaterThan(1);
  });

  test('a transient lookup failure neither settles nor resets a healthy margin', async () => {
    const provider = new ScriptedSeedProvider([
      [nodeB, nodeC], new Error('transient'), [nodeB, nodeC],
    ]);

    const targets = await observationOf(nodeA, provider).resolveJoinTargets();

    expect(targets.contactPoints).toHaveLength(3);
  });
});

describe('StableObservation — refusals', () => {
  test('runs out of budget with a set that never settles', async () => {
    let flip = 0;
    const provider: SeedProvider = { lookup: async () => (flip++ % 2 === 0 ? [nodeB] : [nodeC]) };

    const promise = observationOf(nodeA, provider, { maxWaitMs: 150 }).resolveJoinTargets();

    const error = await promise.catch((e: unknown) => e) as StableObservationError;
    expect(error).toBeInstanceOf(StableObservationError);
    // The message has to be actionable on its own — it is what an operator
    // reads out of a crash-looping pod.
    expect(error.message).toContain('did not stay unchanged');
    expect(error.message).toContain('app@10.0.0.1:2552');
    expect(error.polls).toBeGreaterThan(1);
    expect(error.lastObserved.length).toBeGreaterThan(0);
  });

  test('waits rather than settling below requiredContactPoints', async () => {
    const provider = new ScriptedSeedProvider([[nodeB]]);

    const promise = observationOf(nodeA, provider, {
      requiredContactPoints: 3, maxWaitMs: 120,
    }).resolveJoinTargets();

    const error = await promise.catch((e: unknown) => e) as StableObservationError;
    expect(error).toBeInstanceOf(StableObservationError);
    expect(error.message).toContain('requiredContactPoints=3');
  });

  test('settles once requiredContactPoints is finally met', async () => {
    const provider = new ScriptedSeedProvider([[nodeB], [nodeB, nodeC]]);

    const targets = await observationOf(nodeA, provider, { requiredContactPoints: 3 })
      .resolveJoinTargets();

    expect(targets.contactPoints).toHaveLength(3);
  });

  test('a wildcard self address is refused before any polling', async () => {
    const provider = new ScriptedSeedProvider([[nodeB]]);

    expect(() => observationOf(address('0.0.0.0'), provider)).toThrow(OptionsError);
    expect(provider.lookups).toBe(0);
  });

  test('a wildcard peer is dropped and does not count as a contact point', async () => {
    const provider = new ScriptedSeedProvider([[address('0.0.0.0'), nodeB]]);

    const promise = observationOf(nodeA, provider, {
      requiredContactPoints: 3, maxWaitMs: 120,
    }).resolveJoinTargets();

    await expect(promise).rejects.toBeInstanceOf(StableObservationError);
  });

  test('seedProvider and selfAddress are required', () => {
    expect(() => new StableObservation({ selfAddress: nodeA })).toThrow(TypeError);
    expect(() => new StableObservation({ seedProvider: new ScriptedSeedProvider([[]]) }))
      .toThrow(TypeError);
  });
});

describe('StableObservationOptionsValidator', () => {
  const provider = new ScriptedSeedProvider([[]]);

  test('rejects a budget that cannot outlast the margin', () => {
    expect(() => new StableObservation({
      seedProvider: provider, selfAddress: nodeA, stableMarginMs: 5_000, maxWaitMs: 5_000,
    })).toThrow(/must exceed stableMarginMs/);
  });

  test('rejects non-positive intervals and counts', () => {
    expect(() => new StableObservation({
      seedProvider: provider, selfAddress: nodeA, pollIntervalMs: 0,
    })).toThrow(OptionsError);
    expect(() => new StableObservation({
      seedProvider: provider, selfAddress: nodeA, requiredContactPoints: 0,
    })).toThrow(OptionsError);
    expect(() => new StableObservation({
      seedProvider: provider, selfAddress: nodeA, selfElectionGraceMs: -1,
    })).toThrow(OptionsError);
  });

  test('accepts a zero stable margin — the first repeat is enough', () => {
    expect(() => new StableObservation({
      seedProvider: provider, selfAddress: nodeA, stableMarginMs: 0,
    })).not.toThrow();
  });

  test('the builder and a plain object are interchangeable', async () => {
    const observationOptions = StableObservationOptions.create()
      .withSeedProvider(new ScriptedSeedProvider([[nodeB]]))
      .withSelfAddress(nodeA)
      .withPollIntervalMs(5)
      .withStableMarginMs(0)
      .withMaxWaitMs(2_000);

    const targets = await new StableObservation(observationOptions).resolveJoinTargets();

    expect(targets.isInitialSeed).toBe(true);
  });
});

describe('isWildcardHost', () => {
  test('accepts anything that identifies a node', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.1', 'pod-0.svc', '::1']) {
      expect(isWildcardHost(host)).toBe(false);
    }
  });

  test('refuses every spelling of "every interface"', () => {
    for (const host of ['', '  ', '*', '0.0.0.0', '::', '[::]', '::0', '0:0:0:0:0:0:0:0']) {
      expect(isWildcardHost(host)).toBe(true);
    }
  });
});

describe('readStableObservationOptionsFromConfig', () => {
  test('reads the bootstrap block', () => {
    const config = Config.parseString(`
      actor-ts.cluster.bootstrap {
        stable-margin           = 2s
        poll-interval           = 250ms
        max-wait                = 30s
        required-contact-points = 3
        self-election-grace     = 8s
      }
    `);

    expect(readStableObservationOptionsFromConfig(config)).toEqual({
      stableMarginMs: 2_000,
      pollIntervalMs: 250,
      maxWaitMs: 30_000,
      requiredContactPoints: 3,
      selfElectionGraceMs: 8_000,
    });
  });

  test('an empty config yields no settings at all', () => {
    expect(readStableObservationOptionsFromConfig(Config.empty())).toEqual({});
  });
});
