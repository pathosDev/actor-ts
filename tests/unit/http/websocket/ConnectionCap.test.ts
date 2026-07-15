import { describe, expect, test } from 'bun:test';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { HttpRequest } from '../../../../src/http/types.js';

// `wireConnection` builds the per-connection actor's Props lazily (the actor
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

const req = {
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
    const s1 = fakeSocket(); const s2 = fakeSocket(); const s3 = fakeSocket();

    wireConnection({} as never, hub, req, s1.socket, codec, policy);
    wireConnection({} as never, hub, req, s2.socket, codec, policy);
    wireConnection({} as never, hub, req, s3.socket, codec, policy);

    expect(tells.length).toBe(2);        // first two admitted (hub told)
    expect(s1.closes.length).toBe(0);
    expect(s2.closes.length).toBe(0);
    expect(s3.closes).toEqual([{ code: 1013, reason: 'server at capacity' }]);  // third rejected
  });

  test('separate hubs (routes) have independent counts', () => {
    const a = makeHub(); const b = makeHub();
    const policy = { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 1 };
    const codec = jsonCodec() as never;
    wireConnection({} as never, a.hub, req, fakeSocket().socket, codec, policy);
    const bSock = fakeSocket();
    wireConnection({} as never, b.hub, req, bSock.socket, codec, policy);   // different hub → own budget
    expect(a.tells.length).toBe(1);
    expect(b.tells.length).toBe(1);
    expect(bSock.closes.length).toBe(0);
  });

  test('default policy (Infinity) admits everything', () => {
    const { hub, tells } = makeHub();
    const codec = jsonCodec() as never;
    for (let i = 0; i < 50; i++) {
      wireConnection({} as never, hub, req, fakeSocket().socket, codec, DEFAULT_WEBSOCKET_POLICY);
    }
    expect(tells.length).toBe(50);
  });
});
