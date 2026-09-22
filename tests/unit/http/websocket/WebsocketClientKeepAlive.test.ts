/**
 * The keepalive `pingIntervalMs` arms has to put bytes on the wire, or say
 * that it cannot — #751.
 *
 * Before this, `connectImplementation` armed
 * `setInterval(() => { try { ws.ping?.(); } catch {} }, ping)` unconditionally.
 * `ping()` is not part of the WHATWG `WebSocket` interface: it exists on Bun
 * and on neither Node nor Deno, so on two of the three supported runtimes the
 * optional call and the empty `catch` made that timer a guaranteed no-op — a
 * documented mitigation sending zero bytes, forever, silently.  The
 * consequence is the one the option exists to prevent: a middlebox drops its
 * conntrack entry, neither side is notified, `close`/`error` never fire, and
 * `BrokerActor` reports `connected` while every send goes nowhere.
 *
 * The ping timer had **no behavioural coverage at all** — the only test that
 * named `pingIntervalMs` was a validator rejection — which is how a feature
 * that sent nothing on two runtimes shipped and stayed.  These are the first.
 *
 * Both halves of the fix are pinned separately, because they fail
 * independently: the `keepAliveFrame()` hook (an application frame the
 * framework cannot invent for you), and the refusal to arm a timer that
 * provably sends nothing, with one warning in its place.
 *
 * The fake sockets model the measured runtimes rather than one of them:
 * {@link SilentSocket} has no `ping` at all (Node 26.7.0, Deno 2.6.8) and
 * {@link PingingSocket} has one (Bun 1.4.0).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../../src/Logger.js';
import { BrokerBufferOverflow } from '../../../../src/io/broker/BrokerEvents.js';
import { WebsocketClientActor } from '../../../../src/http/websocket/WebsocketClientActor.js';
import { WebsocketClientOptions } from '../../../../src/http/websocket/WebsocketClientOptions.js';
import { rawCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/Types.js';
import {
  websocketClientConstructor,
  type WebsocketClientConstructor,
  type WebsocketLike,
} from '../../../../src/http/websocket/WebsocketConstructor.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

/**
 * The keepalive period every client here is configured with.  Deliberately an
 * odd small number: {@link recordedKeepAliveTimers} identifies *our* timers by
 * their delay, and nothing else in the process schedules a 37 ms interval.
 */
const KEEP_ALIVE_INTERVAL_MS = 37;

/**
 * Long enough for five keepalive periods.  Used only where the assertion is an
 * **absence** — "no timer fired" cannot be polled for, since a predicate over
 * a counter that is already 0 is satisfied on its first poll.
 */
const FIVE_PERIODS_MS = KEEP_ALIVE_INTERVAL_MS * 5;

/**
 * The reconnect backoff {@link BufferProbeClient} waits out, sized at five
 * keepalive periods so that several ticks land *inside* the window between
 * the broker giving up on a socket and the reconnect tearing it down.  That
 * window is where #1514 lives: the transport is not closed there, so nothing
 * has cleared the keepalive timer yet.
 */
const RECONNECT_DELAY_MS = FIVE_PERIODS_MS;

/** Every `BrokerBufferOverflow` published while the running test is alive. */
const recordedOverflows: BrokerBufferOverflow[] = [];

/**
 * Every frame the framework pushed through `sendRaw` on behalf of
 * {@link SendRawWatchingClient}.
 *
 * Module-scoped rather than an instance field because a test here holds a
 * `ActorRef`, never the actor — and the claim being pinned is about which
 * method the framework calls, which the subclass can see from inside.
 */
const recordedRawSends: WebsocketFrame[] = [];

/**
 * Subscribes to `BrokerBufferOverflow` so an eviction from the resend buffer
 * is observable from outside the actor.  That event is the load-bearing
 * instrument for #1514: a heartbeat that takes a buffer slot is invisible on
 * the wire — the socket it was meant for is gone — and shows up only as
 * somebody else's message being evicted to make room for it.
 */
class OverflowRecorder extends Actor<BrokerBufferOverflow> {
  override onReceive(event: BrokerBufferOverflow): void { recordedOverflows.push(event); }
}

/** A WHATWG `WebSocket` as Node and Deno ship it: no `ping` method anywhere. */
class SilentSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  binaryType: 'blob' | 'arraybuffer' | 'nodebuffer' = 'blob';
  /** Every payload the actor handed to `send`, in order. */
  readonly sent: Array<string | Uint8Array> = [];

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void {}

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

/** Bun's socket: the same, plus the non-standard `ping()` control frame. */
class PingingSocket extends SilentSocket {
  pingCount = 0;
  ping(): void { this.pingCount++; }
}

/**
 * A socket that can refuse every payload — the only door into the state
 * #1514 is about.
 *
 * Every *other* way this client goes offline runs through `onSocketDown` or
 * `disconnectImplementation`, and both clear the keepalive timer on the way
 * past.  A `send` that throws does not: `BrokerActor._dispatchOne` catches
 * it, pushes the envelope back at the head of the resend buffer and calls
 * `handleConnectionLost`, which flips the state to `disconnected` and
 * schedules a reconnect without touching the transport.  For the length of
 * the backoff the actor is therefore offline while still holding a live
 * socket handle and a live keepalive timer.
 */
class RefusingSocket extends SilentSocket {
  /** Set while the socket must throw out of `send` instead of recording. */
  failSends = false;
  /** How often `send` was called while refusing. */
  refusedSends = 0;

  override send(data: string | Uint8Array): void {
    if (this.failSends) { this.refusedSends++; throw new Error('websocket send failed'); }
    super.send(data);
  }
}

/** A client that supplies no keepalive payload — the un-overridden default. */
class DefaultKeepAliveClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://user:secret@feed.example.com/ws?token=abc')
      .withCodec(rawCodec())
      .withPingIntervalMs(KEEP_ALIVE_INTERVAL_MS)
      .withReconnect(false);
    super(clientOptions);
  }

  onMessage(_frame: WebsocketFrame): void {}
}

/** The same client with the hook overridden — the documented remedy. */
class HeartbeatClient extends DefaultKeepAliveClient {
  protected override keepAliveFrame(): WebsocketFrame {
    return { kind: 'text', data: 'heartbeat' };
  }
}

/**
 * A heartbeat client that reports every `sendRaw` made on its behalf.
 *
 * This is the direct form of #1514's claim, and it holds whether or not a
 * particular timing window is reachable: a keepalive must not enter the
 * resend buffer's front door at all.  Gating the call on the connection
 * state instead — the near-miss fix — leaves `sendRaw` as the route and so
 * leaves the keepalive inheriting `sendRaw`'s promises (buffer while
 * offline, replay after reconnect, take a bounded slot) and any override a
 * subclass gives it.  A tick lands on the socket or it does not happen.
 */
class SendRawWatchingClient extends DefaultKeepAliveClient {
  protected override keepAliveFrame(): WebsocketFrame {
    return { kind: 'text', data: 'heartbeat' };
  }

  protected override sendRaw(frame: WebsocketFrame): boolean {
    recordedRawSends.push(frame);
    return super.sendRaw(frame);
  }
}

/** A client with no keepalive configured at all. */
class NoKeepAliveClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withReconnect(false);
    super(clientOptions);
  }

  onMessage(_frame: WebsocketFrame): void {}
}

/**
 * The unsendable client again, but one that reconnects — the only shape in
 * which the warning's per-*actor* latch differs from a per-*connection* one.
 *
 * Jitter off and a 5 ms delay so the second connect lands inside the same
 * `awaitCondition` budget every other test here uses; two attempts, because
 * the test drops exactly one connection.
 */
class ReconnectingKeepAliveClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withPingIntervalMs(KEEP_ALIVE_INTERVAL_MS)
      .withReconnect({ initialDelayMs: 5, maxDelayMs: 5, randomFactor: 0, maxAttempts: 3 });
    super(clientOptions);
  }

  onMessage(_frame: WebsocketFrame): void {}
}

/**
 * A heartbeat client sized to make one buffer slot contested: it reconnects
 * after {@link RECONNECT_DELAY_MS}, buffers exactly one outbound message, and
 * enqueues exactly one application message on its first connection.
 *
 * `outboundBuffer(1)` is the whole point.  The resend buffer is a bounded,
 * FIFO-evicting queue of messages the application asked to send, and the
 * question #1514 asks is whether a keepalive may compete for a slot in it.
 * With one slot the answer is visible in a single `BrokerBufferOverflow`
 * rather than in an arithmetic argument about a default of a thousand.
 */
class BufferProbeClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  private connects = 0;

  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withPingIntervalMs(KEEP_ALIVE_INTERVAL_MS)
      .withOutboundBuffer(1)
      .withReconnect({
        initialDelayMs: RECONNECT_DELAY_MS,
        maxDelayMs: RECONNECT_DELAY_MS,
        randomFactor: 0,
        maxAttempts: 3,
      });
    super(clientOptions);
  }

  protected override keepAliveFrame(): WebsocketFrame {
    return { kind: 'text', data: 'heartbeat' };
  }

  protected override onConnected(): void {
    this.connects++;
    // First connection only.  The message has to be enqueued while the
    // refusing socket is still the live one, so that its rejection is what
    // puts the actor into the offline-with-armed-timer window; enqueuing it
    // again on the reconnect would make the replay assertion meaningless.
    if (this.connects === 1) this.send({ kind: 'text', data: 'application-message' });
  }

  onMessage(_frame: WebsocketFrame): void {}
}

type ClientClass = new () => WebsocketClientActor<WebsocketFrame, WebsocketFrame>;

describe('WebsocketClientActor — keepalive (#751)', () => {
  const systems: ActorSystem[] = [];
  /** Delays of every interval scheduled while a test is running. */
  let scheduledDelays: number[] = [];
  /** How often a keepalive interval's handler has actually run. */
  let keepAliveTicks = 0;
  let nativeSetInterval: typeof globalThis.setInterval;

  /**
   * Intervals this suite's clients armed, told apart from the rest of the
   * process by their period.  This is what pins "arm nothing" as *nothing*:
   * an absence of sends alone cannot distinguish a timer that was never
   * created from one that fires and does nothing, and the second is the
   * defect — it is what convinces an operator the connection is kept warm.
   */
  const recordedKeepAliveTimers = (): number[] =>
    scheduledDelays.filter((delay) => delay === KEEP_ALIVE_INTERVAL_MS);

  /**
   * The wrapper counts **ticks**, not sends, and that distinction is the
   * whole of `#1508`'s finding about the stop-on-drop test below.  A
   * keepalive that reaches the socket is observable as a `sent` entry, but a
   * keepalive that *fires and does nothing* — the state a stale timer is in
   * once its socket is gone — reaches nothing and is invisible from the
   * socket's side.  Counting at the timer boundary is the only instrument
   * here that separates "the timer was cleared" from "the timer still runs
   * and every tick returns early", and those are the two hypotheses the test
   * has to tell apart.
   */
  beforeEach(() => {
    scheduledDelays = [];
    keepAliveTicks = 0;
    recordedOverflows.length = 0;
    recordedRawSends.length = 0;
    nativeSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof delay === 'number') scheduledDelays.push(delay);
      const counted = delay === KEEP_ALIVE_INTERVAL_MS && typeof handler === 'function'
        ? (...handlerArgs: unknown[]): unknown => { keepAliveTicks++; return handler(...handlerArgs); }
        : handler;
      return (nativeSetInterval as (...a: unknown[]) => unknown)(counted, delay, ...args);
    }) as typeof globalThis.setInterval;
  });

  afterEach(async () => {
    globalThis.setInterval = nativeSetInterval;
    websocketClientConstructor.reset();
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  /** Spawns `clientClass` against `socket`; resolves once the socket is open. */
  async function connectedClient(
    name: string,
    socket: SilentSocket,
    clientClass: ClientClass,
  ): Promise<RecordingLogger> {
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        // The actor registers its 'open' listener after `create` returns, so
        // the handshake has to land on a later turn.
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create(name, systemOptions);
    systems.push(system);
    system.spawn(clientClass, 'client');

    await awaitCondition(() => socket.isOpen, {
      timeoutMs: 4_000,
      label: 'the client actor opened its socket',
    });
    return log;
  }

  const keepAliveWarnings = (log: RecordingLogger): string[] =>
    log.records.filter((record) => record.message.includes('pingIntervalMs is set'))
      .map((record) => record.message);

  test('no native ping() and no keepAliveFrame() override → no timer is armed', async () => {
    const socket = new SilentSocket();
    const log = await connectedClient('ws-keepalive-unsendable', socket, DefaultKeepAliveClient);

    // An absence: five periods is long enough that a timer would have fired,
    // and there is no state to poll for a thing that must never happen.
    await sleep(FIVE_PERIODS_MS);

    expect(recordedKeepAliveTimers()).toEqual([]);
    expect(socket.sent).toEqual([]);
    expect(keepAliveWarnings(log).length).toBe(1);
  });

  test('the warning names both remedies and redacts the endpoint', async () => {
    const socket = new SilentSocket();
    const log = await connectedClient('ws-keepalive-warning', socket, DefaultKeepAliveClient);

    await awaitCondition(() => keepAliveWarnings(log).length === 1, {
      timeoutMs: 4_000,
      label: 'the unsendable-keepalive warning was logged',
    });
    const [warning] = keepAliveWarnings(log);
    // Actionable, not merely diagnostic: the operator who set the interval
    // wanted a keepalive, so both ways to get one belong in the line saying
    // they have not got one.
    expect(warning).toContain(`${KEEP_ALIVE_INTERVAL_MS} ms`);
    expect(warning).toContain('keepAliveFrame()');
    expect(warning).toContain('idleTimeoutMs');
    // The line is written at a peer's prompting, so it carries the same
    // redacted label the oversize-frame warning does — never the userinfo or
    // the `?token=` a WebSocket endpoint is commonly authenticated with.
    expect(warning).toContain('feed.example.com/ws');
    expect(warning).not.toContain('secret');
    expect(warning).not.toContain('token=abc');
  });

  test('an overridden keepAliveFrame() reaches the wire on a runtime with no ping()', async () => {
    const socket = new SilentSocket();
    const log = await connectedClient('ws-keepalive-hook', socket, HeartbeatClient);

    // The whole point of the hook: Node and Deno are exactly where the old
    // timer sent nothing, so that is where the replacement has to send.
    await awaitCondition(() => socket.sent.length >= 2, {
      timeoutMs: 4_000,
      label: 'two application keepalive frames reached the socket',
    });
    expect(socket.sent.slice(0, 2)).toEqual(['heartbeat', 'heartbeat']);
    expect(recordedKeepAliveTimers()).toEqual([KEEP_ALIVE_INTERVAL_MS]);
    expect(keepAliveWarnings(log)).toEqual([]);
  });

  test('a runtime that has ping() still gets one, and no warning', async () => {
    const socket = new PingingSocket();
    const log = await connectedClient('ws-keepalive-native-ping', socket, DefaultKeepAliveClient);

    await awaitCondition(() => socket.pingCount >= 2, {
      timeoutMs: 4_000,
      label: 'the native ping fired twice',
    });
    expect(recordedKeepAliveTimers()).toEqual([KEEP_ALIVE_INTERVAL_MS]);
    expect(keepAliveWarnings(log)).toEqual([]);
    // A control frame is not a message: nothing should reach `send`.
    expect(socket.sent).toEqual([]);
  });

  test('no pingIntervalMs → neither a timer nor a warning', async () => {
    const socket = new SilentSocket();
    const log = await connectedClient('ws-keepalive-unconfigured', socket, NoKeepAliveClient);

    // Another absence, and the one that keeps the warning from becoming noise
    // every client sees: it belongs only to a keepalive that was asked for.
    await sleep(FIVE_PERIODS_MS);

    expect(recordedKeepAliveTimers()).toEqual([]);
    expect(log.records.filter((record) => record.message.includes('keepAliveFrame'))).toEqual([]);
  });

  /**
   * The assertion is on the **timer**, not on the socket — #1508.
   *
   * This test used to check only that `socket.sent` stopped growing, and that
   * is satisfied by machinery that has nothing to do with the timer: once
   * `onSocketDown` has nulled `this.socket`, a tick reaches no socket whether
   * the interval was cleared or not.  Measured: deleting the `clearInterval`
   * from `onSocketDown` left the old body green while the timer went on
   * firing four more times in the same window.  A dropped connection keeping
   * a wake-up per period forever is exactly the leak the comment claimed to
   * pin, so the count that goes flat has to be the tick count.
   */
  test('the keepalive stops when the connection drops', async () => {
    const socket = new SilentSocket();
    await connectedClient('ws-keepalive-stops', socket, HeartbeatClient);

    await awaitCondition(() => socket.sent.length >= 1, {
      timeoutMs: 4_000,
      label: 'the first keepalive frame reached the socket',
    });
    socket.fire('close');
    const ticksAtClose = keepAliveTicks;
    const sentAtClose = socket.sent.length;

    // An absence again: five periods is long enough that a surviving timer
    // would have woken several times, and a counter that is already flat
    // cannot be polled for.
    await sleep(FIVE_PERIODS_MS);
    expect(keepAliveTicks).toBe(ticksAtClose);
    // Kept beside it rather than replaced: the wire staying quiet is still
    // the user-visible half, it just does not imply the half above.
    expect(socket.sent.length).toBe(sentAtClose);
  });

  /**
   * The warning latches **per actor**, not per connection.
   *
   * Every other client in this file is `withReconnect(false)` and connects
   * exactly once, so `toBe(1)` there is satisfied whether the latch is per
   * actor, per connection, or absent entirely.  This is the shape that tells
   * them apart, and the reasoning the latch rests on is what makes per-actor
   * the right scope: neither input to the verdict — the runtime's `WebSocket`
   * and this class's own `keepAliveFrame` override — can change across a
   * reconnect, so a per-connection latch would repeat one unchanging sentence
   * once per reconnect, forever, on exactly the deployment (a flapping link)
   * that can least afford the noise.
   *
   * Contrast {@link WebsocketClientActor}'s *other* latch,
   * `unrecognisedFrameWarned`, which `connectImplementation` resets on every
   * open: a payload shape is a property of what the peer sends, and that can
   * change across a reconnect.  Two latches, opposite scopes, each matching
   * what its verdict depends on.
   */
  test('the unsendable warning is emitted once per actor, not once per connection', async () => {
    const sockets: SilentSocket[] = [];
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        const socket = new SilentSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('ws-keepalive-reconnect', systemOptions);
    systems.push(system);
    system.spawn(ReconnectingKeepAliveClient, 'client');

    await awaitCondition(() => keepAliveWarnings(log).length === 1, {
      timeoutMs: 4_000,
      label: 'the first connection warned that its keepalive cannot send',
    });

    // Drop it.  `armKeepAlive` runs again on the next open, and the verdict it
    // reaches is identical — which is exactly when a per-connection latch
    // would write the same line a second time.
    sockets[0]!.fire('close');
    await awaitCondition(() => sockets.length >= 2 && sockets[1]!.isOpen, {
      timeoutMs: 4_000,
      label: 'the client reconnected onto a second socket',
    });

    // Poll-free: the reconnect has already happened, so a second line would
    // already be in the log.  Five periods of slack in case the warning is
    // written on a later turn than the open listener.
    await sleep(FIVE_PERIODS_MS);
    expect(keepAliveWarnings(log)).toHaveLength(1);
    // The second connection is genuinely unsendable too, so the assertion
    // above is about the latch and not about a keepalive that started
    // working: no timer was armed on either socket.
    expect(recordedKeepAliveTimers()).toEqual([]);
    expect(sockets[1]!.sent).toEqual([]);
  });

  /**
   * A keepalive belongs to one socket and must never reach the resend
   * buffer — #1514.
   *
   * The buffer is the application's: messages it asked to send while the
   * connection was down, replayed in order once the next one is up.  A
   * heartbeat has no business in it on either count.  It is *addressed to a
   * socket*, so replaying it onto the next one sends a keepalive for a
   * connection that no longer exists, measured against a period that already
   * elapsed; and it competes for a bounded slot, so on a full buffer it
   * evicts an application message to make room for itself.
   *
   * Reached through the one path that leaves the timer armed while the
   * broker is offline — see {@link RefusingSocket}.  Before the fix the
   * window produced four evictions with `outboundBuffer(1)`, the application
   * message was gone, and the second socket's first frame was a stale
   * `heartbeat`.
   */
  test('a keepalive tick never takes a slot in the resend buffer', async () => {
    const sockets: RefusingSocket[] = [];
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        const socket = new RefusingSocket();
        // Only the first socket refuses.  The second has to accept the
        // drain, because what the drain delivers is the assertion.
        socket.failSends = sockets.length === 0;
        sockets.push(socket);
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('ws-keepalive-buffer', systemOptions);
    systems.push(system);
    system.eventStream.subscribe(system.spawnAnonymous(OverflowRecorder), BrokerBufferOverflow);
    system.spawn(BufferProbeClient, 'client');

    // The rejected application message is what opens the window: the broker
    // unshifts it and goes `disconnected` without tearing the transport down.
    await awaitCondition(() => sockets[0]?.refusedSends === 1, {
      timeoutMs: 4_000,
      label: 'the first socket refused the application message',
    });

    await awaitCondition(() => sockets.length >= 2 && sockets[1]!.isOpen, {
      timeoutMs: 4_000,
      label: 'the client reconnected onto a second socket',
    });
    await awaitCondition(() => sockets[1]!.sent.length >= 1, {
      timeoutMs: 4_000,
      label: 'the reconnect drained the resend buffer onto the second socket',
    });

    // The keepalive fired throughout the backoff window — this is not a test
    // of a timer that happened to be idle.
    expect(keepAliveTicks).toBeGreaterThanOrEqual(2);
    // Nothing was ever evicted, so nothing ever competed for the one slot.
    expect(recordedOverflows).toEqual([]);
    // And the slot still holds what the application put in it: the first
    // frame on the new socket is the message, not a heartbeat from the old
    // connection, and the message survived rather than being evicted.
    expect(sockets[1]!.sent[0]).toBe('application-message');
    expect(sockets[1]!.sent.filter((data) => data === 'application-message')).toHaveLength(1);
  });

  /**
   * The same decision stated where it cannot depend on a timing window —
   * #1514.
   *
   * The test above reaches the buffer through the one path that leaves a
   * keepalive timer armed on a socket the broker has given up on, and that
   * path is narrow: a near-miss fix that only checked
   * `connectionState === 'connected'`, and still went through `sendRaw`,
   * passed it.  It should not have.  `sendRaw` is the resend buffer's front
   * door, with the promises that go with it — buffer while offline, replay
   * after reconnect, occupy a bounded slot — plus whatever a subclass makes
   * of it, since it is `protected`.  A keepalive wants none of those, so the
   * pin is the absence of the call itself.
   */
  test('a keepalive frame never goes through sendRaw()', async () => {
    const socket = new SilentSocket();
    await connectedClient('ws-keepalive-direct-send', socket, SendRawWatchingClient);

    await awaitCondition(() => socket.sent.length >= 2, {
      timeoutMs: 4_000,
      label: 'two keepalive frames reached the socket',
    });
    expect(socket.sent.slice(0, 2)).toEqual(['heartbeat', 'heartbeat']);
    // Both frames reached the wire, and neither was handed to the buffer's
    // entry point on the way.
    expect(recordedRawSends).toEqual([]);
  });
});
