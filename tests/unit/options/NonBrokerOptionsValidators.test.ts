import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { FailureDetectorOptionsValidator, type FailureDetectorOptionsType } from '../../../src/cluster/FailureDetectorOptions.js';
import {
  ClusterClientReceptionistOptionsValidator,
  type ClusterClientReceptionistOptionsType,
} from '../../../src/cluster/ClusterClientReceptionistOptions.js';
import { ClusterOptionsValidator, type ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import {
  ClusterBootstrapOptionsValidator,
  type ClusterBootstrapOptionsType,
} from '../../../src/cluster/ClusterBootstrapOptions.js';
import { WebsocketClientOptionsValidator, type WebsocketClientOptionsType } from '../../../src/http/websocket/WebsocketClientOptions.js';
import { ExpressBackendOptionsValidator, type ExpressBackendOptionsType } from '../../../src/http/backend/ExpressBackendOptions.js';
import { HonoBackendOptionsValidator, type HonoBackendOptionsType } from '../../../src/http/backend/HonoBackendOptions.js';
import { LeaseOptionsValidator, type LeaseOptionsType } from '../../../src/coordination/LeaseOptions.js';
import {
  KubernetesLeaseOptionsValidator,
  type KubernetesLeaseOptionsType,
} from '../../../src/coordination/leases/KubernetesLeaseOptions.js';
import { ShardingOptionsValidator, type ShardingOptionsType } from '../../../src/cluster/sharding/ShardingOptions.js';
import {
  ShardedDaemonProcessOptionsValidator,
  type ShardedDaemonProcessOptionsType,
} from '../../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import {
  StartShardingOptionsValidator,
  type StartShardingOptionsType,
} from '../../../src/cluster/sharding/StartShardingOptions.js';
import {
  StartSingletonOptionsValidator,
  type StartSingletonOptionsType,
} from '../../../src/cluster/singleton/StartSingletonOptions.js';
import {
  ClusterSingletonManagerOptionsValidator,
  type ClusterSingletonManagerOptionsType,
} from '../../../src/cluster/singleton/ClusterSingletonManagerOptions.js';
import { WorkerClusterOptionsValidator, type WorkerClusterOptionsType } from '../../../src/worker/WorkerClusterOptions.js';
import {
  DEFAULT_WINDOW_SIZE,
  ProducerControllerOptionsValidator,
  type ProducerControllerOptionsType,
} from '../../../src/delivery/ProducerControllerOptions.js';
import {
  ConsumerControllerOptionsValidator,
  DEFAULT_MAX_OUT_OF_ORDER,
  DEFAULT_MAX_PRODUCERS,
  DEFAULT_PRODUCER_IDLE_TTL_MS,
  type ConsumerControllerOptionsType,
} from '../../../src/delivery/ConsumerControllerOptions.js';
import {
  ThrottleOptionsValidator,
  type ThrottleOptionsType,
  type ThrottleOnExcess,
} from '../../../src/ThrottleOptions.js';
import { MAX_DELIVERY_IDENTIFIER_LENGTH } from '../../../src/delivery/Constants.js';
import { AutoDiscoveryOptionsValidator, type AutoDiscoveryOptionsType } from '../../../src/discovery/AutoDiscoveryOptions.js';
import {
  ConfigSeedProviderOptionsValidator,
  type ConfigSeedProviderOptionsType,
} from '../../../src/discovery/ConfigSeedProviderOptions.js';
import {
  KubernetesApiSeedProviderOptionsValidator,
  type KubernetesApiSeedProviderOptionsType,
} from '../../../src/discovery/KubernetesApiSeedProviderOptions.js';
import { ReceptionistOptionsValidator, type ReceptionistOptionsType } from '../../../src/discovery/ReceptionistOptions.js';
import {
  DistributedPubSubOptionsValidator,
  type DistributedPubSubOptionsType,
} from '../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { DistributedDataOptionsValidator, type DistributedDataOptionsType } from '../../../src/crdt/DistributedDataOptions.js';
import { MemcachedCacheOptionsValidator, type MemcachedCacheOptionsType } from '../../../src/cache/MemcachedCacheOptions.js';
import {
  CassandraJournalOptionsValidator,
  type CassandraJournalOptionsType,
} from '../../../src/persistence/journals/CassandraJournalOptions.js';
import {
  S3ObjectStorageOptionsValidator,
  type S3ObjectStorageOptionsType,
} from '../../../src/persistence/object-storage/S3ObjectStorageOptions.js';
import {
  FilesystemObjectStorageOptionsValidator,
  type FilesystemObjectStorageOptionsType,
} from '../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { KeepRefereeOptionsValidator, type KeepRefereeOptionsType } from '../../../src/cluster/downing/KeepRefereeOptions.js';
import { LeaseMajorityOptionsValidator, type LeaseMajorityOptionsType } from '../../../src/cluster/downing/LeaseMajorityOptions.js';
import { ClusterRouterOptionsValidator, type ClusterRouterOptionsType } from '../../../src/cluster/router/ClusterRouterOptions.js';
import { TestProbeOptionsValidator, type TestProbeOptionsType } from '../../../src/testkit/TestProbeOptions.js';

// Direct validator tests for the non-broker options. Each consumer calls the
// same validator in its constructor / start method after merging defaults.

describe('FailureDetectorOptionsValidator', () => {
  const check = (s: Partial<FailureDetectorOptionsType>): void =>
    new FailureDetectorOptionsValidator().validate(s);

  test('rejects a non-positive threshold', () => {
    expect(() => check({ heartbeatIntervalMs: 0 })).toThrow(OptionsError);
    expect(() => check({ unreachableAfterMs: -1 })).toThrow(OptionsError);
    expect(() => check({ downAfterMs: 0 })).toThrow(OptionsError);
  });

  test('accepts positive thresholds (defaults are valid)', () => {
    expect(() => check({ heartbeatIntervalMs: 500, unreachableAfterMs: 2_000, downAfterMs: 5_000 }))
      .not.toThrow();
  });
});

describe('ClusterClientReceptionistOptionsValidator', () => {
  const check = (s: Partial<ClusterClientReceptionistOptionsType>): void =>
    new ClusterClientReceptionistOptionsValidator().validate(s);

  test('rejects a non-positive askTimeoutMs', () => {
    expect(() => check({ askTimeoutMs: 0 })).toThrow(OptionsError);
  });

  test('accepts an unset or positive askTimeoutMs', () => {
    expect(() => check({})).not.toThrow();
    expect(() => check({ askTimeoutMs: 3_000 })).not.toThrow();
  });
});

describe('ClusterOptionsValidator', () => {
  const check = (s: Partial<ClusterOptionsType>): void => new ClusterOptionsValidator().validate(s);

  test('rejects a non-positive/fractional port and empty host', () => {
    expect(() => check({ host: 'h', port: 0 })).toThrow(OptionsError);
    expect(() => check({ host: 'h', port: 1.5 })).toThrow(OptionsError);
    expect(() => check({ host: '', port: 2552 })).toThrow(OptionsError);
  });

  test('accepts a synthetic (out-of-TCP-range) port for InMemoryTransport', () => {
    // The port doubles as an InMemoryTransport node id, so > 65535 is allowed.
    expect(() => check({ host: 'sys', port: 89_001 })).not.toThrow();
  });

  test('rejects non-positive gossip/seed/tombstone durations', () => {
    expect(() => check({ gossipIntervalMs: 0 })).toThrow(/gossipIntervalMs/);
    expect(() => check({ seedRetryIntervalMs: -1 })).toThrow(OptionsError);
    expect(() => check({ tombstoneTtlMs: 0 })).toThrow(OptionsError);
  });

  test('accepts weaklyUpAfterMs 0 (disabled) and a valid config', () => {
    expect(() => check({ host: '127.0.0.1', port: 2552, weaklyUpAfterMs: 0 })).not.toThrow();
  });

  test('the four association-lifecycle bounds have no "off" spelling (#846)', () => {
    // Unlike `weaklyUpAfterMs` above, `0` is not "disabled" for any of these —
    // it is a distinct way of breaking the node for each: no handshake window,
    // no room to buffer a send racing the handshake, no inbound connection
    // admitted, no connection allowed to end off a frame boundary.
    expect(() => check({ handshakeTimeoutMs: 0 })).toThrow(/handshakeTimeoutMs/);
    expect(() => check({ outboundQueueSize: 0 })).toThrow(/outboundQueueSize/);
    expect(() => check({ maxInboundConnections: 0 })).toThrow(/maxInboundConnections/);
    expect(() => check({ incompleteFrameIdleMs: 0 })).toThrow(/incompleteFrameIdleMs/);
    expect(() => check({ outboundQueueSize: 1.5 })).toThrow(OptionsError);
  });

  test('the stall deadline must outlast the handshake deadline (#846)', () => {
    // A socket that sends nothing at all never reaches the stall deadline, so
    // the handshake timer is the only thing that reclaims it.  Inverting the
    // two swaps their roles for a peer that sends three bytes and stops.
    expect(() => check({ handshakeTimeoutMs: 5_000, incompleteFrameIdleMs: 5_000 }))
      .toThrow(/incompleteFrameIdleMs/);
    expect(() => check({ handshakeTimeoutMs: 5_000, incompleteFrameIdleMs: 1_000 }))
      .toThrow(/must be greater than handshakeTimeoutMs/);
    expect(() => check({ handshakeTimeoutMs: 5_000, incompleteFrameIdleMs: 30_000 }))
      .not.toThrow();
    // Either alone passes: the unset half falls through to a default that the
    // set half clears, and a helper is a no-op on an unset field.
    expect(() => check({ incompleteFrameIdleMs: 1_000 })).not.toThrow();
  });
});

describe('ClusterBootstrapOptionsValidator', () => {
  const check = (s: Partial<ClusterBootstrapOptionsType>): void =>
    new ClusterBootstrapOptionsValidator().validate(s);

  test('rejects an empty name and a non-positive port', () => {
    expect(() => check({ name: '' })).toThrow(OptionsError);
    expect(() => check({ name: 'app', port: 0 })).toThrow(OptionsError);
  });

  test('awaitReady accepts booleans and non-negative numbers, rejects negatives', () => {
    expect(() => check({ name: 'app', awaitReady: true })).not.toThrow();
    expect(() => check({ name: 'app', awaitReady: 0 })).not.toThrow();
    expect(() => check({ name: 'app', awaitReady: 5_000 })).not.toThrow();
    expect(() => check({ name: 'app', awaitReady: -1 })).toThrow(/awaitReady/);
  });

  test('awaitReady accepts a readiness bag and holds it to the readiness rules', () => {
    expect(() => check({ name: 'app', awaitReady: { minimumMembers: 3, timeoutMs: 30_000 } })).not.toThrow();
    expect(() => check({ name: 'app', awaitReady: {} })).not.toThrow();
    expect(() => check({ name: 'app', awaitReady: { minimumMembers: 0 } })).toThrow(OptionsError);
    expect(() => check({ name: 'app', awaitReady: { timeoutMs: 0 } })).toThrow(OptionsError);
  });
});

describe('WebsocketClientOptionsValidator', () => {
  const check = (s: Partial<WebsocketClientOptionsType>): void =>
    new WebsocketClientOptionsValidator().validate(s);

  test('accepts ws / wss urls, rejects others', () => {
    expect(() => check({ url: 'ws://host:8080/ws' })).not.toThrow();
    expect(() => check({ url: 'wss://host/ws' })).not.toThrow();
    expect(() => check({ url: 'http://host/ws' })).toThrow(OptionsError);
  });

  test('rejects a non-positive maxFrameBytes / pingIntervalMs', () => {
    expect(() => check({ maxFrameBytes: 0 })).toThrow(OptionsError);
    expect(() => check({ pingIntervalMs: -1 })).toThrow(OptionsError);
  });

  test('rejects an unknown onInvalidMessage policy', () => {
    expect(() => check({ onInvalidMessage: 'explode' as unknown as 'drop' })).toThrow(/onInvalidMessage/);
  });

  // #753 — `0` is the documented "off" for both deadlines, so the rule is
  // non-negative rather than positive: rejecting `0` would leave a HOCON-set
  // timeout with no way to switch it off per instance.
  test('accepts 0 for either liveness deadline and rejects a negative one', () => {
    expect(() => check({ idleTimeoutMs: 0, connectTimeoutMs: 0 })).not.toThrow();
    expect(() => check({ idleTimeoutMs: -1 })).toThrow(/idleTimeoutMs/);
    expect(() => check({ connectTimeoutMs: -1 })).toThrow(/connectTimeoutMs/);
  });
});

describe('HTTP backend option validators', () => {
  test('Express rejects a non-positive maxBodyBytes', () => {
    const check = (s: Partial<ExpressBackendOptionsType>): void =>
      new ExpressBackendOptionsValidator().validate(s);
    expect(() => check({ maxBodyBytes: 0 })).toThrow(OptionsError);
    expect(() => check({ maxBodyBytes: 1 << 20 })).not.toThrow();
  });

  test('Hono rejects a non-positive maxBodyBytes', () => {
    const check = (s: Partial<HonoBackendOptionsType>): void =>
      new HonoBackendOptionsValidator().validate(s);
    expect(() => check({ maxBodyBytes: -5 })).toThrow(OptionsError);
  });
});

describe('LeaseOptionsValidator', () => {
  const check = (s: Partial<LeaseOptionsType>): void => new LeaseOptionsValidator().validate(s);

  test('rejects a non-positive ttlMs and empty name/owner', () => {
    expect(() => check({ ttlMs: 0 })).toThrow(OptionsError);
    expect(() => check({ name: '' })).toThrow(OptionsError);
    expect(() => check({ owner: '' })).toThrow(OptionsError);
  });

  test('rejects a negative acquireRetries', () => {
    expect(() => check({ acquireRetries: -1 })).toThrow(/acquireRetries/);
  });

  test('accepts a valid lease config', () => {
    expect(() => check({ name: 'singleton', owner: 'node-1', ttlMs: 10_000 })).not.toThrow();
  });
});

describe('KubernetesLeaseOptionsValidator', () => {
  const check = (s: Partial<KubernetesLeaseOptionsType>): void =>
    new KubernetesLeaseOptionsValidator().validate(s);

  test('inherits the common lease rules', () => {
    expect(() => check({ ttlMs: -1 })).toThrow(/ttlMs/);
  });

  test('rejects a non-https apiServerUrl', () => {
    expect(() => check({ apiServerUrl: 'ftp://k8s' })).toThrow(OptionsError);
    // `http` used to be allowed even though the client always dials
    // `node:https` — the URL's protocol is never read.
    expect(() => check({ apiServerUrl: 'http://k8s.default.svc' })).toThrow(/apiServerUrl/);
  });

  // Until #599 this case asserted `.not.toThrow()`, which froze the defect
  // green: an apiServerUrl on its own fell back to the Pod's mounted
  // ServiceAccount token, sending the cluster credential to a
  // caller-supplied host.
  test('rejects a partial API-server credential', () => {
    const base = { name: 's', owner: 'o', ttlMs: 15_000, namespace: 'actors' };
    expect(() => check({ ...base, apiServerUrl: 'https://k8s.default.svc' })).toThrow(OptionsError);
    expect(() => check({ ...base, apiServerUrl: 'https://k8s.default.svc', authToken: 't' }))
      .toThrow(/caCert/);
    expect(() => check({ ...base, authToken: 't' })).toThrow(/apiServerUrl \+ caCert/);
  });

  test('accepts a valid k8s lease config', () => {
    expect(() => check({
      name: 's',
      owner: 'o',
      ttlMs: 15_000,
      namespace: 'actors',
      apiServerUrl: 'https://k8s.default.svc',
      authToken: 'token',
      caCert: '<<ca>>',
    })).not.toThrow();
  });

  test('accepts a config with no explicit credentials — the in-cluster mount is used whole', () => {
    expect(() => check({ name: 's', owner: 'o', ttlMs: 15_000, namespace: 'actors' })).not.toThrow();
  });
});

/** Stand-in for the required `entityActor` / `actor` in the cluster validators. */
class NoopEntity extends Actor<unknown> {
  override onReceive(): void {}
}

describe('ShardingOptionsValidator', () => {
  // The fields a region cannot work without; spread into every case that is
  // only exercising a different rule.
  const required = {
    typeName: 'entity',
    entityActor: NoopEntity,
    extractEntityId: () => 'e-1',
  } satisfies Partial<ShardingOptionsType<unknown>>;
  const check = (s: Partial<ShardingOptionsType<unknown>>): void =>
    new ShardingOptionsValidator<unknown>().validate(s);

  test('rejects numShards < 1 and negative maxEntities', () => {
    expect(() => check({ ...required, numShards: 0 })).toThrow(OptionsError);
    expect(() => check({ ...required, maxEntities: -1 })).toThrow(OptionsError);
  });

  test('rejects negative or non-finite passivation windows, at both levels', () => {
    expect(() => check({ ...required, passivationIdleMs: -1 })).toThrow(/passivationIdleMs/);
    expect(() => check({ ...required, shardPassivationIdleMs: -1 })).toThrow(/shardPassivationIdleMs/);
    expect(() => check({ ...required, shardPassivationIdleMs: Number.POSITIVE_INFINITY }))
      .toThrow(/shardPassivationIdleMs/);
  });

  test('accepts sensible sharding values (0 maxEntities = no cap)', () => {
    expect(() => check({ ...required, numShards: 64, maxEntities: 0, passivationIdleMs: 0 })).not.toThrow();
  });

  test('accepts both passivation windows set independently, including 0', () => {
    expect(() => check({ ...required, passivationIdleMs: 30_000, shardPassivationIdleMs: 0 })).not.toThrow();
    expect(() => check({ ...required, passivationIdleMs: 0, shardPassivationIdleMs: 600_000 })).not.toThrow();
  });

  test('rejects a region missing typeName, entityActor or extractEntityId', () => {
    expect(() => check({})).toThrow(/typeName is required/);
    expect(() => check({ typeName: 'entity' })).toThrow(/entityActor is required/);
    expect(() => check({ typeName: 'entity', entityActor: required.entityActor }))
      .toThrow(/extractEntityId is required/);
  });

  test('a proxy region needs neither entityActor nor extractEntityId', () => {
    // It routes but never hosts, so both are unreachable there.
    expect(() => check({ typeName: 'entity', proxy: true })).not.toThrow();
  });

  test('rejects an entity-recovery strategy outside the union (#851)', () => {
    // HOCON is untyped, so a misspelt strategy reaches the validator as a plain
    // string.  Silently treating it as `all` would give an operator the burst
    // they configured this key to remove.
    expect(() => check({ ...required, entityRecoveryStrategy: 'constant_rate' as never }))
      .toThrow(/entityRecoveryStrategy/);
  });

  test('rejects a zero or negative constant-rate bound (#851)', () => {
    // Under `constant-rate` either one turns "recover slowly" into "never
    // recover", which is worse than the burst the setting exists to avoid.
    expect(() => check({ ...required, entityRecoveryConstantRateFrequencyMs: 0 }))
      .toThrow(/entityRecoveryConstantRateFrequencyMs/);
    expect(() => check({ ...required, entityRecoveryConstantRateNumberOfEntities: 0 }))
      .toThrow(/entityRecoveryConstantRateNumberOfEntities/);
    expect(() => check({ ...required, entityRecoveryConstantRateNumberOfEntities: 2.5 }))
      .toThrow(/entityRecoveryConstantRateNumberOfEntities/);
  });

  test('rejects a zero or negative region heartbeat interval (#853)', () => {
    // `0` is not "no beat" here — the timer would fire as fast as the scheduler
    // runs it.  Turning the mechanism off is `staleRegionDetection`.
    expect(() => check({ ...required, regionHeartbeatIntervalMs: 0 }))
      .toThrow(/regionHeartbeatIntervalMs/);
    expect(() => check({ ...required, regionHeartbeatIntervalMs: -1 })).toThrow(OptionsError);
  });

  test('accepts both strategies and a sane paced configuration', () => {
    expect(() => check({ ...required, entityRecoveryStrategy: 'all' })).not.toThrow();
    expect(() => check({
      ...required,
      entityRecoveryStrategy: 'constant-rate',
      entityRecoveryConstantRateFrequencyMs: 100,
      entityRecoveryConstantRateNumberOfEntities: 5,
    })).not.toThrow();
  });
});

describe('ShardedDaemonProcessOptionsValidator', () => {
  const check = (s: Partial<ShardedDaemonProcessOptionsType<unknown>>): void =>
    new ShardedDaemonProcessOptionsValidator<unknown>().validate(s);

  test('rejects numDaemons < 1', () => {
    expect(() => check({ numDaemons: 0 })).toThrow(/numDaemons/);
  });

  test('accepts numDaemons >= 1 and livenessIntervalMs 0 (disabled)', () => {
    expect(() => check({ name: 'workers', numDaemons: 4, livenessIntervalMs: 0 })).not.toThrow();
  });
});

describe('StartShardingOptionsValidator', () => {
  const check = (s: Partial<StartShardingOptionsType<unknown>>): void =>
    new StartShardingOptionsValidator<unknown>().validate(s);

  const required = {
    typeName: 'entity',
    entityActor: NoopEntity,
    extractEntityId: () => 'e-1',
  } satisfies Partial<StartShardingOptionsType<unknown>>;

  test('inherits the region rules (numShards) and adds coordinator intervals', () => {
    expect(() => check({ ...required, numShards: 0 })).toThrow(/numShards/);
    expect(() => check({ ...required, rebalanceIntervalMs: 0 })).toThrow(/rebalanceIntervalMs/);
    expect(() => check({ ...required, handOffTimeoutMs: -1 })).toThrow(OptionsError);
    expect(() => check({ ...required, acquireRetryIntervalMs: 0 })).toThrow(OptionsError);
  });

  test('inherits the required-field rules too', () => {
    expect(() => check({ rebalanceIntervalMs: 10_000 })).toThrow(/typeName is required/);
  });

  test('rejects a negative or fractional absolute rebalance limit', () => {
    // A count of shards, so `0.5` is as meaningless as `-1`; `0` is the
    // documented way to switch the ceiling off and must stay accepted (#850).
    expect(() => check({ ...required, rebalanceAbsoluteLimit: -1 })).toThrow(/rebalanceAbsoluteLimit/);
    expect(() => check({ ...required, rebalanceAbsoluteLimit: 0.5 })).toThrow(OptionsError);
    expect(() => check({ ...required, rebalanceAbsoluteLimit: 0 })).not.toThrow();
  });

  test('rejects a relative rebalance limit outside 0..1', () => {
    // It is a fraction of `numShards`, so anything above 1 asks for more shards
    // than exist and reads as "6 shards" from someone who meant the absolute
    // limit.  Both ends of the range stay legal: `0` disables it, `1` is
    // "uncapped, spelt as a fraction" (#850).
    expect(() => check({ ...required, rebalanceRelativeLimit: -0.1 })).toThrow(/rebalanceRelativeLimit/);
    expect(() => check({ ...required, rebalanceRelativeLimit: 6 })).toThrow(OptionsError);
    expect(() => check({ ...required, rebalanceRelativeLimit: 0 })).not.toThrow();
    expect(() => check({ ...required, rebalanceRelativeLimit: 1 })).not.toThrow();
  });

  test('rejects a stale-after at or below the heartbeat interval (#853)', () => {
    // A threshold inside one beat evicts a healthy region between two of its
    // own beats, stopping every entity under every shard it held, and does it
    // again after the re-registration.
    expect(() => check({ ...required, regionHeartbeatIntervalMs: 5_000, regionStaleAfterMs: 5_000 }))
      .toThrow(/regionStaleAfterMs/);
    expect(() => check({ ...required, regionHeartbeatIntervalMs: 5_000, regionStaleAfterMs: 1_000 }))
      .toThrow(OptionsError);
    expect(() => check({ ...required, regionStaleAfterMs: 0 })).toThrow(/regionStaleAfterMs/);
  });

  test('the stale-after rule compares resolved values, not only set ones (#853)', () => {
    // The half a "only check what was set" rule misses, and the reason this
    // mirrors `ClusterRouterOptions`: each of these sets exactly one of the
    // pair, and each crosses the *other's* shipped default (5s beat, 20s
    // threshold) without either being visible at the call site.
    expect(() => check({ ...required, regionStaleAfterMs: 3_000 })).toThrow(/regionStaleAfterMs/);
    expect(() => check({ ...required, regionHeartbeatIntervalMs: 30_000 })).toThrow(/regionStaleAfterMs/);
    // And the shipped pair itself has to be legal, or every default start throws.
    expect(() => check({ ...required })).not.toThrow();
  });

  test('accepts a valid coordinator config', () => {
    expect(() => check({ ...required, numShards: 64, rebalanceIntervalMs: 10_000, handOffTimeoutMs: 5_000, acquireRetryIntervalMs: 5_000, rebalanceAbsoluteLimit: 8, rebalanceRelativeLimit: 0.25 }))
      .not.toThrow();
    expect(() => check({ ...required, staleRegionDetection: true, regionHeartbeatIntervalMs: 1_000, regionStaleAfterMs: 4_000 }))
      .not.toThrow();
  });
});

describe('StartSingletonOptionsValidator', () => {
  const check = (s: Partial<StartSingletonOptionsType<unknown>>): void =>
    new StartSingletonOptionsValidator<unknown>().validate(s);

  const required = {
    typeName: 'counter',
    actor: NoopEntity,
  } satisfies Partial<StartSingletonOptionsType<unknown>>;

  test('rejects empty typeName and non-positive acquireRetryIntervalMs', () => {
    expect(() => check({ ...required, typeName: '' })).toThrow(OptionsError);
    expect(() => check({ ...required, acquireRetryIntervalMs: 0 })).toThrow(/acquireRetryIntervalMs/);
    expect(() => check({ ...required, role: '' })).toThrow(/role/);
  });

  test('rejects a non-positive handOverTimeoutMs (#949)', () => {
    // A zero or negative wait is not "no hand-over" — it is a hand-over whose
    // deadline has already passed, so the manager would host without ever
    // reading an answer, which is the defect the option exists to bound.
    expect(() => check({ ...required, handOverTimeoutMs: 0 })).toThrow(/handOverTimeoutMs/);
    expect(() => check({ ...required, handOverTimeoutMs: -1 })).toThrow(OptionsError);
  });

  test('rejects a singleton missing typeName or actor', () => {
    // Both used to pass: the check helpers no-op on `undefined`, so a
    // singleton with no actor validated cleanly and blew up at the spawn.
    expect(() => check({})).toThrow(/typeName is required/);
    expect(() => check({ typeName: 'counter' })).toThrow(/actor is required/);
  });

  test('rejects a non-positive or fractional bufferSize', () => {
    expect(() => check({ ...required, bufferSize: 0 })).toThrow(/bufferSize/);
    expect(() => check({ ...required, bufferSize: -1 })).toThrow(/bufferSize/);
    expect(() => check({ ...required, bufferSize: 1.5 })).toThrow(/bufferSize/);
  });

  test('rejects a non-positive or fractional maxHandOverStateBytes (#194)', () => {
    // A byte count, so fractional is as meaningless as negative.  Zero is worth
    // rejecting rather than reading as "never ship state": warm hand-over is
    // turned off by not implementing the hooks, and a cap that silently means
    // "off" would leave an actor that does implement them looking broken.
    expect(() => check({ ...required, maxHandOverStateBytes: 0 })).toThrow(/maxHandOverStateBytes/);
    expect(() => check({ ...required, maxHandOverStateBytes: -1 })).toThrow(/maxHandOverStateBytes/);
    expect(() => check({ ...required, maxHandOverStateBytes: 1.5 })).toThrow(/maxHandOverStateBytes/);
  });

  test('accepts a valid singleton config', () => {
    expect(() => check({
      ...required,
      acquireRetryIntervalMs: 5_000,
      handOverTimeoutMs: 10_000,
      maxHandOverStateBytes: 65_536,
      bufferSize: 10,
    })).not.toThrow();
  });
});

describe('ClusterSingletonManagerOptionsValidator', () => {
  const check = (s: Partial<ClusterSingletonManagerOptionsType<unknown>>): void =>
    new ClusterSingletonManagerOptionsValidator<unknown>().validate(s);

  // Only the shape matters here — the validator never dereferences it.
  const required = {
    cluster: {} as ClusterSingletonManagerOptionsType<unknown>['cluster'],
    typeName: 'counter',
    singletonActor: NoopEntity,
  } satisfies Partial<ClusterSingletonManagerOptionsType<unknown>>;

  test('rejects each missing required field by name', () => {
    expect(() => check({})).toThrow(/cluster is required/);
    expect(() => check({ cluster: required.cluster })).toThrow(/typeName is required/);
    expect(() => check({ cluster: required.cluster, typeName: 'counter' }))
      .toThrow(/singletonActor is required/);
  });

  test('rejects empty typeName / role and non-positive acquireRetryIntervalMs', () => {
    expect(() => check({ ...required, typeName: '' })).toThrow(OptionsError);
    expect(() => check({ ...required, role: '' })).toThrow(/role/);
    expect(() => check({ ...required, acquireRetryIntervalMs: 0 })).toThrow(/acquireRetryIntervalMs/);
  });

  test('rejects a non-positive handOverTimeoutMs (#949)', () => {
    // The manager's own copy of the bound: `ClusterSingleton` builds these
    // options field by field, so both surfaces have to reject the same value or
    // the one nobody validates is the one a caller reaches.
    expect(() => check({ ...required, handOverTimeoutMs: 0 })).toThrow(/handOverTimeoutMs/);
    expect(() => check({ ...required, handOverTimeoutMs: -1 })).toThrow(OptionsError);
  });

  test('rejects a non-positive maxHandOverStateBytes (#194)', () => {
    // Same reasoning as `handOverTimeoutMs` above: the extension copies this
    // field across by hand, so a bound only one of the two surfaces enforces is
    // a bound a caller can walk around.
    expect(() => check({ ...required, maxHandOverStateBytes: 0 })).toThrow(/maxHandOverStateBytes/);
    expect(() => check({ ...required, maxHandOverStateBytes: 1.5 })).toThrow(OptionsError);
  });

  test('accepts a valid manager config', () => {
    expect(() => check({
      ...required,
      role: 'worker',
      acquireRetryIntervalMs: 1_000,
      handOverTimeoutMs: 10_000,
      maxHandOverStateBytes: 65_536,
    })).not.toThrow();
  });
});

describe('WorkerClusterOptionsValidator', () => {
  // `bootstrap` is required and scheme-constrained (#776), so every case that
  // is about some *other* field supplies a valid one; the bootstrap cases below
  // override it.
  const check = (s: Partial<WorkerClusterOptionsType>): void =>
    new WorkerClusterOptionsValidator().validate({ bootstrap: 'file:///worker.js', ...s });

  test('requires a bootstrap rather than letting new URL(undefined) throw', () => {
    // The value of the rule is the error, not the rejection: without it an
    // empty options object reached `new URL(undefined)` inside `spawn()` and
    // surfaced a raw ERR_INVALID_URL naming no field at all.
    expect(() => new WorkerClusterOptionsValidator().validate({})).toThrow(OptionsError);
    expect(() => new WorkerClusterOptionsValidator().validate({}))
      .toThrow(/bootstrap is required/);
  });

  test('accepts a file: bootstrap as a URL or as a string', () => {
    expect(() => check({ bootstrap: new URL('file:///srv/app/worker.js') })).not.toThrow();
    expect(() => check({ bootstrap: 'file:///srv/app/worker.js' })).not.toThrow();
  });

  test('rejects every scheme a Worker constructor would otherwise execute', () => {
    // Measured per runtime, not assumed: `data:` runs on Bun, Node and Deno,
    // `blob:` on Bun and Deno, and a remote entry is fetched and run on Deno.
    for (const bootstrap of [
      'data:text/javascript,console.log(1)',
      'blob:null/2c9a1f34-0000-4000-8000-000000000000',
      'http://example.invalid/worker.js',
      'https://example.invalid/worker.js',
    ]) {
      expect(() => check({ bootstrap })).toThrow(/bootstrap must use the file: scheme/);
    }
  });

  test('rejects a file: bootstrap that carries a host, as a string and as a URL', () => {
    // The scheme check alone was not the allow-list it read as (#776): a
    // `file:` URL may carry an authority, and on Windows that authority IS a
    // remote server.  Measured on this machine (Windows 11, Node 26.7.0):
    // `fileURLToPath('file://attacker.example.com/share/worker.js')` yields the
    // UNC path `\\attacker.example.com\share\worker.js`, and none of the three
    // runtimes refuses the specifier — Node's Worker fails with
    // MODULE_NOT_FOUND on that UNC path, Deno with `Module not found
    // "file://attacker.example.com/share/worker.js"`, Bun with an
    // `Error in worker`.  All three ACCEPTED the URL and only the SMB fetch
    // failed, so on a host where the share resolves the worker's entry module
    // comes off a remote server.  Both input forms, because `parseBootstrapUrl`
    // passes a `URL` through untouched and only the string form is parsed here.
    for (const host of ['attacker.example.com', '127.0.0.1', '[::1]', '.']) {
      const specifier = `file://${host}/share/worker.js`;
      expect(() => check({ bootstrap: specifier }))
        .toThrow(/bootstrap must be a host-less file: URL/);
      expect(() => check({ bootstrap: new URL(specifier) }))
        .toThrow(/bootstrap must be a host-less file: URL/);
    }
  });

  test('keeps accepting the host-less forms, localhost included', () => {
    // `file:///path` has an empty host and is the only form the docs and
    // examples ever produce — `new URL('./worker.js', import.meta.url)` yields
    // it.  `file://localhost/path` is the other host WHATWG allows, and the
    // spec has the parser erase it: measured identically on Bun 1.4.0, Node
    // 26.7.0 and Deno 2.6.8, `new URL('file://localhost/srv/app/worker.js')`
    // normalises to `file:///srv/app/worker.js` with `host === ''` (and so does
    // `LOCALHOST` — the host is lower-cased first).  So it is admitted by the
    // host rule rather than exempted from it, and it resolves locally.
    for (const bootstrap of [
      'file:///srv/app/worker.js',
      'file://localhost/srv/app/worker.js',
      'file://LOCALHOST/srv/app/worker.js',
    ]) {
      expect(() => check({ bootstrap })).not.toThrow();
      expect(() => check({ bootstrap: new URL(bootstrap) })).not.toThrow();
    }
  });

  test('rejects a bare relative specifier with a message that names the fix', () => {
    // `new URL('./worker.js')` throws with no base, so this never reached the
    // Worker constructor — it just failed later, and less legibly.
    expect(() => check({ bootstrap: './worker.js' }))
      .toThrow(/bootstrap must be an absolute URL.*import\.meta\.url/s);
  });

  test("accepts a positive integer or 'auto' for workers", () => {
    expect(() => check({ workers: 4 })).not.toThrow();
    expect(() => check({ workers: 'auto' })).not.toThrow();
    expect(() => check({ workers: 0 })).toThrow(OptionsError);
  });

  test('rejects an out-of-range basePort and non-positive readyTimeoutMs', () => {
    expect(() => check({ basePort: 70_000 })).toThrow(OptionsError);
    expect(() => check({ readyTimeoutMs: 0 })).toThrow(OptionsError);
  });

  test('rejects an empty systemName or hostname', () => {
    // Unreachable until these got config leaves (#883): every code caller was
    // passing a real name.  An empty one reaches NodeAddress and gives every
    // worker an address with no host, or no system name.
    expect(() => check({ systemName: '' })).toThrow(OptionsError);
    expect(() => check({ hostname: '' })).toThrow(OptionsError);
    expect(() => check({ systemName: 'ingest', hostname: 'ingest-worker' })).not.toThrow();
    // Unset still passes -- the helpers are a no-op on undefined, and the
    // built-in defaults fill both in.
    expect(() => check({})).not.toThrow();
  });

  test('accepts the restart-budget knobs at their edges', () => {
    // A zero floor means "respawn on the next turn"; a zero window means the
    // counts are never reset; -1 restarts restores the unbounded behaviour.
    expect(() => check({ restartMinBackoffMs: 0, restartMaxBackoffMs: 0 })).not.toThrow();
    expect(() => check({ restartRandomFactor: 0 })).not.toThrow();
    expect(() => check({ restartRandomFactor: 1 })).not.toThrow();
    expect(() => check({ maxRestarts: -1 })).not.toThrow();
    expect(() => check({ maxRestarts: 0 })).not.toThrow();
    expect(() => check({ restartWindowMs: 0 })).not.toThrow();
  });

  test('rejects out-of-domain restart-budget knobs', () => {
    expect(() => check({ restartMinBackoffMs: -1 })).toThrow(OptionsError);
    expect(() => check({ restartMaxBackoffMs: -1 })).toThrow(OptionsError);
    expect(() => check({ restartRandomFactor: 1.5 })).toThrow(OptionsError);
    expect(() => check({ restartWindowMs: -1 })).toThrow(OptionsError);
    expect(() => check({ maxRestarts: -2 })).toThrow(OptionsError);
    expect(() => check({ maxRestarts: 2.5 })).toThrow(OptionsError);
  });

  test('rejects a maximum respawn backoff below the minimum', () => {
    expect(() => check({ restartMinBackoffMs: 500, restartMaxBackoffMs: 100 }))
      .toThrow(/restartMaxBackoffMs must be >= restartMinBackoffMs \(500\)/);
  });
});

describe('ProducerControllerOptionsValidator', () => {
  const check = (s: Partial<ProducerControllerOptionsType<unknown>>): void =>
    new ProducerControllerOptionsValidator<unknown>().validate(s);

  test('rejects a non-positive resendTimeout / windowSize', () => {
    expect(() => check({ resendTimeout: 0 })).toThrow(OptionsError);
    expect(() => check({ windowSize: 0 })).toThrow(OptionsError);
  });

  test('accepts sensible flow-control values', () => {
    expect(() => check({ resendTimeout: 500, windowSize: 16 })).not.toThrow();
  });

  test('rejects an empty or over-long producerId', () => {
    // The consumer refuses an identifier past this bound, so accepting one
    // here would turn every delivery from this producer into a silent dead
    // letter instead of a construction-time error (#727, #728).
    expect(() => check({ producerId: '' })).toThrow(OptionsError);
    expect(() => check({ producerId: 'x'.repeat(MAX_DELIVERY_IDENTIFIER_LENGTH + 1) })).toThrow(OptionsError);
    expect(() => check({ producerId: 'x'.repeat(MAX_DELIVERY_IDENTIFIER_LENGTH) })).not.toThrow();
    expect(() => check({ producerId: 'orders' })).not.toThrow();
  });
});

describe('ConsumerControllerOptionsValidator', () => {
  const check = (s: Partial<ConsumerControllerOptionsType<unknown>>): void =>
    new ConsumerControllerOptionsValidator<unknown>().validate(s);

  test('rejects a maxProducers that is not a positive integer', () => {
    expect(() => check({ maxProducers: 0 })).toThrow(OptionsError);
    expect(() => check({ maxProducers: -1 })).toThrow(OptionsError);
    expect(() => check({ maxProducers: 2.5 })).toThrow(/maxProducers/);
    expect(() => check({ maxProducers: Number.NaN })).toThrow(/maxProducers/);
  });

  test('rejects a non-positive or non-finite producerIdleTtlMs', () => {
    expect(() => check({ producerIdleTtlMs: 0 })).toThrow(OptionsError);
    expect(() => check({ producerIdleTtlMs: -1 })).toThrow(/producerIdleTtlMs/);
    expect(() => check({ producerIdleTtlMs: Number.NaN })).toThrow(/producerIdleTtlMs/);
  });

  test('rejects a maxOutOfOrder that is not a positive integer', () => {
    expect(() => check({ maxOutOfOrder: 0 })).toThrow(OptionsError);
    expect(() => check({ maxOutOfOrder: -1 })).toThrow(/maxOutOfOrder/);
    expect(() => check({ maxOutOfOrder: 2.5 })).toThrow(/maxOutOfOrder/);
    expect(() => check({ maxOutOfOrder: Number.NaN })).toThrow(/maxOutOfOrder/);
  });

  test('accepts Infinity on all three bounds — it is the documented opt-out', () => {
    // `Infinity` is the value that says "no cap" / "no sweep" / "retain every
    // out-of-order sequence", so the generic positiveInt / positiveNumber
    // helpers cannot be used: they reject it.
    expect(() => check({ maxProducers: Infinity })).not.toThrow();
    expect(() => check({ producerIdleTtlMs: Infinity })).not.toThrow();
    expect(() => check({ maxOutOfOrder: Infinity })).not.toThrow();
  });

  test('accepts the built-in defaults and an unset options object', () => {
    expect(() => check({
      maxProducers: DEFAULT_MAX_PRODUCERS,
      producerIdleTtlMs: DEFAULT_PRODUCER_IDLE_TTL_MS,
      maxOutOfOrder: DEFAULT_MAX_OUT_OF_ORDER,
    })).not.toThrow();
    // Every helper is a no-op on `undefined`; `handler` is required rather
    // than bounded, and asserting it at construction is #1234.
    expect(() => check({})).not.toThrow();
  });

  test('the shipped defaults are the ones the validator would accept', () => {
    // Reading the constants rather than repeating their values is what keeps
    // this case honest: a default changed to something its own validator
    // rejects would otherwise pass here forever.
    expect(Number.isInteger(DEFAULT_MAX_PRODUCERS) && DEFAULT_MAX_PRODUCERS >= 1).toBe(true);
    expect(Number.isInteger(DEFAULT_MAX_OUT_OF_ORDER) && DEFAULT_MAX_OUT_OF_ORDER >= 1).toBe(true);
    // The out-of-order cap has one more constraint than the map cap, and it is
    // a floor rather than the bound this comment used to claim.  Reaching the
    // cap stalls a producer, and a producer whose window exceeds it stalls on
    // its very first gap with nothing queued at all — that many sends are
    // already in flight when the gap opens.  What it is NOT is unreachable
    // otherwise: the consumer acknowledges every out-of-order delivery it
    // admits, so a stock producer streams past an open gap by its send count
    // and not by `windowSize - 1` (measured in `tests/unit/delivery`).
    expect(DEFAULT_MAX_OUT_OF_ORDER).toBeGreaterThan(DEFAULT_WINDOW_SIZE);
  });
});

describe('ThrottleOptionsValidator', () => {
  const check = (s: Partial<ThrottleOptionsType>): void =>
    new ThrottleOptionsValidator().validate(s);

  test('rejects a qps that is zero, negative, NaN, or -Infinity', () => {
    expect(() => check({ qps: 0 })).toThrow(OptionsError);
    expect(() => check({ qps: -1 })).toThrow(/qps/);
    expect(() => check({ qps: Number.NaN })).toThrow(/qps/);
    expect(() => check({ qps: -Infinity })).toThrow(/qps/);
  });

  test('accepts qps: Infinity — the documented "clear the throttle" sentinel', () => {
    // `Infinity` means "remove the limiter", so the generic positiveNumber
    // helper cannot stand in for qps: it rejects every non-finite value.
    expect(() => check({ qps: Infinity })).not.toThrow();
  });

  test('rejects a non-positive burst and an unknown onExcess mode', () => {
    expect(() => check({ qps: 10, burst: 0 })).toThrow(/burst/);
    expect(() => check({ qps: 10, burst: -2 })).toThrow(OptionsError);
    expect(() => check({ qps: 10, onExcess: 'explode' as ThrottleOnExcess })).toThrow(/onExcess/);
  });

  test('accepts valid configs, including a sub-1 qps', () => {
    expect(() => check({ qps: 10, burst: 2, onExcess: 'drop' })).not.toThrow();
    expect(() => check({ qps: 1 / 60, burst: 1 })).not.toThrow();
  });
});

describe('discovery option validators', () => {
  test('AutoDiscovery: empty systemName / non-positive port', () => {
    const check = (s: Partial<AutoDiscoveryOptionsType>): void =>
      new AutoDiscoveryOptionsValidator().validate(s);
    expect(() => check({ systemName: '', port: 2552 })).toThrow(OptionsError);
    expect(() => check({ systemName: 'sys', port: 0 })).toThrow(OptionsError);
    expect(() => check({ systemName: 'sys', port: 2552 })).not.toThrow();
  });

  test('ConfigSeedProvider: empty seeds / systemName', () => {
    const check = (s: Partial<ConfigSeedProviderOptionsType>): void =>
      new ConfigSeedProviderOptionsValidator().validate(s);
    expect(() => check({ seeds: [], systemName: 'sys' })).toThrow(/seeds/);
    expect(() => check({ seeds: ['a@h:1'], systemName: '' })).toThrow(OptionsError);
    expect(() => check({ seeds: ['a@h:1'], systemName: 'sys' })).not.toThrow();
  });

  test('KubernetesApiSeedProvider: required names + positive port', () => {
    const check = (s: Partial<KubernetesApiSeedProviderOptionsType>): void =>
      new KubernetesApiSeedProviderOptionsValidator().validate(s);
    expect(() => check({ namespace: '', serviceName: 'svc', systemName: 'sys', port: 2552 })).toThrow(OptionsError);
    expect(() => check({ namespace: 'ns', serviceName: 'svc', systemName: 'sys', port: 0 })).toThrow(OptionsError);
  });

  // #597: both names are interpolated into the K8s API path by the default
  // fetcher.  `endpointsPath` percent-encodes them, which contains the
  // traversal; this rule is the half that turns the resulting puzzling 404
  // into a rejection naming the field.
  test('KubernetesApiSeedProvider: names must be DNS-1123 (#597)', () => {
    const check = (s: Partial<KubernetesApiSeedProviderOptionsType>): void =>
      new KubernetesApiSeedProviderOptionsValidator().validate(s);
    const base = { namespace: 'actors', serviceName: 'actor-ts', systemName: 'sys', port: 2552 };
    expect(() => check(base)).not.toThrow();

    expect(() => check({ ...base, serviceName: 'app/../../../namespaces/other/endpoints/decoy' }))
      .toThrow(/serviceName/);
    expect(() => check({ ...base, serviceName: 'actor-ts?watch=true' })).toThrow(OptionsError);
    expect(() => check({ ...base, namespace: '../kube-system' })).toThrow(/namespace/);
    // `$` in a JS regex also matches before a trailing newline, so an
    // `^…$` rule would have waved this one through.
    expect(() => check({ ...base, serviceName: 'actor-ts\n' })).toThrow(/serviceName/);
    // Kubernetes names are lowercase, and a namespace is a label: no dots,
    // at most 63 characters.
    expect(() => check({ ...base, serviceName: 'Actor-TS' })).toThrow(/serviceName/);
    expect(() => check({ ...base, namespace: 'kube.system' })).toThrow(/namespace/);
    expect(() => check({ ...base, namespace: 'n'.repeat(64) })).toThrow(/namespace/);

    // An Endpoints object may carry a dotted name, so `serviceName` is the
    // wider subdomain form — a label rule would lock those out.
    expect(() => check({ ...base, serviceName: 'actor-ts.default.svc' })).not.toThrow();
  });

  test('KubernetesApiSeedProvider: a custom fetchEndpoints lifts the name shape rule (#597)', () => {
    // The shape rule exists because the DEFAULT fetcher builds an API path
    // out of the two names.  A caller-supplied fetcher builds its own
    // request, so there its names are plain labels.
    const check = (s: Partial<KubernetesApiSeedProviderOptionsType>): void =>
      new KubernetesApiSeedProviderOptionsValidator().validate(s);
    const base = { namespace: 'Consul DC', serviceName: 'Not A K8s Name', systemName: 'sys', port: 2552 };
    expect(() => check(base)).toThrow(OptionsError);
    expect(() => check({ ...base, fetchEndpoints: async () => ['10.244.0.1'] })).not.toThrow();
    // …but they are still required to be non-empty.
    expect(() => check({ ...base, serviceName: '', fetchEndpoints: async () => [] })).toThrow(/serviceName/);
  });

  test('Receptionist: non-positive gossipIntervalMs', () => {
    const check = (s: Partial<ReceptionistOptionsType>): void =>
      new ReceptionistOptionsValidator().validate(s);
    expect(() => check({ gossipIntervalMs: 0 })).toThrow(/gossipIntervalMs/);
    expect(() => check({ gossipIntervalMs: 1_000 })).not.toThrow();
  });

  test('Receptionist: subscriber caps must be integers >= 1 (#137)', () => {
    // A cap of 0 would refuse every subscription and a fractional one would
    // refuse at an unpredictable point — both are configuration mistakes that
    // present as "discovery silently stopped working".
    const check = (s: Partial<ReceptionistOptionsType>): void =>
      new ReceptionistOptionsValidator().validate(s);
    expect(() => check({ maxSubscribersPerKey: 0 })).toThrow(/maxSubscribersPerKey/);
    expect(() => check({ maxSubscribersPerKey: 1.5 })).toThrow(OptionsError);
    expect(() => check({ maxSubscriptionsTotal: -1 })).toThrow(/maxSubscriptionsTotal/);
    expect(() => check({ maxSubscribersPerKey: 1_000, maxSubscriptionsTotal: 10_000 })).not.toThrow();
    // Unset stays valid — the actor's built-in defaults apply.
    expect(() => check({})).not.toThrow();
  });
});

describe('gossip-interval validators', () => {
  test('DistributedPubSub: non-positive gossipIntervalMs', () => {
    const check = (s: Partial<DistributedPubSubOptionsType>): void =>
      new DistributedPubSubOptionsValidator().validate(s);
    expect(() => check({ gossipIntervalMs: 0 })).toThrow(OptionsError);
  });

  test('DistributedPubSub: mediator caps must be integers >= 1 (#139)', () => {
    const check = (s: Partial<DistributedPubSubOptionsType>): void =>
      new DistributedPubSubOptionsValidator().validate(s);
    expect(() => check({ maxSubscribersPerTopic: 0 })).toThrow(/maxSubscribersPerTopic/);
    expect(() => check({ maxTopics: 0 })).toThrow(/maxTopics/);
    expect(() => check({ maxRemoteNodesPerTopic: 2.5 })).toThrow(/maxRemoteNodesPerTopic/);
    expect(() => check({
      maxSubscribersPerTopic: 10_000,
      maxTopics: 10_000,
      maxRemoteNodesPerTopic: 1_000,
      sendToDeadLettersWhenNoSubscribers: false,
    })).not.toThrow();
  });

  test('DistributedData: non-positive gossipInterval / fractional maxGossipBytes', () => {
    const check = (s: Partial<DistributedDataOptionsType>): void =>
      new DistributedDataOptionsValidator().validate(s);
    expect(() => check({ gossipInterval: -1 })).toThrow(/gossipInterval/);
    expect(() => check({ gossipInterval: 1_000 })).not.toThrow();
    // A byte budget compared against a frame length has to be a whole number;
    // `0` is the documented "no budget" spelling and stays legal.
    expect(() => check({ maxGossipBytes: 1.5 })).toThrow(/maxGossipBytes/);
    expect(() => check({ maxGossipBytes: 0 })).not.toThrow();
  });
});

describe('persistence + memcached validators', () => {
  test('MemcachedCache: empty servers', () => {
    const check = (s: Partial<MemcachedCacheOptionsType>): void =>
      new MemcachedCacheOptionsValidator().validate(s);
    expect(() => check({ servers: '' })).toThrow(OptionsError);
    expect(() => check({ servers: 'localhost:11211' })).not.toThrow();
  });

  test('CassandraJournal: out-of-range port / non-positive partitionSize', () => {
    const check = (s: Partial<CassandraJournalOptionsType>): void =>
      new CassandraJournalOptionsValidator().validate(s);
    expect(() => check({ port: 70_000 })).toThrow(OptionsError);
    expect(() => check({ partitionSize: 0 })).toThrow(/partitionSize/);
    expect(() => check({ port: 9042, partitionSize: 500_000 })).not.toThrow();
  });
});

describe('object-storage validators', () => {
  test('S3: bucket/region required + non-empty, endpoint URL', () => {
    const check = (s: Partial<S3ObjectStorageOptionsType>): void =>
      new S3ObjectStorageOptionsValidator().validate(s);
    expect(() => check({ region: 'eu-central-1' })).toThrow(/bucket/);            // missing bucket
    expect(() => check({ bucket: 'b' })).toThrow(/region/);                        // missing region
    expect(() => check({ bucket: 'b', region: '' })).toThrow(OptionsError);        // empty region
    expect(() => check({ bucket: 'b', region: 'r', endpoint: 'ftp://x' })).toThrow(OptionsError);
    expect(() => check({ bucket: 'b', region: 'r', endpoint: 'https://minio:9000' })).not.toThrow();
  });

  test('Filesystem: dir required + positive lock timeouts', () => {
    const check = (s: Partial<FilesystemObjectStorageOptionsType>): void =>
      new FilesystemObjectStorageOptionsValidator().validate(s);
    expect(() => check({})).toThrow(/dir/);
    expect(() => check({ dir: '/var/x', lockTimeoutMs: 0 })).toThrow(OptionsError);
    expect(() => check({ dir: '/var/x', staleLockMs: -1 })).toThrow(OptionsError);
    expect(() => check({ dir: '/var/x' })).not.toThrow();
  });
});

describe('downing-strategy validators', () => {
  test('KeepReferee: refereeAddress required + positive quorum', () => {
    const check = (s: Partial<KeepRefereeOptionsType>): void =>
      new KeepRefereeOptionsValidator().validate(s);
    expect(() => check({})).toThrow(/refereeAddress/);
    expect(() => check({ refereeAddress: 'sys@h:2551', downAllIfBelowQuorum: 0 })).toThrow(OptionsError);
    expect(() => check({ refereeAddress: 'sys@h:2551' })).not.toThrow();
  });

  test('LeaseMajority: positive acquireTimeoutMs', () => {
    const check = (s: Partial<LeaseMajorityOptionsType>): void =>
      new LeaseMajorityOptionsValidator().validate(s);
    expect(() => check({ acquireTimeoutMs: 0 })).toThrow(/acquireTimeoutMs/);
    expect(() => check({ acquireTimeoutMs: 5_000 })).not.toThrow();
  });
});

describe('ClusterRouterOptionsValidator', () => {
  const check = (s: Partial<ClusterRouterOptionsType<unknown>>): void =>
    new ClusterRouterOptionsValidator<unknown>().validate(s);

  test('rejects an unknown routerType and empty routeePath', () => {
    expect(() => check({ routerType: 'spray' as never, routeePath: '/user/x' })).toThrow(/routerType/);
    expect(() => check({ routerType: 'round-robin', routeePath: '' })).toThrow(OptionsError);
  });

  test('consistent-hashing requires extractKey (cross-field)', () => {
    expect(() => check({ routerType: 'consistent-hashing', routeePath: '/user/x' })).toThrow(/extractKey/);
    expect(() => check({ routerType: 'consistent-hashing', routeePath: '/user/x', extractKey: () => 'k' })).not.toThrow();
  });

  test('accepts a valid non-hashing config', () => {
    expect(() => check({ routerType: 'broadcast', routeePath: '/user/x' })).not.toThrow();
  });
});

describe('TestProbeOptionsValidator', () => {
  test('rejects a non-positive defaultTimeoutMs', () => {
    const check = (s: Partial<TestProbeOptionsType>): void =>
      new TestProbeOptionsValidator().validate(s);
    expect(() => check({ defaultTimeoutMs: 0 })).toThrow(OptionsError);
    expect(() => check({ defaultTimeoutMs: 3_000 })).not.toThrow();
  });
});
