/**
 * Read-idle deadline and connect deadline on `BrokerActor` (#753).
 *
 * Every client subclass used to treat an explicit transport event — `close`,
 * `error`, a stream's `done` — as the only way a connection could end.  A peer
 * that vanishes without FIN/RST produces none of them, so the actor stayed
 * `connected` forever and the reconnect machinery, which is only ever entered
 * through `handleConnectionLost`, never ran.  These tests pin the two clocks
 * that now exist: one on inbound silence, one on a connect that never settles.
 *
 * The scheduler is the seam.  Both deadlines go through
 * `scheduleOnceFunction`, so a scheduler that records what was armed — and
 * whether it was cancelled — asserts the arming, the re-arming and the
 * teardown without waiting on wall-clock time.  Only the tests that need a
 * deadline to actually *elapse* use a real (very short) one.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import { createTestActorSystem } from '../../../util/TestActorSystem.js';
import { Actor } from '../../../../src/Actor.js';
import type { Config } from '../../../../src/config/Config.js';
import { LogLevel, type Logger } from '../../../../src/Logger.js';
import { Scheduler, type Cancellable } from '../../../../src/Scheduler.js';
import { BrokerActor, type OutboundEnvelope } from '../../../../src/io/broker/BrokerActor.js';
import { BrokerDisconnected } from '../../../../src/io/broker/BrokerEvents.js';
import type { BrokerCommonOptionsType } from '../../../../src/io/broker/BrokerOptions.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/**
 * The window in which one *too many* of something would show up.  A poll
 * returns on the event that satisfies it, so "nothing was armed" needs a beat
 * of stillness rather than a poll.
 */
const SETTLE_MS = 30;

type IdleOptions = BrokerCommonOptionsType & {
  readonly endpoint?: string;
  readonly idleTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
};

/** One armed one-shot, plus whether the broker later cancelled it. */
type ArmedTask = {
  readonly delayMs: number;
  readonly task: () => void;
  cancelled: boolean;
};

/**
 * Records every one-shot the system arms and whether it was cancelled, while
 * still scheduling it for real.
 *
 * Wrapping the `Cancellable` rather than only counting delays is what lets a
 * test assert that `postStop` *disarmed* the deadline: a stopped actor also
 * refuses to act on a fired one, so a test that checked only for the absence
 * of a disconnect would pass against a timer that outlives the actor.
 */
class DrivableScheduler extends Scheduler {
  readonly armed: ArmedTask[] = [];

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    const inner = super.scheduleOnceFunction(delayMs, task);
    const entry: ArmedTask = { delayMs, task, cancelled: false };
    this.armed.push(entry);
    return {
      cancel: (): boolean => { entry.cancelled = true; return inner.cancel(); },
      get isCancelled(): boolean { return inner.isCancelled; },
    };
  }

  /** The most recently armed task, or a failure naming the empty schedule. */
  last(): ArmedTask {
    const entry = this.armed[this.armed.length - 1];
    if (!entry) throw new Error('no one-shot has been armed');
    return entry;
  }

  /** Run the most recently armed task now, without waiting out its delay. */
  fireLast(): void { this.last().task(); }
}

/** Collects warn records so a test can assert a failure was *reported*. */
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

/**
 * A broker whose connect can be parked and whose inbound activity the test
 * drives by hand — the two things a real transport does that the deadlines
 * watch.
 */
class IdleBroker extends BrokerActor<IdleOptions, never, string> {
  connectAttempts = 0;
  /** Every cause `abortConnectAttempt` was handed, in order. */
  readonly aborts: string[] = [];
  firstConnectSettled = false;
  /** When true, `connectImplementation` parks until released or aborted. */
  parkConnect = false;
  /** Whether this subclass can actually abort — `false` exercises the base hook. */
  private readonly abortable: boolean;
  private resolveParkedConnect: (() => void) | null = null;
  private rejectParkedConnect: ((cause: Error) => void) | null = null;

  constructor(options: Partial<IdleOptions> = {}, abortable = true) {
    super(options);
    this.abortable = abortable;
  }

  protected configKey(): string { return 'actor-ts.io.broker.idle-fake'; }
  protected builtInDefaultOptions(): Partial<IdleOptions> { return {}; }
  protected readOptionsFromConfig(_config: Config): Partial<IdleOptions> { return {}; }
  protected requiredOptions(): ReadonlyArray<keyof IdleOptions> { return ['endpoint']; }
  protected endpointLabel(): string { return this.options.endpoint ?? '<none>'; }

  protected override idleTimeoutMs(): number | undefined { return this.options.idleTimeoutMs; }
  protected override connectTimeoutMs(): number | undefined { return this.options.connectTimeoutMs; }

  protected override abortConnectAttempt(cause: Error): void {
    this.aborts.push(cause.message);
    // The unabortable variant delegates to the base implementation — the one
    // that warns instead of quietly doing nothing.
    if (!this.abortable) { super.abortConnectAttempt(cause); return; }
    const reject = this.rejectParkedConnect;
    this.rejectParkedConnect = null;
    this.resolveParkedConnect = null;
    reject?.(cause);
  }

  protected async connectImplementation(): Promise<void> {
    this.connectAttempts++;
    if (!this.parkConnect) return;
    await new Promise<void>((resolve, reject) => {
      this.resolveParkedConnect = resolve;
      this.rejectParkedConnect = reject;
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    this.resolveParkedConnect = null;
    this.rejectParkedConnect = null;
  }

  protected async dispatchOutgoing(_envelope: OutboundEnvelope<string>): Promise<void> {}

  protected override onCommand(_command: never): void {}

  override async preStart(): Promise<void> {
    try { await super.preStart(); }
    finally { this.firstConnectSettled = true; }
  }

  /* -------------------------- test surface --------------------------- */

  publicNoteInbound(): void { this.noteInboundActivity(); }
  publicConnectionState(): string { return this.connectionState; }
  publicSimulateLoss(): void { this.handleConnectionLost(new Error('simulated loss')); }

  /**
   * Let a parked connect finish.  A test that leaves one parked would hang
   * `terminate()`: the stop queues behind a `preStart` that never returns.
   */
  releaseConnect(): void {
    this.parkConnect = false;
    const resolve = this.resolveParkedConnect;
    this.resolveParkedConnect = null;
    this.rejectParkedConnect = null;
    resolve?.();
  }
}

/** A subclass with a connect deadline but no way to abort — the warning path. */
class UnabortableBroker extends IdleBroker {
  constructor(options: Partial<IdleOptions> = {}) { super(options, false); }
}

function spawnBroker<B extends IdleBroker>(
  system: ActorSystem,
  make: () => B,
  configure: (broker: B) => void = () => {},
): Promise<B> {
  let resolve!: (broker: B) => void;
  const ready = new Promise<B>((r) => { resolve = r; });
  system.spawnAnonymous(() => {
    const broker = make();
    configure(broker);
    resolve(broker);
    return broker as unknown as Actor<never>;
  });
  return ready;
}

/** Wait for `preStart`'s first connect attempt to settle, either way. */
function awaitFirstConnect(broker: IdleBroker): Promise<void> {
  return awaitCondition(() => broker.firstConnectSettled, {
    timeoutMs: 4_000, label: "the broker's first connect attempt settled",
  });
}

/** Records every `BrokerDisconnected` cause, so a test can name the reason. */
function collectDisconnectCauses(system: ActorSystem): string[] {
  const causes: string[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(message: unknown): void {
        causes.push((message as BrokerDisconnected).cause?.message ?? '<no cause>');
      }
    })()),
    BrokerDisconnected,
  );
  return causes;
}

/* --------------------------- read-idle deadline ------------------------- */

describe('BrokerActor — read-idle deadline (#753)', () => {
  test('inbound silence past the deadline reports the loss and reconnects', async () => {
    const system = createTestActorSystem({ name: 'idle-expire' });
    const causes = collectDisconnectCauses(system);
    const broker = await spawnBroker(system, () => new IdleBroker({
      endpoint: 'silent.local',
      idleTimeoutMs: 20,
      reconnect: { initialDelayMs: 5, maxDelayMs: 5, randomFactor: 0 },
    }));
    await awaitFirstConnect(broker);
    expect(broker.publicConnectionState()).toBe('connected');

    // Nothing ever calls noteInboundActivity — which is exactly a peer that
    // has vanished without saying so.
    await awaitCondition(() => causes.length > 0, {
      timeoutMs: 4_000, label: 'the idle deadline reported the connection lost',
    });
    expect(causes[0]).toContain('idle timeout');
    expect(causes[0]).toContain('silent.local');

    // The point of routing through handleConnectionLost: the reconnect
    // machinery runs, rather than the actor sitting on a dead connection.
    await awaitCondition(() => broker.connectAttempts >= 2, {
      timeoutMs: 4_000, label: 'the idle timeout started a reconnect cycle',
    });
    await system.terminate();
  });

  test('inbound activity re-arms the deadline instead of taking the connection down', async () => {
    const scheduler = new DrivableScheduler();
    const system = createTestActorSystem({ name: 'idle-refresh', scheduler });
    const causes = collectDisconnectCauses(system);
    const baseline = scheduler.armed.length;
    // Long enough that the real timer cannot fire during the test — the firing
    // is done by hand, so what is asserted is the callback's decision.
    const broker = await spawnBroker(system, () => new IdleBroker({
      endpoint: 'busy.local', idleTimeoutMs: 60_000, reconnect: false,
    }));
    await awaitFirstConnect(broker);
    expect(scheduler.armed.length).toBe(baseline + 1);
    expect(scheduler.last().delayMs).toBe(60_000);

    broker.publicNoteInbound();
    scheduler.fireLast();

    // Re-armed for the remainder rather than declaring the peer gone.
    expect(causes).toEqual([]);
    expect(broker.publicConnectionState()).toBe('connected');
    expect(scheduler.armed.length).toBe(baseline + 2);
    expect(scheduler.last().delayMs).toBeGreaterThan(0);
    expect(scheduler.last().delayMs).toBeLessThanOrEqual(60_000);
    await system.terminate();
  });

  test('a broker that declares no idle timeout arms nothing', async () => {
    const scheduler = new DrivableScheduler();
    const system = createTestActorSystem({ name: 'idle-off', scheduler });
    const baseline = scheduler.armed.length;
    const broker = await spawnBroker(system, () => new IdleBroker({
      endpoint: 'quiet.local', reconnect: false,
    }));
    await awaitFirstConnect(broker);
    // A successful connect with reconnect off schedules nothing of its own, so
    // a one-shot armed here could only be the deadline.
    await sleep(SETTLE_MS);
    expect(scheduler.armed.length).toBe(baseline);
    await system.terminate();
  });

  test('a loss reported by the transport disarms the deadline', async () => {
    const scheduler = new DrivableScheduler();
    const system = createTestActorSystem({ name: 'idle-dropped', scheduler });
    const baseline = scheduler.armed.length;
    const broker = await spawnBroker(system, () => new IdleBroker({
      endpoint: 'dropped.local', idleTimeoutMs: 60_000, reconnect: false,
    }));
    await awaitFirstConnect(broker);
    const deadline = scheduler.armed[baseline]!;

    // A subclass can report a loss without any teardown — `dropConnection` on
    // TcpSocketActor's framing-cap path is exactly that — so the disarm cannot
    // wait for `_closeTransport`, which under `reconnect: false` only runs at
    // `postStop`.
    broker.publicSimulateLoss();

    expect(deadline.cancelled).toBe(true);
    expect(broker.publicConnectionState()).toBe('disconnected');
    await system.terminate();
  });

  test('stopping the actor disarms the deadline', async () => {
    const scheduler = new DrivableScheduler();
    const system = createTestActorSystem({ name: 'idle-stop', scheduler });
    const causes = collectDisconnectCauses(system);
    const broker = await spawnBroker(system, () => new IdleBroker({
      endpoint: 'stopped.local', idleTimeoutMs: 60_000, reconnect: false,
    }));
    await awaitFirstConnect(broker);
    const deadline = scheduler.last();
    expect(deadline.delayMs).toBe(60_000);

    await system.terminate();

    // Cancelled, not merely ignored: a stopped actor also refuses to act on a
    // fired deadline, so the absence of a disconnect alone would pass against
    // a timer that keeps the runtime's event loop alive for a minute.
    expect(deadline.cancelled).toBe(true);
    deadline.task();
    expect(causes).toEqual([]);
  });
});

/* ---------------------------- connect deadline -------------------------- */

describe('BrokerActor — connect deadline (#753)', () => {
  test('a connect that never settles is aborted and fails the attempt', async () => {
    const system = createTestActorSystem({ name: 'connect-deadline' });
    const broker = await spawnBroker(
      system,
      () => new IdleBroker({ endpoint: 'stalled.local', connectTimeoutMs: 20, reconnect: false }),
      (b) => { b.parkConnect = true; },
    );
    await awaitFirstConnect(broker);
    expect(broker.aborts.length).toBe(1);
    expect(broker.aborts[0]).toContain('did not complete within 20 ms');
    expect(broker.aborts[0]).toContain('stalled.local');
    expect(broker.publicConnectionState()).toBe('disconnected');
    await system.terminate();
  });

  test('a connect that completes in time is not aborted', async () => {
    const scheduler = new DrivableScheduler();
    const system = createTestActorSystem({ name: 'connect-in-time', scheduler });
    const baseline = scheduler.armed.length;
    const broker = await spawnBroker(system, () => new IdleBroker({
      endpoint: 'prompt.local', connectTimeoutMs: 60_000, reconnect: false,
    }));
    await awaitFirstConnect(broker);
    expect(broker.aborts).toEqual([]);
    expect(broker.publicConnectionState()).toBe('connected');
    // The handle is released as soon as the connect returns; leaving it armed
    // would hold the runtime's event loop open for a minute.
    expect(scheduler.armed.length).toBe(baseline + 1);
    expect(scheduler.armed[baseline]!.cancelled).toBe(true);
    await system.terminate();
  });

  test('a deadline nothing can act on is reported, not swallowed', async () => {
    const logger = new CapturingLogger();
    const system = createTestActorSystem({
      name: 'connect-unabortable', logger, logLevel: LogLevel.Warn,
    });
    const broker = await spawnBroker(
      system,
      () => new UnabortableBroker({ endpoint: 'deaf.local', connectTimeoutMs: 20, reconnect: false }),
      (b) => { b.parkConnect = true; },
    );
    await awaitCondition(
      () => logger.warnings.some((w) => w.includes('cannot abort an in-flight connect')),
      { timeoutMs: 4_000, label: 'the unabortable connect deadline was reported' },
    );
    // The attempt really does keep running — that is what the warning says,
    // and claiming otherwise is how #751 happened one interface over.
    expect(broker.firstConnectSettled).toBe(false);
    // Release it before terminating: a stop queued behind a preStart that
    // never returns would hang the whole suite.
    broker.releaseConnect();
    await awaitFirstConnect(broker);
    await system.terminate();
  });
});
