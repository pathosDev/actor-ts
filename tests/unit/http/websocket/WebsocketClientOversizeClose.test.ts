/**
 * An oversize inbound frame is a hard stop, not a drop (#750).
 *
 * The client cannot stop the allocation: by the time `maxFrameBytes` is
 * checked the runtime has already reassembled the payload, and no supported
 * runtime's native `WebSocket` honours a payload limit handed to its
 * constructor (measured on Bun 1.4.0, Node 26.7.0 and Deno 2.6.8 — see
 * `WebsocketConstructor.ts`).  What it *can* stop is the repeat: the old bare
 * `return` left the socket open, so one hostile peer could spend the same heap
 * again for every frame it felt like sending, on a single connection.
 *
 * So these tests are about the *second* frame's worth of damage, and they pin
 * three separable things a weaker fix would miss:
 *
 *   - the close carries **1009** ("Message Too Big"), not some other code;
 *   - the actor actually re-dials, i.e. it entered the reconnect cycle rather
 *     than closing a socket and sitting on a connection it thinks is live;
 *   - the breach routes through `onSocketDown`, not `handleConnectionLost`
 *     bare.  This is the one that is easy to get wrong and invisible in a
 *     "did close get called" assertion: going straight to
 *     `handleConnectionLost` reconnects just as convincingly while leaving
 *     `this.socket` non-null and the ping timer running.  Pinned by the
 *     `onDisconnected` hook (told only from `onSocketDown`) and by pings
 *     stopping.
 *
 * Driven through a fake socket, like the #592 warning suite next door: the
 * size branch sits in `handleInbound` before the codec, so a real round-trip
 * would have to push a megabyte through a backend to reach one `if`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../../src/Logger.js';
import { WebsocketClientActor } from '../../../../src/http/websocket/WebsocketClientActor.js';
import { WebsocketClientOptions } from '../../../../src/http/websocket/WebsocketClientOptions.js';
import {
  websocketClientConstructor,
  type WebsocketClientConstructor,
  type WebsocketLike,
} from '../../../../src/http/websocket/WebsocketConstructor.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/** Every `close(code, reason)` the actor issued, in order. */
type CloseCall = { readonly code?: number; readonly reason?: string };

/**
 * Enough of a socket for `connectImplementation`, plus the two things this
 * suite reads that the #592 fake does not: the arguments `close` was given,
 * and how many keep-alive pings have been sent since.
 */
class RecordingSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly closeCalls: CloseCall[] = [];
  pingCount = 0;

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(_data: string | Uint8Array): void {}
  close(code?: number, reason?: string): void { this.closeCalls.push({ code, reason }); }
  ping(): void { this.pingCount++; }

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

const CAP_BYTES = 8;
const OVERSIZE = 'x'.repeat(64);

/** Records the disconnect cause so the test can prove which path produced it. */
class ProbeClient extends WebsocketClientActor<string, string> {
  static readonly disconnects: Array<string | undefined> = [];

  onMessage(_message: string): void {}
  protected override onDisconnected(cause?: Error): void {
    ProbeClient.disconnects.push(cause?.message);
  }
}

/** Reconnecting variant — fast, unjittered, so the re-dial is deterministic. */
class ReconnectingClient extends ProbeClient {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<string, string>()
      .withUrl('ws://feed.example.com/ws')
      .withMaxFrameBytes(CAP_BYTES)
      .withReconnect({ initialDelayMs: 10, maxDelayMs: 10, factor: 1, randomFactor: 0 });
    super(clientOptions);
  }
}

/**
 * One-shot variant.  Reconnect is off so the ping assertion has a quiet window
 * to observe: a re-dial would arm a *fresh* timer on the same fake socket and
 * the counter would climb again for a reason that says nothing about #750.
 */
class OneShotClient extends ProbeClient {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<string, string>()
      .withUrl('ws://feed.example.com/ws')
      .withMaxFrameBytes(CAP_BYTES)
      .withPingIntervalMs(10)
      .withReconnect(false);
    super(clientOptions);
  }
}

describe('WebsocketClientActor — oversize inbound frame is a hard stop (#750)', () => {
  const systems: ActorSystem[] = [];

  afterEach(async () => {
    websocketClientConstructor.reset();
    ProbeClient.disconnects.length = 0;
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  /**
   * Spawns `actorClass` against one fake socket reused across dials, and
   * resolves once the first connection is open.  `dials` counts every trip
   * through the constructor, which is what makes "it re-dialled" observable.
   */
  async function connectedClient(
    name: string,
    actorClass: new () => ProbeClient,
  ): Promise<{ socket: RecordingSocket; dials: () => number }> {
    const socket = new RecordingSocket();
    let dials = 0;
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        dials++;
        // The actor registers its 'open' listener after `create` returns, so
        // the handshake has to land on a later turn.
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const systemOptions = ActorSystemOptions.create()
      .withLogLevel(LogLevel.Error);
    const system = ActorSystem.create(name, systemOptions);
    systems.push(system);
    system.spawn(actorClass, 'client');

    await awaitCondition(() => socket.isOpen, {
      timeoutMs: 4_000,
      label: 'the client actor opened its socket',
    });
    return { socket, dials: () => dials };
  }

  test('closes the connection with 1009 "Message Too Big"', async () => {
    const { socket } = await connectedClient('ws-oversize-close', ReconnectingClient);
    socket.fire('message', { data: OVERSIZE });

    await awaitCondition(() => socket.closeCalls.length > 0, {
      timeoutMs: 4_000,
      label: 'the client closed the socket on the oversize frame',
    });
    // The specific code, not merely "close was called": 1009 is what tells the
    // peer the frame was too big rather than that we lost interest.
    expect(socket.closeCalls[0]).toEqual({ code: 1009, reason: 'message too big' });
  });

  test('enters the reconnect cycle rather than sitting on a dead socket', async () => {
    const { socket, dials } = await connectedClient('ws-oversize-redial', ReconnectingClient);
    expect(dials()).toBe(1);
    socket.fire('message', { data: OVERSIZE });

    // A second dial is the strongest available evidence that the breach was
    // routed into the connection-lost path: a fix that only called `close`
    // would leave the actor believing it was still connected forever.
    await awaitCondition(() => dials() >= 2, {
      timeoutMs: 4_000,
      label: 'the client re-dialled after the oversize close',
    });
  });

  test('runs the disconnect path, so the hook sees the oversize cause', async () => {
    const { socket } = await connectedClient('ws-oversize-hook', ReconnectingClient);
    socket.fire('message', { data: OVERSIZE });

    // `websocketClientDisconnected` is told from `onSocketDown` alone.  Calling
    // `handleConnectionLost` directly — which is literally what #750's own
    // suggested fix says — reconnects but never reaches this hook, and leaves
    // `this.socket` and the ping timer behind with it.
    await awaitCondition(() => ProbeClient.disconnects.length > 0, {
      timeoutMs: 4_000,
      label: 'the disconnect hook ran for the oversize frame',
    });
    expect(ProbeClient.disconnects[0]).toBe('oversize inbound frame');
  });

  test('stops the keep-alive pings with the connection it was measuring', async () => {
    const { socket } = await connectedClient('ws-oversize-ping', OneShotClient);
    await awaitCondition(() => socket.pingCount > 0, {
      timeoutMs: 4_000,
      label: 'the keep-alive ping timer started',
    });

    socket.fire('message', { data: OVERSIZE });
    await awaitCondition(() => socket.closeCalls.length > 0, {
      timeoutMs: 4_000,
      label: 'the client closed the socket on the oversize frame',
    });

    const settled = socket.pingCount;
    // An absence, so it cannot be polled: the window is what gives a surviving
    // timer time to tick.  At 10 ms a still-armed timer would fire ~15 times.
    await sleep(150);
    expect(socket.pingCount).toBe(settled);
  });

  test('a frame within the cap closes nothing', async () => {
    const { socket, dials } = await connectedClient('ws-oversize-under', ReconnectingClient);
    socket.fire('message', { data: '"ok"' });

    // The guard against the opposite defect — a fix that tears the connection
    // down on every frame would pass every assertion above.
    await sleep(150);
    expect(socket.closeCalls).toEqual([]);
    expect(dials()).toBe(1);
    expect(ProbeClient.disconnects).toEqual([]);
  });
});
