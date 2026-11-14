/**
 * `AmqpActor` against a hand-rolled amqplib fake, injected through the
 * `amqpModule()` seam.  The fake records every ack / nack, lets a test drive a
 * delivery into the consumer callback, and lets it decide what `publish`
 * returns — which is all the backpressure path needs.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../../src/ActorSystem.js';
import {
  AmqpActor,
  type AmqpChannelLike,
  type AmqpCommand,
  type AmqpConnectionLike,
  type AmqpModuleLike,
  type AmqpRawMessage,
} from '../../../../../src/io/broker/AmqpActor.js';
import { AmqpOptions } from '../../../../../src/io/broker/AmqpOptions.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/* ------------------------------- Fakes --------------------------------- */

type ChannelEvent = 'drain' | 'close' | 'error';

class FakeAmqpChannel implements AmqpChannelLike {
  /** What the next `publish` returns — `false` is amqplib's "buffer full". */
  publishResult = true;
  readonly published: Array<{ exchange: string; routingKey: string; content: Uint8Array }> = [];
  readonly acked: AmqpRawMessage[] = [];
  readonly nacked: Array<{ message: AmqpRawMessage; requeue: boolean }> = [];
  /** Throws from `ack` when set — a closing channel, a stale delivery tag. */
  ackError: Error | null = null;
  private readonly listeners = new Map<ChannelEvent, Set<(...args: unknown[]) => void>>();
  private consumer: ((message: AmqpRawMessage | null) => void) | null = null;

  async prefetch(): Promise<void> {}
  async assertQueue(): Promise<unknown> { return undefined; }
  async bindQueue(): Promise<unknown> { return undefined; }
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
  nack(message: AmqpRawMessage, _allUpTo: boolean, requeue: boolean): void {
    this.nacked.push({ message, requeue });
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
  async close(): Promise<void> {}

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
}

async function bootAmqp(
  system: ActorSystem, options: AmqpOptions,
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

/* ------------------------------- Tests --------------------------------- */

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
});
