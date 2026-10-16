import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { KafkaOptionsValidator, type KafkaOptionsType } from '../../../../src/io/broker/KafkaOptions.js';
import { AmqpOptionsValidator, type AmqpOptionsType } from '../../../../src/io/broker/AmqpOptions.js';
import { RedisStreamsOptionsValidator, type RedisStreamsOptionsType } from '../../../../src/io/broker/RedisStreamsOptions.js';
import { MqttOptionsValidator, type MqttOptionsType } from '../../../../src/io/broker/MqttOptions.js';
import { NatsOptionsValidator, type NatsOptionsType } from '../../../../src/io/broker/NatsOptions.js';
import { JetStreamOptionsValidator, type JetStreamOptionsType } from '../../../../src/io/broker/JetStreamOptions.js';
import { JetStreamKeyValueOptionsValidator, type JetStreamKeyValueOptionsType } from '../../../../src/io/broker/JetStreamKeyValueOptions.js';
import { JetStreamObjectStoreOptionsValidator, type JetStreamObjectStoreOptionsType } from '../../../../src/io/broker/JetStreamObjectStoreOptions.js';
import { SseOptionsValidator, type SseOptionsType } from '../../../../src/io/broker/SseOptions.js';
import { TcpSocketOptionsValidator, type TcpSocketOptionsType } from '../../../../src/io/broker/TcpSocketOptions.js';
import { UdpSocketOptionsValidator, type UdpSocketOptionsType } from '../../../../src/io/broker/UdpSocketOptions.js';
import { GrpcClientOptionsValidator, type GrpcClientOptionsType } from '../../../../src/io/broker/GrpcClientOptions.js';
import { EmailBridgeOptionsValidator, type EmailBridgeOptionsType } from '../../../../src/io/broker/EmailBridgeOptions.js';
import type { EmailMessage } from '../../../../src/io/broker/EmailBridgeActor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';

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

  // #652 — the jitter fraction is bounded here so a nonsensical value is
  // rejected at construction rather than producing an absurd delay during
  // the outage that triggers the reconnect.
  test('rejects reconnect.randomFactor outside [0, 1]', () => {
    for (const randomFactor of [-0.1, 1.5, Number.NaN]) {
      expect(
        () => check({ ...ok, reconnect: { randomFactor } }),
        `randomFactor=${randomFactor} was accepted`,
      ).toThrow(/reconnect\.randomFactor/);
    }
  });

  test('accepts reconnect.randomFactor at both ends of the band', () => {
    expect(() => check({ ...ok, reconnect: { randomFactor: 0 } })).not.toThrow();
    expect(() => check({ ...ok, reconnect: { randomFactor: 1 } })).not.toThrow();
  });

  test('accepts a circuit-breaker id, and the empty id that means none', () => {
    expect(() => check({ ...ok, circuitBreaker: 'orders-kafka' })).not.toThrow();
    expect(() => check({ ...ok, circuitBreaker: '' })).not.toThrow();
  });

  // #1478 — the field is an id now.  A plain-JavaScript caller still handing
  // over the `{ failureThreshold, resetMs }` object it used to take would
  // otherwise resolve a breaker named "[object Object]" on the defaults.
  test('rejects a circuitBreaker that is not an id, naming where the numbers went', () => {
    const legacy = { failureThreshold: 3, resetMs: 1_000 } as unknown as string;
    expect(() => check({ ...ok, circuitBreaker: legacy })).toThrow(OptionsError);
    expect(() => check({ ...ok, circuitBreaker: legacy })).toThrow(/circuitBreaker must be a circuit-breaker id/);
    expect(() => check({ ...ok, circuitBreaker: legacy })).toThrow(/actor-ts\.circuit-breaker\.<id>/);
    expect(() => check({ ...ok, circuitBreaker: 5 as unknown as string })).toThrow(/circuitBreaker/);
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

/*
 * `consumer.deliverPolicy` is checked whole.  The compiler vouches for the
 * object arms only at a typed call site; a cast or a plain-JavaScript caller
 * hands over any `kind`, and one outside the union used to reach nats.js as
 * `deliver_policy: 'all'` — a consumer that replays the stream from its first
 * message.  Found while #1443.
 */
describe('JetStreamOptionsValidator — consumer.deliverPolicy', () => {
  type DeliverPolicy = NonNullable<JetStreamOptionsType['consumer']>['deliverPolicy'];
  const withPolicy = (deliverPolicy: unknown): Partial<JetStreamOptionsType> => ({
    servers: 'nats://h:4222',
    consumer: { durable: 'd', deliverPolicy: deliverPolicy as DeliverPolicy },
  });
  const refusalOf = (deliverPolicy: unknown): OptionsError => {
    try {
      new JetStreamOptionsValidator().validate(withPolicy(deliverPolicy));
    } catch (e) {
      if (e instanceof OptionsError) return e;
      throw e;
    }
    throw new Error(`deliverPolicy ${JSON.stringify(deliverPolicy)} was accepted`);
  };

  test('accepts the three strings and both object kinds', () => {
    const accepted: ReadonlyArray<DeliverPolicy> = [
      undefined,
      'all',
      'last',
      'new',
      { kind: 'by-start-sequence', startSeq: 4242 },
      { kind: 'by-start-time', startTimeMs: 1_767_225_600_000 },
    ];
    for (const deliverPolicy of accepted) {
      expect(
        () => new JetStreamOptionsValidator().validate(withPolicy(deliverPolicy)),
        `${JSON.stringify(deliverPolicy)} was refused`,
      ).not.toThrow();
    }
  });

  // Named like the HOCON reader names it, so the two doors a policy comes in
  // through give the same answer.
  test.each([
    { retired: 'byStartSeq', replacement: 'by-start-sequence', start: { startSeq: 4242 } },
    { retired: 'byStartTime', replacement: 'by-start-time', start: { startTimeMs: 1_767_225_600_000 } },
  ])('refuses the retired kind $retired, naming $replacement', ({ retired, replacement, start }) => {
    const refusal = refusalOf({ kind: retired, ...start });
    expect(refusal.field).toBe('consumer.deliverPolicy.kind');
    expect(refusal.value).toBe(retired);
    expect(refusal.message).toContain(`'${replacement}'`);
    expect(refusal.message).toMatch(/renamed/);
  });

  // Each near miss is what a lenient check would let through: the driver's
  // own spelling, a different case, a longer word, and a name every object
  // inherits — which a lookup with `in` would find.
  test.each(['from-the-top', 'by_start_sequence', 'By-Start-Sequence', 'by-start-sequences', 'constructor'])(
    'refuses the unknown kind %s, naming the kinds that exist',
    (kind) => {
      const refusal = refusalOf({ kind, startSeq: 4242, startTimeMs: 1_767_225_600_000 });
      expect(refusal.field).toBe('consumer.deliverPolicy.kind');
      expect(refusal.value).toBe(kind);
      expect(refusal.message).toContain("'by-start-sequence'");
      expect(refusal.message).toContain("'by-start-time'");
      expect(refusal.message).not.toMatch(/renamed/);
    },
  );

  test('refuses an object that carries no kind', () => {
    const refusal = refusalOf({ startSeq: 4242 });
    expect(refusal.field).toBe('consumer.deliverPolicy.kind');
    expect(refusal.message).toContain("'by-start-sequence'");
  });

  // Wrapped, because `test.each` spreads an array row into arguments.
  test.each([
    { label: 'null', deliverPolicy: null },
    { label: 'a number', deliverPolicy: 42 },
    { label: 'a boolean', deliverPolicy: true },
    { label: 'an array', deliverPolicy: ['by-start-sequence'] },
  ])('refuses $label, which is neither a string nor a { kind } object', ({ deliverPolicy }) => {
    const refusal = refusalOf(deliverPolicy);
    expect(refusal.field).toBe('consumer.deliverPolicy');
    expect(refusal.value).toEqual(deliverPolicy);
  });

  // An object arm is only as good as the value it carries: nats.js hands
  // `startSeq` on as `opt_start_seq` and `startTimeMs` as `opt_start_time`, so
  // an arm without a usable one provisions a consumer the server refuses at
  // connect — and since that error is rethrown into the reconnect loop, which
  // retries forever by default, a configuration mistake used to surface as an
  // endless outage instead of a startup failure naming the field.
  test.each([
    { label: 'a missing startSeq', start: {} },
    { label: 'startSeq 0, before the first sequence', start: { startSeq: 0 } },
    { label: 'a negative startSeq', start: { startSeq: -3 } },
    { label: 'a fractional startSeq', start: { startSeq: 7.5 } },
    { label: 'a NaN startSeq', start: { startSeq: Number.NaN } },
    { label: 'an infinite startSeq', start: { startSeq: Number.POSITIVE_INFINITY } },
    { label: 'a startSeq spelled as a string', start: { startSeq: '42' } },
  ])('refuses by-start-sequence with $label, naming the field', ({ start }) => {
    const refusal = refusalOf({ kind: 'by-start-sequence', ...start });
    expect(refusal.field).toBe('consumer.deliverPolicy.startSeq');
    expect(refusal.message).toMatch(/positive integer/);
  });

  test.each([
    { label: 'a missing startTimeMs', start: {} },
    { label: 'a negative startTimeMs', start: { startTimeMs: -1 } },
    { label: 'a NaN startTimeMs', start: { startTimeMs: Number.NaN } },
    { label: 'an infinite startTimeMs', start: { startTimeMs: Number.POSITIVE_INFINITY } },
    // Finite, and still past the last instant a Date can hold, so the actor's
    // `new Date(startTimeMs).toISOString()` throws a RangeError at connect.
    { label: 'a startTimeMs past the range of a Date', start: { startTimeMs: 8.64e15 + 1 } },
    { label: 'a startTimeMs spelled as a date string', start: { startTimeMs: '2026-01-01T00:00:00Z' } },
  ])('refuses by-start-time with $label, naming the field', ({ start }) => {
    const refusal = refusalOf({ kind: 'by-start-time', ...start });
    expect(refusal.field).toBe('consumer.deliverPolicy.startTimeMs');
    expect(refusal.message).toMatch(/epoch milliseconds/);
  });

  test('accepts the edges: the first sequence, the epoch, and the last instant a Date holds', () => {
    for (const deliverPolicy of [
      { kind: 'by-start-sequence', startSeq: 1 },
      { kind: 'by-start-time', startTimeMs: 0 },
      { kind: 'by-start-time', startTimeMs: 8.64e15 },
    ] as const) {
      expect(
        () => new JetStreamOptionsValidator().validate(withPolicy(deliverPolicy)),
        `${JSON.stringify(deliverPolicy)} was refused`,
      ).not.toThrow();
    }
    // The bound is the Date's own, not a rounder number near it.
    expect(new Date(8.64e15).toISOString()).toBe('+275760-09-13T00:00:00.000Z');
    expect(() => new Date(8.64e15 + 1).toISOString()).toThrow(RangeError);
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

  // #753 — `0` is the documented "off" for both deadlines, so the rule has to
  // be non-negative rather than positive: rejecting `0` would leave a
  // HOCON-set timeout with no way to switch it off per instance.
  test('accepts 0 for either liveness deadline and rejects a negative one', () => {
    expect(() => check({ url: 'http://host/events', idleTimeoutMs: 0 })).not.toThrow();
    expect(() => check({ url: 'http://host/events', connectTimeoutMs: 0 })).not.toThrow();
    expect(() => check({ url: 'http://host/events', idleTimeoutMs: -1 })).toThrow(/idleTimeoutMs/);
    expect(() => check({ url: 'http://host/events', connectTimeoutMs: -1 })).toThrow(/connectTimeoutMs/);
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

  // #753 — see the SSE case above for why `0` has to pass.
  test('accepts 0 for each liveness knob and rejects a negative one', () => {
    const base = { host: 'h', port: 9000 } as const;
    expect(() => check({ ...base, idleTimeoutMs: 0, connectTimeoutMs: 0, keepAliveMs: 0 }))
      .not.toThrow();
    expect(() => check({ ...base, idleTimeoutMs: -1 })).toThrow(/idleTimeoutMs/);
    expect(() => check({ ...base, connectTimeoutMs: -1 })).toThrow(/connectTimeoutMs/);
    expect(() => check({ ...base, keepAliveMs: -1 })).toThrow(/keepAliveMs/);
  });

  // #372 — the nested framing caps were unvalidated.  Both are applied as
  // `length > cap`, and every comparison against NaN is false, so a
  // non-numeric value did not clamp anything: it removed the cap and restored
  // the unbounded buffering the limit exists to prevent.
  test('rejects an implausible framing.maxLineBytes', () => {
    for (const maxLineBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => check({ host: 'h', port: 9000, framing: { kind: 'lines', maxLineBytes } }),
        `maxLineBytes=${maxLineBytes} was accepted`,
      ).toThrow(OptionsError);
    }
  });

  test('rejects an implausible framing.maxFrameBytes', () => {
    for (const maxFrameBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => check({ host: 'h', port: 9000, framing: { kind: 'length-prefixed', maxFrameBytes } }),
        `maxFrameBytes=${maxFrameBytes} was accepted`,
      ).toThrow(OptionsError);
    }
  });

  test('the error names the nested field', () => {
    try {
      check({ host: 'h', port: 9000, framing: { kind: 'lines', maxLineBytes: Number.NaN } });
      throw new Error('expected the validator to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(OptionsError);
      expect((e as OptionsError).field).toBe('framing.maxLineBytes');
    }
  });

  test('accepts plausible caps, an unset cap, and bytes framing', () => {
    expect(() => check({ host: 'h', port: 9000, framing: { kind: 'lines', maxLineBytes: 65_536 } })).not.toThrow();
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

describe('EmailBridgeOptionsValidator', () => {
  const check = (s: Partial<EmailBridgeOptionsType>): void => new EmailBridgeOptionsValidator().validate(s);
  // The validator only ever checks the ref for presence.
  const target = {} as ActorRef<EmailMessage>;
  const imap = { host: 'imap.example.test' };
  const smtp = { host: 'smtp.example.test' };

  test('accepts either side alone, and both together', () => {
    expect(() => check({ imap, target })).not.toThrow();
    expect(() => check({ smtp })).not.toThrow();
    expect(() => check({ imap, smtp, target })).not.toThrow();
  });

  test('rejects a bridge with neither side configured', () => {
    expect(() => check({})).toThrow(/at least one side/);
  });

  // Both directions: each half of the inbound pair is useless alone.
  test('rejects an imap side with no target', () => {
    expect(() => check({ imap })).toThrow(/target/);
  });

  test('rejects a target with no imap side', () => {
    expect(() => check({ smtp, target })).toThrow(/imap/);
  });

  test('rejects an empty or missing host on either side', () => {
    expect(() => check({ imap: { host: '' }, target })).toThrow(/imap\.host/);
    expect(() => check({ imap: {}, target })).toThrow(/imap\.host/);
    expect(() => check({ smtp: { host: '' } })).toThrow(/smtp\.host/);
  });

  test('rejects out-of-range ports', () => {
    expect(() => check({ imap: { ...imap, port: 0 }, target })).toThrow(/imap\.port/);
    expect(() => check({ smtp: { ...smtp, port: 70_000 } })).toThrow(/smtp\.port/);
  });

  test('rejects an unknown onProcessed action', () => {
    expect(() => check({ imap: { ...imap, onProcessed: 'delete' as 'move' }, target }))
      .toThrow(/imap\.onProcessed/);
  });

  // #1443 — every value a HOCON key takes is kebab-case, so the union lost
  // the camelCase spelling the action shipped with.  A caller that gets past
  // the type (plain JavaScript, a cast) meets this rule instead, and the rule
  // names the spelling that replaced it.
  test('refuses the retired markSeen spelling and accepts mark-seen', () => {
    expect(() => check({ imap: { ...imap, onProcessed: 'markSeen' as 'move' }, target }))
      .toThrow(/imap\.onProcessed must be one of "mark-seen", "move"/);
    expect(() => check({ imap: { ...imap, onProcessed: 'mark-seen' }, target })).not.toThrow();
  });

  test('rejects move mode without a destination', () => {
    expect(() => check({ imap: { ...imap, onProcessed: 'move' }, target }))
      .toThrow(/imap\.moveToMailbox/);
  });

  // Moving mail into the mailbox it is swept from redelivers it forever —
  // and the move itself succeeds, so nothing downstream would report it.
  test('rejects moving into the watched mailbox', () => {
    expect(() => check({
      imap: { ...imap, onProcessed: 'move', mailbox: 'Alerts', moveToMailbox: 'Alerts' },
      target,
    })).toThrow(/must differ from the watched mailbox/);
    // Same trap via the default mailbox name.
    expect(() => check({
      imap: { ...imap, onProcessed: 'move', moveToMailbox: 'INBOX' },
      target,
    })).toThrow(/must differ from the watched mailbox/);
  });

  test('accepts move mode with a different destination', () => {
    expect(() => check({
      imap: { ...imap, onProcessed: 'move', mailbox: 'INBOX', moveToMailbox: 'Processed' },
      target,
    })).not.toThrow();
  });

  test('rejects non-positive timings and sizes', () => {
    expect(() => check({ imap: { ...imap, pollIntervalMs: 0 }, target })).toThrow(/pollIntervalMs/);
    expect(() => check({ imap: { ...imap, maxIdleTimeMs: -1 }, target })).toThrow(/maxIdleTimeMs/);
    expect(() => check({ imap: { ...imap, maxMessageBytes: 0 }, target })).toThrow(/maxMessageBytes/);
    expect(() => check({ imap: { ...imap, acknowledgmentTimeoutMs: 0 }, target }))
      .toThrow(/acknowledgmentTimeoutMs/);
  });

  test('rejects non-positive pool sizing', () => {
    expect(() => check({ smtp: { ...smtp, maxConnections: 0 } })).toThrow(/maxConnections/);
    expect(() => check({ smtp: { ...smtp, maxMessages: 1.5 } })).toThrow(/maxMessages/);
  });

  test('rejects an empty default From', () => {
    expect(() => check({ smtp: { ...smtp, from: '' } })).toThrow(/smtp\.from/);
  });

  test('unset optionals always pass', () => {
    expect(() => check({ imap, smtp, target })).not.toThrow();
  });
});

/**
 * Client TLS material, on every broker that now takes it (#743).
 *
 * A certificate without its key is the one mistake catchable before the
 * handshake, and it is worth catching *here* rather than letting the driver
 * throw: a throw from `connectImplementation` is a connection failure to
 * `BrokerActor`, and `reconnect.maxAttempts` defaults to Infinity — so the
 * mistake would retry forever instead of failing the actor's start.
 */
describe('broker TLS material', () => {
  const halfCertificate = { cert: 'client-certificate' } as const;
  const halfKey = { key: 'client-key' } as const;
  const whole = { ca: 'private-ca', cert: 'client-certificate', key: 'client-key' } as const;

  test('AmqpOptions rejects a half-configured client certificate', () => {
    const check = (s: Partial<AmqpOptionsType>): void => new AmqpOptionsValidator().validate(s);
    expect(() => check({ url: 'amqps://host:5671', tls: halfCertificate })).toThrow(/tls/);
    expect(() => check({ url: 'amqps://host:5671', tls: halfKey })).toThrow(/tls/);
    expect(() => check({ url: 'amqps://host:5671', tls: whole })).not.toThrow();
    expect(() => check({ url: 'amqps://host:5671', tls: { ca: 'private-ca' } })).not.toThrow();
    expect(() => check({ url: 'amqps://host:5671' })).not.toThrow();
  });

  test('RedisStreamsOptions rejects a half-configured client certificate', () => {
    const check = (s: Partial<RedisStreamsOptionsType>): void =>
      new RedisStreamsOptionsValidator().validate(s);
    expect(() => check({ url: 'rediss://host:6379', tls: halfCertificate })).toThrow(/tls/);
    expect(() => check({ url: 'rediss://host:6379', tls: whole })).not.toThrow();
  });

  test('MqttOptions rejects a half-configured client certificate', () => {
    const check = (s: Partial<MqttOptionsType>): void => new MqttOptionsValidator().validate(s);
    expect(() => check({ brokerUrl: 'mqtts://host:8883', tls: halfCertificate })).toThrow(/tls/);
    expect(() => check({ brokerUrl: 'mqtts://host:8883', tls: whole })).not.toThrow();
  });

  test('NatsOptions rejects a half-configured client certificate', () => {
    const check = (s: Partial<NatsOptionsType>): void => new NatsOptionsValidator().validate(s);
    expect(() => check({ servers: 'nats://host:4222', tls: halfCertificate })).toThrow(/tls/);
    expect(() => check({ servers: 'nats://host:4222', tls: whole })).not.toThrow();
  });

  test('JetStreamOptions rejects a half-configured client certificate', () => {
    const check = (s: Partial<JetStreamOptionsType>): void =>
      new JetStreamOptionsValidator().validate(s);
    expect(() => check({ servers: 'nats://host:4222', tls: halfCertificate })).toThrow(/tls/);
    expect(() => check({ servers: 'nats://host:4222', tls: whole })).not.toThrow();
  });

  // Kafka carries the material inside `ssl`, because that is kafkajs's own
  // union — so the rule has to look through the boolean arm without tripping.
  test('KafkaOptions checks the material arm of ssl and leaves the boolean alone', () => {
    const check = (s: Partial<KafkaOptionsType>): void => new KafkaOptionsValidator().validate(s);
    expect(() => check({ brokers: ['k:9093'], ssl: halfCertificate })).toThrow(/ssl/);
    expect(() => check({ brokers: ['k:9093'], ssl: whole })).not.toThrow();
    expect(() => check({ brokers: ['k:9093'], ssl: true })).not.toThrow();
    expect(() => check({ brokers: ['k:9093'], ssl: false })).not.toThrow();
  });
});
