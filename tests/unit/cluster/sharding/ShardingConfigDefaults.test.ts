import { describe, expect, test } from 'bun:test';
import { Config } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import { readShardingOptionsFromConfig } from '../../../../src/cluster/sharding/StartShardingOptions.js';
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
    const config = Config.loadReference();

    expect(readShardingOptionsFromConfig(config)).toEqual({
      numShards: 64,
      rememberEntities: false,
      passivationIdleMs: 0,
      maxEntities: 0,
      rebalanceIntervalMs: 2_000,
      handOffTimeoutMs: 10_000,
    });
  });

  test('every key it reads is reachable from ConfigKeys', () => {
    expect(ConfigKeys.sharding).toEqual({
      numberOfShards: 'actor-ts.sharding.number-of-shards',
      rememberEntities: 'actor-ts.sharding.remember-entities',
      passivationIdle: 'actor-ts.sharding.passivation-idle',
      maxEntities: 'actor-ts.sharding.max-entities',
      rebalanceInterval: 'actor-ts.sharding.rebalance-interval',
      handOffTimeout: 'actor-ts.sharding.hand-off-timeout',
    });
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
