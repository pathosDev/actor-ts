import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { KafkaOptionsValidator, type KafkaOptionsType } from '../../../../src/io/broker/KafkaOptions.js';
import { AmqpOptionsValidator, type AmqpOptionsType } from '../../../../src/io/broker/AmqpOptions.js';
import { RedisStreamsOptionsValidator, type RedisStreamsOptionsType } from '../../../../src/io/broker/RedisStreamsOptions.js';
import { NatsOptionsValidator, type NatsOptionsType } from '../../../../src/io/broker/NatsOptions.js';
import { JetStreamOptionsValidator, type JetStreamOptionsType } from '../../../../src/io/broker/JetStreamOptions.js';
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

  test('rejects a non-positive ackTimeout', () => {
    expect(() => check({ servers: 'nats://h:4222', ackTimeout: 0 })).toThrow(/ackTimeout/);
  });

  test('accepts a valid configuration', () => {
    expect(() => check({ servers: 'nats://h:4222', ackTimeout: 30_000 })).not.toThrow();
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
