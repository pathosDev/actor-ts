import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Actor } from '../../../../../src/Actor.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import {
  MqttActor,
  buildPublishProperties,
  matchesMqttPattern,
  type MqttClientLike,
  type MqttInboundPacketLike,
  type MqttModuleLike,
  type MqttPublish,
} from '../../../../../src/io/broker/MqttActor.js';
import { MqttOptions, type MqttOptionsType } from '../../../../../src/io/broker/MqttOptions.js';
import type { MqttDecodeError } from '../../../../../src/io/broker/MqttCodec.js';
import type { MqttMessage, MqttQos, MqttRef } from '../../../../../src/io/broker/MqttMessages.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

const enc = new TextEncoder();

/**
 * The window in which one *too many* of something shows up.
 *
 * Several assertions here are exact — `toHaveLength(1)`, `toEqual([…])` — and a
 * poll returns on the arrival that reaches the number, so it can only ever see
 * the lower half of such a claim.  Polling `>=` and then holding still for this
 * long is what restores the upper half.
 */
const SETTLE_MS = 20;

/* ----------------------- matchesMqttPattern ------------------------ */

describe('matchesMqttPattern', () => {
  test('exact-match topics', () => {
    expect(matchesMqttPattern('a/b', 'a/b')).toBe(true);
    expect(matchesMqttPattern('a/b', 'a/c')).toBe(false);
    expect(matchesMqttPattern('a/b', 'a/b/c')).toBe(false);
  });

  test('+ wildcard matches a single segment', () => {
    expect(matchesMqttPattern('a/+/c', 'a/x/c')).toBe(true);
    expect(matchesMqttPattern('a/+/c', 'a/c')).toBe(false);
    expect(matchesMqttPattern('a/+/c', 'a/x/y/c')).toBe(false);
    expect(matchesMqttPattern('+/+', 'x/y')).toBe(true);
  });

  test('# wildcard matches the remaining segments', () => {
    expect(matchesMqttPattern('a/#', 'a/b/c/d')).toBe(true);
    expect(matchesMqttPattern('a/#', 'a')).toBe(true);
    expect(matchesMqttPattern('#', 'anything/at/all')).toBe(true);
  });
});

/* --------------------------- fake mqtt client ----------------------- */

class FakeMqttClient implements MqttClientLike {
  readonly subscribes: Array<{ topic: string; qos: number }> = [];
  readonly unsubscribes: string[] = [];
  readonly publishes: Array<{ topic: string; payload: string | Uint8Array; qos: number; retain: boolean }> = [];

  private messageListeners: Array<(t: string, publish: Uint8Array, pk?: MqttInboundPacketLike) => void> = [];
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<(e: Error) => void> = [];
  private connectListeners: Array<() => void> = [];
  private connectErrorListeners: Array<(e: Error) => void> = [];

  on(event: 'message' | 'error' | 'close', listener: (...args: never[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as never);
    else if (event === 'close') this.closeListeners.push(listener as never);
    else this.errorListeners.push(listener as never);
  }
  once(event: 'connect' | 'error', listener: (...args: never[]) => void): void {
    if (event === 'connect') this.connectListeners.push(listener as never);
    else this.connectErrorListeners.push(listener as never);
  }
  removeAllListeners(event?: string): void {
    if (event === 'error' || event === undefined) { this.errorListeners = []; this.connectErrorListeners = []; }
    if (event === undefined) { this.messageListeners = []; this.closeListeners = []; this.connectListeners = []; }
  }
  publish(topic: string, payload: string | Uint8Array, options: { qos: MqttQos; retain: boolean }, callback?: (err?: Error) => void): void {
    this.publishes.push({ topic, payload, qos: options.qos, retain: options.retain });
    callback?.();
  }
  subscribe(topic: string, options: { qos: MqttQos }, callback?: (err?: Error) => void): void {
    this.subscribes.push({ topic, qos: options.qos });
    callback?.();
  }
  unsubscribe(topic: string, _options: undefined, callback?: (err?: Error) => void): void {
    this.unsubscribes.push(topic);
    callback?.();
  }
  end(_force?: boolean, _options?: object, callback?: () => void): void { callback?.(); }

  fireConnect(): void { for (const listener of [...this.connectListeners]) listener(); }
  fireMessage(topic: string, payload: Uint8Array, packet?: MqttInboundPacketLike): void {
    for (const listener of [...this.messageListeners]) listener(topic, payload, packet);
  }
  fireClose(): void { for (const listener of [...this.closeListeners]) listener(); }
}

class FakeMqttModule {
  readonly clients: FakeMqttClient[] = [];
  autoConnect = true;
  connect(_url: string, _options?: unknown): FakeMqttClient {
    const client = new FakeMqttClient();
    this.clients.push(client);
    if (this.autoConnect) setTimeout(() => client.fireConnect(), 0);
    return client;
  }
  last(): FakeMqttClient { return this.clients[this.clients.length - 1]!; }
}

/* --------------------------- test actor ----------------------------- */

type TestActorOpts<T> = {
  options?: MqttOptions;
  module?: FakeMqttModule;
  ctorSubs?: Array<{ topic: string; qos?: MqttQos; target?: ActorRef<MqttMessage<T>> }>;
};

class TestMqttActor<T = unknown, TSelf = never> extends MqttActor<T, TSelf> {
  readonly module: FakeMqttModule;
  readonly inbound: MqttMessage<T>[] = [];
  readonly selfMessages: TSelf[] = [];
  readonly decodeErrors: Array<{ error: MqttDecodeError; message: MqttMessage<T> }> = [];
  connectedCount = 0;
  disconnectedCount = 0;

  constructor(options: TestActorOpts<T> = {}) {
    super(options.options ?? MqttOptions.create());
    this.module = options.module ?? new FakeMqttModule();
    for (const s of options.ctorSubs ?? []) this.subscribe(s.topic, { qos: s.qos, target: s.target });
  }

  protected override mqttModule(): Promise<MqttModuleLike> {
    return Promise.resolve(this.module as unknown as MqttModuleLike);
  }

  override onMessage(message: MqttMessage<T>): void {
    // Touch entity() so a malformed payload surfaces to onInvalidMessage.
    if (this.decodeOnReceive) message.payload.entity();
    this.inbound.push(message);
  }
  decodeOnReceive = false;

  protected override onConnected(): void { this.connectedCount++; }
  protected override onDisconnected(): void { this.disconnectedCount++; }
  protected override onInvalidMessage(error: MqttDecodeError, message: MqttMessage<T>): void {
    this.decodeErrors.push({ error, message });
  }
  protected override onSelfMessage(message: TSelf): void { this.selfMessages.push(message); }

  // Public test wrappers for the protected API.
  doSubscribe(topic: string, options?: { qos?: MqttQos; target?: ActorRef<MqttMessage<T>> }): void { this.subscribe(topic, options); }
  doUnsubscribe(topic: string, options?: { target?: ActorRef<MqttMessage<T>> }): void { this.unsubscribe(topic, options); }
  doPublish(topic: string, payload: unknown, options?: { qos?: MqttQos; retain?: boolean }): boolean {
    return (this.publish as (t: string, publish: unknown, o?: unknown) => boolean)(topic, payload, options);
  }
  encodeEntity(value: unknown): Uint8Array { return this.codec().encode(value); }
  get resolvedOptions(): MqttOptionsType { return this.options; }
}

let sysCounter = 0;
function makeSystem(): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(`mqtt-unit-${++sysCounter}`, sysOptions);
}

async function boot<T, TSelf>(
  sys: ActorSystem,
  actor: TestMqttActor<T, TSelf>,
  name = 'mqtt',
): Promise<MqttRef<T, TSelf>> {
  const ref = sys.spawn(() => actor, name);
  // `connectedCount` is the *last* thing a connect produces, which is what makes
  // it the right thing to wait on: `connectImplementation` replays the whole
  // subscription registry onto the fresh client and only then tells itself
  // `mqtt-connected`, so a bumped counter means the subscribes the callers
  // assert on have already been issued — and, because the signal is handled
  // after `preStart` returns, that the state machine reads `connected` too.
  await awaitCondition(() => actor.connectedCount >= 1, {
    timeoutMs: 4_000, label: `${name}: preStart connected and applied its subscriptions`,
  });
  return ref as MqttRef<T, TSelf>;
}

/** Collects fanned-out MqttMessages for external-target assertions. */
class InboxActor<T> extends Actor<MqttMessage<T>> {
  readonly received: MqttMessage<T>[] = [];
  override onReceive(m: MqttMessage<T>): void { this.received.push(m); }
}

/* --------------------------- construction --------------------------- */

describe('MqttActor construction', () => {
  test('constructing an actor does not pull in the mqtt peer-dep', () => {
    const mqttOptions = MqttOptions.create()
      .withBrokerUrl('mqtt://localhost');
    const actor = new TestMqttActor({ options: mqttOptions });
    expect(actor).toBeInstanceOf(MqttActor);
  });
});

/* ------------------------ pending-sub flush ------------------------- */

describe('MqttActor subscription flush + defaults', () => {
  test('constructor subscribe is applied to the broker on connect with defaultQos', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(1);
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'a/+' }],
      });
      await boot(sys, actor);
      expect(actor.module.last().subscribes).toEqual([{ topic: 'a/+', qos: 1 }]);
    } finally {
      await sys.terminate();
    }
  });

  test('per-subscription qos overrides defaultQos', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(0);
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'a/#', qos: 2 }],
      });
      await boot(sys, actor);
      expect(actor.module.last().subscribes).toEqual([{ topic: 'a/#', qos: 2 }]);
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- inbound routing ------------------------ */

describe('MqttActor inbound routing', () => {
  test('own subscription delivers a wrapped, decodable payload to onMessage', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor<{ v: number }>({
        options: mqttOptions,
        ctorSubs: [{ topic: 'sensors/+/temp' }],
      });
      await boot(sys, actor);
      actor.module.last().fireMessage('sensors/1/temp', enc.encode('{"v":21}'));
      await awaitCondition(() => actor.inbound.length >= 1, {
        timeoutMs: 4_000, label: 'the inbound message reached onMessage',
      });
      await sleep(SETTLE_MS);  // the exact-count half of the claim; see SETTLE_MS
      expect(actor.inbound).toHaveLength(1);
      expect(actor.inbound[0]!.topic).toBe('sensors/1/temp');
      const decoded = actor.inbound[0]!.payload.entity();
      expect(decoded).toEqual({ v: 21 });
    } finally {
      await sys.terminate();
    }
  });

  test('external target receives the message; overlapping patterns dedupe', async () => {
    const sys = makeSystem();
    try {
      const inbox = new InboxActor<unknown>();
      const inboxRef = sys.spawn(() => inbox, 'inbox') as ActorRef<MqttMessage<unknown>>;
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [
          { topic: 'a/#', target: inboxRef },
          { topic: 'a/b', target: inboxRef }, // overlaps a/# for topic a/b
        ],
      });
      await boot(sys, actor);
      actor.module.last().fireMessage('a/b', enc.encode('hi'));
      // The claim is "exactly once despite two matching patterns", so the
      // second copy is what a bug produces — poll for the first, then hold
      // still long enough for a second to arrive if the dedupe is broken.
      await awaitCondition(() => inbox.received.length >= 1, {
        timeoutMs: 4_000, label: 'the external target received the message',
      });
      await sleep(SETTLE_MS);  // the exact-count half of the claim; see SETTLE_MS
      // Two matching patterns, one ref → delivered exactly once.
      expect(inbox.received).toHaveLength(1);
      expect(inbox.received[0]!.payload.text()).toBe('hi');
      // No own-delivery was configured.
      expect(actor.inbound).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });

  test('external subscribe command with no target routes to onMessage', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'subscribe', topic: 'x/#' });
      await awaitCondition(
        () => actor.module.last().subscribes.some((s) => s.topic === 'x/#'),
        { timeoutMs: 4_000, label: 'the subscribe command reached the broker' },
      );
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('x/#');
      actor.module.last().fireMessage('x/y', enc.encode('yo'));
      await awaitCondition(() => actor.inbound.length >= 1, {
        timeoutMs: 4_000, label: 'the message for the runtime subscription reached onMessage',
      });
      await sleep(SETTLE_MS);  // the exact-count half of the claim; see SETTLE_MS
      expect(actor.inbound.map((m) => m.topic)).toEqual(['x/y']);
    } finally {
      await sys.terminate();
    }
  });
});

/* -------------------- external-command provenance (#783) ------------ */

/**
 * The registry distinguishes a change the actor made from one an external
 * command asked for, in both directions.  The removal half has been guarded
 * since the actor was written — its JSDoc states the invariant outright — but
 * nothing sent this actor an `unsubscribe` command until now, so the guard
 * was asserted by nothing; the additive half was missing entirely (#783).
 */
describe('MqttActor external-command provenance', () => {
  test('an external subscribe cannot rewrite the QoS the subclass declared', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(1);
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'own/#', qos: 2 }],
      });
      const ref = await boot(sys, actor);
      expect(actor.module.last().subscribes).toEqual([{ topic: 'own/#', qos: 2 }]);
      // Same pattern, lower QoS, from outside the actor.  The command may join
      // the pattern; it must not downgrade exactly-once to at-most-once.
      ref.tell({ kind: 'subscribe', topic: 'own/#', qos: 0 });
      // Poll on the *arrival* of the second SUBSCRIBE rather than on its QoS:
      // the re-SUBSCRIBE fires either way, so the wait cannot pass the
      // assertion below by outrunning the bug it is meant to catch.
      await awaitCondition(() => actor.module.last().subscribes.length >= 2, {
        timeoutMs: 4_000, label: 'the external subscribe reached the broker',
      });
      await sleep(SETTLE_MS);  // the subscribe list is asserted exactly; see SETTLE_MS
      expect(actor.module.last().subscribes).toEqual([
        { topic: 'own/#', qos: 2 },
        { topic: 'own/#', qos: 2 },
      ]);
    } finally {
      await sys.terminate();
    }
  });

  test('an external subscribe still sets the QoS of a pattern it creates', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(0);
      const actor = new TestMqttActor({ options: mqttOptions });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'subscribe', topic: 'fresh/#', qos: 2 });
      await awaitCondition(
        () => actor.module.last().subscribes.some((s) => s.topic === 'fresh/#'),
        { timeoutMs: 4_000, label: 'the external subscribe reached the broker' },
      );
      // The guard is on rewriting an entry, not on creating one — a pattern the
      // subclass never declared carries no QoS worth protecting, so the
      // command's own value stands rather than falling back to the default 0.
      expect(actor.module.last().subscribes).toEqual([{ topic: 'fresh/#', qos: 2 }]);
    } finally {
      await sys.terminate();
    }
  });

  test('an external unsubscribe with no target clears foreign targets and keeps the own subscription', async () => {
    const sys = makeSystem();
    try {
      const inbox = new InboxActor<unknown>();
      const inboxRef = sys.spawn(() => inbox, 'inbox-external-unsubscribe') as ActorRef<MqttMessage<unknown>>;
      const mqttOptions = MqttOptions.create().withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [
          { topic: 'shared/#' },                    // the subclass's own delivery
          { topic: 'shared/#', target: inboxRef },  // a foreign fan-out target
        ],
      });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'unsubscribe', topic: 'shared/#' });
      // Command and inbound signal share one mailbox, so FIFO puts the
      // unsubscribe strictly before this message: the routing decision below is
      // taken against the post-command registry, with no wait in between.
      actor.module.last().fireMessage('shared/x', enc.encode('after'));
      await awaitCondition(() => actor.inbound.length >= 1, {
        timeoutMs: 4_000,
        label: "the subclass's own subscription still delivers after an external unsubscribe",
      });
      await sleep(SETTLE_MS);  // the fan-out copy is an absence; see SETTLE_MS
      expect(actor.inbound.map((m) => m.topic)).toEqual(['shared/x']);
      expect(inbox.received).toHaveLength(0);
      // The pattern still has a consumer, so it was never dropped at the broker.
      expect(actor.module.last().unsubscribes).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});

/* ----------------------- reconnect / disconnected ------------------- */

describe('MqttActor reconnect + subscription persistence', () => {
  test('subscribe received while disconnected reaches the broker on reconnect (bug #2)', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      // Drop the connection → disconnected, reconnect scheduled.
      actor.module.last().fireClose();
      // Subscribe arrives while disconnected: recorded, not yet on the broker.
      ref.tell({ kind: 'subscribe', topic: 'late/#', qos: 1 });
      await awaitCondition(
        () => actor.module.clients.length >= 2 && actor.module.last().subscribes.length >= 1,
        { timeoutMs: 4_000, label: 'the reconnect applied the registry to a second client' },
      );
      // The subscribe list is asserted exactly; see SETTLE_MS.
      await sleep(SETTLE_MS);
      const latest = actor.module.last();
      expect(actor.module.clients.length).toBeGreaterThanOrEqual(2);
      expect(latest.subscribes).toEqual([{ topic: 'late/#', qos: 1 }]);
    } finally {
      await sys.terminate();
    }
  });

  test('runtime subscription is re-applied on the broker after a reconnect (bug #1)', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(1)
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'subscribe', topic: 'run/#' });
      await awaitCondition(
        () => actor.module.last().subscribes.some((s) => s.topic === 'run/#'),
        { timeoutMs: 4_000, label: 'the runtime subscribe reached the first client' },
      );
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('run/#');
      // Reconnect → the new client must re-receive the runtime subscription.
      actor.module.last().fireClose();
      await awaitCondition(
        () => actor.module.clients.length >= 2
          && actor.module.last().subscribes.some((s) => s.topic === 'run/#'),
        { timeoutMs: 4_000, label: 'the second client re-received the runtime subscription' },
      );
      const latest = actor.module.last();
      expect(actor.module.clients.length).toBeGreaterThanOrEqual(2);
      expect(latest.subscribes.map((s) => s.topic)).toContain('run/#');
    } finally {
      await sys.terminate();
    }
  });

  test('onConnected / onDisconnected hooks fire across a reconnect', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      await boot(sys, actor);
      expect(actor.connectedCount).toBe(1);
      actor.module.last().fireClose();
      await awaitCondition(
        () => actor.disconnectedCount >= 1 && actor.connectedCount >= 2,
        { timeoutMs: 4_000, label: 'both lifecycle hooks fired across the reconnect' },
      );
      expect(actor.disconnectedCount).toBeGreaterThanOrEqual(1);
      expect(actor.connectedCount).toBeGreaterThanOrEqual(2);
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- Terminated cleanup --------------------- */

describe('MqttActor deathwatch cleanup (bug #3)', () => {
  test('stopping an external target prunes it and unsubscribes when the pattern empties', async () => {
    const sys = makeSystem();
    try {
      const inbox = new InboxActor<unknown>();
      const inboxRef = sys.spawn(() => inbox, 'inbox-term') as ActorRef<MqttMessage<unknown>>;
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'watched/#', target: inboxRef }],
      });
      await boot(sys, actor);
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('watched/#');
      // Stop the target → Terminated flows to the actor → registry pruned.
      inboxRef.stop();
      await awaitCondition(
        () => actor.module.last().unsubscribes.includes('watched/#'),
        { timeoutMs: 4_000, label: 'the pruned pattern was unsubscribed at the broker' },
      );
      expect(actor.module.last().unsubscribes).toContain('watched/#');
      // A subsequent message must not reach the stopped inbox.
      actor.module.last().fireMessage('watched/x', enc.encode('gone'));
      // An absence cannot be polled — `received` is already empty, so a
      // predicate over it returns at t=0 and proves nothing.  This is the turn
      // in which a message that should not be routed would arrive.
      await sleep(SETTLE_MS);
      expect(inbox.received).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- decode errors -------------------------- */

describe('MqttActor onInvalidMessage', () => {
  test('malformed payload in onMessage routes to onInvalidMessage without restarting', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'j/#' }],
      });
      actor.decodeOnReceive = true;
      await boot(sys, actor);
      actor.module.last().fireMessage('j/1', enc.encode('{ broken'));
      await awaitCondition(() => actor.decodeErrors.length >= 1, {
        timeoutMs: 4_000, label: 'the malformed payload reached onInvalidMessage',
      });
      // One error, not one per restart attempt; see SETTLE_MS.
      await sleep(SETTLE_MS);
      expect(actor.decodeErrors).toHaveLength(1);
      expect(actor.decodeErrors[0]!.error.topic).toBe('j/1');
      // Actor is still alive and processing: a valid message still lands.
      actor.decodeOnReceive = false;
      actor.module.last().fireMessage('j/2', enc.encode('"ok"'));
      await awaitCondition(() => actor.inbound.some((m) => m.topic === 'j/2'), {
        timeoutMs: 4_000, label: 'the actor still delivers after the decode failure',
      });
      expect(actor.inbound.map((m) => m.topic)).toContain('j/2');
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- self messages -------------------------- */

describe('MqttActor onSelfMessage', () => {
  test('non-command app messages route to onSelfMessage; commands still dispatch', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor<unknown, { kind: 'tick'; n: number }>({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'tick', n: 7 });
      ref.tell({ kind: 'subscribe', topic: 's/#' });
      await awaitCondition(
        () => actor.selfMessages.length >= 1
          && actor.module.last().subscribes.some((s) => s.topic === 's/#'),
        { timeoutMs: 4_000, label: 'the app message and the command were both dispatched' },
      );
      // The self-message list is asserted exactly; see SETTLE_MS.
      await sleep(SETTLE_MS);
      expect(actor.selfMessages).toEqual([{ kind: 'tick', n: 7 }]);
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('s/#');
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- publish matrix ------------------------- */

describe('MqttActor publish', () => {
  test('string + Uint8Array pass through raw; objects are codec-encoded', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      await boot(sys, actor);
      actor.doPublish('t/str', 'hello');
      actor.doPublish('t/bin', enc.encode('bin'));
      actor.doPublish('t/obj', { a: 1 });
      await awaitCondition(() => actor.module.last().publishes.length >= 3, {
        timeoutMs: 4_000, label: 'all three publishes reached the client',
      });
      const byTopic = new Map(actor.module.last().publishes.map((publish) => [publish.topic, publish.payload]));
      expect(byTopic.get('t/str')).toBe('hello');
      expect(new TextDecoder().decode(byTopic.get('t/bin') as Uint8Array)).toBe('bin');
      expect(new TextDecoder().decode(byTopic.get('t/obj') as Uint8Array)).toBe('{"a":1}');
    } finally {
      await sys.terminate();
    }
  });

  test('escape hatch: encode a bare string as a JSON entity', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      await boot(sys, actor);
      actor.doPublish('t/entity', actor.encodeEntity('pong'));
      await awaitCondition(
        () => actor.module.last().publishes.some((x) => x.topic === 't/entity'),
        { timeoutMs: 4_000, label: 'the pre-encoded entity reached the client' },
      );
      const publish = actor.module.last().publishes.find((x) => x.topic === 't/entity')!;
      expect(new TextDecoder().decode(publish.payload as Uint8Array)).toBe('"pong"');
    } finally {
      await sys.terminate();
    }
  });

  test('encode failure drops the publish and returns false', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      await boot(sys, actor);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const ok = actor.doPublish('t/bad', circular);
      // Both claims are absences — `ok` is already false when `doPublish`
      // returns, and the point of the second is that no publish EVER reaches
      // the client.  A predicate over either holds at t=0, so this is a turn
      // in which a wrongly-enqueued publish would surface, not a wait.
      await sleep(SETTLE_MS);
      expect(ok).toBe(false);
      expect(actor.module.last().publishes.find((x) => x.topic === 't/bad')).toBeUndefined();
    } finally {
      await sys.terminate();
    }
  });

  test('publishes while disconnected are buffered and flushed on reconnect in order', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      actor.module.last().fireClose();
      // Buffered while disconnected.
      ref.tell({ kind: 'publish', publish: { topic: 'buf/1', payload: 'one' } });
      ref.tell({ kind: 'publish', publish: { topic: 'buf/2', payload: 'two' } });
      await awaitCondition(
        () => actor.module.last().publishes
          .filter((publish) => publish.topic.startsWith('buf/')).length >= 2,
        { timeoutMs: 4_000, label: 'the reconnect flushed both buffered publishes' },
      );
      // The flushed list is asserted exactly — a third copy is what a broken
      // drain produces; see SETTLE_MS.
      await sleep(SETTLE_MS);
      const flushed = actor.module.last().publishes.filter((publish) => publish.topic.startsWith('buf/'));
      expect(flushed.map((publish) => publish.topic)).toEqual(['buf/1', 'buf/2']);
    } finally {
      await sys.terminate();
    }
  });
});

/* ------------------- MQTT 5.0 publish-properties helper (#13) -------- */

describe('buildPublishProperties (MQTT 5.0)', () => {
  test('returns undefined on protocolVersion=4 even with userProperties set', () => {
    const publish: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties: { tenant: 't1' } };
    expect(buildPublishProperties(publish, 4)).toBeUndefined();
  });

  test('returns undefined when no v5 fields are set, regardless of version', () => {
    const publish: MqttPublish = { topic: 'sensor/1', payload: 'x' };
    expect(buildPublishProperties(publish, 4)).toBeUndefined();
    expect(buildPublishProperties(publish, 5)).toBeUndefined();
  });

  test('returns undefined when userProperties is an empty object on v5', () => {
    const publish: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties: {} };
    expect(buildPublishProperties(publish, 5)).toBeUndefined();
  });

  test('returns a properties block on v5 with populated userProperties', () => {
    const userProperties = { tenant: 't1', priority: ['high', 'audit'] };
    const publish: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties };
    expect(buildPublishProperties(publish, 5)).toEqual({ userProperties });
  });

  test('preserves multi-valued properties (string[]) verbatim', () => {
    const publish: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties: { tag: ['alpha', 'beta', 'gamma'] } };
    const props = buildPublishProperties(publish, 5);
    expect(props?.userProperties?.tag).toEqual(['alpha', 'beta', 'gamma']);
  });
});
