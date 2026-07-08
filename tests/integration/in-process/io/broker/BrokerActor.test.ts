import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Props } from '../../../../../src/Props.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';
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

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

interface FakeOptions extends BrokerCommonOptionsType {
  readonly endpoint?: string;
  readonly tag?: string;
}

interface FakeCommand {
  kind: 'send' | 'subscribe' | 'unsubscribe' | 'fanOut' | 'simulate-loss';
  topic?: string;
  ref?: ActorRef<unknown>;
  payload?: string;
}

/**
 * Concrete subclass for tests — `connectImplementation` and `dispatchOutgoing`
 * are wired to mutable flags so the test can simulate failures.
 */
class FakeBroker extends BrokerActor<FakeOptions, FakeCommand, string> {
  connectAttempts = 0;
  disconnects = 0;
  dispatched: string[] = [];
  failNextConnects = 0;
  failNextDispatches = 0;

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
  }
  protected async disconnectImplementation(): Promise<void> {
    this.disconnects++;
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
  publicFanOut(topic: string, msg: unknown): void { this.fanOutToTopic(topic, msg); }
  publicSimulateLoss(): void { this.handleConnectionLost(new Error('simulated loss')); }
  publicConnectionState(): string { return this.connectionState; }
  publicBufferSize(): number { return this.outboundBufferSize; }
  publicSubscriberCount(topic: string): number { return this.subscriberCountForTopic(topic); }

  override onReceive(_cmd: FakeCommand): void { /* no-op — direct manipulation in tests */ }
}

class ProbeActor extends Actor<unknown> {
  received: unknown[] = [];
  override onReceive(m: unknown): void { this.received.push(m); }
}

function makeSystem(name = 'broker-test', config?: Record<string, unknown>): ActorSystem {
  // Thin wrapper around the shared `createTestActorSystem` helper.
  // Kept named `makeSystem` to match the per-file convention used by
  // existing tests; the test body's `makeSystem('foo')` calls don't
  // need to change as a result of the helper consolidation.
  return createTestActorSystem({ name, config });
}

/** Bypass `Props` to keep direct access to a captured FakeBroker. */
function spawnFake(
  sys: ActorSystem,
  options: Partial<FakeOptions> = {},
): { ref: ActorRef<FakeCommand>; brokerReady: Promise<FakeBroker> } {
  let resolve!: (b: FakeBroker) => void;
  const brokerReady = new Promise<FakeBroker>((r) => { resolve = r; });
  const ref = sys.spawnAnonymous(Props.create(() => {
    const b = new FakeBroker(options);
    resolve(b);
    return b as unknown as Actor<FakeCommand>;
  }));
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
    sys.spawnAnonymous(Props.create(() => {
      const b = new FakeBroker();  // no endpoint anywhere
      // Intercept preStart to capture the error.
      const orig = b.preStart.bind(b);
      b.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return b as unknown as Actor<FakeCommand>;
    }));
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
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connectedCount++; }
      })())),
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
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { disconnectedCount++; }
      })())),
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
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { reconnectAttempts++; }
      })())),
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
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { overflows++; }
      })())),
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
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { notConnected++; }
      })())),
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
      sys.spawn(Props.create(() => p as unknown as Actor<unknown>), `p${i}`),
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
    const probeRef = sys.spawnAnonymous(Props.create(() => probe as unknown as Actor<unknown>));
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
    const probeRef = sys.spawnAnonymous(Props.create(() => probe as unknown as Actor<unknown>));
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
});
