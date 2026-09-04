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
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../../src/Logger.js';
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

type ClientClass = new () => WebsocketClientActor<WebsocketFrame, WebsocketFrame>;

describe('WebsocketClientActor — keepalive (#751)', () => {
  const systems: ActorSystem[] = [];
  /** Delays of every interval scheduled while a test is running. */
  let scheduledDelays: number[] = [];
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

  beforeEach(() => {
    scheduledDelays = [];
    nativeSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof delay === 'number') scheduledDelays.push(delay);
      return (nativeSetInterval as (...a: unknown[]) => unknown)(handler, delay, ...args);
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

  test('the keepalive stops when the connection drops', async () => {
    const socket = new SilentSocket();
    await connectedClient('ws-keepalive-stops', socket, HeartbeatClient);

    await awaitCondition(() => socket.sent.length >= 1, {
      timeoutMs: 4_000,
      label: 'the first keepalive frame reached the socket',
    });
    socket.fire('close');
    const afterClose = socket.sent.length;

    // An absence again: the timer must not outlive the socket it was armed
    // for, or a dropped connection keeps a wake-up per period forever.
    await sleep(FIVE_PERIODS_MS);
    expect(socket.sent.length).toBe(afterClose);
  });
});
