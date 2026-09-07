/**
 * #839 — the split-brain stability window, at the seams the integration test
 * cannot reach: the options triad, the validator, the escalation derivation
 * and the config reader.
 *
 * The *behaviour* — a provider that is not consulted mid-churn, a settled
 * partition that still resolves, and the escalation — lives in
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
  DEFAULT_UNSTABLE_ESCALATION_FACTOR,
  SplitBrainResolverOptions,
  SplitBrainResolverOptionsValidator,
  readSplitBrainResolverOptionsFromConfig,
  unstableEscalationDeadlineMs,
} from '../../../src/cluster/downing/SplitBrainResolverOptions.js';
import type { SplitBrainResolverOptionsType } from '../../../src/cluster/downing/SplitBrainResolverOptions.js';

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
