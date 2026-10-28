import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { ShardRegion, shardConfigFor } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS,
  DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS,
  DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR,
  DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS,
  DEFAULT_PASSIVATION_STOP_TIMEOUT_MS,
  DEFAULT_SHARD_FAILURE_BACKOFF_MAX_MS,
  DEFAULT_SHARD_FAILURE_BACKOFF_MIN_MS,
  DEFAULT_SHARD_FAILURE_BACKOFF_RANDOM_FACTOR,
  DEFAULT_SHARD_FAILURE_BACKOFF_RESET_AFTER_MS,
  DEFAULT_SHARD_REGION_BUFFER_SIZE,
} from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  readShardingOptionsFromConfig,
  StartShardingOptions,
  type StartShardingOptionsBuilder,
} from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { readShardingHealthCheckNamesFromConfig } from '../../../../src/cluster/ClusterHealthChecks.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { mergeOptions } from '../../../../src/util/OptionsMerge.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { expectExactOptions } from '../../../util/ExactOptions.js';

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
        use-lease                  = on
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
        shard-failure-backoff {
          min           = 150ms
          max           = 20s
          random-factor = 0.5
          reset-after   = 2 minutes
        }
        entity-restart-backoff {
          min           = 120ms
          max           = 30s
          random-factor = 0.4
          reset-after   = 3 minutes
        }
        passivation {
          replacement                    = segmented-least-recently-used
          segmented-protected-proportion = 0.75
          admission-window-proportion    = 0.05
          admission-filter               = frequency-sketch
          stop-timeout                   = 3s
        }
      }
    `);

    expectExactOptions(readShardingOptionsFromConfig(config), {
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
      useLease: true,
      shardRegionQueryTimeoutMs: 9_000,
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: 250,
      entityRecoveryConstantRateNumberOfEntities: 12,
      staleRegionDetection: true,
      regionHeartbeatIntervalMs: 2_000,
      regionStaleAfterMs: 12_000,
      shardFailureBackoffMinMs: 150,
      shardFailureBackoffMaxMs: 20_000,
      shardFailureBackoffRandomFactor: 0.5,
      shardFailureBackoffResetAfterMs: 120_000,
      // Four values unlike the shard backoff's above, so a reader that fills one
      // block's fields from the other's leaves cannot pass.
      entityRestartBackoffMinMs: 120,
      entityRestartBackoffMaxMs: 30_000,
      entityRestartBackoffRandomFactor: 0.4,
      entityRestartBackoffResetAfterMs: 180_000,
      passivationReplacement: 'segmented-least-recently-used',
      passivationSegmentedProtectedProportion: 0.75,
      passivationAdmissionWindowProportion: 0.05,
      passivationAdmissionFilter: 'frequency-sketch',
      passivationStopTimeoutMs: 3_000,
    });
  });

  test('omits absent keys entirely rather than reporting them as undefined', () => {
    const config = Config.parseString('actor-ts.sharding.passivation-idle = 90s');
    const fromConfig = readShardingOptionsFromConfig(config);

    // The distinction that matters: a present-but-undefined key would shadow
    // the built-in default once spread.
    expectExactOptions(fromConfig, { passivationIdleMs: 90_000 });
  });

  test('an empty config yields no settings at all', () => {
    expectExactOptions(readShardingOptionsFromConfig(Config.empty()), {});
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // The values `reference.conf` ships have to match what the code falls back
    // to, or merely wiring the block would change behaviour for everyone.
    //
    // `shardPassivationIdleMs` is absent by design, and the exact-object
    // assertion is what holds it that way — both halves of it: the value
    // comparison fails on a shipped value, and only the own-key half fails on
    // a reader that writes the key as `undefined`.  Shipping a value would make
    // `hasPath` true forever and the "follow passivationIdleMs" default
    // unreachable.
    //
    // `role` is absent for the neighbouring reason and by a *different*
    // mechanism: the leaf does ship, as `""`, so `hasPath` IS true forever —
    // and the reader's empty-string skip is the only thing keeping `role: ''`
    // out of every merged options object on a node that configured nothing.
    const config = Config.loadReference();

    expectExactOptions(readShardingOptionsFromConfig(config), {
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
      // Off, which is what every sharded type did before the switch existed:
      // no coordinator gets a lease until a deployment both asks and names a
      // backend under `actor-ts.coordination.lease` (#1454).
      useLease: false,
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
      // The backoff ships ON, unlike the switches around it: what it replaced
      // was no wait at all, which under `rememberEntities` re-created a
      // crashing shard thousands of times a second with no traffic (#1437).
      // A first wait of 200 ms keeps a shard that died once prompt, and a
      // positive `min` is what makes the doubling a backoff at all.
      shardFailureBackoffMinMs: 200,
      shardFailureBackoffMaxMs: 10_000,
      shardFailureBackoffRandomFactor: 0.2,
      shardFailureBackoffResetAfterMs: 60_000,
      // On as well, and at the shard backoff's numbers: what it replaced was an
      // entity re-created by every message that reached it after its shard
      // stopped it — thirty instances for thirty messages to an entity failing
      // on each (#1437).  The first in-budget restarts stay immediate; this is
      // the wait after them.
      entityRestartBackoffMinMs: 200,
      entityRestartBackoffMaxMs: 10_000,
      entityRestartBackoffRandomFactor: 0.2,
      entityRestartBackoffResetAfterMs: 60_000,
      // The replacement policy ships as the plain LRU every release before #848
      // had, and the filter ships off, so wiring the block changes the eviction
      // order for nobody.  All five ship anyway — an operator who cannot see
      // them cannot judge what naming a policy would cost — and the pair
      // `admission-filter = off` / `admission-window-proportion = 0` has to be a
      // legal one, because `ShardingOptionsValidator` rejects a filter without a
      // window against the resolved values.
      passivationReplacement: 'least-recently-used',
      passivationSegmentedProtectedProportion: 0.8,
      passivationAdmissionWindowProportion: 0,
      passivationAdmissionFilter: 'off',
      // `0` — the unbounded cooperative wait every release before #848 had.
      // See the dedicated test below for why the shipped value is not `10s`.
      passivationStopTimeoutMs: 0,
    });
  });

  test('the shipped stop-timeout arms no backstop, so an upgrade changes no behaviour (#848)', () => {
    // The compatibility claim #848 shipped with, as an assertion rather than
    // prose.  `Passivate`'s stop-message has always been a *request*: the entity
    // decides when to act on it, and an entity mid-drain — a long flush, a slow
    // final write — is entitled to take as long as the drain takes.  A shipped
    // `10s` turned that into a deadline for every deployment that upgraded,
    // including ones that had never heard of the key, and a forced stop there
    // abandons the flush.  So the backstop ships **off** and an operator opts
    // in, which is also what keeps the key orthogonal to `max-entities`: it
    // arms on the value alone, with or without a cap.
    const reference = readShardingOptionsFromConfig(Config.loadReference());

    expect(reference.passivationStopTimeoutMs).toBe(0);
    expect(DEFAULT_PASSIVATION_STOP_TIMEOUT_MS).toBe(0);
  });

  test('reads shard-passivation-idle when an operator sets it', () => {
    const config = Config.parseString('actor-ts.sharding.shard-passivation-idle = 90s');

    expectExactOptions(readShardingOptionsFromConfig(config), { shardPassivationIdleMs: 90_000 });
  });

  test('an explicitly empty role is "unrestricted", not a role named ""', () => {
    // The shape an operator hits by uncommenting the shipped line and leaving
    // it alone.  `role: ''` would reach `ShardCoordinator.candidates()`, which
    // reads it as unrestricted anyway — but it would also *shadow* an explicit
    // `withRole` on the layer above, since `mergeOptions` only falls through on
    // `undefined`.  Omitting the key is what keeps the two readings the same.
    const config = Config.parseString('actor-ts.sharding.role = ""');

    expectExactOptions(readShardingOptionsFromConfig(config), {});
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
      useLease: 'actor-ts.sharding.use-lease',
      shardRegionQueryTimeout: 'actor-ts.sharding.shard-region-query-timeout',
      // Declared as three full dotted paths rather than one `entity-recovery`
      // block root (#851).  A root no longer lets an unread leaf through
      // `NoDeadConfigKeys`, which decides a read by perturbing the leaf
      // (#1425), but its reachability check still resolves a leaf through
      // *any* config root above it: a root-only entry would vouch for leaves
      // no accessor names.
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
      // Nested to mirror its HOCON block, and four full dotted paths for the
      // reason `entity-recovery` above gives (#1437).
      shardFailureBackoff: {
        min: 'actor-ts.sharding.shard-failure-backoff.min',
        max: 'actor-ts.sharding.shard-failure-backoff.max',
        randomFactor: 'actor-ts.sharding.shard-failure-backoff.random-factor',
        resetAfter: 'actor-ts.sharding.shard-failure-backoff.reset-after',
      },
      // The entity half of the same backoff, in the same shape (#1437).
      entityRestartBackoff: {
        min: 'actor-ts.sharding.entity-restart-backoff.min',
        max: 'actor-ts.sharding.entity-restart-backoff.max',
        randomFactor: 'actor-ts.sharding.entity-restart-backoff.random-factor',
        resetAfter: 'actor-ts.sharding.entity-restart-backoff.reset-after',
      },
      // Five more full dotted paths, and flat here rather than nested under a
      // `passivation` object for the same reason `entityRecovery*` is flat: a
      // nested group reads as one thing to `NoDeadConfigKeys`' reachability
      // lookup only if it is a root, and a root would make all five reachable
      // whether an accessor names them or not (#848).
      passivationReplacement: 'actor-ts.sharding.passivation.replacement',
      passivationSegmentedProtectedProportion:
        'actor-ts.sharding.passivation.segmented-protected-proportion',
      passivationAdmissionWindowProportion:
        'actor-ts.sharding.passivation.admission-window-proportion',
      passivationAdmissionFilter: 'actor-ts.sharding.passivation.admission-filter',
      passivationStopTimeout: 'actor-ts.sharding.passivation.stop-timeout',
      // A full dotted leaf, nested to mirror its HOCON block like
      // `staleRegionDetection` above (#1465).  No start option reads it — it
      // is read once per `Cluster.join` by its own reader, whose cases are in
      // the block below.
      healthcheck: {
        names: 'actor-ts.sharding.healthcheck.names',
      },
    });
  });

  test('healthcheck.names is no start option, so this reader leaves it out (#1465)', () => {
    // It gates readiness rather than tuning a region, and is read once per
    // `Cluster.join`; surfaced here it would be merged into every started
    // type's options as a field nothing there reads.
    const config = Config.parseString('actor-ts.sharding.healthcheck.names = ["orders"]');

    expectExactOptions(readShardingOptionsFromConfig(config), {});
  });

  test('use-lease ships off and is read; lease-name stays absent (#1454)', () => {
    // The pin `SingletonConfigDefaults` holds for the singleton block, held
    // here for this one.  `use-lease` ships because something builds the lease
    // it asks for now; `lease-name` does not, because the name is derived per
    // type, and one value for the block would put every type on one record.
    const reference = Config.loadReference();
    expect(reference.getBoolean('actor-ts.sharding.use-lease')).toBe(false);
    expect(reference.hasPath('actor-ts.sharding.lease-name')).toBe(false);
  });

  test('a lease-name written into the block is refused, naming it (#1454)', () => {
    const config = Config.parseString(`
      actor-ts.sharding {
        use-lease  = on
        lease-name = "cart-lease"
      }
    `);

    expect(() => readShardingOptionsFromConfig(config)).toThrow(ConfigError);
    expect(() => readShardingOptionsFromConfig(config))
      .toThrow(/^actor-ts\.sharding\.lease-name is read by nothing: .*<system>-sharding-<type>/);
  });
});

describe('readShardingHealthCheckNamesFromConfig (#1465)', () => {
  test('the reference ships the empty list, which gates nothing', () => {
    // `[]` and an unset key are the same node: no shard-region check at all,
    // so wiring the key changes readiness for nobody who does not ask.
    expectExactOptions(readShardingHealthCheckNamesFromConfig(Config.loadReference()), []);
    expectExactOptions(readShardingHealthCheckNamesFromConfig(Config.empty()), []);
  });

  test('reads the named types, in the order they are listed', () => {
    const config = Config.parseString('actor-ts.sharding.healthcheck.names = ["orders", "billing"]');

    expectExactOptions(readShardingHealthCheckNamesFromConfig(config), ['orders', 'billing']);
  });

  test('a type listed twice is gated once', () => {
    // Two checks of one name would be two identical entries on `/ready`; the
    // intent — gate on this type — is the same either way.
    const config = Config.parseString('actor-ts.sharding.healthcheck.names = ["orders", "billing", "orders"]');

    expectExactOptions(readShardingHealthCheckNamesFromConfig(config), ['orders', 'billing']);
  });

  test('an empty name is refused, naming the entry', () => {
    // `ClusterSharding.start` refuses an empty type name, so a check for one
    // could never pass: the node would stay out of rotation for good with a
    // detail about a region nobody can start.
    const config = Config.parseString('actor-ts.sharding.healthcheck.names = ["orders", ""]');

    expect(() => readShardingHealthCheckNamesFromConfig(config)).toThrow(ConfigError);
    expect(() => readShardingHealthCheckNamesFromConfig(config))
      .toThrow(/^actor-ts\.sharding\.healthcheck\.names\[1\] is empty/);
  });

  test('a single name written without the list is refused rather than read', () => {
    // `getStringList` refuses a bare string, which is the right call: the
    // spelling an operator writes for one type is a list of one.
    const config = Config.parseString('actor-ts.sharding.healthcheck.names = "orders"');

    expect(() => readShardingHealthCheckNamesFromConfig(config)).toThrow(ConfigError);
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

  test('unset, the shard failure backoff resolves to its built-in defaults (#1437)', () => {
    // Defaulted here as well as in `reference.conf`, like `bufferSize`: the
    // backoff is what keeps a shard that fails on every start from looping, so
    // a region built without `ClusterSharding.start` must have it too.
    const config = resolve({});

    expect(config.shardFailureBackoffMinMs).toBe(DEFAULT_SHARD_FAILURE_BACKOFF_MIN_MS);
    expect(config.shardFailureBackoffMaxMs).toBe(DEFAULT_SHARD_FAILURE_BACKOFF_MAX_MS);
    expect(config.shardFailureBackoffRandomFactor).toBe(DEFAULT_SHARD_FAILURE_BACKOFF_RANDOM_FACTOR);
    expect(config.shardFailureBackoffResetAfterMs).toBe(DEFAULT_SHARD_FAILURE_BACKOFF_RESET_AFTER_MS);
  });

  test('an explicit shard failure backoff reaches the region config, a random factor of 0 included', () => {
    // `0` is a real value — exact waits — and must not fall through to `0.2`.
    const config = resolve({
      shardFailureBackoffMinMs: 50,
      shardFailureBackoffMaxMs: 5_000,
      shardFailureBackoffRandomFactor: 0,
      shardFailureBackoffResetAfterMs: 1_000,
    });

    expect(config.shardFailureBackoffMinMs).toBe(50);
    expect(config.shardFailureBackoffMaxMs).toBe(5_000);
    expect(config.shardFailureBackoffRandomFactor).toBe(0);
    expect(config.shardFailureBackoffResetAfterMs).toBe(1_000);
  });

  test('unset, the entity restart backoff resolves to its built-in defaults, and every shard is handed them (#1437)', () => {
    // Defaulted in the region like the shard backoff, and passed down whole: a
    // shard that fell back to its own defaults would still back off, but a
    // configured value would stop at the region and never reach an entity.
    const config = resolve({});

    expect(config.entityRestartBackoffMinMs).toBe(DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS);
    expect(config.entityRestartBackoffMaxMs).toBe(DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS);
    expect(config.entityRestartBackoffRandomFactor).toBe(DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR);
    expect(config.entityRestartBackoffResetAfterMs).toBe(DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS);
    expect(shardConfigFor(config, 3)).toEqual({
      typeName: 'entity',
      shardId: 3,
      entityActor: NoopEntity,
      entityOptions: undefined,
      passivationStopTimeoutMs: DEFAULT_PASSIVATION_STOP_TIMEOUT_MS,
      // The region's own cap, which bounds what a shard holds for its entities
      // backing off as well — per shard there.
      bufferSize: DEFAULT_SHARD_REGION_BUFFER_SIZE,
      entityRestartBackoffMinMs: DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS,
      entityRestartBackoffMaxMs: DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS,
      entityRestartBackoffRandomFactor: DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR,
      entityRestartBackoffResetAfterMs: DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS,
    });
  });

  test('an explicit entity restart backoff reaches the region config and the shards, a random factor of 0 included', () => {
    // `0` is a real value — exact waits — and must not fall through to `0.2`
    // anywhere on the way down.
    const config = resolve({
      bufferSize: 64,
      entityRestartBackoffMinMs: 75,
      entityRestartBackoffMaxMs: 7_500,
      entityRestartBackoffRandomFactor: 0,
      entityRestartBackoffResetAfterMs: 2_500,
    });

    expect(config.entityRestartBackoffMinMs).toBe(75);
    expect(config.entityRestartBackoffMaxMs).toBe(7_500);
    expect(config.entityRestartBackoffRandomFactor).toBe(0);
    expect(config.entityRestartBackoffResetAfterMs).toBe(2_500);
    expect(shardConfigFor(config, 0)).toMatchObject({
      shardId: 0,
      bufferSize: 64,
      entityRestartBackoffMinMs: 75,
      entityRestartBackoffMaxMs: 7_500,
      entityRestartBackoffRandomFactor: 0,
      entityRestartBackoffResetAfterMs: 2_500,
    });
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

/* -------- what a shard is handed, through `ClusterSharding.start` (#1437) -------- */

/**
 * The helper cases above pin `shardConfigFor`; these pin that the region
 * actually hands its result to every shard it spawns.  A shard built from a
 * config that leaves the four backoff values and `bufferSize` out falls back
 * to the shipped defaults, so an operator's HOCON or builder values would stop
 * at the region — with every case above still green.  So the values are made
 * observable from outside: a wait far from the shipped one, measured on a real
 * entity, and a hold cap of two, counted in dead letters.
 */

/** The entity restart wait both cases configure: `min` = `max`, exact. */
const CONFIGURED_WAIT_MS = 1_500;

/** The hold cap both cases configure — the region's `buffer-size`, applied per shard. */
const CONFIGURED_BUFFER_SIZE = 2;

type EchoCommand = { readonly kind: 'echo'; readonly id: string; readonly sequence: number };

type FailCommand = { readonly kind: 'fail'; readonly id: string };

type Command = EchoCommand | FailCommand;

type EchoReply = { readonly kind: 'echoed'; readonly id: string; readonly sequence: number };

/** When each echo came back, by sequence, on the monotonic clock. */
const echoed = new Map<number, number>();
const deadEchoes: number[] = [];

class EchoEntity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'echo' }, (m) => this.onEcho(m))
      .with({ kind: 'fail' }, () => this.onFail())
      .exhaustive();
  }

  private onEcho(message: EchoCommand): void {
    const reply: EchoReply = { kind: 'echoed', id: message.id, sequence: message.sequence };
    this.sender.toNullable()?.tell(reply);
  }

  private onFail(): void { this.context.stopSelf(); }
}

class EchoCollector extends Actor<EchoReply> {
  override onReceive(reply: EchoReply): void { echoed.set(reply.sequence, performance.now()); }
}

class DeadEchoListener extends Actor<DeadLetter> {
  override preStart(): void { this.system.eventStream.subscribe(this.self, DeadLetter); }

  override onReceive(letter: DeadLetter): void {
    const message = letter.message as Partial<EchoCommand>;
    if (message.kind === 'echo' && typeof message.sequence === 'number') deadEchoes.push(message.sequence);
  }
}

let runningNode: { system: ActorSystem; cluster: Cluster } | null = null;

afterEach(async () => {
  if (runningNode) {
    await runningNode.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await runningNode.system.terminate().catch(() => { /* teardown is best-effort */ });
    runningNode = null;
  }
  echoed.clear();
  deadEchoes.length = 0;
});

/**
 * Start a node whose sharded type is configured by `hocon` and `builder`, stop
 * its one entity unasked, and send six messages into the wait: what comes back,
 * when, and what is dead-lettered is the shard's configuration made visible.
 */
async function sixMessagesIntoTheWait(
  systemName: string,
  port: number,
  hocon: string,
  configure: (builder: StartShardingOptionsBuilder<Command>) => StartShardingOptionsBuilder<Command>,
): Promise<{ readonly stoppedAt: number }> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  runningNode = { system, cluster };
  system.spawn(DeadEchoListener, 'dead-echo-listener');
  const collector = system.spawn(EchoCollector, 'echo-collector') as ActorRef<unknown>;

  const shardingOptions = configure(
    StartShardingOptions.create<Command>()
      .withTypeName('configured')
      .withEntityActor(EchoEntity)
      .withExtractEntityId((command) => command.id),
  );
  const region = cluster.sharding.start(shardingOptions);

  region.tell({ kind: 'echo', id: 'e-1', sequence: 0 }, collector);
  await awaitCondition(() => echoed.has(0), { timeoutMs: 4_000, label: 'the entity answered before its stop' });
  const stoppedAt = performance.now();
  region.tell({ kind: 'fail', id: 'e-1' });
  // Only once the shard has seen the stop does a message meet the wait rather
  // than the stopping entity's mailbox; the region's count follows the shard's
  // report of it.
  await awaitCondition(async () => {
    const shards = await cluster.sharding.shards('configured');
    return shards.length > 0 && shards.every((shard) => shard.entityCount === 0);
  }, { timeoutMs: 4_000, label: 'the region saw the entity stop' });
  for (let sequence = 1; sequence <= 6; sequence++) region.tell({ kind: 'echo', id: 'e-1', sequence }, collector);
  await awaitCondition(() => echoed.size + deadEchoes.length === 7, {
    timeoutMs: 4_000,
    label: 'every message into the wait was answered or dead-lettered',
  });
  return { stoppedAt };
}

describe('ClusterSharding.start — every shard is handed the configured restart backoff and buffer-size (#1437)', () => {
  test('from HOCON', async () => {
    const { stoppedAt } = await sixMessagesIntoTheWait('configured-from-hocon', 53_431, `
      actor-ts.sharding {
        buffer-size = ${CONFIGURED_BUFFER_SIZE}
        entity-restart-backoff {
          min = ${CONFIGURED_WAIT_MS}ms
          max = ${CONFIGURED_WAIT_MS}ms
          random-factor = 0
        }
      }
    `, (builder) => builder);

    // The cap held the first two; the four behind them were dead-lettered.
    expect([...echoed.keys()].filter((sequence) => sequence > 0).sort()).toEqual([1, 2]);
    expect([...deadEchoes].sort()).toEqual([3, 4, 5, 6]);
    // And they waited the configured wait, not the shipped 200 ms.
    expect(echoed.get(1)! - stoppedAt).toBeGreaterThanOrEqual(CONFIGURED_WAIT_MS - 50);
  }, 15_000);

  test('from the builder', async () => {
    const { stoppedAt } = await sixMessagesIntoTheWait('configured-from-builder', 53_432, '', (builder) => builder
      .withBufferSize(CONFIGURED_BUFFER_SIZE)
      .withEntityRestartBackoffMinMs(CONFIGURED_WAIT_MS)
      .withEntityRestartBackoffMaxMs(CONFIGURED_WAIT_MS)
      .withEntityRestartBackoffRandomFactor(0));

    expect([...echoed.keys()].filter((sequence) => sequence > 0).sort()).toEqual([1, 2]);
    expect([...deadEchoes].sort()).toEqual([3, 4, 5, 6]);
    expect(echoed.get(1)! - stoppedAt).toBeGreaterThanOrEqual(CONFIGURED_WAIT_MS - 50);
  }, 15_000);
});
