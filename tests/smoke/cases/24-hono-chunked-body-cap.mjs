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
 * for the body to end never *settles* the exchange at all — it neither answers
 * nor hangs up — so "still waiting" is the failure, not a slow success.
 *
 * Settling, not answering, is the assertion on purpose.  Refusing a body
 * mid-flight means closing a connection the client is still writing to, and a
 * close over unread inbound data goes out as a reset, on which the platform
 * discards the receive queue — the 413 included.  Instrumented against the
 * built backend this case lost a genuinely-sent answer 15 cold Node starts out
 * of 15, with the handler call count still 0 on every one of them; warm runs
 * read it back cleanly.  A case that insisted on reading the status was
 * therefore reporting the runtime's teardown timing as a framework defect.
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
/**
 * Everything the client ever writes, and deliberately not one frame more.
 * Enough to put the backend past the cap, so it has to decide; short enough
 * that the client is done writing before it does, so the server's close finds
 * an empty receive queue and goes out as a FIN rather than a reset.
 */
const CHUNKS_TO_EXCEED_CAP = Math.ceil(CAP_BYTES / CHUNK_BYTES) + 1;
/** How long to wait for a backend to end an exchange it will never see the end of. */
const SETTLE_TIMEOUT_MS = 5000;

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
        .newServerAt('127.0.0.1', await freePort())
        .useBackend(new HonoBackend(backendOptions))
        .bind(routes);
    } catch (e) {
      console.log(`  (skipped: the Hono backend cannot bind on this runtime — ${e.message})`);
      return;
    }

    const outcome = await streamOverCapBody(binding.port);
    assert(
      outcome.settled !== 'never',
      `the server neither answered nor closed the connection after ${outcome.bytesWritten} bytes of a `
        + `${CAP_BYTES}-byte-capped chunked body whose terminating chunk was never sent — it is waiting `
        + 'for the body to end instead of counting the bytes as they arrive',
    );
    assert(handlerCalls === 0, `the over-cap body still reached the handler (${handlerCalls} call(s))`);
    // Only when the answer outlived the teardown is its status readable; a
    // reset one is still a refusal, and `settled` above already caught it.
    if (outcome.settled === 'response') {
      assert(outcome.status === 413, `expected 413 Payload Too Large, got HTTP ${outcome.status}`);
    }
  } finally {
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

/**
 * Post a chunked body that never ends, and report how the server ended it.
 *
 * Every path — connect failure, mid-write reset, the deadline — goes through
 * the same `socket.destroy()`, because a socket left open here keeps Deno's
 * event loop alive and the whole smoke run then hangs after its last green
 * line instead of exiting (#1196).  The `error` listener is part of that: once
 * the server refuses the body it drops the connection, and the write after
 * that would otherwise surface as an unhandled `ECONNRESET`.
 *
 * `close` and `error` both mark the exchange settled, because the runtimes
 * disagree about which one a reset is — Node raises `ECONNRESET` and closes
 * with `hadError`, Bun reports a plain close.  What they agree on is that the
 * connection ended without a terminating chunk, which is the whole signal.
 */
async function streamOverCapBody(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let received = '';
  let chunksWritten = 0;
  let bytesWritten = 0;
  let hungUp = false;
  const answered = () => received.includes('\r\n\r\n');
  socket.on('data', (data) => { received += data.toString('latin1'); });
  socket.on('error', () => { hungUp = true; /* the peer hung up — a valid outcome */ });
  socket.on('close', () => { hungUp = true; });
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
    // the body as it lands can decide anything about this request.  The write
    // stops at the cap, so the client is silent by the time it does — writing
    // on past the decision is what turns the close into a reset.
    const frame = `${CHUNK_BYTES.toString(16)}\r\n${'x'.repeat(CHUNK_BYTES)}\r\n`;
    while (chunksWritten < CHUNKS_TO_EXCEED_CAP && !answered() && !hungUp) {
      write(frame);
      chunksWritten++;
      bytesWritten += frame.length;
      await sleep(5);
    }

    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (!answered() && !hungUp && Date.now() < deadline) await sleep(20);

    // A readable answer beats a bare hangup, but both are the server deciding.
    const settled = answered() ? 'response' : hungUp ? 'hangup' : 'never';
    return { settled, status: answered() ? statusOf(received) : null, chunksWritten, bytesWritten };
  } finally {
    socket.destroy();
  }
}

/**
 * A port that is free right now, so the server can be asked for a concrete one.
 *
 * `newServerAt(host, 0)` is not usable here: on Deno the Hono runner reports
 * the port it was *asked* for rather than the one it bound (`Deno.serve`
 * exposes the real one as `server.addr.port` and the runner drops it), so
 * `binding.port` comes back as 0 and nothing can connect.  Every runner does
 * echo back a port it was given, so asking for a concrete one works
 * everywhere.  Probed through `node:net`, which all three runtimes implement.
 */
async function freePort() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    return probe.address().port;
  } finally {
    await new Promise((resolve) => probe.close(resolve));
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
