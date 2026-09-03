import { describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
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
  BrokerReconnectFailed,
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
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * The window in which one *too many* of something shows up.
 *
 * A poll returns on the event that reaches the number it waits for, so it can
 * only confirm the lower half of an exact claim — `toBe(2)`, `toEqual(['m1',
 * 'm2'])`.  Polling `>=` and then holding still for this long restores the
 * upper half.  It is only needed where a surplus is actually reachable: after a
 * *successful* first connect nothing is scheduled that could produce a second
 * attempt, so those assertions need no settle.
 */
const SETTLE_MS = 20;

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
  /** When set, a simulated connect failure names the endpoint verbatim (#1388). */
  connectFailureEmbedsEndpoint = false;

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
      // `connectFailureEmbedsEndpoint` models the shape #1388 is about:
      // amqplib and mqtt.js both name the target they were dialling in the
      // error they throw, so the raw options string — credential included —
      // ends up in a message the base class never built.
      throw new Error(this.connectFailureEmbedsEndpoint
        ? `connect ECONNREFUSED ${this.options.endpoint ?? ''}`
        : `simulated connect failure (${this.connectAttempts})`);
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
  publicSimulateLossWith(cause: Error): void { this.handleConnectionLost(cause); }
  publicConnectionState(): string { return this.connectionState; }
  publicBufferSize(): number { return this.outboundBufferSize; }
  publicSubscriberCount(topic: string): number { return this.subscriberCountForTopic(topic); }
  publicRemember(key: string, subscription: string): Promise<void> {
    return this.rememberSubscription(key, subscription);
  }
  publicForget(key: string): Promise<void> { return this.forgetSubscription(key); }
  publicDesiredCount(): number { return this.desiredSubscriptionCount; }

  /**
   * How many `Terminated` signals the sealed dispatch handed on (#1111, #709).
   *
   * The prune itself is the base class's now, and it runs *before* the hook —
   * so this counts deaths the subclass was told about, and a poll on it is a
   * barrier for a prune that has already happened.
   */
  terminatedSignals = 0;

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

  /**
   * True once `preStart` returned — the first connect attempt has settled,
   * whether it connected or fell into backoff.
   *
   * Nothing else in this class can express that.  `connectionState` reads
   * `disconnected` both *before* the attempt starts and *after* it failed, so a
   * poll on it returns at t=0 and waits for nothing.  `connectAttempts === 1`
   * is worse than useless here: it returns on attempt 1 and structurally
   * cannot see the attempt 2 that the `reconnect: false` test exists to rule
   * out, so the test would assert nothing at all (#418).
   */
  firstConnectSettled = false;

  override async preStart(): Promise<void> {
    await super.preStart();
    this.firstConnectSettled = true;
  }

  protected override onCommand(_command: FakeCommand): void {
    /* a no-op — the tests drive this actor directly */
  }

  protected override onTerminated(_signal: Terminated): void {
    this.terminatedSignals++;
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

/**
 * Wait for `preStart`'s first connect attempt to settle, either way.
 *
 * `brokerReady` resolves inside the spawn factory — i.e. *before* `preStart`
 * runs — so it hands back the instance and nothing more.  See
 * {@link FakeBroker.firstConnectSettled} for why that flag, and not the
 * connection state or the attempt count, is the honest condition here.
 */
function awaitFirstConnect(broker: FakeBroker): Promise<void> {
  return awaitCondition(() => broker.firstConnectSettled, {
    timeoutMs: 4_000, label: "the broker's first connect attempt settled",
  });
}

/** Wait for a `stop()` to have run all the way through `postStop`. */
function awaitStopped(broker: FakeBroker, expected = 1): Promise<void> {
  return awaitCondition(() => broker.postStopCalls >= expected, {
    timeoutMs: 4_000, label: 'the broker finished postStop',
  });
}

/* ---------------------------- Options tests ---------------------------- */

describe('BrokerActor — options resolution', () => {
  test('constructor options win over HOCON config', async () => {
    const sys = makeSystem('cfg-1', {
      'actor-ts': { io: { broker: { fake: { endpoint: 'cfg.local' } } } },
    });
    const { brokerReady } = spawnFake(sys, { endpoint: 'ctor.local' });
    const broker = await brokerReady;
    await awaitFirstConnect(broker);
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
    await awaitFirstConnect(broker);
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
    await awaitFirstConnect(broker);
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
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'preStart rejected the incomplete options',
    });
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
    // The event travels through the stream to a subscriber actor, so it lands
    // a turn *after* the connect — which makes it the furthest-downstream of
    // the three things asserted below.
    await awaitCondition(() => connectedCount >= 1, {
      timeoutMs: 4_000, label: 'BrokerConnected reached its subscriber',
    });
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
    await awaitFirstConnect(broker);
    ref.stop();
    await awaitStopped(broker);
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
    // Attempt 1 fails, ~30 ms wait, attempt 2 fails, ~60 ms wait, attempt 3 is
    // let through — so the third attempt landing is the observable, not the
    // ~200 ms the backoff schedule happens to add up to.
    await awaitCondition(
      () => broker.connectAttempts >= 3 && broker.publicConnectionState() === 'connected',
      { timeoutMs: 4_000, label: 'the third connect attempt succeeded' },
    );
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
    await awaitFirstConnect(broker);
    // Now an absence, and the one this file most needs to keep as a delay: the
    // claim is that a second attempt NEVER happens, and a poll on
    // `connectAttempts === 1` returns on the first one and can never see a
    // second — the test would then assert nothing at all.  250 ms is chosen to
    // exceed `DEFAULT_RECONNECT.initialDelayMs` (200 ms), so a retry that the
    // `reconnect: false` option failed to disable would have fired by now.
    await sleep(250);
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
    await awaitFirstConnect(broker);
    expect(broker.publicConnectionState()).toBe('connected');
    broker.publicSimulateLoss();
    expect(broker.publicConnectionState()).toBe('disconnected');
    await awaitCondition(
      () => broker.connectAttempts >= 2 && broker.publicConnectionState() === 'connected'
        && reconnectAttempts >= 1,
      { timeoutMs: 4_000, label: 'the steady-state loss was followed by a successful reconnect' },
    );
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
    await awaitFirstConnect(broker);
    expect(broker.publicConnectionState()).toBe('connected');
    // First connect had nothing to tear down.
    expect(broker.disconnects).toBe(0);

    broker.publicSimulateLoss();
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected' && broker.connectAttempts >= 2,
      { timeoutMs: 4_000, label: 'the second connect attempt completed' },
    );
    // Both counts below are exact; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected' && broker.connectAttempts >= 3,
      { timeoutMs: 4_000, label: 'the third attempt connected after two teardowns' },
    );
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
    await awaitFirstConnect(broker);
    broker.publicSimulateLoss();
    expect(broker.publicConnectionState()).toBe('disconnected');
    expect(broker.disconnects).toBe(0);

    ref.stop();
    await awaitStopped(broker);
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
    await awaitFirstConnect(broker);
    expect(broker.appliedSubscriptions).toEqual(['orders=a', 'audit=b']);
    expect(broker.publicDesiredCount()).toBe(2);

    broker.publicSimulateLoss();
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected',
      { timeoutMs: 4_000, label: 'the reconnect finished its subscription replay pass' },
    );
    // The subscription list is asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitFirstConnect(broker);
    await broker.publicRemember('runtime', 'x');
    expect(broker.appliedSubscriptions).toEqual(['runtime=x']);

    broker.publicSimulateLoss();
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected',
      { timeoutMs: 4_000, label: 'the reconnect finished its subscription replay pass' },
    );
    // The subscription list is asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    // The first connect is configured to fail, so this settles into
    // `disconnected` — which `awaitFirstConnect` waits for without needing to
    // guess how long the failure takes.
    await awaitFirstConnect(broker);
    expect(broker.publicConnectionState()).toBe('disconnected');
    await broker.publicRemember('offline', 'y');
    // Recorded, not dropped — nothing to apply it to yet.
    expect(broker.publicDesiredCount()).toBe(1);
    expect(broker.appliedSubscriptions).toEqual([]);

    await awaitCondition(
      () => broker.publicConnectionState() === 'connected',
      { timeoutMs: 4_000, label: 'the backoff retry connected and replayed the offline entry' },
    );
    // The subscription list is asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
    expect(broker.publicConnectionState()).toBe('connected');
    expect(broker.appliedSubscriptions).toEqual(['offline=y']);
    await sys.terminate();
  });

  test('re-remembering a live key revokes it first so the new payload takes effect', async () => {
    const sys = makeSystem('ds-4');
    const { brokerReady } = spawnFake(sys, { endpoint: 'host:1' });
    const broker = await brokerReady;
    await awaitFirstConnect(broker);
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
    await awaitFirstConnect(broker);
    await broker.publicForget('orders');
    expect(broker.revokedSubscriptions).toEqual(['orders']);
    expect(broker.publicDesiredCount()).toBe(0);

    broker.publicSimulateLoss();
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected',
      { timeoutMs: 4_000, label: 'the reconnect finished its subscription replay pass' },
    );
    // The subscription list is asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitFirstConnect(broker);

    // Park the next connect *after* its replay pass, so the actor sits in
    // `connecting` with a working connection.  The reconnect cycle runs on
    // the scheduler, detached from the mailbox, so a real subscribe can
    // land in exactly this window — it must apply now rather than wait for
    // the next reconnect.
    let releaseConnect!: () => void;
    broker.connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    broker.publicSimulateLoss();
    // The hand-rolled 40x5 ms loop this replaces fell through silently.  Both
    // halves matter: the second attempt must have started AND the actor must
    // still be inside it — `connecting` is only reachable while the connect is
    // parked on the gate.
    await awaitCondition(
      () => broker.connectAttempts >= 2 && broker.publicConnectionState() === 'connecting',
      { timeoutMs: 4_000, label: 'the second connect parked after its replay pass' },
    );
    expect(broker.publicConnectionState()).toBe('connecting');

    await broker.publicRemember('in-the-gap', 'z');
    expect(broker.appliedSubscriptions).toEqual(['in-the-gap=z']);

    releaseConnect();
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected',
      { timeoutMs: 4_000, label: 'the parked connect completed once released' },
    );
    expect(broker.publicConnectionState()).toBe('connected');
    await sys.terminate();
  });

  test('forget of an unknown key is a no-op', async () => {
    const sys = makeSystem('ds-6');
    const { brokerReady } = spawnFake(sys, { endpoint: 'host:1' });
    const broker = await brokerReady;
    await awaitFirstConnect(broker);
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
    await awaitFirstConnect(broker);
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
    // The enqueues below only exercise the buffer if the actor is genuinely
    // disconnected first, and attempt 1 is configured to fail — so waiting for
    // that attempt to settle is the fixture, not a guess at how long it takes.
    await awaitFirstConnect(broker);
    broker.publicEnqueue('m1');
    broker.publicEnqueue('m2');
    expect(broker.publicBufferSize()).toBe(2);
    await awaitCondition(
      () => broker.publicConnectionState() === 'connected' && broker.dispatched.length >= 2,
      { timeoutMs: 4_000, label: 'the reconnect drained both buffered messages' },
    );
    // The dispatched list is asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitFirstConnect(broker);
    expect(broker.publicEnqueue('a')).toBe(true);
    expect(broker.publicEnqueue('b')).toBe(true);
    expect(broker.publicEnqueue('c')).toBe(true);  // overflow → drop 'a'
    expect(broker.publicBufferSize()).toBe(2);
    await awaitCondition(() => overflows >= 1, {
      timeoutMs: 4_000, label: 'BrokerBufferOverflow reached its subscriber',
    });
    // One overflow, not one per enqueue; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitFirstConnect(broker);
    expect(broker.publicEnqueue('a')).toBe(false);
    expect(broker.publicBufferSize()).toBe(0);
    await awaitCondition(() => notConnected >= 1, {
      timeoutMs: 4_000, label: 'BrokerNotConnected reached its subscriber',
    });
    // One event, not one per retry; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitFirstConnect(broker);
    broker.publicSubscribe('foo', refs[0]!);
    broker.publicSubscribe('foo', refs[1]!);
    broker.publicSubscribe('bar', refs[1]!);
    broker.publicFanOut('foo', { hello: 1 });
    broker.publicFanOut('bar', { hello: 2 });
    // The second probe is the one that must see both topics, so its count is
    // the last thing the two fan-outs produce.
    await awaitCondition(() => probes[1]!.received.length >= 2, {
      timeoutMs: 4_000, label: 'both fan-outs reached the probe subscribed to both topics',
    });
    // Both lists are asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    await awaitFirstConnect(broker);
    broker.publicSubscribe('foo', probeRef);
    broker.publicFanOut('foo', 1);
    broker.publicUnsubscribe('foo', probeRef);
    broker.publicFanOut('foo', 2);
    // Waiting on the first message is what makes 'and not the second' mean
    // anything: an empty probe could otherwise mean neither had arrived yet.
    await awaitCondition(() => probe.received.length >= 1, {
      timeoutMs: 4_000, label: 'the fan-out before the unsubscribe reached the probe',
    });
    await sleep(SETTLE_MS);  // the second fan-out must NOT arrive; see SETTLE_MS
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
    await awaitFirstConnect(broker);
    broker.publicSubscribe('a', probeRef);
    broker.publicSubscribe('b', probeRef);
    broker.publicFanOut('a', 1);
    broker.publicFanOut('b', 2);
    await awaitCondition(() => probe.received.length >= 2, {
      timeoutMs: 4_000, label: 'both topics fanned out to the one ref',
    });
    // The received list is asserted exactly; see SETTLE_MS.
    await sleep(SETTLE_MS);
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
    // topic and kept costing a dead-lettered `tell` on each fan-out.  The
    // handler is the base class's now (#709) — this subclass only counts the
    // signal it is handed afterwards.
    const sys = makeSystem('sub-terminated');
    const doomed = new ProbeActor();
    const doomedRef = sys.spawnAnonymous(() => doomed as unknown as Actor<unknown>);
    const survivor = new ProbeActor();
    const survivorRef = sys.spawnAnonymous(() => survivor as unknown as Actor<unknown>);
    const { brokerReady } = spawnFake(sys, { endpoint: 'h' });
    const broker = await brokerReady;
    await awaitFirstConnect(broker);

    broker.publicSubscribe('a', doomedRef);
    broker.publicSubscribe('b', doomedRef);
    broker.publicSubscribe('a', survivorRef);
    expect(broker.publicSubscriberCount('a')).toBe(2);

    doomedRef.stop();
    await awaitCondition(() => broker.terminatedSignals === 1, {
      timeoutMs: 4_000, intervalMs: 25, label: 'the broker processed Terminated for the stopped subscriber',
    });

    // Gone from both topics, not just the one that still has a subscriber.
    expect(broker.publicSubscriberCount('a')).toBe(1);
    expect(broker.publicSubscriberCount('b')).toBe(0);

    broker.publicFanOut('a', 'after');
    broker.publicFanOut('b', 'after');
    // The survivor's message is the observable; the pruned subscriber seeing
    // nothing is the absence that only means something once it has arrived.
    await awaitCondition(() => survivor.received.length >= 1, {
      timeoutMs: 4_000, label: 'the fan-out after the prune reached the survivor',
    });
    await sleep(SETTLE_MS);  // the pruned subscriber must stay empty; see SETTLE_MS
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

/* ---------------- The documented subclass recipe (#709) ----------------- */

type SubscribeTopicCommand = {
  readonly kind: 'subscribe';
  readonly topic: string;
  readonly subscriber: ActorRef<unknown>;
};
type FanOutCommand = {
  readonly kind: 'fan-out';
  readonly topic: string;
  readonly payload: string;
};
type RecipeCommand = SubscribeTopicCommand | FanOutCommand;

/**
 * A `BrokerActor` written exactly the way the docs prescribe: a `match(command)
 * … .exhaustive()` over the subclass's **own** command union, and nothing else.
 *
 * That plain form is what #709 is titled after — it used to throw
 * `NonExhaustiveError` on the first subscriber death, and the published recipe
 * had to widen the match input and carry a `P.instanceOf(Terminated)` arm to
 * stay upright.  `onReceive` is the base class's now, so the widening is gone
 * and the union is back to what the protocol actually is.  Compiling this here
 * is the assertion that it *stays* gone: re-introduce `Terminated` into the
 * mailbox and `.exhaustive()` would be the thing that stops compiling.
 *
 * Counters are **static** on purpose: a restart replaces the instance, so an
 * instance field could not tell "never restarted" from "restarted and the
 * new instance has not counted yet".
 */
class RecipeBroker extends BrokerActor<FakeOptions, RecipeCommand, string, string> {
  static connects = 0;
  static prunes = 0;

  constructor(options: Partial<FakeOptions> = {}) { super(options); }

  protected configKey(): string { return 'actor-ts.io.broker.recipe'; }
  protected builtInDefaultOptions(): Partial<FakeOptions> { return { endpoint: 'recipe:1' }; }
  protected readOptionsFromConfig(_config: Config): Partial<FakeOptions> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof FakeOptions> { return ['endpoint']; }
  protected endpointLabel(): string { return this.options.endpoint ?? '<none>'; }

  protected async connectImplementation(): Promise<void> { RecipeBroker.connects++; }
  protected async disconnectImplementation(): Promise<void> { /* nothing to close */ }
  protected async dispatchOutgoing(): Promise<void> { /* never sends */ }

  protected override onCommand(command: RecipeCommand): void {
    match(command)
      .with({ kind: 'subscribe' }, (m) => this.onSubscribe(m))
      .with({ kind: 'fan-out' }, (m) => this.onFanOut(m))
      .exhaustive();
  }

  protected override onTerminated(_signal: Terminated): void {
    RecipeBroker.prunes++;
  }

  private onSubscribe(command: SubscribeTopicCommand): void {
    this.subscribeRef(command.topic, command.subscriber);
  }

  private onFanOut(command: FanOutCommand): void {
    this.fanOutToTopic(command.topic, command.payload);
  }

  publicSubscriberCount(topic: string): number { return this.subscriberCountForTopic(topic); }
  publicConnectionState(): string { return this.connectionState; }
}

describe('BrokerActor — the documented subclass recipe (#709)', () => {
  test('a subscriber death prunes the topic and leaves the bridge running', async () => {
    // The prune half is covered for a subclass that keeps its own counter
    // (#1111).  What was never asserted is the *availability* half this issue
    // is titled after: that handling `Terminated` costs no restart, i.e. no
    // broker reconnect.  Before the seal, a subclass whose matcher had no
    // `Terminated` arm failed `.exhaustive()`, the default supervisor restarted
    // it, `preRestart` → `postStop` tore the transport down, and `postRestart`
    // → `preStart` reconnected — eleven subscriber deaths inside a minute then
    // stopped the bridge for good.  This broker has no such arm, deliberately.
    RecipeBroker.connects = 0;
    RecipeBroker.prunes = 0;
    const sys = makeSystem('recipe-terminated');

    let resolveBroker!: (broker: RecipeBroker) => void;
    const brokerReady = new Promise<RecipeBroker>((resolve) => { resolveBroker = resolve; });
    const ref = sys.spawnAnonymous(() => {
      const broker = new RecipeBroker();
      resolveBroker(broker);
      return broker as unknown as Actor<RecipeCommand>;
    }) as ActorRef<RecipeCommand>;
    const broker = await brokerReady;
    await awaitCondition(() => RecipeBroker.connects === 1, { label: 'the broker connected' });

    const doomed = new ProbeActor();
    const doomedRef = sys.spawnAnonymous(() => doomed as unknown as Actor<unknown>);
    const survivor = new ProbeActor();
    const survivorRef = sys.spawnAnonymous(() => survivor as unknown as Actor<unknown>);
    ref.tell({ kind: 'subscribe', topic: 'a', subscriber: doomedRef });
    ref.tell({ kind: 'subscribe', topic: 'a', subscriber: survivorRef });
    await awaitCondition(() => broker.publicSubscriberCount('a') === 2, {
      label: 'both subscribers registered',
    });

    doomedRef.stop();
    await awaitCondition(() => RecipeBroker.prunes === 1, {
      label: 'the sealed dispatch routed Terminated into onTerminated',
    });

    expect(broker.publicSubscriberCount('a')).toBe(1);
    // Never restarted: one connect for the whole test.  `connectImplementation`
    // would run a second time on the restart path.
    expect(RecipeBroker.connects).toBe(1);
    expect(broker.publicConnectionState()).toBe('connected');

    // And the bridge still works — the same instance, still fanning out.
    ref.tell({ kind: 'fan-out', topic: 'a', payload: 'after' });
    await awaitCondition(() => survivor.received.length === 1, {
      label: 'the surviving subscriber still receives fan-out',
    });
    expect(survivor.received).toEqual(['after']);
    expect(doomed.received).toEqual([]);
    await sys.terminate();
  });
});

/* ------------- Credential redaction on the EventStream (#741) ------------- */

/**
 * `endpoint` is the only field on a broker lifecycle event that says *which*
 * broker — `actorPath` does not — so a monitor has to read it.  And a broker
 * connection string is the one configuration value that routinely carries a
 * credential inline; `AmqpOptionsType.url` documents its own shape as
 * `amqp://user:pass@host:5672/vhost`.
 *
 * What makes this worse than an error-path log: these events go to the
 * system-wide `EventStream`, which has no authorization concept, so any actor
 * in the system can subscribe and read them — and they fire on the *happy*
 * path, once per successful connect and once per reconnect attempt, with the
 * default policy retrying forever at up to 30 s for the length of an outage.
 */
describe('BrokerActor — a lifecycle event carries no credential (#741)', () => {
  const SECRET_URL = 'amqp://svc-orders:S3cr3tPw@rabbit.prod:5671/orders';

  /** Record the `endpoint` of every `BrokerConnected` the stream delivers. */
  function connectedEndpoints(sys: ActorSystem): string[] {
    const seen: string[] = [];
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(m: unknown): void { seen.push((m as BrokerConnected).endpoint); }
      })()),
      BrokerConnected,
    );
    return seen;
  }

  test('BrokerConnected drops the userinfo and keeps the identity', async () => {
    const sys = makeSystem('redact-connected');
    const seen = connectedEndpoints(sys);
    const { brokerReady } = spawnFake(sys, { endpoint: SECRET_URL });
    await brokerReady;
    await awaitCondition(() => seen.length >= 1, {
      timeoutMs: 4_000, label: 'BrokerConnected reached its subscriber',
    });

    // Host, port and path stay: without them the field says nothing, and
    // telling one broker from another is the whole reason it exists.
    expect(seen[0]).toBe('amqp://rabbit.prod:5671/orders');
    expect(seen[0]).not.toContain('S3cr3tPw');
    expect(seen[0]).not.toContain('svc-orders');
    await sys.terminate();
  });

  test('BrokerReconnectAttempt — the one that repeats — is redacted too', async () => {
    const sys = makeSystem('redact-reconnect');
    const seen: string[] = [];
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(m: unknown): void { seen.push((m as BrokerReconnectAttempt).endpoint); }
      })()),
      BrokerReconnectAttempt,
    );
    const { brokerReady } = spawnFake(
      sys,
      { endpoint: SECRET_URL, reconnect: RECONNECT_EVERY_20_MS },
      (broker) => { broker.failNextConnects = 2; },
    );
    await brokerReady;
    await awaitCondition(() => seen.length >= 2, {
      timeoutMs: 4_000, label: 'two reconnect attempts published',
    });

    for (const endpoint of seen) expect(endpoint).not.toContain('S3cr3tPw');
    expect(seen[0]).toBe('amqp://rabbit.prod:5671/orders');
    await sys.terminate();
  });

  test('a composite label keeps its shape and loses every credential', async () => {
    const sys = makeSystem('redact-composite');
    const seen = connectedEndpoints(sys);
    // The NATS / Kafka / email-bridge shape: a joined list is not a parseable
    // URL, so this exercises the helper's scan fallback rather than its URL
    // path — the case a naive `new URL(...)` redaction would have mangled.
    const { brokerReady } = spawnFake(sys, { endpoint: 'nats://u:pw@a:4222,nats://u:pw@b:4222' });
    await brokerReady;
    await awaitCondition(() => seen.length >= 1, {
      timeoutMs: 4_000, label: 'BrokerConnected reached its subscriber',
    });

    expect(seen[0]).toBe('nats://***@a:4222,nats://***@b:4222');
    await sys.terminate();
  });

  test('a label that never carried a credential is unchanged', async () => {
    const sys = makeSystem('redact-noop');
    const seen = connectedEndpoints(sys);
    const { brokerReady } = spawnFake(sys, { endpoint: 'tcp://10.0.0.4:9000' });
    await brokerReady;
    await awaitCondition(() => seen.length >= 1, {
      timeoutMs: 4_000, label: 'BrokerConnected reached its subscriber',
    });

    // The guard against the opposite defect.  Redaction that also ate the
    // labels with nothing to hide would trade the field's diagnostic value
    // for no disclosure benefit at all.
    expect(seen[0]).toBe('tcp://10.0.0.4:9000');
    await sys.terminate();
  });
});

/* ---------- security: the driver's error on the event (#1388) ------------ */

/**
 * #741 took the credential out of the `endpoint` field of these events.  The
 * `cause` beside it is the driver's own `Error`, and several drivers put the
 * connection target — userinfo included — into the message they throw, so it
 * reaches the same system-wide `EventStream`, the same audience and the same
 * log aggregator by a different route.
 *
 * `endpoint` is asserted alongside `cause` on purpose: it is what makes the
 * event look already-handled, and the pair is the whole point of the issue.
 */
describe('BrokerActor — the published cause carries no credential (#1388)', () => {
  const dsn = 'amqp://guest:hunter2@rabbit:5672/vhost';

  test('BrokerDisconnected.cause is redacted, and the driver keeps its own error', async () => {
    const sys = makeSystem('cred-1');
    const seen: BrokerDisconnected[] = [];
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(event: unknown): void { seen.push(event as BrokerDisconnected); }
      })()),
      BrokerDisconnected,
    );
    const { brokerReady } = spawnFake(sys, { endpoint: dsn, reconnect: false });
    const broker = await brokerReady;
    await awaitFirstConnect(broker);

    const driverError = Object.assign(
      new Error(`connect ECONNREFUSED ${dsn}`),
      { code: 'ECONNREFUSED' },
    );
    broker.publicSimulateLossWith(driverError);

    await awaitCondition(() => seen.length >= 1, { timeoutMs: 4_000, label: 'BrokerDisconnected' });
    expect(seen[0]!.cause?.message).toBe('connect ECONNREFUSED amqp://***@rabbit:5672/vhost');
    expect(seen[0]!.cause?.stack ?? '').not.toContain('hunter2');
    expect(seen[0]!.endpoint).not.toContain('hunter2');
    // The identity a subscriber branches on survives the copy…
    expect((seen[0]!.cause as unknown as { code: string }).code).toBe('ECONNREFUSED');
    // …and the driver's own object is not scrubbed under it.
    expect(driverError.message).toBe(`connect ECONNREFUSED ${dsn}`);
    await sys.terminate();
  });

  test('BrokerReconnectFailed.cause is redacted too', async () => {
    const sys = makeSystem('cred-2');
    const seen: BrokerReconnectFailed[] = [];
    sys.eventStream.subscribe(
      sys.spawnAnonymous(() => new (class extends Actor<unknown> {
        override onReceive(event: unknown): void { seen.push(event as BrokerReconnectFailed); }
      })()),
      BrokerReconnectFailed,
    );
    // The cause on *this* event is not the one handed to `handleConnectionLost`
    // — it is whatever the last failed reconnect threw, which is why the
    // failure has to embed the endpoint rather than the initial loss.  Written
    // the other way round the assertion held against the unfixed tree, because
    // the credential-bearing error was never the one published.
    const { brokerReady } = spawnFake(sys, {
      endpoint: dsn,
      reconnect: { initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 1 },
    }, (broker) => {
      broker.failNextConnects = 5;
      broker.connectFailureEmbedsEndpoint = true;
    });
    const broker = await brokerReady;

    broker.publicSimulateLossWith(new Error('connection reset'));

    await awaitCondition(() => seen.length >= 1, { timeoutMs: 4_000, label: 'BrokerReconnectFailed' });
    expect(seen[0]!.cause.message).toContain('amqp://***@rabbit:5672');
    expect(seen[0]!.cause.message).not.toContain('hunter2');
    expect(seen[0]!.endpoint).not.toContain('hunter2');
    await sys.terminate();
  });
});
