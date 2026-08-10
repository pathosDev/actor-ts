import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { KafkaOptionsValidator, type KafkaOptionsType } from '../../../../src/io/broker/KafkaOptions.js';
import { AmqpOptionsValidator, type AmqpOptionsType } from '../../../../src/io/broker/AmqpOptions.js';
import { RedisStreamsOptionsValidator, type RedisStreamsOptionsType } from '../../../../src/io/broker/RedisStreamsOptions.js';
import { NatsOptionsValidator, type NatsOptionsType } from '../../../../src/io/broker/NatsOptions.js';
import { JetStreamOptionsValidator, type JetStreamOptionsType } from '../../../../src/io/broker/JetStreamOptions.js';
import { JetStreamKeyValueOptionsValidator, type JetStreamKeyValueOptionsType } from '../../../../src/io/broker/JetStreamKeyValueOptions.js';
import { JetStreamObjectStoreOptionsValidator, type JetStreamObjectStoreOptionsType } from '../../../../src/io/broker/JetStreamObjectStoreOptions.js';
import { SseOptionsValidator, type SseOptionsType } from '../../../../src/io/broker/SseOptions.js';
import { TcpSocketOptionsValidator, type TcpSocketOptionsType } from '../../../../src/io/broker/TcpSocketOptions.js';
import { UdpSocketOptionsValidator, type UdpSocketOptionsType } from '../../../../src/io/broker/UdpSocketOptions.js';
import { GrpcClientOptionsValidator, type GrpcClientOptionsType } from '../../../../src/io/broker/GrpcClientOptions.js';

// Direct validator tests. The optionsValidator() hook is proven to fire in
// preStart end-to-end by the MqttOptions integration test; here we exercise
// each broker's rules (and the shared commonRules) without the actor infra.

describe('BrokerOptionsValidator — common broker fields (via Kafka)', () => {
  const check = (s: Partial<KafkaOptionsType>): void => new KafkaOptionsValidator().validate(s);
  const ok: Partial<KafkaOptionsType> = { brokers: ['k:9092'] };

  test('rejects a negative outboundBuffer', () => {
    expect(() => check({ ...ok, outboundBuffer: -1 })).toThrow(OptionsError);
  });

  test('accepts reconnect: false', () => {
    expect(() => check({ ...ok, reconnect: false })).not.toThrow();
  });

  test('rejects reconnect.factor < 1', () => {
    expect(() => check({ ...ok, reconnect: { factor: 0.5 } })).toThrow(/reconnect\.factor/);
  });

  test('allows reconnect.maxAttempts = Infinity (retry forever)', () => {
    expect(() => check({ ...ok, reconnect: { maxAttempts: Infinity } })).not.toThrow();
  });

  test('rejects circuitBreaker.failureThreshold < 1', () => {
    expect(() => check({ ...ok, circuitBreaker: { failureThreshold: 0, resetMs: 100 } }))
      .toThrow(/circuitBreaker\.failureThreshold/);
  });
});

describe('KafkaOptionsValidator', () => {
  const check = (s: Partial<KafkaOptionsType>): void => new KafkaOptionsValidator().validate(s);

  test('rejects empty brokers (array and string)', () => {
    expect(() => check({ brokers: [] })).toThrow(OptionsError);
    expect(() => check({ brokers: '' })).toThrow(OptionsError);
  });

  test('accepts brokers as a non-empty string or array', () => {
    expect(() => check({ brokers: 'k1:9092,k2:9092' })).not.toThrow();
    expect(() => check({ brokers: ['k1:9092'] })).not.toThrow();
  });

  test('rejects a non-positive consumer.commitTimeoutMs', () => {
    expect(() => check({ brokers: ['k:9092'], consumer: { commitTimeoutMs: 0 } }))
      .toThrow(/consumer\.commitTimeoutMs/);
  });
});

describe('AmqpOptionsValidator', () => {
  const check = (s: Partial<AmqpOptionsType>): void => new AmqpOptionsValidator().validate(s);

  test('accepts amqp / amqps urls', () => {
    expect(() => check({ url: 'amqp://user:pass@host:5672/vhost' })).not.toThrow();
    expect(() => check({ url: 'amqps://host:5671' })).not.toThrow();
  });

  test('rejects a non-amqp url', () => {
    expect(() => check({ url: 'http://host:5672' })).toThrow(OptionsError);
  });

  test('rejects a negative prefetch but accepts 0 (unlimited)', () => {
    expect(() => check({ prefetch: -1 })).toThrow(OptionsError);
    expect(() => check({ prefetch: 0 })).not.toThrow();
  });
});

describe('RedisStreamsOptionsValidator', () => {
  const check = (s: Partial<RedisStreamsOptionsType>): void => new RedisStreamsOptionsValidator().validate(s);

  test('accepts redis / rediss urls', () => {
    expect(() => check({ url: 'redis://host:6379' })).not.toThrow();
    expect(() => check({ url: 'rediss://host:6379' })).not.toThrow();
  });

  test('rejects a non-redis url', () => {
    expect(() => check({ url: 'amqp://host' })).toThrow(OptionsError);
  });

  test('rejects a negative blockMs but accepts 0 (block indefinitely)', () => {
    expect(() => check({ blockMs: -1 })).toThrow(OptionsError);
    expect(() => check({ blockMs: 0 })).not.toThrow();
  });
});

describe('NatsOptionsValidator', () => {
  const check = (s: Partial<NatsOptionsType>): void => new NatsOptionsValidator().validate(s);

  test('rejects empty servers', () => {
    expect(() => check({ servers: [] })).toThrow(OptionsError);
    expect(() => check({ servers: '' })).toThrow(OptionsError);
  });

  test('accepts non-empty servers', () => {
    expect(() => check({ servers: 'nats://localhost:4222' })).not.toThrow();
    expect(() => check({ servers: ['nats://a:4222', 'nats://b:4222'] })).not.toThrow();
  });
});

describe('JetStreamOptionsValidator', () => {
  const check = (s: Partial<JetStreamOptionsType>): void => new JetStreamOptionsValidator().validate(s);

  test('rejects empty servers', () => {
    expect(() => check({ servers: [] })).toThrow(OptionsError);
  });

  test('rejects a non-positive acknowledgmentTimeout', () => {
    expect(() => check({ servers: 'nats://h:4222', acknowledgmentTimeout: 0 })).toThrow(/acknowledgmentTimeout/);
  });

  test('accepts a valid configuration', () => {
    expect(() => check({ servers: 'nats://h:4222', acknowledgmentTimeout: 30_000 })).not.toThrow();
  });
});

describe('JetStreamKeyValueOptionsValidator', () => {
  const check = (s: Partial<JetStreamKeyValueOptionsType>): void =>
    new JetStreamKeyValueOptionsValidator().validate(s);
  const ok: Partial<JetStreamKeyValueOptionsType> = { servers: 'nats://h:4222', bucket: 'sessions' };

  test('rejects empty servers and an empty bucket', () => {
    expect(() => check({ ...ok, servers: [] })).toThrow(OptionsError);
    expect(() => check({ ...ok, bucket: '' })).toThrow(/bucket/);
  });

  test('rejects create-time limits outside their domain', () => {
    expect(() => check({ ...ok, history: 0 })).toThrow(/history/);
    expect(() => check({ ...ok, timeToLive: 0 })).toThrow(/timeToLive/);
    expect(() => check({ ...ok, storage: 'disk' as unknown as 'file' })).toThrow(/storage/);
    expect(() => check({ ...ok, replicas: 0 })).toThrow(/replicas/);
    expect(() => check({ ...ok, maxValueBytes: 0 })).toThrow(/maxValueBytes/);
  });

  test('accepts a valid configuration', () => {
    expect(() => check({
      ...ok, history: 5, timeToLive: 60_000, storage: 'file', replicas: 3, maxValueBytes: 4096,
    })).not.toThrow();
  });
});

describe('JetStreamObjectStoreOptionsValidator', () => {
  const check = (s: Partial<JetStreamObjectStoreOptionsType>): void =>
    new JetStreamObjectStoreOptionsValidator().validate(s);
  const ok: Partial<JetStreamObjectStoreOptionsType> = { servers: 'nats://h:4222', bucket: 'assets' };

  test('rejects empty servers and an empty bucket', () => {
    expect(() => check({ ...ok, servers: [] })).toThrow(OptionsError);
    expect(() => check({ ...ok, bucket: '' })).toThrow(/bucket/);
  });

  test('rejects a non-positive maxObjectBytes — a zero ceiling would reject every object', () => {
    expect(() => check({ ...ok, maxObjectBytes: 0 })).toThrow(/maxObjectBytes/);
    expect(() => check({ ...ok, maxObjectBytes: 1.5 })).toThrow(/maxObjectBytes/);
  });

  test('accepts a valid configuration', () => {
    expect(() => check({ ...ok, storage: 'file', replicas: 3, maxObjectBytes: 4 * 1024 * 1024 }))
      .not.toThrow();
  });
});

describe('SseOptionsValidator', () => {
  const check = (s: Partial<SseOptionsType>): void => new SseOptionsValidator().validate(s);

  test('accepts http / https urls', () => {
    expect(() => check({ url: 'http://host/events' })).not.toThrow();
    expect(() => check({ url: 'https://host/events' })).not.toThrow();
  });

  test('rejects a non-http url', () => {
    expect(() => check({ url: 'ws://host/events' })).toThrow(OptionsError);
  });
});

describe('TcpSocketOptionsValidator', () => {
  const check = (s: Partial<TcpSocketOptionsType>): void => new TcpSocketOptionsValidator().validate(s);

  test('rejects an out-of-range port and empty host', () => {
    expect(() => check({ host: 'h', port: 70_000 })).toThrow(OptionsError);
    expect(() => check({ host: '', port: 5000 })).toThrow(OptionsError);
  });

  test('accepts a valid host/port', () => {
    expect(() => check({ host: 'localhost', port: 9000 })).not.toThrow();
  });

  // #372 — the nested framing caps were unvalidated.  Both are applied as
  // `length > cap`, and every comparison against NaN is false, so a
  // non-numeric value did not clamp anything: it removed the cap and restored
  // the unbounded buffering the limit exists to prevent.
  test('rejects an implausible framing.maxLineLen', () => {
    for (const maxLineLen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => check({ host: 'h', port: 9000, framing: { kind: 'lines', maxLineLen } }),
        `maxLineLen=${maxLineLen} was accepted`,
      ).toThrow(OptionsError);
    }
  });

  test('rejects an implausible framing.maxFrameLen', () => {
    for (const maxFrameLen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => check({ host: 'h', port: 9000, framing: { kind: 'length-prefixed', maxFrameLen } }),
        `maxFrameLen=${maxFrameLen} was accepted`,
      ).toThrow(OptionsError);
    }
  });

  test('the error names the nested field', () => {
    try {
      check({ host: 'h', port: 9000, framing: { kind: 'lines', maxLineLen: Number.NaN } });
      throw new Error('expected the validator to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(OptionsError);
      expect((e as OptionsError).field).toBe('framing.maxLineLen');
    }
  });

  test('accepts plausible caps, an unset cap, and bytes framing', () => {
    expect(() => check({ host: 'h', port: 9000, framing: { kind: 'lines', maxLineLen: 65_536 } })).not.toThrow();
    expect(() => check({ host: 'h', port: 9000, framing: { kind: 'lines' } })).not.toThrow();
    expect(() => check({ host: 'h', port: 9000, framing: { kind: 'length-prefixed' } })).not.toThrow();
    expect(() => check({ host: 'h', port: 9000, framing: { kind: 'bytes' } })).not.toThrow();
    expect(() => check({ host: 'h', port: 9000 })).not.toThrow();
  });
});

describe('UdpSocketOptionsValidator', () => {
  const check = (s: Partial<UdpSocketOptionsType>): void => new UdpSocketOptionsValidator().validate(s);

  test('accepts bindPort 0 (OS-assigned) and rejects out-of-range', () => {
    expect(() => check({ bindPort: 0 })).not.toThrow();
    expect(() => check({ bindPort: 70_000 })).toThrow(OptionsError);
  });

  test('rejects an unknown socket type', () => {
    expect(() => check({ type: 'udp7' as unknown as 'udp4' })).toThrow(/type/);
  });
});

describe('GrpcClientOptionsValidator', () => {
  const check = (s: Partial<GrpcClientOptionsType>): void => new GrpcClientOptionsValidator().validate(s);

  test('rejects a non-positive deadlineMs', () => {
    expect(() => check({ deadlineMs: 0 })).toThrow(OptionsError);
  });

  test('accepts a positive deadlineMs', () => {
    expect(() => check({ deadlineMs: 30_000 })).not.toThrow();
  });
});
