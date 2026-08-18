import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

// `wireConnection` builds the per-connection actor's factory lazily (the actor
// is only constructed when the hub spawns it), so with a stubbed hub we can
// exercise the admission cap without a real ActorSystem.
function fakeSocket() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    send() { /* noop */ },
    close(code?: number, reason?: string) { closes.push({ code, reason }); },
    setListeners() { /* noop */ },
    get readyState() { return 1 as const; },
  } as unknown as WebsocketSocketAdapter;
  return { socket, closes };
}

const request = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
} as HttpRequest;

function makeHub() {
  const tells: unknown[] = [];
  const hub = { tell: (m: unknown) => { tells.push(m); } } as never;
  return { hub, tells };
}

// security audit WS-5 — a route's connection admission cap.
describe('wireConnection — maxConnections admission cap (WS-5)', () => {
  test('rejects connections beyond the cap with 1013, admits the rest', () => {
    const { hub, tells } = makeHub();
    const policy = { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 2 };
    const codec = jsonCodec() as never;
    const socket1 = fakeSocket(); const socket2 = fakeSocket(); const socket3 = fakeSocket();

    wireConnection({} as never, hub, request, socket1.socket, codec, policy);
    wireConnection({} as never, hub, request, socket2.socket, codec, policy);
    wireConnection({} as never, hub, request, socket3.socket, codec, policy);

    expect(tells.length).toBe(2);        // first two admitted (hub told)
    expect(socket1.closes.length).toBe(0);
    expect(socket2.closes.length).toBe(0);
    expect(socket3.closes).toEqual([{ code: 1013, reason: 'server at capacity' }]);  // third rejected
  });

  test('separate hubs (routes) have independent counts', () => {
    const hubA = makeHub(); const hubB = makeHub();
    const policy = { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 1 };
    const codec = jsonCodec() as never;
    wireConnection({} as never, hubA.hub, request, fakeSocket().socket, codec, policy);
    const bSock = fakeSocket();
    wireConnection({} as never, hubB.hub, request, bSock.socket, codec, policy);   // different hub → own budget
    expect(hubA.tells.length).toBe(1);
    expect(hubB.tells.length).toBe(1);
    expect(bSock.closes.length).toBe(0);
  });

  test('default policy (Infinity) admits everything', () => {
    const { hub, tells } = makeHub();
    const codec = jsonCodec() as never;
    for (let i = 0; i < 50; i++) {
      wireConnection({} as never, hub, request, fakeSocket().socket, codec, DEFAULT_WEBSOCKET_POLICY);
    }
    expect(tells.length).toBe(50);
  });
});

/* ------------------------- the release half of the cap ---------------------- */

/**
 * The three tests above stub `hub.tell`, so nothing is ever spawned and no
 * socket is ever closed — they cover admission and only admission.  The
 * *release* is the half that decides whether a cap is a rate limit or a
 * permanent lockout, and it needs a real system: the decrement is chained onto
 * the connection actor's `setListeners`, so it happens two mailbox hops away
 * from `wireConnection` and no stub can reach it (#717 AC-5).
 */
type In = { kind: 'ping' };
type Out = { kind: 'pong' };

/** Buffers `close` until `setListeners`, exactly as the real adapters do. */
class ClosableSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;
  private pendingClose: { code: number; reason: string } | null = null;

  send(): void { /* nothing outbound under test */ }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    const event = { code: code ?? 1000, reason: reason ?? '' };
    if (this.listeners) this.listeners.onClose(event.code, event.reason);
    else this.pendingClose = event;
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
    const pending = this.pendingClose;
    this.pendingClose = null;
    if (pending) l.onClose(pending.code, pending.reason);
  }
}

/** Records the hub-side disconnect, which is ordered *after* the decrement. */
class CountingServer extends WebsocketServerActor<Out, In> {
  constructor(private readonly disconnects: string[]) { super(); }
  onMessage(): void { /* no inbound frames in this test */ }
  protected override onClientDisconnected(): void {
    this.disconnects.push('disconnected');
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

describe('wireConnection — maxConnections release cycle (WS-5)', () => {
  test('a closed connection returns its slot, so a later client is re-admitted', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('ws-cap-release', systemOptions);
    systems.push(system);
    const disconnects: string[] = [];
    const hub = system.spawn(
      () => new CountingServer(disconnects), 'hub',
    ) as WebsocketServerRef<Out, In>;
    const policy = { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 1 };
    const codec = jsonCodec<Out, In>();
    const wire = (socket: WebsocketSocketAdapter): void => {
      wireConnection<Out, In>(system, hub, request, socket, codec, policy);
    };

    const first = new ClosableSocket();
    wire(first);
    await awaitCondition(() => first.readyState === 1 && disconnects.length === 0, {
      timeoutMs: 4_000,
      label: 'the first connection was admitted and stayed open',
    });

    // While it is open, the single slot is taken.
    const refused = new ClosableSocket();
    wire(refused);
    expect(refused.closeCalls).toEqual([{ code: 1013, reason: 'server at capacity' }]);

    // Closing releases it.  The decrement runs inside the socket's `onClose`,
    // strictly before the connection actor stops and reports the disconnect —
    // so the hub-side disconnect is a *later* signal than the release, which is
    // what makes it safe to wait on.
    first.close(1000, 'bye');
    await awaitCondition(() => disconnects.length === 1, {
      timeoutMs: 4_000,
      label: 'the hub observed the first connection disconnecting',
    });

    const readmitted = new ClosableSocket();
    wire(readmitted);
    expect(readmitted.closeCalls).toEqual([]);
    await awaitCondition(() => disconnects.length === 1 && readmitted.readyState === 1, {
      timeoutMs: 4_000,
      label: 'the re-admitted connection is live',
    });
  });
});
