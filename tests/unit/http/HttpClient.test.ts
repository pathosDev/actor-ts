/**
 * `HttpClient` limits (#602) — the two things a remote peer controls that
 * were unbounded before: how much it sends and how long it takes.
 *
 * The server here is a raw `node:http` server rather than the framework's own
 * route DSL, because the interesting cases are ones a well-behaved server
 * never produces: a body that keeps coming and never ends, a response that
 * never starts, a 204 with no stream at all.
 *
 * Every stall case is written so that the WRONG behaviour hangs rather than
 * asserting on elapsed time — a cap applied after `arrayBuffer()` has already
 * buffered, or a missing default deadline, blows Bun's per-test timeout
 * instead of racing a stopwatch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { HttpClient, HttpResponseTooLargeError } from '../../../src/http/HttpClient.js';
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
});
