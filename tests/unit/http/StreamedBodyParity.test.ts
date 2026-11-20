/**
 * #1868 — a `streamedBody()` route behaves the same on every shipped backend.
 *
 * Driven over a raw socket wherever the property is about bytes on the wire
 * — when the handler ran, how much the server took in, whether it closed —
 * because `fetch` hides exactly those.  `fetch` with a `ReadableStream` body
 * is used where only the bytes matter: Bun sends it with the declared
 * `Content-Length`, the way a consumer piping into object storage does.
 *
 * What a backend has to show:
 *   - the handler runs before a body byte is sent, with headers and query;
 *   - the stream yields exactly the bytes sent;
 *   - the limit holds, declared (413 before the handler) and counted (a
 *     typed error in the handler, 413 on the wire);
 *   - a handler that answers without reading costs at most a bounded intake:
 *     the connection closes unless the remainder is declared and small;
 *   - a client that goes away errors the stream;
 *   - a consumer that stalls holds the client back — no read-ahead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { STREAMED_BODY_DRAIN_LIMIT_BYTES } from '../../../src/http/Constants.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { BearerTokenAuth } from '../../../src/http/middleware/BearerToken.js';
import { complete, completeJson, path, put, withMiddleware, type Route } from '../../../src/http/Route.js';
import { streamedBody } from '../../../src/http/StreamedBody.js';
import { RequestBodyAbortedError, RequestBodyTooLargeError, Status, type StreamedHttpRequest } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const BACKENDS = ['hono'] as const;

/**
 * Whether a response written over an unread body reaches a client that keeps
 * writing it.  The `node:http` backends close lingeringly, so it does; under
 * `Bun.serve` — the Hono backend in this suite, which runs on Bun — the
 * runtime resets the connection when it closes, and the reset can discard the
 * answer before the client reads it (measured, #1868).  There the bound on
 * what the server took in is what is asserted, and the status only where an
 * answer arrived.
 */
function answersAClientStillWriting(backend: string): boolean {
  return backend !== 'hono';
}

/**
 * The refusal of a body the server did not read: the connection closes, the
 * server took in a bounded amount, and the answer is `status` — asserted
 * outright where the backend can deliver it to a client still writing.
 */
async function expectRefusedWithoutReading(backend: string, client: RawClient, status: number, label: string): Promise<void> {
  if (answersAClientStillWriting(backend)) {
    const response = await client.awaitResponse(label);
    expect(response.status).toBe(status);
  }
  await awaitCondition(() => client.closed, { timeoutMs: 6000, label: `${label}: the server closes the connection` });
  const response = client.response();
  if (response !== undefined) expect(response.status).toBe(status);
  // Socket buffers on both ends plus the linger bound — never the body.
  expect(client.acked).toBeLessThan(16 * MiB);
}
const MiB = 1024 * 1024;

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];

afterEach(async () => {
  for (const { binding, system } of live.splice(0)) {
    await binding.unbind();
    await system.terminate();
  }
});

async function start(backend: string, routes: Route): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(`actor-ts.http.backend = ${backend}`));
  const system = ActorSystem.create('streamed-body-parity', systemOptions);
  try {
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    live.push({ binding, system });
    return binding.port;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

/** A promise with its resolver outside — the handler signals, the test waits. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<{ length: number; sha256: string }> {
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  return { length, sha256: hash.digest('hex') };
}

/** What a `readAll` over a streamed body ended in: the digest, or the error it threw. */
async function settleBody(body: ReadableStream<Uint8Array>): Promise<{ length: number; sha256: string } | Error> {
  try {
    return await readAll(body);
  } catch (err) {
    return err as Error;
  }
}

type RawResponse = { readonly status: number; readonly headers: Record<string, string>; readonly body: string };

/** One HTTP/1.1 connection, driven byte by byte. */
class RawClient {
  private received = Buffer.alloc(0);
  closed = false;
  /** Bytes the socket acknowledged writing — handed to the kernel, not necessarily read by the server. */
  acked = 0;
  /** Body bytes handed to the socket so far, acknowledged or not. */
  private written = 0;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => { this.received = Buffer.concat([this.received, chunk]); });
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => { /* a reset is an outcome these tests read off `closed` */ });
  }

  static async open(port: number): Promise<RawClient> {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RawClient(socket);
  }

  sendHead(method: string, target: string, headers: Record<string, string>): void {
    let head = `${method} ${target} HTTP/1.1\r\nhost: localhost\r\n`;
    for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
    this.socket.write(`${head}\r\n`);
  }

  async send(data: Uint8Array | string): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const length = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      this.socket.write(data, (err) => {
        if (!err) this.acked += length;
        resolve();
      });
    });
  }

  /**
   * Write body bytes in 64 KiB chunks until `total` have been written over
   * this connection's lifetime, for as long as the server takes them, giving
   * up after `windowMs`.  Never awaits a write the server is not
   * reading: a full socket buffer ends the pump rather than blocking it, so
   * `acked` measures what the server let through.
   */
  async pump(total: number, windowMs: number): Promise<void> {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const deadline = Date.now() + windowMs;
    while (!this.closed && this.written < total && Date.now() < deadline) {
      const piece = this.written + chunk.length > total ? chunk.subarray(0, total - this.written) : chunk;
      const accepted = this.socket.write(piece, (err) => { if (!err) this.acked += piece.length; });
      this.written += piece.length;
      if (!accepted) {
        await Promise.race([
          new Promise<void>((resolve) => this.socket.once('drain', () => resolve())),
          // Bounded wait for a drain that may never come — that is the point.
          sleep(Math.max(1, Math.min(200, deadline - Date.now()))),
        ]);
      }
    }
  }

  /** The final (non-1xx) response, once its head and `content-length` body arrived. */
  response(): RawResponse | undefined {
    let text = this.received.toString('latin1');
    for (;;) {
      const headEnd = text.indexOf('\r\n\r\n');
      if (headEnd < 0) return undefined;
      const [statusLine, ...lines] = text.slice(0, headEnd).split('\r\n');
      const status = Number(statusLine!.split(' ')[1]);
      if (status >= 100 && status < 200) {
        text = text.slice(headEnd + 4);
        continue;
      }
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const body = text.slice(headEnd + 4);
      const length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']);
      if (length !== undefined && body.length < length) return undefined;
      if (length === undefined && headers['transfer-encoding'] !== undefined && !body.includes('0\r\n\r\n')) return undefined;
      return { status, headers, body };
    }
  }

  async awaitResponse(label: string): Promise<RawResponse> {
    await awaitCondition(() => this.response() !== undefined, { timeoutMs: 4000, label });
    return this.response()!;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

describe.each(BACKENDS)('streamedBody() on the %s backend — HTTP/1.1', (backend) => {
  test('the handler runs before any body byte is sent, with headers, query and params', async () => {
    const seen = deferred<{ token: string | undefined; query: unknown; id: string | undefined; contentLength: number | undefined }>();
    const port = await start(backend, path('files', path(':id', put(streamedBody(async (request) => {
      seen.resolve({ token: request.headers['x-token'], query: request.query.token, id: request.params.id, contentLength: request.contentLength });
      return completeJson(Status.OK, await readAll(request.body));
    })))));
    const client = await RawClient.open(port);
    const payload = randomBytes(1000);
    client.sendHead('PUT', '/files/42?token=abc', { 'content-length': String(payload.length), 'x-token': 't-1' });

    // Not a byte of the body is on the wire yet.
    expect(await seen.promise).toEqual({ token: 't-1', query: 'abc', id: '42', contentLength: 1000 });
    await client.send(payload);
    const response = await client.awaitResponse('the streamed upload is answered');
    client.destroy();

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ length: 1000, sha256: createHash('sha256').update(payload).digest('hex') });
  });

  test('the stream yields exactly the bytes sent — 5 MiB through fetch with a stream body', async () => {
    const port = await start(backend, path('upload', put(streamedBody(async (request) => completeJson(Status.OK, await readAll(request.body))))));
    const payload = randomBytes(5 * MiB);
    const pieces = 40;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const step = Math.ceil(payload.length / pieces);
        for (let offset = 0; offset < payload.length; offset += step) controller.enqueue(payload.subarray(offset, offset + step));
        controller.close();
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'PUT',
      body,
      headers: { 'content-length': String(payload.length) },
      duplex: 'half',
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
  });

  test('a declared Content-Length over the limit is answered 413 before the handler, and the connection closes', async () => {
    let called = false;
    const port = await start(backend, path('upload', put(streamedBody({ maxBytes: 1024 }, () => { called = true; return complete(Status.OK); }))));
    const client = await RawClient.open(port);
    client.sendHead('PUT', '/upload', { 'content-length': String(50 * MiB) });
    await client.pump(50 * MiB, 1500);

    await expectRefusedWithoutReading(backend, client, 413, 'the declared-oversize upload is refused');
    expect(called).toBe(false);
  }, 15_000);

  test('a body that grows past the limit errors the stream with RequestBodyTooLargeError and answers 413', async () => {
    const outcome = deferred<unknown>();
    const port = await start(backend, path('upload', put(streamedBody({ maxBytes: 100_000 }, async (request) => {
      const settled = await settleBody(request.body);
      outcome.resolve(settled);
      if (settled instanceof Error) throw settled;
      return complete(Status.OK);
    }))));
    const client = await RawClient.open(port);
    client.sendHead('PUT', '/upload', { 'transfer-encoding': 'chunked' });
    const chunk = Buffer.alloc(32 * 1024, 1);
    for (let i = 0; i < 8 && !client.closed; i++) {
      await client.send(`${chunk.length.toString(16)}\r\n`);
      await client.send(chunk);
      await client.send('\r\n');
    }
    const failure = await outcome.promise;

    expect(failure).toBeInstanceOf(RequestBodyTooLargeError);
    await expectRefusedWithoutReading(backend, client, 413, 'the over-limit chunked upload is answered');
  }, 15_000);

  test('a handler that answers without reading a large body takes in a bounded amount and closes', async () => {
    const port = await start(backend, path('upload', put(streamedBody((request: StreamedHttpRequest) =>
      complete(request.headers['x-token'] === 'good' ? Status.OK : Status.Unauthorized)))));
    const client = await RawClient.open(port);
    client.sendHead('PUT', '/upload', { 'content-length': String(50 * MiB) });
    await client.pump(50 * MiB, 2000);

    await expectRefusedWithoutReading(backend, client, 401, 'the unauthenticated upload is refused');
  }, 15_000);

  test('a small declared remainder is drained and the connection kept for the next request', async () => {
    const port = await start(backend, path('upload', put(streamedBody(() => complete(Status.Unauthorized)))));
    const client = await RawClient.open(port);
    const small = STREAMED_BODY_DRAIN_LIMIT_BYTES / 2;
    client.sendHead('PUT', '/upload', { 'content-length': String(small) });
    await client.send(Buffer.alloc(small, 3));
    const first = await client.awaitResponse('the small refused upload is answered');

    expect(first.status).toBe(401);
    expect(first.headers['connection']).not.toBe('close');
    expect(client.closed).toBe(false);
  });

  test('a client that goes away mid-body errors the stream with RequestBodyAbortedError', async () => {
    const outcome = deferred<unknown>();
    const firstChunk = deferred<void>();
    const port = await start(backend, path('upload', put(streamedBody(async (request) => {
      const reader = request.body.getReader();
      try {
        await reader.read();
        firstChunk.resolve();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        outcome.resolve('ended');
      } catch (err) {
        outcome.resolve(err);
      }
      return complete(Status.OK);
    }))));
    const client = await RawClient.open(port);
    client.sendHead('PUT', '/upload', { 'content-length': String(MiB) });
    await client.send(Buffer.alloc(64 * 1024, 5));
    await firstChunk.promise;
    client.destroy();

    expect(await outcome.promise).toBeInstanceOf(RequestBodyAbortedError);
  });

  test('a stalled consumer holds the client back — the server reads nothing ahead of it', async () => {
    const release = deferred<void>();
    const port = await start(backend, path('upload', put(streamedBody(async (request) => {
      const reader = request.body.getReader();
      await reader.read();
      await release.promise;
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
      }
      return completeJson(Status.OK, { rest: length });
    }))));
    const client = await RawClient.open(port);
    const total = 64 * MiB;
    client.sendHead('PUT', '/upload', { 'content-length': String(total) });
    await client.pump(total, 1500);
    const stalledAt = client.acked;
    release.resolve();
    await client.pump(total, 30_000);
    const response = await client.awaitResponse('the stalled upload completes once released');
    client.destroy();

    expect(response.status).toBe(200);
    // What sits in the two socket buffers and the runtime's own read buffer —
    // a few MiB — never the 64 MiB the client offered.
    expect(stalledAt).toBeLessThan(16 * MiB);
  }, 40_000);

  test('a middleware can refuse before a byte is read', async () => {
    let handled = false;
    const auth = BearerTokenAuth({ tokens: ['s3cret'] });
    const port = await start(backend, path('upload', withMiddleware(auth, put(streamedBody(() => { handled = true; return complete(Status.OK); })))));
    const client = await RawClient.open(port);
    client.sendHead('PUT', '/upload', { 'content-length': String(20 * MiB) });
    await client.pump(20 * MiB, 1000);

    await expectRefusedWithoutReading(backend, client, 401, 'the unauthenticated upload is refused by the middleware');
    expect(handled).toBe(false);
  }, 15_000);

  test('a consumer that cancels the stream releases the connection', async () => {
    const port = await start(backend, path('upload', put(streamedBody(async (request) => {
      const reader = request.body.getReader();
      await reader.read();
      await reader.cancel();
      return complete(Status.Accepted);
    }))));
    const client = await RawClient.open(port);
    client.sendHead('PUT', '/upload', { 'content-length': String(20 * MiB) });
    await client.pump(20 * MiB, 1500);

    await expectRefusedWithoutReading(backend, client, 202, 'the cancelled upload is answered');
  }, 15_000);
});
