/**
 * Smoke case: the Hono backend refuses an over-cap chunked request body while
 * it is still arriving, on whichever runtime is running (#357).
 *
 * Runtime-sensitive in the strict sense.  A body that declares no
 * `Content-Length` cannot be refused up front, so the backend reads
 * `c.req.raw.body` chunk by chunk and abandons the read at the cap — and
 * `req.raw` is the one object the three Hono adapters build in three separate
 * stacks: `Bun.serve` hands over its own `Request`, `Deno.serve` the Rust
 * core's, and `@hono/node-server` a shim wrapped around a Node
 * `IncomingMessage`.  Whether that shim exposes a *streaming* `body` at all is
 * exactly what a Bun-only unit suite cannot answer; a runtime where it does
 * not falls back to buffering the whole body, and this case is what notices.
 *
 * The discriminator is the withheld terminating chunk: a backend that waits
 * for the body to end never answers at all, so "no response" is the failure,
 * not a slow success.
 *
 * `hono` (and, on Node, `@hono/node-server`) are optional peer dependencies,
 * so a runtime that cannot load them skips rather than fails.
 */
import net from 'node:net';

export const name = 'hono chunked body cap';
export const description = 'an over-cap chunked body is refused before its terminating chunk arrives';

/** Small enough that the whole exchange costs a few hundred milliseconds. */
const CAP_BYTES = 16 * 1024;
/** One chunk of the streamed body — three of them already cross the cap. */
const CHUNK_BYTES = 8 * 1024;
/** Ceiling on what the client writes before it stops waiting for an answer. */
const MAX_CHUNKS = 64;

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HonoBackend, HonoBackendOptions, completeJson, path, post } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-hono-chunked-body-cap', systemOptions);

  let binding;
  let handlerCalls = 0;
  try {
    const backendOptions = HonoBackendOptions.create().withMaxBodyBytes(CAP_BYTES);
    const routes = path('up', post((request) => {
      handlerCalls++;
      return completeJson(200, { length: request.body ? request.body.byteLength : 0 });
    }));
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(new HonoBackend(backendOptions))
        .bind(routes);
    } catch (e) {
      console.log(`  (skipped: the Hono backend cannot bind on this runtime — ${e.message})`);
      return;
    }

    const outcome = await streamOverCapBody(binding.port);
    assert(
      outcome.status !== null,
      'the server never answered a chunked body that was already over the cap — '
        + `it is buffering the whole request instead of counting it (wrote ${outcome.chunksWritten} chunk(s))`,
    );
    assert(outcome.status === 413, `expected 413 Payload Too Large, got HTTP ${outcome.status}`);
    assert(
      outcome.chunksWritten < MAX_CHUNKS,
      `the refusal only arrived after the client had written all ${MAX_CHUNKS} chunks`,
    );
    assert(handlerCalls === 0, `the over-cap body still reached the handler (${handlerCalls} call(s))`);
  } finally {
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

/**
 * Post a chunked body that never ends, and report what came back.
 *
 * Every path — connect failure, mid-write reset, the deadline — goes through
 * the same `socket.destroy()`, because a socket left open here keeps Deno's
 * event loop alive and the whole smoke run then hangs after its last green
 * line instead of exiting (#1196).  The `error` listener is part of that: once
 * the server refuses the body it drops the connection, and the write after
 * that would otherwise surface as an unhandled `ECONNRESET`.
 */
async function streamOverCapBody(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let received = '';
  let chunksWritten = 0;
  socket.on('data', (data) => { received += data.toString('latin1'); });
  socket.on('error', () => { /* the peer hung up — a valid outcome here */ });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    const write = (data) => { if (!socket.destroyed && socket.writable) socket.write(data); };
    write(
      'POST /up HTTP/1.1\r\n'
      + `Host: 127.0.0.1:${port}\r\n`
      + 'Content-Type: application/octet-stream\r\n'
      + 'Transfer-Encoding: chunked\r\n'
      + 'Connection: close\r\n\r\n',
    );

    // No terminating `0\r\n\r\n` is ever written: only a backend that measures
    // the body as it lands can decide anything about this request.
    const frame = `${CHUNK_BYTES.toString(16)}\r\n${'x'.repeat(CHUNK_BYTES)}\r\n`;
    while (chunksWritten < MAX_CHUNKS && received === '') {
      write(frame);
      chunksWritten++;
      await sleep(5);
    }

    const deadline = Date.now() + 5000;
    while (!received.includes('\r\n\r\n') && Date.now() < deadline) await sleep(20);
    return { status: statusOf(received), chunksWritten };
  } finally {
    socket.destroy();
  }
}

/** Status code off an HTTP/1.1 response line, or `null` if none arrived. */
function statusOf(response) {
  const line = /^HTTP\/1\.[01] (\d{3})/.exec(response);
  return line ? Number(line[1]) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
