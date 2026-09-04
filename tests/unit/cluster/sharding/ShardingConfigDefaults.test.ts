import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
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
        number-of-shards           = 128
        role                       = "backend"
        remember-entities          = true
        passivation-idle           = 2 minutes
        max-entities               = 50000
        buffer-size                = 4096
        register-retry-interval    = 750ms
        rebalance-interval         = 5s
        hand-off-timeout           = 30s
        rebalance-absolute-limit   = 4
        rebalance-relative-limit   = 0.25
        acquire-retry-interval     = 1500ms
        shard-region-query-timeout = 9s
        entity-recovery {
          strategy = constant-rate
          constant-rate.frequency = 250ms
          constant-rate.number-of-entities = 12
        }
        stale-region-detection {
          enabled            = on
          heartbeat-interval = 2s
          stale-after        = 12s
        }
      }
    `);

    expect(readShardingOptionsFromConfig(config)).toEqual({
      numShards: 128,
      role: 'backend',
      rememberEntities: true,
      passivationIdleMs: 120_000,
      maxEntities: 50_000,
      bufferSize: 4_096,
      registerRetryIntervalMs: 750,
      rebalanceIntervalMs: 5_000,
      handOffTimeoutMs: 30_000,
      rebalanceAbsoluteLimit: 4,
      rebalanceRelativeLimit: 0.25,
      acquireRetryIntervalMs: 1_500,
      shardRegionQueryTimeoutMs: 9_000,
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: 250,
      entityRecoveryConstantRateNumberOfEntities: 12,
      staleRegionDetection: true,
      regionHeartbeatIntervalMs: 2_000,
      regionStaleAfterMs: 12_000,
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
    //
    // `role` is absent for the neighbouring reason and by a *different*
    // mechanism: the leaf does ship, as `""`, so `hasPath` IS true forever —
    // and the reader's empty-string skip is the only thing keeping `role: ''`
    // out of every merged options object on a node that configured nothing.
    const config = Config.loadReference();

    expect(readShardingOptionsFromConfig(config)).toEqual({
      numShards: 64,
      rememberEntities: false,
      passivationIdleMs: 300_000,
      maxEntities: 0,
      bufferSize: 100_000,
      registerRetryIntervalMs: 500,
      rebalanceIntervalMs: 2_000,
      handOffTimeoutMs: 10_000,
      // A ceiling ships ON: the default strategy re-homes 42 of these 64 shards
      // in one tick when a third node joins, and `0`/`0` — still expressible —
      // is what that unbounded behaviour now costs an operator to ask for.
      rebalanceAbsoluteLimit: 0,
      rebalanceRelativeLimit: 0.1,
      acquireRetryIntervalMs: 5_000,
      shardRegionQueryTimeoutMs: 5_000,
      // `all` is today's behaviour, so wiring `entity-recovery` changes nothing
      // for anyone who does not ask for pacing — and the two `constant-rate`
      // bounds ship anyway, because an operator who cannot see them cannot know
      // what switching the strategy would cost them.
      entityRecoveryStrategy: 'all',
      entityRecoveryConstantRateFrequencyMs: 100,
      entityRecoveryConstantRateNumberOfEntities: 5,
      // Ships `off`, and the two timings ship anyway — an operator who cannot
      // see them cannot judge what turning the switch on would cost.  The pair
      // is also what `StartShardingOptionsValidator`'s cross-field rule
      // compares against, so the shipped values have to be a legal pair (#853).
      staleRegionDetection: false,
      regionHeartbeatIntervalMs: 5_000,
      regionStaleAfterMs: 20_000,
    });
  });

  test('reads shard-passivation-idle when an operator sets it', () => {
    const config = Config.parseString('actor-ts.sharding.shard-passivation-idle = 90s');

    expect(readShardingOptionsFromConfig(config)).toEqual({ shardPassivationIdleMs: 90_000 });
  });

  test('an explicitly empty role is "unrestricted", not a role named ""', () => {
    // The shape an operator hits by uncommenting the shipped line and leaving
    // it alone.  `role: ''` would reach `ShardCoordinator.candidates()`, which
    // reads it as unrestricted anyway — but it would also *shadow* an explicit
    // `withRole` on the layer above, since `mergeOptions` only falls through on
    // `undefined`.  Omitting the key is what keeps the two readings the same.
    const config = Config.parseString('actor-ts.sharding.role = ""');

    expect(readShardingOptionsFromConfig(config)).toEqual({});
    expect(Object.keys(readShardingOptionsFromConfig(config))).toEqual([]);
  });

  test('every key it reads is reachable from ConfigKeys', () => {
    expect(ConfigKeys.sharding).toEqual({
      numberOfShards: 'actor-ts.sharding.number-of-shards',
      role: 'actor-ts.sharding.role',
      rememberEntities: 'actor-ts.sharding.remember-entities',
      passivationIdle: 'actor-ts.sharding.passivation-idle',
      shardPassivationIdle: 'actor-ts.sharding.shard-passivation-idle',
      maxEntities: 'actor-ts.sharding.max-entities',
      bufferSize: 'actor-ts.sharding.buffer-size',
      registerRetryInterval: 'actor-ts.sharding.register-retry-interval',
      rebalanceInterval: 'actor-ts.sharding.rebalance-interval',
      handOffTimeout: 'actor-ts.sharding.hand-off-timeout',
      rebalanceAbsoluteLimit: 'actor-ts.sharding.rebalance-absolute-limit',
      rebalanceRelativeLimit: 'actor-ts.sharding.rebalance-relative-limit',
      acquireRetryInterval: 'actor-ts.sharding.acquire-retry-interval',
      shardRegionQueryTimeout: 'actor-ts.sharding.shard-region-query-timeout',
      // Declared as three full dotted paths rather than one `entity-recovery`
      // block root, and the difference is not cosmetic: `NoDeadConfigKeys`
      // resolves a leaf through *any* config root above it, so a root-only
      // entry would let all three pass with nothing reading them (#851).
      entityRecoveryStrategy: 'actor-ts.sharding.entity-recovery.strategy',
      entityRecoveryConstantRateFrequency: 'actor-ts.sharding.entity-recovery.constant-rate.frequency',
      entityRecoveryConstantRateNumberOfEntities:
        'actor-ts.sharding.entity-recovery.constant-rate.number-of-entities',
      // Nested for the same reason and with the same caveat as
      // `entity-recovery` above: three full dotted paths, never a bare
      // `stale-region-detection` root (#853).
      staleRegionDetection: {
        enabled: 'actor-ts.sharding.stale-region-detection.enabled',
        heartbeatInterval: 'actor-ts.sharding.stale-region-detection.heartbeat-interval',
        staleAfter: 'actor-ts.sharding.stale-region-detection.stale-after',
      },
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
        entityActor: NoopEntity,
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

  test('entity recovery defaults to the unpaced burst, with the two bounds resolved', () => {
    // `all` is the pre-#851 behaviour, so a region built any way at all keeps
    // it unless someone asks otherwise; the two `constant-rate` bounds resolve
    // regardless, because the strategy can also arrive from the layer above.
    const config = resolve({});

    expect(config.entityRecoveryStrategy).toBe('all');
    expect(config.entityRecoveryConstantRateFrequencyMs).toBe(100);
    expect(config.entityRecoveryConstantRateNumberOfEntities).toBe(5);
  });

  test('an explicit recovery setting reaches the region config', () => {
    const config = resolve({
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: 250,
      entityRecoveryConstantRateNumberOfEntities: 20,
    });

    expect(config.entityRecoveryStrategy).toBe('constant-rate');
    expect(config.entityRecoveryConstantRateFrequencyMs).toBe(250);
    expect(config.entityRecoveryConstantRateNumberOfEntities).toBe(20);
  });

  test('stale-region detection is off, with the beat interval resolved anyway (#853)', () => {
    // Off is what keeps the mechanism free for everyone who did not ask: the
    // region only arms its heartbeat timer when the switch is on.  The interval
    // resolves regardless, because the switch can arrive from the layer above.
    const config = resolve({});

    expect(config.staleRegionDetection).toBe(false);
    expect(config.regionHeartbeatIntervalMs).toBe(5_000);
  });

  test('an explicit stale-region setting reaches the region config', () => {
    const config = resolve({ staleRegionDetection: true, regionHeartbeatIntervalMs: 1_000 });

    expect(config.staleRegionDetection).toBe(true);
    expect(config.regionHeartbeatIntervalMs).toBe(1_000);
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

  test('an explicit role beats a configured one, and a type without one inherits it', () => {
    const withRole = Config.parseString('actor-ts.sharding.role = "backend"');
    const fromConfig = readShardingOptionsFromConfig(withRole);

    expect(mergeOptions<{ role?: string }>({}, fromConfig, { role: 'gpu' }).role).toBe('gpu');
    expect(mergeOptions<{ role?: string }>({}, fromConfig, {}).role).toBe('backend');
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
