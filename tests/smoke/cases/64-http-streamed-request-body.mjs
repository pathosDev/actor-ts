/**
 * Smoke case: a `streamedBody()` route on the runtime the user actually runs
 * (#1868).
 *
 * `tests/unit/http/StreamedBodyParity.test.ts` holds all three backends to one
 * contract under `bun test`, which means under Bun — and the Hono backend picks
 * its runner by runtime, so `@hono/node-server` and `Deno.serve` never run
 * there.  This case binds each backend the runtime supports — Hono everywhere,
 * Fastify and Express on Bun and Node — and checks the parts that differ by
 * runtime:
 *
 *   - the stream yields exactly the bytes sent (2 MiB, sha-256);
 *   - a declared `Content-Length` over the route's limit never reaches the
 *     handler;
 *   - a handler that answers without reading a 50 MiB upload lets the server
 *     take in a bounded amount — the connection closes rather than the body
 *     being read;
 *   - `Expect: 100-continue` against a refusing handler draws no `100` — except
 *     from `Bun.serve` and from Deno 2.9 onwards, which send it before any
 *     handler runs;
 *   - a handler that answers without reading a *small* body leaves the
 *     connection serving its next request (#1878);
 *   - once every client socket is gone, `unbind()` settles at once (#1878).
 *
 * Every refusal is read as "the handler did what it should" and "the exchange
 * ended", the status only where one arrived: a server that closes a
 * connection the client is still writing to can reset it, and the reset can
 * discard the answer (measured; see the issue).  The raw client is `node:net`,
 * which all three runtimes provide, and every socket is destroyed on every
 * path.
 *
 * A backend whose peers cannot be loaded on this runtime is skipped by name;
 * with the peers in place, a bind that fails is a failure.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

export const name = 'http streamed request body';
export const description = 'a streamedBody() route reads exactly the bytes sent, refuses an over-limit declared length before the handler, bounds what an early answer takes in, and holds back 100 Continue on node:http';

const MiB = 1024 * 1024;
const SETTLE_TIMEOUT_MS = 8_000;
/**
 * How long `unbind()` may take once every client socket is gone.  Measured at
 * 0–1 ms per backend on Node 24; the regression it catches waited out the
 * 2 s lingering-close deadline at best, and forever on an otherwise idle loop.
 */
const UNBIND_BOUND_MS = 1_000;

/** Deno's own version as [major, minor], or undefined off Deno. */
function denoVersion() {
  const version = globalThis.Deno?.version?.deno;
  if (typeof version !== 'string') return undefined;
  const [major, minor] = version.split('.').map(Number);
  return [major, minor];
}

/**
 * Two requests on one connection: a small body the handler does not read,
 * then an empty one.  Answers how many responses came back, and whether the
 * connection closed before the second could be answered.
 */
async function keepAliveExchange({ port, target, smallBytes }) {
  const socket = connect(port, '127.0.0.1');
  let received = '';
  let closed = false;
  const answers = () => (received.match(/HTTP\/1\.1 [2-5]\d\d /g) ?? []).length;
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('data', (chunk) => { received += chunk.toString('latin1'); });
    socket.on('close', () => { closed = true; });
    socket.on('error', () => { /* read off `closed` */ });
    socket.write(`PUT ${target} HTTP/1.1\r\nhost: localhost\r\ncontent-length: ${smallBytes}\r\n\r\n`);
    socket.write(Buffer.alloc(smallBytes, 7));
    const firstBy = Date.now() + SETTLE_TIMEOUT_MS;
    while (!closed && answers() < 1 && Date.now() < firstBy) await sleep(10);
    if (!closed) socket.write(`PUT ${target} HTTP/1.1\r\nhost: localhost\r\ncontent-length: 0\r\n\r\n`);
    const secondBy = Date.now() + SETTLE_TIMEOUT_MS;
    while (!closed && answers() < 2 && Date.now() < secondBy) await sleep(10);
    return { answers: answers(), closed };
  } finally {
    socket.destroy();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One raw HTTP/1.1 exchange: head, then up to `total` body bytes for at most `windowMs`, then wait for an answer or a close. */
async function rawExchange({ port, target, headers, total, windowMs, payload }) {
  const socket = connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let closed = false;
  let acked = 0;
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    socket.on('close', () => { closed = true; });
    socket.on('error', () => { /* a reset is an outcome, read off `closed` */ });
    let head = `PUT ${target} HTTP/1.1\r\nhost: localhost\r\n`;
    for (const [key, value] of Object.entries(headers)) head += `${key}: ${value}\r\n`;
    socket.write(`${head}\r\n`);
    const chunk = Buffer.alloc(64 * 1024, 7);
    const deadline = Date.now() + windowMs;
    let written = 0;
    while (!closed && written < total && Date.now() < deadline) {
      const piece = payload !== undefined
        ? payload.subarray(written, Math.min(total, written + chunk.length))
        : chunk.subarray(0, Math.min(chunk.length, total - written));
      const accepted = socket.write(piece, (err) => { if (!err) acked += piece.length; });
      written += piece.length;
      if (!accepted) {
        await Promise.race([new Promise((resolve) => socket.once('drain', resolve)), sleep(100)]);
      }
    }
    const settleBy = Date.now() + SETTLE_TIMEOUT_MS;
    while (!closed && Date.now() < settleBy && finalResponse(received) === undefined) await sleep(20);
    return { response: finalResponse(received), sawContinue: received.toString('latin1').includes(' 100 Continue'), closed, acked };
  } finally {
    socket.destroy();
  }
}

/** The final, non-1xx response in `bytes`, once complete. */
function finalResponse(bytes) {
  let text = bytes.toString('latin1');
  for (;;) {
    const headEnd = text.indexOf('\r\n\r\n');
    if (headEnd < 0) return undefined;
    const [statusLine, ...lines] = text.slice(0, headEnd).split('\r\n');
    const status = Number(statusLine.split(' ')[1]);
    if (status >= 100 && status < 200) { text = text.slice(headEnd + 4); continue; }
    const headers = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const body = text.slice(headEnd + 4);
    const length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']);
    if (length !== undefined && body.length < length) return undefined;
    return { status, headers, body };
  }
}

async function digest(stream) {
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  return { length, sha256: hash.digest('hex') };
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, complete, completeJson, concat, path, put, streamedBody } = await loadEntry('http');

  const candidates = runtime === 'deno'
    ? [{ backend: 'hono', peers: ['hono'] }]
    : [
      { backend: 'hono', peers: runtime === 'node' ? ['hono', '@hono/node-server'] : ['hono'] },
      { backend: 'fastify', peers: ['fastify'] },
      { backend: 'express', peers: ['express'] },
    ];

  for (const { backend, peers } of candidates) {
    let missing;
    for (const peer of peers) {
      try {
        await import(peer);
      } catch (e) {
        missing = `${peer} (${e.message})`;
        break;
      }
    }
    if (missing !== undefined) {
      console.log(`  (skipped ${backend}: ${missing} cannot be loaded on ${runtime})`);
      continue;
    }

    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { http: { backend } } });
    const system = ActorSystem.create(`smoke-streamed-body-${backend}`, systemOptions);
    const reached = { limited: 0, refusing: 0 };
    const routes = concat(
      path('echo', put(streamedBody(async (request) => completeJson(200, await digest(request.body))))),
      path('limited', put(streamedBody({ maxBytes: 1024 }, () => { reached.limited += 1; return complete(200); }))),
      path('refusing', put(streamedBody(() => { reached.refusing += 1; return complete(401); }))),
    );
    let binding;
    try {
      try {
        binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
      } catch (e) {
        throw new Error(`the ${backend} backend did not bind a streamedBody() route on ${runtime}: ${e.message}`, { cause: e });
      }
      const port = binding.port;
      const where = `${backend} on ${runtime}`;

      /* --- 1. exactly the bytes sent ---------------------------------------- */
      const payload = randomBytes(2 * MiB);
      const echo = await rawExchange({ port, target: '/echo', headers: { 'content-length': String(payload.length) }, total: payload.length, windowMs: 20_000, payload });
      const expected = { length: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
      if (echo.response?.status !== 200 || echo.response.body !== JSON.stringify(expected)) {
        throw new Error(`${where}: a 2 MiB streamed upload came back ${echo.response?.status} ${echo.response?.body?.slice(0, 120)}, expected ${JSON.stringify(expected)}`);
      }

      /* --- 2. a declared length over the limit never reaches the handler ---- */
      const limited = await rawExchange({ port, target: '/limited', headers: { 'content-length': String(10 * MiB) }, total: 10 * MiB, windowMs: 1_500 });
      if (reached.limited !== 0) throw new Error(`${where}: a declared 10 MiB body reached a handler limited to 1 KiB`);
      if (limited.response !== undefined && limited.response.status !== 413) {
        throw new Error(`${where}: a declared length over the limit was answered ${limited.response.status}`);
      }
      if (!limited.closed && limited.response === undefined) throw new Error(`${where}: a declared length over the limit was neither answered nor closed`);

      /* --- 3. an early answer takes in a bounded amount --------------------- */
      const early = await rawExchange({ port, target: '/refusing', headers: { 'content-length': String(50 * MiB) }, total: 50 * MiB, windowMs: 2_000 });
      if (reached.refusing !== 1) throw new Error(`${where}: the refusing handler ran ${reached.refusing} time(s)`);
      if (early.response !== undefined && early.response.status !== 401) throw new Error(`${where}: the refusal was answered ${early.response.status}`);
      if (!early.closed) throw new Error(`${where}: the connection stayed open after a refusal over an unread 50 MiB body`);
      if (early.acked >= 16 * MiB) throw new Error(`${where}: the server took in ${(early.acked / MiB).toFixed(1)} MiB of a body nobody read`);

      /* --- 4. Expect: 100-continue against a refusing handler --------------- */
      const expecting = await rawExchange({ port, target: '/refusing', headers: { 'content-length': String(50 * MiB), expect: '100-continue' }, total: 0, windowMs: 0 });
      if (expecting.response?.status !== 401) throw new Error(`${where}: Expect: 100-continue against a refusing handler was answered ${expecting.response?.status}`);
      // Deno 2.9 answers `Expect: 100-continue` as it dispatches the request,
      // before any handler runs and whether the body is touched or not
      // (measured on 2.9.8; 2.6.8 and 2.8.0 never do).
      const deno = denoVersion();
      const denoSendsItsOwn = deno !== undefined && (deno[0] > 2 || (deno[0] === 2 && deno[1] >= 9));
      const sendsItsOwnContinue = (runtime === 'bun' && backend === 'hono') || denoSendsItsOwn;
      if (!sendsItsOwnContinue && expecting.sawContinue) {
        throw new Error(`${where}: a handler that refused without reading still drew a 100 Continue`);
      }

      /* --- 5. a small unread body keeps the connection ---------------------- */
      // Under the drain limit the rest is read off for the next request rather
      // than the connection closed — on Deno 2.9 only if nothing took the body
      // the handler never read: a taken reader is handed the connection.
      const before = reached.refusing;
      const small = await keepAliveExchange({ port, target: '/refusing', smallBytes: 1024 });
      if (small.answers !== 2) {
        throw new Error(`${where}: after a refused, unread 1 KiB body the connection answered ${small.answers} of 2 requests${small.closed ? ' and closed' : ''}`);
      }
      if (reached.refusing !== before + 2) throw new Error(`${where}: the refusing handler ran ${reached.refusing - before} time(s) for two requests`);

      /* --- 6. the refusals leave nothing for the server's close to wait on -- */
      // Every client socket above is destroyed, so a close has nothing left to
      // drain.  Raced against a referenced timer: a refused connection the
      // server still holds — its request paused, so it reads no FIN — keeps no
      // event loop open, and a bare `await` here hung the whole harness once
      // nothing else did (Hono on Node 24, after case 63).
      const unbinding = binding.unbind();
      binding = undefined;
      const unbound = await Promise.race([
        unbinding.then(() => true, (e) => e),
        sleep(UNBIND_BOUND_MS).then(() => false),
      ]);
      if (unbound instanceof Error) throw new Error(`${where}: unbind() failed: ${unbound.message}`, { cause: unbound });
      if (!unbound) {
        throw new Error(`${where}: unbind() had not settled ${UNBIND_BOUND_MS} ms after the refusals — a refused connection is still holding the server's close`);
      }
    } finally {
      // Bounded for the same reason: on a failure above the close may still
      // be waiting, and the harness has to reach the next case.
      if (binding) await Promise.race([binding.unbind().catch(() => {}), sleep(UNBIND_BOUND_MS)]);
      await Promise.race([system.terminate(), sleep(2 * UNBIND_BOUND_MS)]);
    }
  }
}
