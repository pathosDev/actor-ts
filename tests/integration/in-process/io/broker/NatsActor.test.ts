/**
 * Subscription-lifecycle tests for NatsActor (#504).
 *
 * The test seam is `NatsActor.createNatsConnection()` — we subclass the
 * actor and hand back a mock `NatsConnectionLike` whose subscriptions,
 * drains and close-promise the test drives synchronously.  That covers
 * the reconnect paths (which need a *second* connection object to prove
 * the subscriptions were re-established rather than merely remembered)
 * without involving the `nats` peer-dep at all.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../../src/ActorSystem.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';
import {
  NatsActor,
  type NatsCommand,
  type NatsConnectionLike,
  type NatsMessage,
  type NatsRawMessage,
  type NatsSubscriptionLike,
} from '../../../../../src/io/broker/NatsActor.js';
import { NatsOptions } from '../../../../../src/io/broker/NatsOptions.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- Mocks ----------------------------- */

type InboundCallback = (err: Error | null, message: NatsRawMessage) => void;

class MockSubscription implements NatsSubscriptionLike {
  unsubscribed = false;
  constructor(readonly subject: string, readonly callback: InboundCallback) {}
  unsubscribe(): void { this.unsubscribed = true; }
}

class MockConnection implements NatsConnectionLike {
  /** Every subscribe() ever made on this connection, in order. */
  readonly subscriptions: MockSubscription[] = [];
  readonly published: Array<{ subject: string; payload: Uint8Array; replyTo?: string }> = [];
  drained = false;
  private closeConnection!: (err?: Error) => void;
  private readonly closedPromise = new Promise<Error | undefined>((resolve) => {
    this.closeConnection = resolve;
  });

  publish(subject: string, payload: Uint8Array, options?: { reply?: string }): void {
    this.published.push({ subject, payload, replyTo: options?.reply });
  }

  subscribe(subject: string, options: { callback: InboundCallback }): NatsSubscriptionLike {
    const subscription = new MockSubscription(subject, options.callback);
    this.subscriptions.push(subscription);
    return subscription;
  }

  async drain(): Promise<void> { this.drained = true; }
  closed(): Promise<Error | undefined> { return this.closedPromise; }

  /** Subjects still subscribed on this connection. */
  get liveSubjects(): string[] {
    return this.subscriptions.filter((s) => !s.unsubscribed).map((s) => s.subject).sort();
  }

  /** Simulate the server dropping the connection. */
  simulateClose(cause?: Error): void { this.closeConnection(cause); }

  /** Deliver an inbound message to every live subscription on `subject`. */
  deliver(subject: string, payload: string, replyTo?: string): void {
    const data = new TextEncoder().encode(payload);
    for (const subscription of this.subscriptions) {
      if (subscription.unsubscribed || subscription.subject !== subject) continue;
      subscription.callback(null, { subject, data, reply: replyTo });
    }
  }
}

/** NatsActor variant that hands out mock connections and counts them. */
class MockNatsActor extends NatsActor {
  readonly connections: MockConnection[] = [];
  failNextConnects = 0;

  protected override async createNatsConnection(): Promise<NatsConnectionLike> {
    if (this.failNextConnects > 0) {
      this.failNextConnects--;
      throw new Error('simulated connect failure');
    }
    const connection = new MockConnection();
    this.connections.push(connection);
    return connection;
  }

  /** The most recent connection — the live one when connected. */
  get connection(): MockConnection {
    const latest = this.connections[this.connections.length - 1];
    if (!latest) throw new Error('no connection was ever created');
    return latest;
  }

  publicConnectionState(): string { return this.connectionState; }
  publicDesiredCount(): number { return this.desiredSubscriptionCount; }
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<NatsMessage> {
  readonly received: NatsMessage[] = [];
  override onReceive(message: NatsMessage): void { this.received.push(message); }
}

function spawnTarget(
  system: ActorSystem, name: string,
): { ref: ActorRef<NatsMessage>; target: CapturingTarget } {
  const target = new CapturingTarget();
  const ref = system.spawn(() => target as unknown as Actor<NatsMessage>, name);
  return { ref: ref as ActorRef<NatsMessage>, target };
}

type Booted = {
  readonly ref: ActorRef<NatsCommand>;
  readonly actor: MockNatsActor;
};

/**
 * Spawn a MockNatsActor and wait for the first connect attempt to settle.
 * `beforeStart` runs on the fresh instance before `preStart`, which is
 * how a test makes the very first connect fail.
 */
async function bootActor(
  system: ActorSystem,
  options: ReturnType<typeof NatsOptions.create>,
  beforeStart: (actor: MockNatsActor) => void = () => {},
): Promise<Booted> {
  let resolveActor!: (actor: MockNatsActor) => void;
  const ready = new Promise<MockNatsActor>((resolve) => { resolveActor = resolve; });
  const ref = system.spawnAnonymous(() => {
    const actor = new MockNatsActor(options);
    beforeStart(actor);
    resolveActor(actor);
    return actor as unknown as Actor<NatsCommand>;
  });
  const actor = await ready;
  await sleep(30);
  return { ref: ref as ActorRef<NatsCommand>, actor };
}

/** Drop the live connection and wait for the reconnect to land. */
async function reconnect(actor: MockNatsActor): Promise<void> {
  const connectionCount = actor.connections.length;
  actor.connection.simulateClose(new Error('server restarted'));
  for (let i = 0; i < 60 && actor.connections.length === connectionCount; i++) await sleep(10);
  await sleep(20);
}

const baseOptions = (): ReturnType<typeof NatsOptions.create> => NatsOptions.create()
  .withServers(['nats://fake:4222'])
  .withReconnect({ initialDelayMs: 10, maxDelayMs: 20, factor: 1 });

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('NatsActor — subscriptions on the live connection', () => {
  test('configured subscriptions are established and deliver to their target', async () => {
    const system = createTestActorSystem({ name: 'nats-config' });
    try {
      const { ref, target } = spawnTarget(system, 'orders');
      const { actor } = await bootActor(
        system,
        baseOptions().withSubscriptions([{ subject: 'orders.new', target: ref }]),
      );
      expect(actor.publicConnectionState()).toBe('connected');
      expect(actor.connection.liveSubjects).toEqual(['orders.new']);

      actor.connection.deliver('orders.new', 'hello', 'reply.1');
      await sleep(20);
      expect(target.received).toHaveLength(1);
      expect(new TextDecoder().decode(target.received[0]!.payload)).toBe('hello');
      expect(target.received[0]!.replyTo).toBe('reply.1');
    } finally {
      await system.terminate();
    }
  });

  test('unsubscribe drops the live handle and the desired entry', async () => {
    const system = createTestActorSystem({ name: 'nats-unsub' });
    try {
      const { ref } = spawnTarget(system, 'audit');
      const { ref: natsRef, actor } = await bootActor(
        system,
        baseOptions().withSubscriptions([{ subject: 'audit.*', target: ref }]),
      );
      expect(actor.publicDesiredCount()).toBe(1);

      natsRef.tell({ kind: 'unsubscribe', subject: 'audit.*' });
      await sleep(20);
      expect(actor.connection.liveSubjects).toEqual([]);
      expect(actor.publicDesiredCount()).toBe(0);
    } finally {
      await system.terminate();
    }
  });

  test('re-subscribing a live subject swaps the target', async () => {
    const system = createTestActorSystem({ name: 'nats-swap' });
    try {
      const first = spawnTarget(system, 'first');
      const second = spawnTarget(system, 'second');
      const { ref: natsRef, actor } = await bootActor(
        system,
        baseOptions().withSubscriptions([{ subject: 'events', target: first.ref }]),
      );

      natsRef.tell({ kind: 'subscribe', subject: 'events', target: second.ref });
      await sleep(20);
      // Exactly one live handle for the subject — the old one was revoked.
      expect(actor.connection.liveSubjects).toEqual(['events']);

      actor.connection.deliver('events', 'payload');
      await sleep(20);
      expect(first.target.received).toHaveLength(0);
      expect(second.target.received).toHaveLength(1);
    } finally {
      await system.terminate();
    }
  });
});

describe('NatsActor — subscriptions across a reconnect (#504)', () => {
  test('configured subscriptions are re-established on the new connection', async () => {
    const system = createTestActorSystem({ name: 'nats-reconnect-config' });
    try {
      const { ref, target } = spawnTarget(system, 'orders');
      const { actor } = await bootActor(
        system,
        baseOptions().withSubscriptions([{ subject: 'orders.new', target: ref }]),
      );

      await reconnect(actor);
      expect(actor.connections).toHaveLength(2);
      expect(actor.publicConnectionState()).toBe('connected');
      // The old connection was drained; the new one carries the subscription.
      expect(actor.connections[0]!.drained).toBe(true);
      expect(actor.connection.liveSubjects).toEqual(['orders.new']);

      // And it actually delivers — not just a handle sitting in a map.
      actor.connection.deliver('orders.new', 'after-reconnect');
      await sleep(20);
      expect(target.received).toHaveLength(1);
      expect(new TextDecoder().decode(target.received[0]!.payload)).toBe('after-reconnect');
    } finally {
      await system.terminate();
    }
  });

  test('a subscription added at runtime survives a reconnect', async () => {
    const system = createTestActorSystem({ name: 'nats-reconnect-runtime' });
    try {
      const orders = spawnTarget(system, 'orders');
      const audit = spawnTarget(system, 'audit');
      const { ref: natsRef, actor } = await bootActor(
        system,
        baseOptions().withSubscriptions([{ subject: 'orders.new', target: orders.ref }]),
      );

      natsRef.tell({ kind: 'subscribe', subject: 'audit.trail', target: audit.ref });
      await sleep(20);
      expect(actor.connection.liveSubjects).toEqual(['audit.trail', 'orders.new']);

      await reconnect(actor);
      expect(actor.connection.liveSubjects).toEqual(['audit.trail', 'orders.new']);

      actor.connection.deliver('audit.trail', 'still-here');
      await sleep(20);
      expect(audit.target.received).toHaveLength(1);
    } finally {
      await system.terminate();
    }
  });

  test('a subscribe issued while disconnected lands on the next connect', async () => {
    const system = createTestActorSystem({ name: 'nats-offline-subscribe' });
    try {
      const { ref, target } = spawnTarget(system, 'late');
      // First connect fails, so the actor is disconnected + backing off.
      const { ref: natsRef, actor } = await bootActor(
        system,
        baseOptions().withReconnect({ initialDelayMs: 80, maxDelayMs: 80, factor: 1 }),
        (instance) => { instance.failNextConnects = 1; },
      );
      expect(actor.publicConnectionState()).toBe('disconnected');
      expect(actor.connections).toHaveLength(0);

      natsRef.tell({ kind: 'subscribe', subject: 'late.arrival', target: ref });
      await sleep(20);
      // Nothing to apply it to yet — but it is remembered, not dropped.
      expect(actor.publicDesiredCount()).toBe(1);

      for (let i = 0; i < 40 && actor.connections.length === 0; i++) await sleep(10);
      await sleep(20);
      expect(actor.publicConnectionState()).toBe('connected');
      expect(actor.connection.liveSubjects).toEqual(['late.arrival']);

      actor.connection.deliver('late.arrival', 'made-it');
      await sleep(20);
      expect(target.received).toHaveLength(1);
    } finally {
      await system.terminate();
    }
  });

  test('an unsubscribed configured subject is not resurrected by a reconnect', async () => {
    const system = createTestActorSystem({ name: 'nats-no-resurrect' });
    try {
      const { ref } = spawnTarget(system, 'orders');
      const { ref: natsRef, actor } = await bootActor(
        system,
        baseOptions().withSubscriptions([{ subject: 'orders.new', target: ref }]),
      );

      natsRef.tell({ kind: 'unsubscribe', subject: 'orders.new' });
      await sleep(20);
      await reconnect(actor);
      // Seeding from the options is once-only — the runtime unsubscribe wins.
      expect(actor.connection.liveSubjects).toEqual([]);
      expect(actor.publicDesiredCount()).toBe(0);
    } finally {
      await system.terminate();
    }
  });
});

describe('NatsActor — publish', () => {
  test('publish reaches the connection, string payloads encoded as UTF-8', async () => {
    const system = createTestActorSystem({ name: 'nats-publish' });
    try {
      const { ref: natsRef, actor } = await bootActor(system, baseOptions());
      natsRef.tell({ kind: 'publish', publish: { subject: 'greet', payload: 'hi', replyTo: 'r' } });
      await sleep(30);
      expect(actor.connection.published).toHaveLength(1);
      const published = actor.connection.published[0]!;
      expect(published.subject).toBe('greet');
      expect(new TextDecoder().decode(published.payload)).toBe('hi');
      expect(published.replyTo).toBe('r');
    } finally {
      await system.terminate();
    }
  });
});
