/**
 * `AmqpActor` against a hand-rolled amqplib fake, injected through the
 * `amqpModule()` seam.  The fake records every ack / nack, lets a test drive a
 * delivery into the consumer callback, and lets it decide what `publish`
 * returns — which is all the backpressure path needs.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../../src/ActorSystem.js';
import {
  AmqpActor,
  type AmqpChannelLike,
  type AmqpCommand,
  type AmqpConnectionLike,
  type AmqpDelivery,
  type AmqpModuleLike,
  type AmqpRawMessage,
} from '../../../../../src/io/broker/AmqpActor.js';
import { AmqpOptions, type AmqpOptionsBuilder } from '../../../../../src/io/broker/AmqpOptions.js';
import { acknowledgeDelivery, negativelyAcknowledgeDelivery } from '../../../../../src/io/broker/BrokerAcknowledgment.js';
import { BrokerAcknowledgmentFailed } from '../../../../../src/io/broker/BrokerEvents.js';
import { LogLevel } from '../../../../../src/Logger.js';
import { RecordingLogger } from '../../../../util/RecordingLogger.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * The window in which an ack that should not happen would show up: a poll can
 * confirm that something arrived, never that it did not, so the "nothing yet"
 * claims hold still this long first.
 */
const SETTLE_MS = 20;

/* ------------------------------- Fakes --------------------------------- */

type ChannelEvent = 'drain' | 'close' | 'error';

class FakeAmqpChannel implements AmqpChannelLike {
  /** What the next `publish` returns — `false` is amqplib's "buffer full". */
  publishResult = true;
  readonly published: Array<{ exchange: string; routingKey: string; content: Uint8Array }> = [];
  readonly acked: AmqpRawMessage[] = [];
  readonly nacked: Array<{ message: AmqpRawMessage; allUpTo: boolean; requeue: boolean }> = [];
  /** Every `prefetch`, `assertQueue` and `bindQueue` call, in order — the consumer setup. */
  readonly prefetches: number[] = [];
  readonly assertedQueues: Array<{ queue: string; options: unknown }> = [];
  readonly boundQueues: Array<{ queue: string; exchange: string; routingKey: string }> = [];
  /** Throws from `ack` when set — a closing channel, a stale delivery tag. */
  ackError: Error | null = null;
  /** Throws from `nack` when set. */
  nackError: Error | null = null;
  private readonly listeners = new Map<ChannelEvent, Set<(...args: unknown[]) => void>>();
  private consumer: ((message: AmqpRawMessage | null) => void) | null = null;

  async prefetch(count: number): Promise<void> { this.prefetches.push(count); }
  async assertQueue(queue: string, options: unknown): Promise<unknown> {
    this.assertedQueues.push({ queue, options });
    return undefined;
  }
  async bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown> {
    this.boundQueues.push({ queue, exchange, routingKey });
    return undefined;
  }
  async consume(_queue: string, onMessage: (message: AmqpRawMessage | null) => void): Promise<unknown> {
    this.consumer = onMessage;
    return undefined;
  }
  publish(exchange: string, routingKey: string, content: Uint8Array): boolean {
    this.published.push({ exchange, routingKey, content });
    return this.publishResult;
  }
  ack(message: AmqpRawMessage): void {
    if (this.ackError) throw this.ackError;
    this.acked.push(message);
  }
  /** Every `nack` call, the refused ones included. */
  nackAttempts = 0;
  /** Set once `close` was called. */
  closed = false;
  nack(message: AmqpRawMessage, allUpTo: boolean, requeue: boolean): void {
    this.nackAttempts++;
    if (this.nackError) throw this.nackError;
    this.nacked.push({ message, allUpTo, requeue });
  }
  once(event: ChannelEvent, listener: (...args: never[]) => void): void {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(event, wrapped);
      (listener as (...args: unknown[]) => void)(...args);
    };
    (wrapped as { original?: unknown }).original = listener;
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(wrapped);
  }
  removeListener(event: ChannelEvent, listener: (...args: never[]) => void): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const candidate of set) {
      if (candidate === listener || (candidate as { original?: unknown }).original === listener) set.delete(candidate);
    }
  }
  async close(): Promise<void> { this.closed = true; }

  /** How many listeners are attached for `event` — the leak check. */
  listenerCount(event: ChannelEvent): number { return this.listeners.get(event)?.size ?? 0; }

  emit(event: ChannelEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  /** Hand one delivery to the consumer callback, as amqplib would. */
  deliver(content: string): AmqpRawMessage {
    if (!this.consumer) throw new Error('fake channel: consume() was not called');
    const message: AmqpRawMessage = { content: Buffer.from(content), properties: {} };
    this.consumer(message);
    return message;
  }
}

class FakeAmqpConnection implements AmqpConnectionLike {
  constructor(readonly channel: FakeAmqpChannel) {}
  async createChannel(): Promise<AmqpChannelLike> { return this.channel; }
  on(): void {}
  async close(): Promise<void> {}
}

class FakeAmqpModule implements AmqpModuleLike {
  readonly channels: FakeAmqpChannel[] = [];
  async connect(): Promise<AmqpConnectionLike> {
    const channel = new FakeAmqpChannel();
    this.channels.push(channel);
    return new FakeAmqpConnection(channel);
  }
  get channel(): FakeAmqpChannel {
    const latest = this.channels[this.channels.length - 1];
    if (!latest) throw new Error('fake amqp: not connected');
    return latest;
  }
}

class FakeAmqpActor extends AmqpActor {
  static drainTimeout = 30_000;
  readonly module = new FakeAmqpModule();
  protected override amqpModule(): Promise<AmqpModuleLike> { return Promise.resolve(this.module); }
  protected override drainTimeoutMs(): number { return FakeAmqpActor.drainTimeout; }
  publicConnectionState(): string { return this.connectionState; }
  /** amqplib surfaces a drop through the connection's `close`. */
  publicSimulateLoss(): void { this.handleConnectionLost(new Error('simulated broker loss')); }
}

async function bootAmqp(
  system: ActorSystem, options: AmqpOptionsBuilder,
): Promise<{ actor: ActorRef<AmqpCommand>; instance: FakeAmqpActor }> {
  const reference = { current: null as FakeAmqpActor | null };
  const actor = system.spawn(() => {
    const instance = new FakeAmqpActor(options);
    reference.current = instance;
    return instance;
  }, 'amqp');
  await awaitCondition(
    () => reference.current !== null && reference.current.publicConnectionState() === 'connected',
    { timeoutMs: 4_000, label: 'the AMQP actor connected' },
  );
  return { actor: actor as ActorRef<AmqpCommand>, instance: reference.current! };
}

/** How a binding's target answers a delivery that arrives with a `replyTo`. */
type TargetReply = 'acknowledge' | 'negative' | 'hold';

class DeliveryTarget extends Actor<AmqpDelivery> {
  readonly received: AmqpDelivery[] = [];
  constructor(private readonly reply: TargetReply) { super(); }
  override onReceive(delivery: AmqpDelivery): void {
    this.received.push(delivery);
    if (this.reply === 'acknowledge') acknowledgeDelivery(delivery);
    else if (this.reply === 'negative') negativelyAcknowledgeDelivery(delivery, 'cannot store it');
  }
}

/** Subscribes to every `BrokerAcknowledgmentFailed` on the system's event stream. */
function collectAcknowledgmentFailures(system: ActorSystem): BrokerAcknowledgmentFailed[] {
  const seen: BrokerAcknowledgmentFailed[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new (class extends Actor<BrokerAcknowledgmentFailed> {
      override onReceive(event: BrokerAcknowledgmentFailed): void { seen.push(event); }
    })()),
    BrokerAcknowledgmentFailed,
  );
  return seen;
}

/** Boot an actor consuming `orders` into a fresh target that answers as `reply` says. */
async function bootConsuming(
  system: ActorSystem, reply: TargetReply, configure: (options: AmqpOptionsBuilder) => AmqpOptionsBuilder = (o) => o,
): Promise<{ actor: ActorRef<AmqpCommand>; instance: FakeAmqpActor; target: DeliveryTarget; channel: FakeAmqpChannel }> {
  const target = new DeliveryTarget(reply);
  const targetRef = system.spawn(() => target, 'orders-target');
  const amqpOptions = configure(AmqpOptions.create()
    .withUrl('amqp://fake:5672')
    .withReconnect({ initialDelayMs: 60_000, randomFactor: 0 })
    .withBindings([{ queue: 'orders', target: targetRef }]));
  const { actor, instance } = await bootAmqp(system, amqpOptions);
  return { actor, instance, target, channel: instance.module.channel };
}

/* ------------------------------- Tests --------------------------------- */

describe('AmqpActor — acknowledges on the target\'s reply (#976)', () => {
  test('the default leaves a delivery unacknowledged until the target acknowledges it', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply' });
    try {
      const { target, channel } = await bootConsuming(system, 'hold');
      const message = channel.deliver('order-1');
      await awaitCondition(() => target.received.length === 1, { timeoutMs: 4_000, label: 'the delivery reached the target' });
      // Still unacknowledged, so it still occupies the prefetch window: a
      // `prefetch: 1` consumer gets nothing else until the target is done.
      await sleep(SETTLE_MS);  // the claim is "no ack yet"; see SETTLE_MS
      expect(channel.acked).toEqual([]);
      expect(target.received[0]!.replyTo).toBeDefined();

      acknowledgeDelivery(target.received[0]!);
      await awaitCondition(() => channel.acked.length === 1, { timeoutMs: 4_000, label: 'the reply acked the delivery' });
      expect(channel.acked[0]).toBe(message);
      expect(channel.nacked).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a negative reply nacks with requeue, so RabbitMQ redelivers', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-negative' });
    try {
      const { channel } = await bootConsuming(system, 'negative');
      const message = channel.deliver('order-1');
      await awaitCondition(() => channel.nacked.length === 1, { timeoutMs: 4_000, label: 'the negative reply nacked' });
      // `allUpTo` false: only this delivery goes back, not every one the
      // channel delivered before it and the target has not settled yet.
      expect(channel.nacked[0]).toEqual({ message, allUpTo: false, requeue: true });
      expect(channel.acked).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('no reply within acknowledgmentTimeoutMs nacks with requeue', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-timeout' });
    try {
      const { channel } = await bootConsuming(system, 'hold', (o) => o.withAcknowledgmentTimeoutMs(50));
      const message = channel.deliver('order-1');
      await awaitCondition(() => channel.nacked.length === 1, { timeoutMs: 4_000, label: 'the timeout nacked' });
      expect(channel.nacked[0]).toEqual({ message, allUpTo: false, requeue: true });
      expect(channel.acked).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a target that never acknowledges is named once, however many deliveries time out (#1877)', async () => {
    const log = new RecordingLogger();
    const system = createTestActorSystem({ name: 'amqp-on-reply-silent', logger: log, logLevel: LogLevel.Debug });
    try {
      const { channel } = await bootConsuming(system, 'hold', (o) => o.withAcknowledgmentTimeoutMs(50));
      channel.deliver('order-1');
      channel.deliver('order-2');
      await awaitCondition(() => channel.nacked.length === 2, { timeoutMs: 4_000, label: 'both timeouts nacked' });
      const silent = log.records.filter((r) => r.level === 'warn' && r.message.includes('has not acknowledged a single delivery'));
      expect(silent).toHaveLength(1);
      expect(silent[0]!.message).toContain('AmqpActor: target ');
      expect(silent[0]!.message).toContain('/orders-target ');
    } finally {
      await system.terminate();
    }
  });

  test('a reply that arrives after the channel was replaced acks nothing on the new channel', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-stale' });
    try {
      const { instance, target, channel } = await bootConsuming(system, 'hold', (o) => o.withReconnect({ initialDelayMs: 5, randomFactor: 0 }));
      channel.deliver('order-1');
      await awaitCondition(() => target.received.length === 1, { timeoutMs: 4_000, label: 'the delivery reached the target' });
      instance.publicSimulateLoss();
      await awaitCondition(
        () => instance.module.channels.length === 2 && instance.publicConnectionState() === 'connected',
        { timeoutMs: 4_000, label: 'the actor reconnected on a fresh channel' },
      );
      acknowledgeDelivery(target.received[0]!);
      await sleep(SETTLE_MS);  // the claim is "nothing acked"; see SETTLE_MS
      expect(channel.acked).toEqual([]);
      expect(instance.module.channel.acked).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a broker that refuses the ack is reported with the queue, not swallowed', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-ack-fails' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { channel } = await bootConsuming(system, 'acknowledge');
      channel.ackError = new Error('channel closing');
      channel.deliver('order-1');
      await awaitCondition(() => failures.length === 1, { timeoutMs: 4_000, label: 'the refused ack was published' });
      expect(failures[0]!.source).toBe('orders');
      expect(failures[0]!.cause.message).toBe('channel closing');
    } finally {
      await system.terminate();
    }
  });

  test('a broker that refuses the requeue nack is reported with the queue, not swallowed', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-nack-fails' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { channel } = await bootConsuming(system, 'negative');
      channel.nackError = new Error('channel closing');
      channel.deliver('order-1');
      await awaitCondition(() => failures.length === 1, { timeoutMs: 4_000, label: 'the refused nack was published' });
      expect(failures[0]!.source).toBe('orders');
      expect(failures[0]!.cause.message).toBe('channel closing');
    } finally {
      await system.terminate();
    }
  });

  /**
   * Teardown takes the channel out of service before it gives up on the
   * outstanding replies (#1846), so the requeue those rejections lead to
   * finds a channel that is no longer current and sends nothing on it.  The
   * closing channel gives every unacknowledged delivery back to RabbitMQ on
   * its own.  A real amqplib channel refuses a nack while it closes, which
   * is what `nackError` stands for: the requeue used to be attempted and
   * reported as a spurious `BrokerAcknowledgmentFailed` per delivery.
   */
  test('stopping the actor with replies outstanding nacks nothing on the closing channel', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-stop' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { actor, target, channel } = await bootConsuming(system, 'hold');
      channel.nackError = new Error('channel closing');
      channel.deliver('order-1');
      channel.deliver('order-2');
      await awaitCondition(() => target.received.length === 2, { timeoutMs: 4_000, label: 'the deliveries reached the target' });
      system.stop(actor);
      await awaitCondition(() => channel.closed, { timeoutMs: 4_000, label: 'teardown closed the channel' });
      await sleep(SETTLE_MS);  // the claim is "nothing nacked, nothing reported"; see SETTLE_MS
      expect(channel.nackAttempts).toBe(0);
      expect(channel.acked).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a connection loss with replies outstanding nacks nothing on the dying channel', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-reply-loss' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { instance, target, channel } = await bootConsuming(system, 'hold', (o) => o.withReconnect({ initialDelayMs: 5, randomFactor: 0 }));
      channel.nackError = new Error('channel closed');
      channel.deliver('order-1');
      channel.deliver('order-2');
      await awaitCondition(() => target.received.length === 2, { timeoutMs: 4_000, label: 'the deliveries reached the target' });
      // The reconnect tears the lost transport down before it dials again.
      instance.publicSimulateLoss();
      await awaitCondition(
        () => channel.closed && instance.module.channels.length === 2 && instance.publicConnectionState() === 'connected',
        { timeoutMs: 4_000, label: 'the actor tore the lost channel down and reconnected' },
      );
      await sleep(SETTLE_MS);  // the claim is "nothing nacked, nothing reported"; see SETTLE_MS
      expect(channel.nackAttempts).toBe(0);
      expect(instance.module.channel.nackAttempts).toBe(0);
      expect(failures).toEqual([]);
      // A reply that arrives afterwards settles nothing on either channel.
      acknowledgeDelivery(target.received[0]!);
      await sleep(SETTLE_MS);  // the claim is "nothing acked"; see SETTLE_MS
      expect(channel.acked).toEqual([]);
      expect(instance.module.channel.acked).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await system.terminate();
    }
  });
});

describe('AmqpActor — acknowledgment = on-delivery', () => {
  test('acks on hand-over and expects no reply', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-delivery' });
    try {
      const { target, channel } = await bootConsuming(system, 'hold', (o) => o.withAcknowledgment('on-delivery'));
      const message = channel.deliver('order-1');
      expect(channel.acked).toEqual([message]);
      await awaitCondition(() => target.received.length === 1, { timeoutMs: 4_000, label: 'the delivery reached the target' });
      expect(target.received[0]!.replyTo).toBeUndefined();
    } finally {
      await system.terminate();
    }
  });

  test('an ack that throws is reported and the delivery is not also handed over', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-delivery-ack-fails' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { target, channel } = await bootConsuming(system, 'hold', (o) => o.withAcknowledgment('on-delivery'));
      channel.ackError = new Error('stale delivery tag');
      channel.deliver('order-1');
      await awaitCondition(() => failures.length === 1, { timeoutMs: 4_000, label: 'the refused ack was published' });
      await sleep(SETTLE_MS);  // the claim is "never handed over"; see SETTLE_MS
      // RabbitMQ never saw the ack and will redeliver: handing this copy over
      // too would process it twice.
      expect(target.received).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a delivery on a channel that was replaced is neither acked nor handed over', async () => {
    const system = createTestActorSystem({ name: 'amqp-on-delivery-stale' });
    try {
      const { instance, target, channel } = await bootConsuming(
        system, 'hold', (o) => o
          .withAcknowledgment('on-delivery')
          .withReconnect({ initialDelayMs: 5, randomFactor: 0 }),
      );
      instance.publicSimulateLoss();
      await awaitCondition(
        () => instance.module.channels.length === 2 && instance.publicConnectionState() === 'connected',
        { timeoutMs: 4_000, label: 'the actor reconnected on a fresh channel' },
      );
      // amqplib can still hand over a delivery the old channel had buffered.
      // Its tag means nothing on the new channel, and RabbitMQ redelivers it
      // there anyway, so this copy must go nowhere.
      channel.deliver('order-1');
      await sleep(SETTLE_MS);  // the claim is "never handed over"; see SETTLE_MS
      expect(channel.acked).toEqual([]);
      expect(instance.module.channel.acked).toEqual([]);
      expect(target.received).toEqual([]);
    } finally {
      await system.terminate();
    }
  });
});

describe('AmqpActor — autoAcknowledge = false', () => {
  test('the target settles with commands, and a refused ack is reported', async () => {
    const system = createTestActorSystem({ name: 'amqp-manual' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { actor, target, channel } = await bootConsuming(system, 'hold', (o) => o.withAutoAcknowledge(false));
      const first = channel.deliver('order-1');
      await awaitCondition(() => target.received.length === 1, { timeoutMs: 4_000, label: 'the delivery reached the target' });
      expect(target.received[0]!.replyTo).toBeUndefined();
      actor.tell({ kind: 'acknowledgment', delivery: target.received[0]! });
      await awaitCondition(() => channel.acked.length === 1, { timeoutMs: 4_000, label: 'the command acked' });
      expect(channel.acked[0]).toBe(first);

      channel.ackError = new Error('channel closing');
      channel.deliver('order-2');
      await awaitCondition(() => target.received.length === 2, { timeoutMs: 4_000, label: 'the second delivery arrived' });
      actor.tell({ kind: 'acknowledgment', delivery: target.received[1]! });
      await awaitCondition(() => failures.length === 1, { timeoutMs: 4_000, label: 'the refused ack was published' });
    } finally {
      await system.terminate();
    }
  });

  test('a negative acknowledgment nacks that delivery alone, requeueing unless told not to', async () => {
    const system = createTestActorSystem({ name: 'amqp-manual-nack' });
    try {
      const { actor, target, channel } = await bootConsuming(system, 'hold', (o) => o.withAutoAcknowledge(false));
      const first = channel.deliver('order-1');
      const second = channel.deliver('order-2');
      await awaitCondition(() => target.received.length === 2, { timeoutMs: 4_000, label: 'both deliveries arrived' });

      actor.tell({ kind: 'negativeAcknowledgment', delivery: target.received[0]! });
      await awaitCondition(() => channel.nacked.length === 1, { timeoutMs: 4_000, label: 'the first nack' });
      expect(channel.nacked[0]).toEqual({ message: first, allUpTo: false, requeue: true });

      actor.tell({ kind: 'negativeAcknowledgment', delivery: target.received[1]!, requeue: false });
      await awaitCondition(() => channel.nacked.length === 2, { timeoutMs: 4_000, label: 'the second nack' });
      expect(channel.nacked[1]).toEqual({ message: second, allUpTo: false, requeue: false });
      expect(channel.acked).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a refused negative acknowledgment is reported with the queue', async () => {
    const system = createTestActorSystem({ name: 'amqp-manual-nack-fails' });
    try {
      const failures = collectAcknowledgmentFailures(system);
      const { actor, target, channel } = await bootConsuming(system, 'hold', (o) => o.withAutoAcknowledge(false));
      channel.nackError = new Error('channel closing');
      channel.deliver('order-1');
      await awaitCondition(() => target.received.length === 1, { timeoutMs: 4_000, label: 'the delivery arrived' });
      actor.tell({ kind: 'negativeAcknowledgment', delivery: target.received[0]! });
      await awaitCondition(() => failures.length === 1, { timeoutMs: 4_000, label: 'the refused nack was published' });
      expect(failures[0]!.source).toBe('orders');
      expect(failures[0]!.cause.message).toBe('channel closing');
    } finally {
      await system.terminate();
    }
  });
});

describe('AmqpActor — consumer setup on connect', () => {
  test('prefetch defaults to 1, a queue is declared durable, and only a binding with an exchange is bound', async () => {
    const system = createTestActorSystem({ name: 'amqp-setup-defaults' });
    try {
      const targetRef = system.spawn(() => new DeliveryTarget('hold'), 'setup-target');
      const amqpOptions = AmqpOptions.create()
        .withUrl('amqp://fake:5672')
        .withBindings([
          { queue: 'orders', target: targetRef },
          { queue: 'audit', exchange: 'events', target: targetRef },
          { queue: 'billing', exchange: 'events', routingKey: 'billing.#', target: targetRef },
        ]);
      const { instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      expect(channel.prefetches).toEqual([1]);
      expect(channel.assertedQueues).toEqual([
        { queue: 'orders', options: { durable: true } },
        { queue: 'audit', options: { durable: true } },
        { queue: 'billing', options: { durable: true } },
      ]);
      expect(channel.boundQueues).toEqual([
        { queue: 'audit', exchange: 'events', routingKey: '' },
        { queue: 'billing', exchange: 'events', routingKey: 'billing.#' },
      ]);
    } finally {
      await system.terminate();
    }
  });

  test('a configured prefetch and queue options reach the channel as given', async () => {
    const system = createTestActorSystem({ name: 'amqp-setup-configured' });
    try {
      const targetRef = system.spawn(() => new DeliveryTarget('hold'), 'setup-target');
      const amqpOptions = AmqpOptions.create()
        .withUrl('amqp://fake:5672')
        .withPrefetch(7)
        .withBindings([{ queue: 'scratch', queueOptions: { durable: false, autoDelete: true }, target: targetRef }]);
      const { instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      expect(channel.prefetches).toEqual([7]);
      expect(channel.assertedQueues).toEqual([{ queue: 'scratch', options: { durable: false, autoDelete: true } }]);
      expect(channel.boundQueues).toEqual([]);
    } finally {
      await system.terminate();
    }
  });
});

describe('AmqpActor — channel backpressure is bounded (#981)', () => {
  test('a channel that closes during a drain wait rejects it and the actor leaves connected', async () => {
    const system = createTestActorSystem({ name: 'amqp-drain-close' });
    try {
      const amqpOptions = AmqpOptions.create()
        .withUrl('amqp://fake:5672')
        .withReconnect({ initialDelayMs: 60_000, randomFactor: 0 });
      const { actor, instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      channel.publishResult = false;
      actor.tell({ kind: 'publish', publish: { exchange: 'x', routingKey: 'k', content: 'one' } });
      await awaitCondition(() => channel.listenerCount('drain') === 1, {
        timeoutMs: 4_000, label: 'the publish is parked on drain',
      });

      // amqplib emits `close` on a dying channel and never `drain`.
      channel.emit('close');

      await awaitCondition(() => instance.publicConnectionState() !== 'connected', {
        timeoutMs: 4_000, label: 'the rejected drain wait started the reconnect cycle',
      });
      // Every listener the wait attached is gone with it.
      expect(channel.listenerCount('drain')).toBe(0);
      expect(channel.listenerCount('close')).toBe(0);
      expect(channel.listenerCount('error')).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('a channel error during a drain wait rejects it', async () => {
    const system = createTestActorSystem({ name: 'amqp-drain-error' });
    try {
      const amqpOptions = AmqpOptions.create()
        .withUrl('amqp://fake:5672')
        .withReconnect({ initialDelayMs: 60_000, randomFactor: 0 });
      const { actor, instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      channel.publishResult = false;
      actor.tell({ kind: 'publish', publish: { exchange: 'x', routingKey: 'k', content: 'one' } });
      await awaitCondition(() => channel.listenerCount('drain') === 1, {
        timeoutMs: 4_000, label: 'the publish is parked on drain',
      });

      channel.emit('error', new Error('PRECONDITION_FAILED'));

      await awaitCondition(() => instance.publicConnectionState() !== 'connected', {
        timeoutMs: 4_000, label: 'the rejected drain wait started the reconnect cycle',
      });
    } finally {
      await system.terminate();
    }
  });

  test('a drain that never comes rejects after the drain timeout', async () => {
    const system = createTestActorSystem({ name: 'amqp-drain-timeout' });
    FakeAmqpActor.drainTimeout = 50;
    try {
      const amqpOptions = AmqpOptions.create()
        .withUrl('amqp://fake:5672')
        .withReconnect({ initialDelayMs: 60_000, randomFactor: 0 });
      const { actor, instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      channel.publishResult = false;
      actor.tell({ kind: 'publish', publish: { exchange: 'x', routingKey: 'k', content: 'one' } });

      await awaitCondition(() => instance.publicConnectionState() !== 'connected', {
        timeoutMs: 4_000, label: 'the drain timeout started the reconnect cycle',
      });
      expect(channel.listenerCount('drain')).toBe(0);
    } finally {
      FakeAmqpActor.drainTimeout = 30_000;
      await system.terminate();
    }
  });

  test('a drain that does come resolves the wait and the actor stays connected', async () => {
    const system = createTestActorSystem({ name: 'amqp-drain-ok' });
    try {
      const amqpOptions = AmqpOptions.create().withUrl('amqp://fake:5672');
      const { actor, instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      channel.publishResult = false;
      actor.tell({ kind: 'publish', publish: { exchange: 'x', routingKey: 'k', content: 'one' } });
      await awaitCondition(() => channel.listenerCount('drain') === 1, {
        timeoutMs: 4_000, label: 'the publish is parked on drain',
      });
      channel.publishResult = true;
      channel.emit('drain');
      actor.tell({ kind: 'publish', publish: { exchange: 'x', routingKey: 'k', content: 'two' } });
      await awaitCondition(() => channel.published.length === 2, {
        timeoutMs: 4_000, label: 'the second publish went out after the drain',
      });
      expect(instance.publicConnectionState()).toBe('connected');
      expect(channel.listenerCount('close')).toBe(0);
      expect(channel.listenerCount('error')).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('a drain that does come also clears the drain timer', async () => {
    // The timer is not unref'd, so one left running holds the event loop for
    // the whole drain timeout after every drain that succeeded.  Its late
    // reject is a no-op on a settled promise — nothing but the timer itself
    // tells the two apart, so the test watches the timer.  The odd delay is
    // what picks it out of every other timer the system sets.
    const drainTimeoutMs = 987_654;
    const armed = new Set<unknown>();
    const cleared = new Set<unknown>();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
      const handle = originalSetTimeout(handler, delay, ...rest);
      if (delay === drainTimeoutMs) armed.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      if (armed.has(handle)) cleared.add(handle);
      originalClearTimeout(handle);
    }) as typeof clearTimeout;
    FakeAmqpActor.drainTimeout = drainTimeoutMs;
    const system = createTestActorSystem({ name: 'amqp-drain-timer' });
    try {
      const amqpOptions = AmqpOptions.create().withUrl('amqp://fake:5672');
      const { actor, instance } = await bootAmqp(system, amqpOptions);
      const channel = instance.module.channel;
      channel.publishResult = false;
      actor.tell({ kind: 'publish', publish: { exchange: 'x', routingKey: 'k', content: 'one' } });
      await awaitCondition(() => channel.listenerCount('drain') === 1, {
        timeoutMs: 4_000, label: 'the publish is parked on drain',
      });
      expect(armed.size).toBe(1);
      channel.emit('drain');
      expect([...cleared]).toEqual([...armed]);
    } finally {
      for (const handle of armed) originalClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      FakeAmqpActor.drainTimeout = 30_000;
      await system.terminate();
    }
  });
});
