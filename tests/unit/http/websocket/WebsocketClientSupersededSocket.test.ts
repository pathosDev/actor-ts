/**
 * A `close` or `error` from a socket that has already been replaced must not
 * tear down the connection that replaced it — #1514.
 *
 * `onSocketDown` guarded only on `this.socket !== null`, and the `close` and
 * `error` listeners `connectImplementation` registers did not say which
 * socket they were speaking for.  So any late event from a *superseded*
 * socket was read as the current connection dropping: `onDisconnected` fired
 * a second time for a connection that was healthy, the socket that was
 * actually working was closed, and a third dial went out.
 *
 * The path that reaches it is the one `idleTimeoutMs` exists for (#753).
 * Against a blackholed peer the client's own `close()` cannot complete its
 * handshake — the peer is not there to answer it — so the runtime's `close`
 * or `error` arrives whenever TCP gives up, which can be long after the
 * reconnect has succeeded.  The fakes here model exactly that: `close()`
 * records the call and fires nothing, and the test fires the late event by
 * hand once the replacement socket is up.
 *
 * The same shape is reachable without an idle timeout at all, because a real
 * runtime fires `error` *and then* `close` for one drop; with a short
 * backoff the second can land after the reconnect.  Both orders are pinned.
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
 * The read deadline the first socket runs out of.  Small enough to keep the
 * test short, and the number every other timing here is sized against.
 */
const IDLE_TIMEOUT_MS = 100;

/** Backoff between the drop and the replacement socket. */
const RECONNECT_DELAY_MS = 5;

/**
 * How long the test watches for a teardown that must not happen.
 *
 * Bounded from both sides.  It has to exceed {@link RECONNECT_DELAY_MS} by
 * enough that a spurious reconnect would certainly have dialled — eight
 * times over — and it has to stay well inside the replacement socket's own
 * read deadline, which the test refreshes immediately before the wait so the
 * full {@link IDLE_TIMEOUT_MS} is available.  An absence cannot be polled
 * for: a predicate over a counter that is already 1 is satisfied on its
 * first poll.
 */
const LATE_EVENT_SETTLE_MS = 40;

/** Every `onDisconnected` cause the client under test reported, in order. */
const recordedDisconnects: string[] = [];

/**
 * A socket whose `close()` answers nothing — the blackholed peer.
 *
 * This is the difference between an observed drop and a deduced one.  After
 * a `close` *event* the socket is already gone and no further event follows;
 * after an idle timeout the client closes a socket that is still nominally
 * open, holding TCP to a peer that is not there, and the runtime's own
 * close/error lands whenever it gives up.  `close()` therefore records the
 * call and fires nothing; the test fires the late event itself, at the
 * moment that makes it late.
 */
class BlackholedSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  binaryType: 'blob' | 'arraybuffer' | 'nodebuffer' = 'blob';
  /** Every payload the actor handed to `send`, in order. */
  readonly sent: Array<string | Uint8Array> = [];
  /** How often the actor asked this socket to close. */
  closeCalls = 0;

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void { this.closeCalls++; }

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

/** A client that reconnects quickly and reports every disconnect it sees. */
class IdleProbeClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withIdleTimeoutMs(IDLE_TIMEOUT_MS)
      .withReconnect({
        initialDelayMs: RECONNECT_DELAY_MS,
        maxDelayMs: RECONNECT_DELAY_MS,
        randomFactor: 0,
        maxAttempts: 5,
      });
    super(clientOptions);
  }

  protected override onDisconnected(cause?: Error): void {
    recordedDisconnects.push(cause?.message ?? '<no cause>');
  }

  onMessage(_frame: WebsocketFrame): void {}
}

/** The same client without a read deadline, for the error-then-close order. */
class NoDeadlineProbeClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withReconnect({
        initialDelayMs: RECONNECT_DELAY_MS,
        maxDelayMs: RECONNECT_DELAY_MS,
        randomFactor: 0,
        maxAttempts: 5,
      });
    super(clientOptions);
  }

  protected override onDisconnected(cause?: Error): void {
    recordedDisconnects.push(cause?.message ?? '<no cause>');
  }

  onMessage(_frame: WebsocketFrame): void {}
}

type ProbeClientClass = new () => WebsocketClientActor<WebsocketFrame, WebsocketFrame>;

describe('WebsocketClientActor — a superseded socket (#1514)', () => {
  const systems: ActorSystem[] = [];

  beforeEach(() => {
    recordedDisconnects.length = 0;
  });

  afterEach(async () => {
    websocketClientConstructor.reset();
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  /** Spawns `clientClass` against a fresh `BlackholedSocket` per dial. */
  function dialingClient(name: string, clientClass: ProbeClientClass): BlackholedSocket[] {
    const sockets: BlackholedSocket[] = [];
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        const socket = new BlackholedSocket();
        sockets.push(socket);
        // The actor registers its 'open' listener after `create` returns, so
        // the handshake has to land on a later turn.
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const systemOptions = ActorSystemOptions.create()
      .withLogger(new RecordingLogger())
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create(name, systemOptions);
    systems.push(system);
    system.spawn(clientClass, 'client');
    return sockets;
  }

  test('a late close from the idled-out socket leaves the replacement alone', async () => {
    const sockets = dialingClient('ws-superseded-idle', IdleProbeClient);

    await awaitCondition(() => recordedDisconnects.length === 1, {
      timeoutMs: 4_000,
      label: 'the read deadline dropped the first socket',
    });
    await awaitCondition(() => sockets.length >= 2 && sockets[1]!.isOpen, {
      timeoutMs: 4_000,
      label: 'the client reconnected onto a second socket',
    });
    // The client asked socket 0 to close on the way out, and the peer is not
    // there to answer — which is the whole premise.
    expect(sockets[0]!.closeCalls).toBe(1);

    // TCP finally gives up on the first connection, long after it stopped
    // being the connection.
    sockets[0]!.fire('close');
    // One inbound frame on the live socket, so its own read deadline starts
    // from here and cannot expire inside the window below.
    sockets[1]!.fire('message', { data: 'the peer is still speaking' });

    // An absence, bounded on both sides — see LATE_EVENT_SETTLE_MS.
    await sleep(LATE_EVENT_SETTLE_MS);
    expect(recordedDisconnects).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.closeCalls).toBe(0);
  });

  test('a late error from the idled-out socket leaves the replacement alone', async () => {
    const sockets = dialingClient('ws-superseded-idle-error', IdleProbeClient);

    await awaitCondition(() => recordedDisconnects.length === 1, {
      timeoutMs: 4_000,
      label: 'the read deadline dropped the first socket',
    });
    await awaitCondition(() => sockets.length >= 2 && sockets[1]!.isOpen, {
      timeoutMs: 4_000,
      label: 'the client reconnected onto a second socket',
    });

    // Some runtimes report the give-up as `error` rather than `close`; both
    // listeners are registered on the same socket, so both need the guard.
    sockets[0]!.fire('error');
    sockets[1]!.fire('message', { data: 'the peer is still speaking' });

    // An absence, bounded on both sides — see LATE_EVENT_SETTLE_MS.
    await sleep(LATE_EVENT_SETTLE_MS);
    expect(recordedDisconnects).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.closeCalls).toBe(0);
  });

  /**
   * The same guard without a read deadline anywhere near it.
   *
   * A real `WebSocket` fires `error` and then `close` for one drop, and
   * `connectImplementation` registers a listener for each.  With a backoff
   * this short the reconnect completes between the two, so the ordinary
   * two-event drop of a plain connection reaches the same defect that the
   * blackholed-peer path does — no idle timeout required, and no timing
   * window to size.
   */
  test('the second of one drop\'s two events does not drop the reconnect', async () => {
    const sockets = dialingClient('ws-superseded-pair', NoDeadlineProbeClient);

    await awaitCondition(() => sockets.length >= 1 && sockets[0]!.isOpen, {
      timeoutMs: 4_000,
      label: 'the client opened its first socket',
    });
    sockets[0]!.fire('error');
    await awaitCondition(() => sockets.length >= 2 && sockets[1]!.isOpen, {
      timeoutMs: 4_000,
      label: 'the client reconnected onto a second socket',
    });

    // The `close` half of the same drop, arriving after the reconnect.
    sockets[0]!.fire('close');

    // An absence: a spurious teardown dials again after RECONNECT_DELAY_MS,
    // and there is no deadline here that could produce a third socket for
    // any other reason.
    await sleep(LATE_EVENT_SETTLE_MS);
    expect(recordedDisconnects).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.closeCalls).toBe(0);
  });
});
