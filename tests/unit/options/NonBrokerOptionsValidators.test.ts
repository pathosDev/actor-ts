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
  ProducerControllerOptionsValidator,
  type ProducerControllerOptionsType,
} from '../../../src/delivery/ProducerControllerOptions.js';
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

  test('accepts a valid coordinator config', () => {
    expect(() => check({ ...required, numShards: 64, rebalanceIntervalMs: 10_000, handOffTimeoutMs: 5_000, acquireRetryIntervalMs: 5_000 }))
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

  test('accepts a valid singleton config', () => {
    expect(() => check({ ...required, acquireRetryIntervalMs: 5_000, bufferSize: 10 })).not.toThrow();
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

  test('accepts a valid manager config', () => {
    expect(() => check({ ...required, role: 'worker', acquireRetryIntervalMs: 1_000 })).not.toThrow();
  });
});

describe('WorkerClusterOptionsValidator', () => {
  const check = (s: Partial<WorkerClusterOptionsType>): void =>
    new WorkerClusterOptionsValidator().validate(s);

  test("accepts a positive integer or 'auto' for workers", () => {
    expect(() => check({ workers: 4 })).not.toThrow();
    expect(() => check({ workers: 'auto' })).not.toThrow();
    expect(() => check({ workers: 0 })).toThrow(OptionsError);
  });

  test('rejects an out-of-range basePort and non-positive readyTimeoutMs', () => {
    expect(() => check({ basePort: 70_000 })).toThrow(OptionsError);
    expect(() => check({ readyTimeoutMs: 0 })).toThrow(OptionsError);
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
    expect(() => check({ maxSubscribersTotal: -1 })).toThrow(/maxSubscribersTotal/);
    expect(() => check({ maxSubscribersPerKey: 1_000, maxSubscribersTotal: 10_000 })).not.toThrow();
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

  test('DistributedData: non-positive gossipInterval', () => {
    const check = (s: Partial<DistributedDataOptionsType>): void =>
      new DistributedDataOptionsValidator().validate(s);
    expect(() => check({ gossipInterval: -1 })).toThrow(/gossipInterval/);
    expect(() => check({ gossipInterval: 1_000 })).not.toThrow();
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
