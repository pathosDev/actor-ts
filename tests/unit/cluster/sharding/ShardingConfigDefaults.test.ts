import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { Props } from '../../../../src/Props.js';
import { Config } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import { ShardRegion } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import { readShardingOptionsFromConfig } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import type { Cluster } from '../../../../src/cluster/Cluster.js';
import { mergeOptions } from '../../../../src/util/OptionsMerge.js';

describe('readShardingOptionsFromConfig', () => {
  test('reads every key of the sharding block', () => {
    const config = Config.parseString(`
      actor-ts.sharding {
        number-of-shards   = 128
        remember-entities  = true
        passivation-idle   = 2 minutes
        max-entities       = 50000
        rebalance-interval = 5s
        hand-off-timeout   = 30s
      }
    `);

    expect(readShardingOptionsFromConfig(config)).toEqual({
      numShards: 128,
      rememberEntities: true,
      passivationIdleMs: 120_000,
      maxEntities: 50_000,
      rebalanceIntervalMs: 5_000,
      handOffTimeoutMs: 30_000,
    });
  });

  test('omits absent keys entirely rather than reporting them as undefined', () => {
    const config = Config.parseString('actor-ts.sharding.passivation-idle = 90s');
    const fromConfig = readShardingOptionsFromConfig(config);

    expect(fromConfig).toEqual({ passivationIdleMs: 90_000 });
    // The distinction that matters: a present-but-undefined key would shadow
    // the built-in default once spread.
    expect(Object.keys(fromConfig)).toEqual(['passivationIdleMs']);
  });

  test('an empty config yields no settings at all', () => {
    expect(readShardingOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // The values `reference.conf` ships have to match what the code falls back
    // to, or merely wiring the block would change behaviour for everyone.
    //
    // `shardPassivationIdleMs` is absent by design, and the exact-object
    // assertion is what holds it that way: shipping a value would make
    // `hasPath` true forever and the "follow passivationIdleMs" default
    // unreachable.
    const config = Config.loadReference();

    expect(readShardingOptionsFromConfig(config)).toEqual({
      numShards: 64,
      rememberEntities: false,
      passivationIdleMs: 300_000,
      maxEntities: 0,
      rebalanceIntervalMs: 2_000,
      handOffTimeoutMs: 10_000,
    });
  });

  test('reads shard-passivation-idle when an operator sets it', () => {
    const config = Config.parseString('actor-ts.sharding.shard-passivation-idle = 90s');

    expect(readShardingOptionsFromConfig(config)).toEqual({ shardPassivationIdleMs: 90_000 });
  });

  test('every key it reads is reachable from ConfigKeys', () => {
    expect(ConfigKeys.sharding).toEqual({
      numberOfShards: 'actor-ts.sharding.number-of-shards',
      rememberEntities: 'actor-ts.sharding.remember-entities',
      passivationIdle: 'actor-ts.sharding.passivation-idle',
      shardPassivationIdle: 'actor-ts.sharding.shard-passivation-idle',
      maxEntities: 'actor-ts.sharding.max-entities',
      rebalanceInterval: 'actor-ts.sharding.rebalance-interval',
      handOffTimeout: 'actor-ts.sharding.hand-off-timeout',
    });
  });
});

describe('ShardRegion.settingsToConfig — the two passivation windows', () => {
  class NoopEntity extends Actor<unknown> {
    override onReceive(): void {}
  }

  /**
   * `settingsToConfig` only stores the cluster and the resolver, so a unit
   * test can hand it placeholders and still exercise the real defaulting.
   */
  const resolve = (extra: Partial<ShardingOptionsType<unknown>>): ReturnType<typeof ShardRegion.settingsToConfig<unknown>> =>
    ShardRegion.settingsToConfig<unknown>(
      {
        typeName: 'entity',
        entityProps: Props.create(() => new NoopEntity()),
        extractEntityId: (message: unknown) => String(message),
        ...extra,
      } as ShardingOptionsType<unknown>,
      null as unknown as Cluster,
      () => null,
    );

  test('unset, both windows are the built-in five minutes', () => {
    const config = resolve({});

    expect(config.passivationIdleMs).toBe(300_000);
    expect(config.shardPassivationIdleMs).toBe(300_000);
  });

  test('the shard window follows an explicit entity window', () => {
    // The whole point of leaving it unset: a shard stands empty because its
    // entities went idle, so it inherits their idleness rather than a default
    // that has nothing to do with them.
    expect(resolve({ passivationIdleMs: 30_000 }).shardPassivationIdleMs).toBe(30_000);
  });

  test('disabling entity passivation disables the shard sweep with it', () => {
    expect(resolve({ passivationIdleMs: 0 }).shardPassivationIdleMs).toBe(0);
  });

  test('an explicit shard window decouples the two', () => {
    const config = resolve({ passivationIdleMs: 30_000, shardPassivationIdleMs: 600_000 });

    expect(config.passivationIdleMs).toBe(30_000);
    expect(config.shardPassivationIdleMs).toBe(600_000);
  });

  test('shardPassivationIdleMs = 0 keeps empty shards while entities still passivate', () => {
    // `0` is a real value, not "unset" — it must not fall through to 30_000.
    const config = resolve({ passivationIdleMs: 30_000, shardPassivationIdleMs: 0 });

    expect(config.passivationIdleMs).toBe(30_000);
    expect(config.shardPassivationIdleMs).toBe(0);
  });
});

describe('sharding options precedence', () => {
  const config = Config.parseString(`
    actor-ts.sharding {
      number-of-shards = 128
      passivation-idle = 2 minutes
    }
  `);

  test('an explicit option beats HOCON, field by field', () => {
    const merged = mergeOptions<{ numShards?: number; passivationIdleMs?: number }>(
      {},
      readShardingOptionsFromConfig(config),
      { numShards: 256 },
    );

    expect(merged.numShards).toBe(256);
    expect(merged.passivationIdleMs).toBe(120_000);
  });

  test('an explicit `undefined` means "not set" and falls through to HOCON', () => {
    const merged = mergeOptions<{ numShards?: number }>(
      {},
      readShardingOptionsFromConfig(config),
      { numShards: undefined },
    );

    expect(merged.numShards).toBe(128);
  });

  test('an explicit `0` is a real value and does shadow HOCON', () => {
    // The falsy-but-set case: `0` disables passivation, and must not be
    // mistaken for "unset" the way `undefined` is.
    const merged = mergeOptions<{ passivationIdleMs?: number }>(
      {},
      readShardingOptionsFromConfig(config),
      { passivationIdleMs: 0 },
    );

    expect(merged.passivationIdleMs).toBe(0);
  });
});
