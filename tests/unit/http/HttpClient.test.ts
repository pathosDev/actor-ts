/**
 * `HttpClient` limits (#602) and redirect policy (#625) — the three things a
 * remote peer controls that were unbounded before: how much it sends, how
 * long it takes, and where it sends the caller next.
 *
 * The server here is a raw `node:http` server rather than the framework's own
 * route DSL, because the interesting cases are ones a well-behaved server
 * never produces: a body that keeps coming and never ends, a response that
 * never starts, a 204 with no stream at all, a 302 to somewhere else entirely.
 *
 * Every stall case is written so that the WRONG behaviour hangs rather than
 * asserting on elapsed time — a cap applied after `arrayBuffer()` has already
 * buffered, or a missing default deadline, blows Bun's per-test timeout
 * instead of racing a stopwatch.  The redirect cases assert on a server-side
 * hit COUNTER rather than on the response, because the property that matters
 * is that the refused host was never contacted at all: a check on where the
 * chain ended up passes just as happily after the request was made.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { HttpClient, HttpRedirectError, HttpResponseTooLargeError } from '../../../src/http/HttpClient.js';
import { HttpClientOptions } from '../../../src/http/HttpClientOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

type TestServer = {
  readonly url: string;
  close(): Promise<void>;
};

const live: TestServer[] = [];
afterEach(async () => {
  while (live.length) await live.shift()!.close();
});

/** Start a throwaway server on an ephemeral port and register it for teardown. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server: Server = createServer((request, response) => {
    // A capped client aborts mid-write, so the write side fails with EPIPE /
    // ECONNRESET on purpose.  Swallow it: an unhandled 'error' on the
    // response would take the whole test process down.
    response.on('error', () => { /* client went away — that is the test */ });
    request.on('error', () => { /* ditto */ });
    handler(request, response);
  });
  server.on('clientError', () => { /* half-open sockets during teardown */ });
  // Sockets are destroyed by hand at teardown: fetch keeps connections alive,
  // and `server.close()` alone waits for them, which would stall every test.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  live.push({
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  return `http://127.0.0.1:${port}`;
}

/** A body of `size` bytes, sent in one shot with a content-length. */
function fixedBody(size: number): (request: IncomingMessage, response: ServerResponse) => void {
  const payload = Buffer.alloc(size, 0x61);
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
    response.end(payload);
  };
}

/** Run `attempt` and hand back the error it threw, or `undefined` on success. */
async function failureOf(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('HttpClient — response size cap', () => {
  test('a body over maxResponseBytes is refused', async () => {
    const url = await serve(fixedBody(4096));
    const client = new HttpClient({ maxResponseBytes: 1024 });
    const error = await failureOf(() => client.get(url));
    expect(error).toBeInstanceOf(HttpResponseTooLargeError);
    expect((error as HttpResponseTooLargeError).maxResponseBytes).toBe(1024);
    expect((error as HttpResponseTooLargeError).message).toContain('maxResponseBytes=1024');
  });

  test('a body exactly at the cap is accepted, one byte more is not', async () => {
    const exact = await serve(fixedBody(1024));
    const over = await serve(fixedBody(1025));
    const client = new HttpClient({ maxResponseBytes: 1024 });
    expect((await client.get(exact)).body.byteLength).toBe(1024);
    expect(await failureOf(() => client.get(over))).toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('the cap trips while the body is still arriving, not after it is buffered', async () => {
    // The response never ends: chunks up to well past the cap, then silence.
    // A client that called `arrayBuffer()` would sit here until its deadline;
    // one that reads incrementally refuses at the crossing chunk.
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let i = 0; i < 32; i++) response.write(Buffer.alloc(1024, 0x62));
      // deliberately no response.end()
    });
    const client = new HttpClient({ maxResponseBytes: 2048 });
    // A deadline far beyond any plausible run, so a hang fails as a Bun test
    // timeout with this error type absent — never as a passing abort.
    const error = await failureOf(() => client.get(url, { timeoutMs: 60_000 }));
    expect(error).toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('a per-request maxResponseBytes overrides the client default, both ways', async () => {
    const url = await serve(fixedBody(4096));
    const strict = new HttpClient({ maxResponseBytes: 1024 });
    expect((await strict.get(url, { maxResponseBytes: 8192 })).body.byteLength).toBe(4096);
    const generous = new HttpClient({ maxResponseBytes: 1024 * 1024 });
    expect(await failureOf(() => generous.get(url, { maxResponseBytes: 100 })))
      .toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('a multi-chunk body reassembles byte-exactly', async () => {
    const chunks = [Buffer.from('alpha-'), Buffer.from('beta-'), Buffer.from('gamma')];
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    const response = await new HttpClient().get(url);
    expect(response.text()).toBe('alpha-beta-gamma');
    expect(response.body.byteLength).toBe(16);
  });

  test('bodyless responses still work — 204 and HEAD', async () => {
    const noContent = await serve((_request, response) => { response.writeHead(204); response.end(); });
    const client = new HttpClient();
    const empty = await client.get(noContent);
    expect(empty.status).toBe(204);
    expect(empty.body.byteLength).toBe(0);

    const head = await serve(fixedBody(2048));
    const headResponse = await client.singleRequest({ method: 'HEAD', url: head });
    expect(headResponse.status).toBe(200);
    expect(headResponse.body.byteLength).toBe(0);
  });

  test('a JSON response still round-trips through json()', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sku: 'book-1', quantity: 2 }));
    });
    const response = await new HttpClient().get(url);
    expect(response.json<{ sku: string; quantity: number }>()).toEqual({ sku: 'book-1', quantity: 2 });
  });
});

describe('HttpClient — default deadline', () => {
  /** A server that accepts the request and never answers it. */
  const silent = (): Promise<string> => serve(() => { /* never responds */ });

  test('a request with no timeoutMs is still bounded by defaultTimeoutMs', async () => {
    const url = await silent();
    const client = new HttpClient({ defaultTimeoutMs: 50 });
    // Without the default this never settles and the test times out.
    expect(await failureOf(() => client.get(url))).toBeDefined();
  });

  test("a request's own timeoutMs wins over the client default", async () => {
    const url = await silent();
    const client = new HttpClient({ defaultTimeoutMs: 600_000 });
    expect(await failureOf(() => client.get(url, { timeoutMs: 50 }))).toBeDefined();
  });

  test('timeoutMs: 0 opts one call out of the default deadline', async () => {
    const url = await serve((_request, response) => {
      setTimeout(() => { response.writeHead(200); response.end('late'); }, 300);
    });
    const client = new HttpClient({ defaultTimeoutMs: 25 });
    expect(await failureOf(() => client.get(url))).toBeDefined();
    const response = await client.get(url, { timeoutMs: 0 });
    expect(response.text()).toBe('late');
  });
});

describe('HttpClientOptions', () => {
  test('the builder and a plain object configure the same client', async () => {
    const url = await serve(fixedBody(4096));
    const clientOptions = HttpClientOptions.create()
      .withMaxResponseBytes(1024)
      .withDefaultTimeoutMs(5_000);
    expect(await failureOf(() => new HttpClient(clientOptions).get(url)))
      .toBeInstanceOf(HttpResponseTooLargeError);
    expect(await failureOf(() => new HttpClient({ maxResponseBytes: 1024, defaultTimeoutMs: 5_000 }).get(url)))
      .toBeInstanceOf(HttpResponseTooLargeError);
  });

  test('every withX writes its own field', () => {
    const clientOptions = HttpClientOptions.create()
      .withMaxResponseBytes(4242)
      .withDefaultTimeoutMs(1234);
    expect({ ...clientOptions }).toEqual({ maxResponseBytes: 4242, defaultTimeoutMs: 1234 });
  });

  test('out-of-domain settings are rejected at construction, not at the first call', () => {
    expect(() => new HttpClient({ maxResponseBytes: 0 })).toThrow(OptionsError);
    expect(() => new HttpClient({ maxResponseBytes: 1.5 })).toThrow(OptionsError);
    expect(() => new HttpClient({ defaultTimeoutMs: Number.NaN })).toThrow(OptionsError);
    expect(() => new HttpClient({ defaultTimeoutMs: -1 })).toThrow(OptionsError);
  });

  test('an unconfigured client carries the built-in limits', async () => {
    const url = await serve(fixedBody(64));
    // No options at all — the defaults must be applied and must validate.
    expect((await new HttpClient().get(url)).body.byteLength).toBe(64);
  });

  test('the redirect knobs validate too', () => {
    expect(() => new HttpClient({ redirect: 'sideways' as 'follow' })).toThrow(OptionsError);
    expect(() => new HttpClient({ maxRedirects: -1 })).toThrow(OptionsError);
    expect(() => new HttpClient({ maxRedirects: 1.5 })).toThrow(OptionsError);
    // 0 is a policy ("refuse the first"), not a mistake.
    expect(() => new HttpClient({ maxRedirects: 0 })).not.toThrow();
  });

  test('every redirect withX writes its own field', () => {
    const clientOptions = HttpClientOptions.create()
      .withRedirect('error')
      .withMaxRedirects(2);
    expect({ ...clientOptions }).toEqual({ redirect: 'error', maxRedirects: 2 });
  });
});

/**
 * The per-request half of the same defect.  Every bound is consumed as a
 * comparison — `timeoutMs > 0`, `total > maxBytes`, `hops >= maxRedirects` —
 * and a `NaN` loses all three of them silently: no exception, no log, just an
 * unbounded call.  Which is what the issue's title describes, reached from the
 * caller's side instead of the client's.
 *
 * These run against a server that never answers or never stops, so a bound
 * that failed to arm would hang the test rather than pass it.
 */
describe('HttpClient — per-request limits are validated', () => {
  const silent = (): Promise<string> => serve(() => { /* never responds */ });

  test('a NaN or negative timeoutMs is refused instead of disarming the deadline', async () => {
    const url = await silent();
    const client = new HttpClient({ defaultTimeoutMs: 50 });
    // `if (timeoutMs > 0)` is false for both, so before this check neither
    // armed a timer and the call waited on the peer forever.
    expect(await failureOf(() => client.get(url, { timeoutMs: Number.NaN }))).toBeInstanceOf(OptionsError);
    expect(await failureOf(() => client.get(url, { timeoutMs: -1 }))).toBeInstanceOf(OptionsError);
  });

  test('a NaN or Infinite maxResponseBytes is refused instead of removing the ceiling', async () => {
    // The body never ends: only a real ceiling can end this call.
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let i = 0; i < 32; i++) response.write(Buffer.alloc(1024, 0x62));
    });
    const client = new HttpClient({ maxResponseBytes: 2048 });
    for (const maxResponseBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(await failureOf(() => client.get(url, { maxResponseBytes, timeoutMs: 60_000 })))
        .toBeInstanceOf(OptionsError);
    }
  });

  test('a NaN maxRedirects is refused instead of granting an endless chain', async () => {
    const server = await redirectServer((path) => {
      const match = /^\/hop\/(\d+)$/.exec(path);
      return match === null ? null : { status: 302, location: `/hop/${Number(match[1]) + 1}` };
    });
    const error = await failureOf(() => new HttpClient().get(`${server.url}/hop/0`, { maxRedirects: Number.NaN }));
    expect(error).toBeInstanceOf(OptionsError);
    // Refused before the first request, not after walking the chain.
    expect(server.hits.get('/hop/0')).toBeUndefined();
  });

  test('an unknown per-request redirect mode is refused', async () => {
    const url = await silent();
    expect(await failureOf(() => new HttpClient().get(url, { redirect: 'sideways' as 'follow' })))
      .toBeInstanceOf(OptionsError);
  });

  /**
   * The landmine.  `timeoutMs: 0` is the documented opt-out (see the deadline
   * suite above), so the per-request rule set CANNOT be the client-wide one —
   * there `defaultTimeoutMs: 0` stays a rejection, because it would disarm
   * every call rather than one.  Both halves are asserted here so a future
   * "let's share one validator" change fails on whichever half it broke.
   */
  test('the per-request and client-wide rules for the same field stay different', async () => {
    const url = await serve((_request, response) => {
      setTimeout(() => { response.writeHead(200); response.end('late'); }, 200);
    });
    const client = new HttpClient({ defaultTimeoutMs: 25 });
    expect((await client.get(url, { timeoutMs: 0 })).text()).toBe('late');
    expect(() => new HttpClient({ defaultTimeoutMs: 0 })).toThrow(OptionsError);
    // And `maxRedirects: 0` is a policy on both, as it always was.
    expect(() => new HttpClient({ maxRedirects: 0 })).not.toThrow();
  });

  test('the whole valid domain still passes — validation refuses, it does not narrow', async () => {
    const url = await serve(fixedBody(64));
    const response = await new HttpClient().get(url, {
      timeoutMs: 5_000,
      maxResponseBytes: 1024,
      redirect: 'manual',
      maxRedirects: 0,
    });
    expect(response.body.byteLength).toBe(64);
  });
});

/** What `/end` reports back about the request it actually received. */
type EchoedRequest = {
  readonly method: string;
  readonly authorization: string | null;
  readonly cookie: string | null;
  readonly contentType: string | null;
  readonly body: string;
};

/** Collect a request body as UTF-8 — needed to prove a hop kept or dropped it. */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

/**
 * A server that counts hits per path.  `/end` echoes the request back so a
 * test can see the method, the credential headers and the body as they
 * actually arrived at the far end of a chain.
 */
async function redirectServer(
  route: (path: string, hits: Map<string, number>) => { status: number; location?: string } | null,
): Promise<{ url: string; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const url = await serve((request, response) => {
    const path = request.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === '/end') {
      void bodyOf(request).then((body) => {
        const echo: EchoedRequest = {
          method: request.method ?? '',
          authorization: request.headers.authorization ?? null,
          cookie: request.headers.cookie ?? null,
          contentType: request.headers['content-type'] ?? null,
          body,
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(echo));
      });
      return;
    }
    const hop = route(path, hits);
    if (hop === null) { response.writeHead(404); response.end(); return; }
    response.writeHead(hop.status, hop.location === undefined ? {} : { location: hop.location });
    response.end('redirect-body');
  });
  return { url, hits };
}

describe('HttpClient — redirect policy', () => {
  test('a redirect is followed by default, and the response names the host that answered', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302, location: '/end' } : null));
    const response = await new HttpClient().get(`${server.url}/start`);
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${server.url}/end`);
    expect(response.json<EchoedRequest>().method).toBe('GET');
  });

  test("redirect: 'error' refuses without ever contacting the target", async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302, location: '/end' } : null));
    const error = await failureOf(() => new HttpClient({ redirect: 'error' }).get(`${server.url}/start`));
    expect(error).toBeInstanceOf(HttpRedirectError);
    expect((error as HttpRedirectError).hops).toBe(0);
    // The property that matters: the nominated host was never asked.
    expect(server.hits.get('/end')).toBeUndefined();
  });

  test("redirect: 'manual' hands the 3xx back with Location readable, target untouched", async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302, location: '/end' } : null));
    const response = await new HttpClient({ redirect: 'manual' }).get(`${server.url}/start`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/end');
    expect(server.hits.get('/end')).toBeUndefined();
  });

  test('a chain longer than maxRedirects is refused, and stops at the budget', async () => {
    // /hop/0 → /hop/1 → … an endless chain; only the budget can end it.
    const server = await redirectServer((path) => {
      const match = /^\/hop\/(\d+)$/.exec(path);
      return match === null ? null : { status: 302, location: `/hop/${Number(match[1]) + 1}` };
    });
    const error = await failureOf(() => new HttpClient({ maxRedirects: 3 }).get(`${server.url}/hop/0`));
    expect(error).toBeInstanceOf(HttpRedirectError);
    expect((error as HttpRedirectError).hops).toBe(3);
    // Four requests issued (the original plus three hops), never a fifth.
    expect(server.hits.get('/hop/3')).toBe(1);
    expect(server.hits.get('/hop/4')).toBeUndefined();
  });

  test('maxRedirects: 0 refuses the first redirect', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302, location: '/end' } : null));
    expect(await failureOf(() => new HttpClient({ maxRedirects: 0 }).get(`${server.url}/start`)))
      .toBeInstanceOf(HttpRedirectError);
    expect(server.hits.get('/end')).toBeUndefined();
  });

  test('a per-request redirect mode overrides the client default', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302, location: '/end' } : null));
    const client = new HttpClient({ redirect: 'error' });
    expect((await client.get(`${server.url}/start`, { redirect: 'follow' })).status).toBe(200);
    const strict = new HttpClient();
    expect(await failureOf(() => strict.get(`${server.url}/start`, { maxRedirects: 0 })))
      .toBeInstanceOf(HttpRedirectError);
  });

  test('a 3xx without a Location is the final answer, not a redirect', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302 } : null));
    const response = await new HttpClient().get(`${server.url}/start`);
    expect(response.status).toBe(302);
    expect(response.text()).toBe('redirect-body');
  });

  test('a non-HTTP(S) redirect target is refused', async () => {
    const server = await redirectServer(
      (path) => (path === '/start' ? { status: 302, location: 'file:///etc/passwd' } : null),
    );
    const error = await failureOf(() => new HttpClient().get(`${server.url}/start`));
    expect(error).toBeInstanceOf(HttpRedirectError);
    expect((error as HttpRedirectError).message).toContain('non-HTTP(S)');
  });

  test('an unparseable Location is refused rather than followed blindly', async () => {
    const server = await redirectServer(
      (path) => (path === '/start' ? { status: 302, location: 'http://[not-a-host' } : null),
    );
    expect(await failureOf(() => new HttpClient().get(`${server.url}/start`)))
      .toBeInstanceOf(HttpRedirectError);
  });
});

describe('HttpClient — what a followed hop carries', () => {
  test('a same-origin hop keeps the credential headers', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 307, location: '/end' } : null));
    const response = await new HttpClient().get(`${server.url}/start`, {
      headers: { authorization: 'Bearer secret-token', cookie: 'session=abc' },
    });
    const echo = response.json<EchoedRequest>();
    expect(echo.authorization).toBe('Bearer secret-token');
    expect(echo.cookie).toBe('session=abc');
  });

  test('a cross-origin hop drops authorization and cookie', async () => {
    const target = await redirectServer(() => null);
    const origin = await redirectServer(
      (path) => (path === '/start' ? { status: 307, location: `${target.url}/end` } : null),
    );
    const response = await new HttpClient().get(`${origin.url}/start`, {
      headers: { authorization: 'Bearer secret-token', cookie: 'session=abc', 'x-trace': 'keep-me' },
    });
    const echo = response.json<EchoedRequest>();
    expect(echo.authorization).toBeNull();
    expect(echo.cookie).toBeNull();
    // Only the credential headers go; everything else is still the caller's request.
    expect(response.url).toBe(`${target.url}/end`);
    expect(target.hits.get('/end')).toBe(1);
  });

  test('307 preserves the method and the body', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 307, location: '/end' } : null));
    const response = await new HttpClient().post(`${server.url}/start`, { body: { sku: 'book-1' } });
    const echo = response.json<EchoedRequest>();
    expect(echo.method).toBe('POST');
    expect(echo.body).toBe('{"sku":"book-1"}');
    expect(echo.contentType).toContain('application/json');
  });

  test('303 turns a POST into a GET and drops the body with its content-type', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 303, location: '/end' } : null));
    const response = await new HttpClient().post(`${server.url}/start`, { body: { sku: 'book-1' } });
    const echo = response.json<EchoedRequest>();
    expect(echo.method).toBe('GET');
    expect(echo.body).toBe('');
    expect(echo.contentType).toBeNull();
  });

  test('302 after a POST continues as a GET, per the Fetch spec', async () => {
    const server = await redirectServer((path) => (path === '/start' ? { status: 302, location: '/end' } : null));
    const echo = (await new HttpClient().post(`${server.url}/start`, { body: { sku: 'book-1' } }))
      .json<EchoedRequest>();
    expect(echo.method).toBe('GET');
    expect(echo.body).toBe('');
  });

  test('a relative Location resolves against the hop that sent it', async () => {
    const server = await redirectServer(
      (path) => (path === '/deep/nested/start' ? { status: 302, location: '../../end' } : null),
    );
    const response = await new HttpClient().get(`${server.url}/deep/nested/start`);
    expect(response.url).toBe(`${server.url}/end`);
    expect(response.status).toBe(200);
  });
});

describe('HttpClient — limits are cumulative across a chain', () => {
  test('the deadline spans the whole chain rather than resetting per hop', async () => {
    const server = await serve((request, response) => {
      const path = request.url ?? '/';
      const match = /^\/slow\/(\d+)$/.exec(path);
      if (match === null) { response.writeHead(200); response.end('done'); return; }
      // Each hop is comfortably inside the deadline; three of them are not.
      setTimeout(() => {
        response.writeHead(302, { location: `/slow/${Number(match[1]) + 1}` });
        response.end();
      }, 150);
    });
    const client = new HttpClient({ defaultTimeoutMs: 250 });
    const error = await failureOf(() => client.get(`${server}/slow/0`));
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(HttpRedirectError);
  });

  test('an intermediate 3xx body is discarded, not counted against the cap', async () => {
    // The 302 carries far more than the cap; only the final body is buffered.
    const big = Buffer.alloc(64 * 1024, 0x63);
    const server = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/end', 'content-type': 'application/octet-stream' });
        response.end(big);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('small');
    });
    const response = await new HttpClient({ maxResponseBytes: 1024 }).get(`${server}/start`);
    expect(response.text()).toBe('small');
  });
});
