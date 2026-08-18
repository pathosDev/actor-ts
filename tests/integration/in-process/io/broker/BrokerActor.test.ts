import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';
import { BrokerActor, type OutboundEnvelope } from '../../../../../src/io/broker/BrokerActor.js';
import {
  BrokerConnected,
  BrokerDisconnected,
  BrokerBufferOverflow,
  BrokerNotConnected,
  BrokerReconnectAttempt,
} from '../../../../../src/io/broker/BrokerEvents.js';
import {
  BrokerOptionsError,
  type BrokerCommonOptionsType,
} from '../../../../../src/io/broker/BrokerOptions.js';
import type { Config } from '../../../../../src/config/Config.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Actor } from '../../../../../src/Actor.js';
import { Terminated } from '../../../../../src/SystemMessages.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import { Scheduler, type Cancellable } from '../../../../../src/Scheduler.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/** `Terminated` arrives via `onReceive` but is not in the typed command union. */
function isTerminated(message: unknown): message is Terminated {
  return message instanceof Terminated;
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

interface FakeOptions extends BrokerCommonOptionsType {
  readonly endpoint?: string;
  readonly tag?: string;
}

type FakeCommand = {
  kind: 'send' | 'subscribe' | 'unsubscribe' | 'fanOut' | 'simulate-loss';
  topic?: string;
  ref?: ActorRef<unknown>;
  payload?: string;
};

/**
 * Concrete subclass for tests — `connectImplementation` and `dispatchOutgoing`
 * are wired to mutable flags so the test can simulate failures.
 */
class FakeBroker extends BrokerActor<FakeOptions, FakeCommand, string, string> {
  connectAttempts = 0;
  disconnects = 0;
  dispatched: string[] = [];
  failNextConnects = 0;
  failNextDispatches = 0;

  /* Desired-subscription test surface (#504).  The `Subscription`
   * payload is just a label, so an assertion can tell a re-applied
   * entry from a replaced one. */

  /** Seeded once into the desired set — stands in for options-declared subscriptions. */
  configuredSubscriptions: Array<readonly [string, string]> = [];
  /** `key=label` per applySubscription on the CURRENT connection; cleared on disconnect. */
  appliedSubscriptions: string[] = [];
  /** Every revokeSubscription, across connections. */
  revokedSubscriptions: string[] = [];
  /** Keys whose applySubscription throws. */
  readonly failSubscriptionKeys = new Set<string>();
  /**
   * When set, `connectImplementation` parks on it *after* the replay pass —
   * the window where the actor is `connecting` with a usable connection.
   * Consumed by the connect that awaits it.
   */
  connectGate: Promise<void> | null = null;
  /**
   * When set, the next `disconnectImplementation` parks on it *after*
   * counting itself.  `_tryConnect` tears the previous transport down before
   * building the new one, so this is the seam that lets a stop land between
   * those two halves of one reconnect attempt (#708).
   */
  disconnectGate: Promise<void> | null = null;
  /**
   * The driver handle the subclass owns, assigned only *after* `connectGate`
   * settles — `MqttActor`'s exact shape, where `this.client` is set inside
   * the `'connect'` callback, i.e. after the whole handshake.  Bumping a
   * counter cannot express "the teardown closed nothing", which is the
   * observable at the heart of #708; a handle can.
   */
  liveHandle: string | null = null;
  /** Every handle `disconnectImplementation` actually closed, in order. */
  closedHandles: string[] = [];

  constructor(options: Partial<FakeOptions> = {}) { super(options); }

  protected configKey(): string { return 'actor-ts.io.broker.fake'; }
  protected builtInDefaultOptions(): Partial<FakeOptions> { return { tag: 'default' }; }
  protected readOptionsFromConfig(c: Config): Partial<FakeOptions> {
    return {
      endpoint: c.hasPath('endpoint') ? c.getString('endpoint') : undefined,
      tag: c.hasPath('tag') ? c.getString('tag') : undefined,
    };
  }
  protected requiredOptions(): ReadonlyArray<keyof FakeOptions> { return ['endpoint']; }
  protected endpointLabel(): string { return this.options.endpoint ?? '<none>'; }

  protected async connectImplementation(): Promise<void> {
    this.connectAttempts++;
    if (this.failNextConnects > 0) {
      this.failNextConnects--;
      throw new Error(`simulated connect failure (${this.connectAttempts})`);
    }
    await this.applyDesiredSubscriptions();
    if (this.connectGate) {
      const gate = this.connectGate;
      this.connectGate = null;
      await gate;
    }
    this.liveHandle = `client-${this.connectAttempts}`;
  }
  protected async disconnectImplementation(): Promise<void> {
    this.disconnects++;
    // Live handles die with the connection; the desired set does not.
    this.appliedSubscriptions = [];
    if (this.liveHandle !== null) {
      this.closedHandles.push(this.liveHandle);
      this.liveHandle = null;
    }
    if (this.disconnectGate) {
      const gate = this.disconnectGate;
      this.disconnectGate = null;
      await gate;
    }
  }

  protected override initialSubscriptions(): Iterable<readonly [string, string]> {
    return this.configuredSubscriptions;
  }
  protected override applySubscription(key: string, subscription: string): void {
    if (this.failSubscriptionKeys.has(key)) throw new Error(`cannot subscribe '${key}'`);
    this.appliedSubscriptions.push(`${key}=${subscription}`);
  }
  protected override revokeSubscription(key: string): void {
    this.revokedSubscriptions.push(key);
    this.appliedSubscriptions = this.appliedSubscriptions.filter((s) => !s.startsWith(`${key}=`));
  }
  protected async dispatchOutgoing(env: OutboundEnvelope<string>): Promise<void> {
    if (this.failNextDispatches > 0) {
      this.failNextDispatches--;
      throw new Error('simulated dispatch failure');
    }
    this.dispatched.push(env.payload);
  }

  // Test surface — expose protected helpers for assertion / driving the actor.
  publicEnqueue(payload: string): boolean { return this.enqueueOutbound(payload); }
  publicSubscribe(topic: string, ref: ActorRef<unknown>): void { this.subscribeRef(topic, ref); }
  publicUnsubscribe(topic: string, ref: ActorRef<unknown>): void { this.unsubscribeRef(topic, ref); }
  publicFanOut(topic: string, message: unknown): void { this.fanOutToTopic(topic, message); }
  publicSimulateLoss(): void { this.handleConnectionLost(new Error('simulated loss')); }
  publicConnectionState(): string { return this.connectionState; }
  publicBufferSize(): number { return this.outboundBufferSize; }
  publicSubscriberCount(topic: string): number { return this.subscriberCountForTopic(topic); }
  publicRemember(key: string, subscription: string): Promise<void> {
    return this.rememberSubscription(key, subscription);
  }
  publicForget(key: string): Promise<void> { return this.forgetSubscription(key); }
  publicDesiredCount(): number { return this.desiredSubscriptionCount; }

  /** How many `Terminated` messages actually removed a subscriber (#1111). */
  terminatedPrunes = 0;

  /**
   * Counted *after* `super.postStop()` resolves, so a test can wait on the
   * stop having fully completed rather than on a proxy an earlier step
   * already satisfies — `connectionState` reads `disconnected` after a mere
   * connect failure, long before any stop (#708).
   */
  postStopCalls = 0;

  override async postStop(): Promise<void> {
    await super.postStop();
    this.postStopCalls++;
  }

  override onReceive(command: FakeCommand): void {
    // Exactly the seam `subscribeRef`'s docs prescribe: the base class cannot
    // route `Terminated` itself, because `onReceive` is abstract and every
    // subclass owns its own dispatch.
    if (isTerminated(command)) {
      if (this.pruneTerminatedSubscriber(command.actor)) this.terminatedPrunes++;
      return;
    }
    /* otherwise a no-op — the tests drive this actor directly */
  }
}

class ProbeActor extends Actor<unknown> {
  received: unknown[] = [];
  override onReceive(m: unknown): void { this.received.push(m); }
}

/**
 * Collects warn records so a test can assert a failure was *reported*.
 * `withSource` / `withFields` return `this`, so every derived logger
 * appends to the same list.
 */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: string[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string): void { this.warnings.push(message); }
  error(): void {}
  withSource(): Logger { return this; }
  withFields(): Logger { return this; }
}

function makeSystem(name = 'broker-test', config?: ConfigObject): ActorSystem {
  // Thin wrapper around the shared `createTestActorSystem` helper.
  // Kept named `makeSystem` to match the per-file convention used by
  // existing tests; the test body's `makeSystem('foo')` calls don't
  // need to change as a result of the helper consolidation.
  return createTestActorSystem({ name, config });
}

/**
 * Bypass the class form to keep direct access to a captured FakeBroker.
 * `configure` runs on the fresh instance *before* `preStart`, which is
 * the only window for anything the first connect must already see
 * (`failNextConnects`, `configuredSubscriptions`).
 */
function spawnFake(
  sys: ActorSystem,
  options: Partial<FakeOptions> = {},
  configure: (broker: FakeBroker) => void = () => {},
): { ref: ActorRef<FakeCommand>; brokerReady: Promise<FakeBroker> } {
  let resolve!: (broker: FakeBroker) => void;
  const brokerReady = new Promise<FakeBroker>((r) => { resolve = r; });
  const ref = sys.spawnAnonymous(() => {
    const broker = new FakeBroker(options);
    configure(broker);
    resolve(broker);
    return broker as unknown as Actor<FakeCommand>;
  });
  return { ref: ref as ActorRef<FakeCommand>, brokerReady };
}

/* ---------------------------- Options tests ---------------------------- */

describe('BrokerActor — options resolution', () => {
  test('constructor options win over HOCON config', async () => {
    const sys = makeSystem('cfg-1', {
      'actor-ts': { io: { broker: { fake: { endpoint: 'cfg.local' } } } },
    });
    const { brokerReady } = spawnFake(sys, { endpoint: 'ctor.local' });
    const broker = await brokerReady;
    await sleep(20);
    expect(broker.connectAttempts).toBe(1);
    expect((broker as unknown as { options: FakeOptions }).options.endpoint).toBe('ctor.local');
    await sys.terminate();
  });

  test('HOCON config provides defaults when constructor is silent', async () => {
    const sys = makeSystem('cfg-2', {
      'actor-ts': { io: { broker: { fake: { endpoint: 'cfg.local', tag: 'from-config' } } } },
    });
    const { brokerReady } = spawnFake(sys);
    const broker = await brokerReady;
    await sleep(20);
    const options = (broker as unknown as { options: FakeOptions }).options;
    expect(options.endpoint).toBe('cfg.local');
    expect(options.tag).toBe('from-config');
    await sys.terminate();
  });

  test('built-in defaults apply when neither constructor nor config provides', async () => {
    const sys = makeSystem('cfg-3', {
      'actor-ts': { io: { broker: { fake: { endpoint: 'cfg.local' } } } },
    });
    const { brokerReady } = spawnFake(sys);
    const broker = await brokerReady;
    await sleep(20);
    const options = (broker as unknown as { options: FakeOptions }).options;
    expect(options.tag).toBe('default');  // from builtInDefaultOptions
    await sys.terminate();
  });

  test('missing required setting raises BrokerOptionsError', async () => {
    const sys = makeSystem('cfg-4');
    let captured: Error | null = null;
    sys.spawnAnonymous(() => {
      const broker = new FakeBroker();  // no endpoint anywhere
      // Intercept preStart to capture the error.
      const orig = broker.preStart.bind(broker);
      broker.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return broker as unknown as Actor<FakeCommand>;
    });
    await sleep(20);
    expect(captured).toBeInstanceOf(BrokerOptionsError);
    expect((captured as unknown as Error).message).toContain('missing required options');
    expect((captured as unknown as Error).message).toContain('endpoint');
    await sys.terminate();
  });
});

/* ---------------------------- Lifecycle tests --------------------------- */

describe('BrokerActor — lifecycle', () => {
  test('successful preStart connects and publishes BrokerConnected', async () => {
    const sys = makeSystem('lc-1');
    let connectedCount = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connectedCount++; }
      })()),
      BrokerConnected,
    );
    const { brokerReady } = spawnFake(sys, { endpoint: 'host:1' });
    const broker = await brokerReady;
    await sleep(30);
    expect(broker.connectAttempts).toBe(1);
    expect(broker.publicConnectionState()).toBe('connected');
    expect(connectedCount).toBe(1);
    await sys.terminate();
  });

  test('postStop calls disconnectImplementation and clears state', async () => {
    const sys = makeSystem('lc-2');
    let disconnectedCount = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { disconnectedCount++; }
      })()),
      BrokerDisconnected,
    );
    const { ref, brokerReady } = spawnFake(sys, { endpoint: 'host:1' });
    const broker = await brokerReady;
    await sleep(20);
    ref.stop();
    await sleep(30);
    expect(broker.disconnects).toBe(1);
    expect(broker.publicConnectionState()).toBe('disconnected');
    void disconnectedCount;  // BrokerDisconnected only on connection-lost, not graceful stop
    await sys.terminate();
  });
});

/* ---------------------------- Reconnect tests --------------------------- */

describe('BrokerActor — reconnect', () => {
  test('failed connectImplementation triggers backoff and a follow-up attempt', async () => {
    const sys = makeSystem('rc-1');
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 30, maxDelayMs: 100, factor: 2 },
    });
    const broker = await brokerReady;
    broker.failNextConnects = 2;
    await sleep(200);  // attempt-1 fails, ~30ms wait, attempt-2 fails, ~60ms wait, attempt-3 OK
    expect(broker.connectAttempts).toBeGreaterThanOrEqual(3);
    expect(broker.publicConnectionState()).toBe('connected');
    await sys.terminate();
  });

  test('reconnect: false disables reconnect after a connect failure', async () => {
    const sys = makeSystem('rc-2');
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: false,
    });
    const broker = await brokerReady;
    broker.failNextConnects = 1;
    await sleep(80);
    expect(broker.connectAttempts).toBe(1);
    expect(broker.publicConnectionState()).toBe('disconnected');
    await sys.terminate();
  });

  test('handleConnectionLost during steady-state triggers reconnect', async () => {
    const sys = makeSystem('rc-3');
    let reconnectAttempts = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { reconnectAttempts++; }
      })()),
      BrokerReconnectAttempt,
    );
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 20, maxDelayMs: 50 },
    });
    const broker = await brokerReady;
    await sleep(20);
    expect(broker.publicConnectionState()).toBe('connected');
    broker.publicSimulateLoss();
    expect(broker.publicConnectionState()).toBe('disconnected');
    await sleep(80);
    expect(broker.connectAttempts).toBeGreaterThanOrEqual(2);
    expect(broker.publicConnectionState()).toBe('connected');
    expect(reconnectAttempts).toBeGreaterThanOrEqual(1);
    await sys.terminate();
  });
});

/* ------------------------- Reconnect jitter (#652) ---------------------- */

/**
 * Records every one-shot delay the system asks for.  Both reconnect
 * wake-ups go through `scheduleOnceFunction`, and observing the *requested*
 * delay rather than the achieved one keeps the assertions independent of
 * how loaded the machine is — which matters most for the circuit-breaker
 * path, whose wake-up publishes no event to key off.
 */
class RecordingScheduler extends Scheduler {
  readonly delays: number[] = [];
  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    this.delays.push(delayMs);
    return super.scheduleOnceFunction(delayMs, task);
  }
}

/**
 * Subscribe a probe that records the first `BrokerReconnectAttempt` delay
 * per endpoint.  Keying on the endpoint (rather than the actor path) is
 * what lets one system host two brokers whose schedules a test can tell
 * apart without knowing which anonymous path each one got.
 */
function recordFirstDelayPerEndpoint(sys: ActorSystem): Map<string, number> {
  const firstDelays = new Map<string, number>();
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(m: unknown): void {
        const attempt = m as BrokerReconnectAttempt;
        if (!firstDelays.has(attempt.endpoint)) firstDelays.set(attempt.endpoint, attempt.delayMs);
      }
    })()),
    BrokerReconnectAttempt,
  );
  return firstDelays;
}

describe('BrokerActor — reconnect jitter (#652)', () => {
  test('two actors that fail in the same instant do not retry in the same millisecond', async () => {
    const sys = makeSystem('jit-1');
    const firstDelays = recordFirstDelayPerEndpoint(sys);
    // Identical policy, identical failure instant, identical attempt
    // counter: un-jittered, both actors compute byte-identical delays and
    // hit the recovering broker together on every wave.
    const policy = { initialDelayMs: 100, maxDelayMs: 100, factor: 1, randomFactor: 0.5 } as const;
    for (const endpoint of ['herd-a', 'herd-b']) {
      spawnFake(sys, { endpoint, reconnect: policy }, (broker) => { broker.failNextConnects = 1; });
    }

    await awaitCondition(() => firstDelays.size === 2, { label: 'both brokers scheduled a reconnect' });
    const a = firstDelays.get('herd-a')!;
    const b = firstDelays.get('herd-b')!;
    expect(a).not.toBe(b);
    // Both still inside ±50 % of the un-jittered 100 ms.
    for (const delay of [a, b]) {
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(150);
    }
    await sys.terminate();
  });

  test('the random seam pins the delay to an exact value', async () => {
    const sys = makeSystem('jit-2');
    const firstDelays = recordFirstDelayPerEndpoint(sys);
    const base = { initialDelayMs: 100, maxDelayMs: 100, factor: 1, randomFactor: 0.25 } as const;
    // random() === 1 maps to the top of the band, random() === 0 to the bottom.
    spawnFake(sys, { endpoint: 'top', reconnect: { ...base, random: () => 1 } },
      (broker) => { broker.failNextConnects = 1; });
    spawnFake(sys, { endpoint: 'bottom', reconnect: { ...base, random: () => 0 } },
      (broker) => { broker.failNextConnects = 1; });

    await awaitCondition(() => firstDelays.size === 2, { label: 'both brokers scheduled a reconnect' });
    expect(firstDelays.get('top')).toBe(125);
    expect(firstDelays.get('bottom')).toBe(75);
    await sys.terminate();
  });

  test('randomFactor: 0 restores the un-jittered schedule, factor included', async () => {
    const sys = makeSystem('jit-3');
    const delays: number[] = [];
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(m: unknown): void { delays.push((m as BrokerReconnectAttempt).delayMs); }
      })()),
      BrokerReconnectAttempt,
    );
    // factor 3 — a base `exponentialBackoff` cannot express, which is why
    // the broker keeps its own arithmetic.
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: { initialDelayMs: 40, maxDelayMs: 10_000, factor: 3, randomFactor: 0 } },
      (broker) => { broker.failNextConnects = 2; },
    );
    await brokerReady;

    await awaitCondition(() => delays.length >= 2, { label: 'two reconnect attempts were scheduled' });
    expect(delays.slice(0, 2)).toEqual([40, 120]);
    await sys.terminate();
  });

  test('reconnect.randomFactor resolves from HOCON', async () => {
    const sys = makeSystem('jit-4', {
      'actor-ts': {
        io: {
          broker: {
            fake: {
              endpoint: 'cfg.local',
              reconnect: { initialDelayMs: 100, maxDelayMs: 100, factor: 1, randomFactor: 0 },
            },
          },
        },
      },
    });
    const firstDelays = recordFirstDelayPerEndpoint(sys);
    spawnFake(sys, {}, (broker) => { broker.failNextConnects = 1; });

    await awaitCondition(() => firstDelays.size === 1, { label: 'the broker scheduled a reconnect' });
    // Exactly 100 only if the leaf was read: an unset randomFactor falls
    // through to the built-in 0.2 and jitters the delay off the round number.
    expect(firstDelays.get('cfg.local')).toBe(100);
    await sys.terminate();
  });

  test('an open circuit breaker wakes on a spread deadline, never before it', async () => {
    const scheduler = new RecordingScheduler();
    const sys = createTestActorSystem({ name: 'jit-5', scheduler });
    // failureThreshold 1 → the breaker opens on the first failure, so the
    // second `_tryConnect` takes the early-return path that never reaches
    // the backoff calculation.  A 5 ms backoff gets it there promptly.
    spawnFake(
      sys,
      {
        endpoint: 'host:1',
        circuitBreaker: { failureThreshold: 1, resetMs: 400 },
        reconnect: { initialDelayMs: 5, maxDelayMs: 5, factor: 1, randomFactor: 1, random: () => 1 },
      },
      (broker) => { broker.failNextConnects = 5; },
    );

    await awaitCondition(() => scheduler.delays.some((d) => d > 400), {
      label: 'the breaker wake-up was scheduled',
    });
    const breakerWait = scheduler.delays.find((d) => d > 400)!;
    // Un-jittered this is exactly the time left on the deadline (< 400 ms).
    // One-sided jitter with random() === 1 doubles it, and never shortens it.
    expect(breakerWait).toBeGreaterThan(600);
    expect(breakerWait).toBeLessThanOrEqual(800);
    await sys.terminate();
  });

  test('randomFactor: 0 leaves the breaker wake-up on the bare deadline', async () => {
    const scheduler = new RecordingScheduler();
    const sys = createTestActorSystem({ name: 'jit-6', scheduler });
    // The control for the test above: same shape, jitter off.  It pins the
    // recorded delay to `resetMs`, which is what makes the >600 ms reading
    // there attributable to the spread rather than to scheduler noise.
    spawnFake(
      sys,
      {
        endpoint: 'host:1',
        circuitBreaker: { failureThreshold: 1, resetMs: 400 },
        reconnect: { initialDelayMs: 5, maxDelayMs: 5, factor: 1, randomFactor: 0 },
      },
      (broker) => { broker.failNextConnects = 5; },
    );

    await awaitCondition(() => scheduler.delays.some((d) => d > 300), {
      label: 'the breaker wake-up was scheduled',
    });
    const breakerWait = scheduler.delays.find((d) => d > 300)!;
    expect(breakerWait).toBeLessThanOrEqual(400);
    await sys.terminate();
  });
});

/* ------------------------ Teardown before reconnect --------------------- */

describe('BrokerActor — transport teardown (#504)', () => {
  test('disconnectImplementation runs before each re-connect attempt', async () => {
    const sys = makeSystem('td-1');
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, factor: 1 },
    });
    const broker = await brokerReady;
    await sleep(20);
    expect(broker.publicConnectionState()).toBe('connected');
    // First connect had nothing to tear down.
    expect(broker.disconnects).toBe(0);

    broker.publicSimulateLoss();
    await sleep(60);
    expect(broker.publicConnectionState()).toBe('connected');
    // The dead connection was closed before the new one was built.
    expect(broker.disconnects).toBe(1);
    expect(broker.connectAttempts).toBe(2);
    await sys.terminate();
  });

  test('a connect that fails half-way is torn down before the retry', async () => {
    const sys = makeSystem('td-2');
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: { initialDelayMs: 10, maxDelayMs: 20, factor: 1 } },
      (broker) => { broker.failNextConnects = 2; },
    );
    const broker = await brokerReady;
    await sleep(120);
    expect(broker.publicConnectionState()).toBe('connected');
    expect(broker.connectAttempts).toBeGreaterThanOrEqual(3);
    // Attempts 2 and 3 each cleaned up after the previous failure.
    expect(broker.disconnects).toBeGreaterThanOrEqual(2);
    await sys.terminate();
  });

  test('postStop tears down after a connection loss', async () => {
    const sys = makeSystem('td-3');
    // Long backoff: the actor stays `disconnected` with transport still
    // open, which the old `_state !== 'disconnected'` guard skipped.
    const { ref, brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 10_000 },
    });
    const broker = await brokerReady;
    await sleep(20);
    broker.publicSimulateLoss();
    expect(broker.publicConnectionState()).toBe('disconnected');
    expect(broker.disconnects).toBe(0);

    ref.stop();
    await sleep(40);
    expect(broker.disconnects).toBe(1);
    await sys.terminate();
  });
});

/* ------------------------- Desired subscriptions ------------------------ */

describe('BrokerActor — desired subscriptions (#504)', () => {
  test('configured subscriptions are applied on connect and re-applied on reconnect', async () => {
    const sys = makeSystem('ds-1');
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: { initialDelayMs: 10, maxDelayMs: 20, factor: 1 } },
      (broker) => { broker.configuredSubscriptions = [['orders', 'a'], ['audit', 'b']]; },
    );
    const broker = await brokerReady;
    await sleep(20);
    expect(broker.appliedSubscriptions).toEqual(['orders=a', 'audit=b']);
    expect(broker.publicDesiredCount()).toBe(2);

    broker.publicSimulateLoss();
    await sleep(60);
    expect(broker.appliedSubscriptions).toEqual(['orders=a', 'audit=b']);
    await sys.terminate();
  });

  test('remember while connected applies immediately and survives a reconnect', async () => {
    const sys = makeSystem('ds-2');
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, factor: 1 },
    });
    const broker = await brokerReady;
    await sleep(20);
    await broker.publicRemember('runtime', 'x');
    expect(broker.appliedSubscriptions).toEqual(['runtime=x']);

    broker.publicSimulateLoss();
    await sleep(60);
    expect(broker.appliedSubscriptions).toEqual(['runtime=x']);
    await sys.terminate();
  });

  test('remember while disconnected is applied on the next connect', async () => {
    const sys = makeSystem('ds-3');
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: { initialDelayMs: 60, maxDelayMs: 60, factor: 1 } },
      (broker) => { broker.failNextConnects = 1; },
    );
    const broker = await brokerReady;
    await sleep(10);
    expect(broker.publicConnectionState()).toBe('disconnected');
    await broker.publicRemember('offline', 'y');
    // Recorded, not dropped — nothing to apply it to yet.
    expect(broker.publicDesiredCount()).toBe(1);
    expect(broker.appliedSubscriptions).toEqual([]);

    await sleep(120);
    expect(broker.publicConnectionState()).toBe('connected');
    expect(broker.appliedSubscriptions).toEqual(['offline=y']);
    await sys.terminate();
  });

  test('re-remembering a live key revokes it first so the new payload takes effect', async () => {
    const sys = makeSystem('ds-4');
    const { brokerReady } = spawnFake(sys, { endpoint: 'host:1' });
    const broker = await brokerReady;
    await sleep(20);
    await broker.publicRemember('topic', 'first');
    await broker.publicRemember('topic', 'second');
    expect(broker.revokedSubscriptions).toEqual(['topic']);
    expect(broker.appliedSubscriptions).toEqual(['topic=second']);
    expect(broker.publicDesiredCount()).toBe(1);
    await sys.terminate();
  });

  test('forget drops the entry and is not resurrected by a reconnect', async () => {
    const sys = makeSystem('ds-5');
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: { initialDelayMs: 10, maxDelayMs: 20, factor: 1 } },
      (broker) => { broker.configuredSubscriptions = [['orders', 'a']]; },
    );
    const broker = await brokerReady;
    await sleep(20);
    await broker.publicForget('orders');
    expect(broker.revokedSubscriptions).toEqual(['orders']);
    expect(broker.publicDesiredCount()).toBe(0);

    broker.publicSimulateLoss();
    await sleep(60);
    // Seeding is once-only, so the options don't bring it back.
    expect(broker.appliedSubscriptions).toEqual([]);
    await sys.terminate();
  });

  test('remember lands immediately once the connect replay pass has run', async () => {
    const sys = makeSystem('ds-6b');
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, factor: 1 },
    });
    const broker = await brokerReady;
    await sleep(20);

    // Park the next connect *after* its replay pass, so the actor sits in
    // `connecting` with a working connection.  The reconnect cycle runs on
    // the scheduler, detached from the mailbox, so a real subscribe can
    // land in exactly this window — it must apply now rather than wait for
    // the next reconnect.
    let releaseConnect!: () => void;
    broker.connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    broker.publicSimulateLoss();
    for (let i = 0; i < 40 && broker.connectAttempts < 2; i++) await sleep(5);
    await sleep(10);
    expect(broker.publicConnectionState()).toBe('connecting');

    await broker.publicRemember('in-the-gap', 'z');
    expect(broker.appliedSubscriptions).toEqual(['in-the-gap=z']);

    releaseConnect();
    await sleep(20);
    expect(broker.publicConnectionState()).toBe('connected');
    await sys.terminate();
  });

  test('forget of an unknown key is a no-op', async () => {
    const sys = makeSystem('ds-6');
    const { brokerReady } = spawnFake(sys, { endpoint: 'host:1' });
    const broker = await brokerReady;
    await sleep(20);
    await broker.publicForget('never-subscribed');
    expect(broker.revokedSubscriptions).toEqual([]);
    await sys.terminate();
  });

  test('a failing subscription warns and leaves the connection + siblings intact', async () => {
    const logger = new CapturingLogger();
    const sys = createTestActorSystem({ name: 'ds-7', logger, logLevel: LogLevel.Warn });
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1' },
      (broker) => {
        broker.configuredSubscriptions = [['good', 'a'], ['bad', 'b'], ['also-good', 'c']];
        broker.failSubscriptionKeys.add('bad');
      },
    );
    const broker = await brokerReady;
    await sleep(30);
    // One bad subject must not fail the connection or block its siblings.
    expect(broker.publicConnectionState()).toBe('connected');
    expect(broker.appliedSubscriptions).toEqual(['good=a', 'also-good=c']);
    // But it must not be silent, either — that is the whole point (#504).
    expect(logger.warnings.some((w) => w.includes("could not establish subscription 'bad'")))
      .toBe(true);
    await sys.terminate();
  });
});

/* ---------------------------- Outbound buffer --------------------------- */

describe('BrokerActor — outbound buffer', () => {
  test('messages enqueued before connect are dispatched after connect', async () => {
    const sys = makeSystem('ob-1');
    // First connect fails → enqueue while disconnected, second connect succeeds.
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 30 },
    });
    const broker = await brokerReady;
    broker.failNextConnects = 1;
    await sleep(10);  // attempt 1 has run and failed, state is disconnected
    broker.publicEnqueue('m1');
    broker.publicEnqueue('m2');
    expect(broker.publicBufferSize()).toBe(2);
    await sleep(120);  // wait for reconnect + drain
    expect(broker.publicConnectionState()).toBe('connected');
    expect(broker.dispatched).toEqual(['m1', 'm2']);
    expect(broker.publicBufferSize()).toBe(0);
    await sys.terminate();
  });

  test('outboundBuffer overflow drops oldest and emits BrokerBufferOverflow', async () => {
    const sys = makeSystem('ob-2');
    let overflows = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { overflows++; }
      })()),
      BrokerBufferOverflow,
    );
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 1_000 },  // long → won't reconnect during test
      outboundBuffer: 2,
    });
    const broker = await brokerReady;
    broker.failNextConnects = 1;  // stay disconnected
    await sleep(10);
    expect(broker.publicEnqueue('a')).toBe(true);
    expect(broker.publicEnqueue('b')).toBe(true);
    expect(broker.publicEnqueue('c')).toBe(true);  // overflow → drop 'a'
    expect(broker.publicBufferSize()).toBe(2);
    await sleep(20);
    expect(overflows).toBe(1);
    await sys.terminate();
  });

  test('outboundBuffer = 0 fail-fast emits BrokerNotConnected and drops the message', async () => {
    const sys = makeSystem('ob-3');
    let notConnected = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { notConnected++; }
      })()),
      BrokerNotConnected,
    );
    const { brokerReady } = spawnFake(sys, {
      endpoint: 'host:1',
      reconnect: { initialDelayMs: 1_000 },
      outboundBuffer: 0,
    });
    const broker = await brokerReady;
    broker.failNextConnects = 1;
    await sleep(10);
    expect(broker.publicEnqueue('a')).toBe(false);
    expect(broker.publicBufferSize()).toBe(0);
    await sleep(10);
    expect(notConnected).toBe(1);
    await sys.terminate();
  });
});

/* ---------------------------- Subscriber fan-out ------------------------ */

describe('BrokerActor — subscribers', () => {
  test('subscribers receive fanOut for matching topic', async () => {
    const sys = makeSystem('sub-1');
    const probes = [new ProbeActor(), new ProbeActor()];
    const refs = probes.map((p, i) =>
      sys.spawn(() => p as unknown as Actor<unknown>, `p${i}`),
    );
    const { brokerReady } = spawnFake(sys, { endpoint: 'h' });
    const broker = await brokerReady;
    await sleep(20);
    broker.publicSubscribe('foo', refs[0]!);
    broker.publicSubscribe('foo', refs[1]!);
    broker.publicSubscribe('bar', refs[1]!);
    broker.publicFanOut('foo', { hello: 1 });
    broker.publicFanOut('bar', { hello: 2 });
    await sleep(20);
    expect(probes[0]!.received).toEqual([{ hello: 1 }]);
    expect(probes[1]!.received).toEqual([{ hello: 1 }, { hello: 2 }]);
    await sys.terminate();
  });

  test('unsubscribe removes from fanOut targets', async () => {
    const sys = makeSystem('sub-2');
    const probe = new ProbeActor();
    const probeRef = sys.spawnAnonymous(() => probe as unknown as Actor<unknown>);
    const { brokerReady } = spawnFake(sys, { endpoint: 'h' });
    const broker = await brokerReady;
    await sleep(20);
    broker.publicSubscribe('foo', probeRef);
    broker.publicFanOut('foo', 1);
    broker.publicUnsubscribe('foo', probeRef);
    broker.publicFanOut('foo', 2);
    await sleep(20);
    expect(probe.received).toEqual([1]);
    expect(broker.publicSubscriberCount('foo')).toBe(0);
    await sys.terminate();
  });

  test('multiple topics for one ref tracked independently', async () => {
    const sys = makeSystem('sub-3');
    const probe = new ProbeActor();
    const probeRef = sys.spawnAnonymous(() => probe as unknown as Actor<unknown>);
    const { brokerReady } = spawnFake(sys, { endpoint: 'h' });
    const broker = await brokerReady;
    await sleep(20);
    broker.publicSubscribe('a', probeRef);
    broker.publicSubscribe('b', probeRef);
    broker.publicFanOut('a', 1);
    broker.publicFanOut('b', 2);
    await sleep(20);
    expect(probe.received).toEqual([1, 2]);
    broker.publicUnsubscribe('a', probeRef);
    expect(broker.publicSubscriberCount('a')).toBe(0);
    expect(broker.publicSubscriberCount('b')).toBe(1);
    await sys.terminate();
  });

  test('a stopped subscriber is pruned from every topic it held (#1111)', async () => {
    // `subscribeRef` watches the ref and its JSDoc promised the removal.
    // Nothing implemented it: the reverse index existed for a `Terminated`
    // handler that did not exist, so a stopped subscriber stayed in every
    // topic and kept costing a dead-lettered `tell` on each fan-out.
    const sys = makeSystem('sub-terminated');
    const doomed = new ProbeActor();
    const doomedRef = sys.spawnAnonymous(() => doomed as unknown as Actor<unknown>);
    const survivor = new ProbeActor();
    const survivorRef = sys.spawnAnonymous(() => survivor as unknown as Actor<unknown>);
    const { brokerReady } = spawnFake(sys, { endpoint: 'h' });
    const broker = await brokerReady;
    await sleep(20);

    broker.publicSubscribe('a', doomedRef);
    broker.publicSubscribe('b', doomedRef);
    broker.publicSubscribe('a', survivorRef);
    expect(broker.publicSubscriberCount('a')).toBe(2);

    doomedRef.stop();
    await awaitCondition(() => broker.terminatedPrunes === 1, {
      timeoutMs: 4_000, intervalMs: 25, label: 'the broker processed Terminated for the stopped subscriber',
    });

    // Gone from both topics, not just the one that still has a subscriber.
    expect(broker.publicSubscriberCount('a')).toBe(1);
    expect(broker.publicSubscriberCount('b')).toBe(0);

    broker.publicFanOut('a', 'after');
    broker.publicFanOut('b', 'after');
    await sleep(20);
    expect(survivor.received).toEqual(['after']);
    expect(doomed.received).toEqual([]);

    await sys.terminate();
  });

});

/* ------------------- Stop during an in-flight reconnect ----------------- */

/**
 * A reconnect attempt runs on the **system** scheduler, detached from the
 * mailbox, and `Scheduler` settles a one-shot handle *before* invoking it —
 * so `postStop`'s `cancel()` is a no-op against an attempt that has already
 * begun, and that attempt then resumes on a terminated actor (#708).
 *
 * Every test here drives the actor into a reconnect cycle first, because the
 * *first* connect cannot race a stop: `preStart` is awaited by the cell.
 *
 * The delay is pinned to exactly 20 ms (`factor: 1`, `randomFactor: 0`) so a
 * `RecordingScheduler` can count the broker's own wake-ups by value and the
 * "no timer was armed" assertion needs no timing window at all — the
 * unguarded `_handleReconnect` re-arms synchronously from the catch block.
 */
const RECONNECT_EVERY_20_MS = {
  initialDelayMs: 20, maxDelayMs: 20, factor: 1, randomFactor: 0,
} as const;

describe('BrokerActor — stop during an in-flight reconnect (#708)', () => {
  test('a connect that resolves after the stop is abandoned, not adopted', async () => {
    const sys = makeSystem('stop-race-resolve');
    let connectedEvents = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connectedEvents++; }
      })()),
      BrokerConnected,
    );
    const { ref, brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: RECONNECT_EVERY_20_MS },
      // Fail attempt 1 so attempt 2 runs on the scheduler, where a stop can
      // interleave with it.
      (broker) => { broker.failNextConnects = 1; },
    );
    const broker = await brokerReady;

    // Park attempt 2 inside `connectImplementation`, after its replay pass.
    let releaseConnect!: () => void;
    broker.connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    await awaitCondition(() => broker.connectAttempts === 2, {
      label: 'the scheduled reconnect entered connectImplementation',
    });

    ref.stop();
    await awaitCondition(() => broker.postStopCalls === 1, {
      label: 'postStop ran to completion while the connect was parked',
    });
    // Both teardowns so far found no handle to close: the subclass assigns
    // its handle only after the gate, exactly as `MqttActor` does.
    expect(broker.closedHandles).toEqual([]);

    releaseConnect();
    // Settles either way: the guard closes the connection it just opened,
    // the unguarded version adopts it.
    await awaitCondition(
      () => broker.closedHandles.length === 1 || broker.publicConnectionState() === 'connected',
      { label: 'the resumed connect finished one way or the other' },
    );

    // The handle the subclass acquired post-mortem was released…
    expect(broker.closedHandles).toEqual(['client-2']);
    expect(broker.liveHandle).toBeNull();
    // …the state machine did not go back to `connected`…
    expect(broker.publicConnectionState()).toBe('disconnected');
    // …and no `BrokerConnected` was announced for an actor with no owner.
    expect(connectedEvents).toBe(0);
    await sys.terminate();
  });

  test('a connect that rejects after the stop arms no further attempt', async () => {
    const scheduler = new RecordingScheduler();
    const sys = createTestActorSystem({ name: 'stop-race-reject', scheduler });
    const twentyMillisecondWakeUps = (): number =>
      scheduler.delays.filter((delay) => delay === 20).length;

    const { ref, brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: RECONNECT_EVERY_20_MS },
      (broker) => { broker.failNextConnects = 1; },
    );
    const broker = await brokerReady;

    let rejectConnect!: (cause: Error) => void;
    broker.connectGate = new Promise<void>((_, reject) => { rejectConnect = reject; });
    await awaitCondition(() => broker.connectAttempts === 2, {
      label: 'the scheduled reconnect entered connectImplementation',
    });

    ref.stop();
    await awaitCondition(() => broker.postStopCalls === 1, {
      label: 'postStop ran to completion while the connect was parked',
    });
    const attemptsAtStop = broker.connectAttempts;
    const disconnectsAtStop = broker.disconnects;
    const wakeUpsAtStop = twentyMillisecondWakeUps();

    // Keep every later attempt failing, so a surviving cycle shows up as an
    // unbounded loop rather than converging on one lucky success.
    // `maxAttempts` defaults to `Number.POSITIVE_INFINITY`, so nothing else
    // would ever stop it.
    broker.failNextConnects = 100;
    rejectConnect(new Error('connect failed after the stop'));
    // ~10 backoff windows.  The scheduler assertion below does not need
    // them — the re-arm is synchronous — but the attempt count does.
    await sleep(200);

    expect(twentyMillisecondWakeUps()).toBe(wakeUpsAtStop);
    expect(broker.connectAttempts).toBe(attemptsAtStop);
    // The half-built transport was closed exactly once, by the abandon path.
    expect(broker.disconnects).toBe(disconnectsAtStop + 1);
    expect(broker.publicConnectionState()).toBe('disconnected');
    await sys.terminate();
  });

  test('an attempt whose teardown outlived the stop never opens a connection', async () => {
    // The worst shape of all: the stop lands between the attempt's
    // `_closeTransport()` and its `connectImplementation()`, so without a
    // second liveness check the *entire* handshake happens post-mortem.
    const sys = makeSystem('stop-race-teardown');
    let connectedEvents = 0;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connectedEvents++; }
      })()),
      BrokerConnected,
    );
    const { ref, brokerReady } = spawnFake(
      sys,
      { endpoint: 'host:1', reconnect: RECONNECT_EVERY_20_MS },
      (broker) => { broker.failNextConnects = 1; },
    );
    const broker = await brokerReady;

    // Park attempt 2 in the teardown that precedes its connect.
    let releaseDisconnect!: () => void;
    broker.disconnectGate = new Promise<void>((resolve) => { releaseDisconnect = resolve; });
    await awaitCondition(() => broker.disconnects === 1, {
      label: 'the scheduled reconnect entered disconnectImplementation',
    });

    ref.stop();
    await awaitCondition(() => broker.postStopCalls === 1, {
      label: 'postStop ran to completion while the teardown was parked',
    });
    expect(broker.connectAttempts).toBe(1);

    releaseDisconnect();
    // Everything the unguarded path does from here is microtasks —
    // `connectImplementation` bumps its counter on its first line — so this
    // window is a settling budget, not a race.
    await sleep(120);

    expect(broker.connectAttempts).toBe(1);
    expect(broker.liveHandle).toBeNull();
    expect(broker.publicConnectionState()).toBe('disconnected');
    expect(connectedEvents).toBe(0);
    await sys.terminate();
  });
});
