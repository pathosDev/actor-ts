import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { FailureDetectorOptionsValidator, type FailureDetectorOptionsType } from '../../../src/cluster/FailureDetectorOptions.js';
import {
  ClusterClientReceptionistOptionsValidator,
  type ClusterClientReceptionistOptionsType,
} from '../../../src/cluster/ClusterClientReceptionistOptions.js';
import { WebSocketClientOptionsValidator, type WebSocketClientOptionsType } from '../../../src/http/ws/WebSocketClientOptions.js';
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
import { WorkerClusterOptionsValidator, type WorkerClusterOptionsType } from '../../../src/worker/WorkerClusterOptions.js';
import {
  ProducerControllerOptionsValidator,
  type ProducerControllerOptionsType,
} from '../../../src/delivery/ProducerControllerOptions.js';

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

describe('WebSocketClientOptionsValidator', () => {
  const check = (s: Partial<WebSocketClientOptionsType>): void =>
    new WebSocketClientOptionsValidator().validate(s);

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

  test('rejects a non-http apiServerUrl', () => {
    expect(() => check({ apiServerUrl: 'ftp://k8s' })).toThrow(OptionsError);
  });

  test('accepts a valid k8s lease config', () => {
    expect(() => check({ name: 's', owner: 'o', ttlMs: 15_000, namespace: 'actors', apiServerUrl: 'https://k8s.default.svc' }))
      .not.toThrow();
  });
});

describe('ShardingOptionsValidator', () => {
  const check = (s: Partial<ShardingOptionsType<unknown>>): void =>
    new ShardingOptionsValidator<unknown>().validate(s);

  test('rejects numShards < 1 and negative maxEntities', () => {
    expect(() => check({ numShards: 0 })).toThrow(OptionsError);
    expect(() => check({ maxEntities: -1 })).toThrow(OptionsError);
  });

  test('accepts sensible sharding values (0 maxEntities = no cap)', () => {
    expect(() => check({ numShards: 64, maxEntities: 0, passivationIdleMs: 0 })).not.toThrow();
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
