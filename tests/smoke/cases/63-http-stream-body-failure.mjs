/**
 * Smoke case: a `ReadableStream` response body whose source fails is seen by
 * the backend on whichever runtime is running, on Hono and Fastify (#1829,
 * #1830).
 *
 * Runtime-sensitive because the stream is handed to three different stacks.
 * Hono gives a `Response` to `Bun.serve`, to `Deno.serve` or to
 * `@hono/node-server`, and each pulls the body on its own schedule; Fastify
 * writes into `node:http`, which Bun and Deno each emulate.  The contract
 * suite under `bun test` sees only Bun, so this case is what holds Node and
 * Deno to the same three clauses:
 *
 * - a failure before the first byte reaches the error handler installed with
 *   `withErrorHandler`, and is answered by it;
 * - a failure after the response was committed reaches the stream-failure
 *   handler once, with the request;
 * - a client that disconnects before the first chunk exists cancels the
 *   source — Hono reads that chunk before the `Response` exists, so only the
 *   runtime request's abort signal can release it there.
 *
 * `hono` (and, on Node, `@hono/node-server`) are optional peer dependencies,
 * so a runtime that cannot load them skips that backend rather than fails.
 */
import net from 'node:net';

export const name = 'http stream body failure';
export const description = 'a failing stream body reaches the error handler before its first byte and the stream-failure handler after it';

const FAILURE = 'upstream row cursor died';
/** Generous on a cold runtime; a healthy exchange settles in milliseconds. */
const SETTLE_TIMEOUT_MS = 4000;

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const http = await loadEntry('http');
  const backends = [
    { label: 'fastify', make: () => new http.FastifyBackend({ logger: false }), probe: () => import('fastify') },
    { label: 'hono', make: () => new http.HonoBackend(), probe: () => import('hono') },
  ];
  for (const { label, make, probe } of backends) {
    try {
      await probe();
    } catch (e) {
      console.log(`  (skipped ${label}: not loadable on this runtime — ${e.message})`);
      continue;
    }
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(`smoke-stream-failure-${label}`, systemOptions);
    let binding;
    try {
      binding = await bindOrSkip(http, system, make(), label);
      if (binding === undefined) continue;
      await assertContract(runtime, label, binding.backend, `http://127.0.0.1:${binding.binding.port}`, binding.state);
    } finally {
      if (binding !== undefined) await binding.binding.unbind();
      await system.terminate();
    }
  }
}

async function bindOrSkip(http, system, backend, label) {
  const { path, get, concat } = http;
  const state = { errorsHandled: [], cancelled: false, pulled: undefined };
  const routes = concat(
    path('early', get(() => ({ status: 200, body: failingAtOnce() }))),
    path('late', get(() => ({ status: 200, body: failingAfterFirstChunk(new TextEncoder().encode('first chunk;')) }))),
    path('never', get(() => {
      const source = neverFirstChunk(() => { state.cancelled = true; });
      state.pulled = source.pulled;
      return { status: 200, body: source.body };
    })),
  );
  try {
    const bound = await system.extension(http.HttpExtensionId)
      .newServerAt('127.0.0.1', await freePort())
      .useBackend(backend)
      .withErrorHandler((err) => {
        state.errorsHandled.push(err);
        return { status: 502, body: 'upstream failed', contentType: 'text/plain' };
      })
      .bind(routes);
    return { binding: bound, backend, state };
  } catch (e) {
    console.log(`  (skipped ${label}: cannot bind on this runtime — ${e.message})`);
    return undefined;
  }
}

async function assertContract(runtime, label, backend, url, state) {
  // Before the first byte: the error handler answers.
  const early = await outcomeOf(`${url}/early`);
  assert(
    early.status === 502 && early.completed && early.body === 'upstream failed',
    `${label}: a source failing before its first byte was answered ${JSON.stringify(early)}, not by the error handler`,
  );
  assert(
    state.errorsHandled.length === 1 && state.errorsHandled[0]?.message === FAILURE,
    `${label}: the error handler saw ${state.errorsHandled.length} error(s), expected the source's one`,
  );

  // After the commit: the stream-failure handler is told, once, with the request.
  assert(typeof backend.setStreamFailureHandler === 'function', `${label}: no setStreamFailureHandler`);
  const failures = [];
  backend.setStreamFailureHandler((err, request) => { failures.push({ err, request }); });
  const late = await outcomeOf(`${url}/late`, { tolerateHang: runtime === 'deno' && label === 'fastify' });
  assert(!late.completed, `${label}: a source failing mid-body ended in a complete response`);
  if (late.hung) {
    console.log(
      `  (known on ${runtime} with ${label}: Deno's node:http does not end a response destroyed after its first `
        + 'write, so the truncated body never settles for the client — a plain node:http server shows the same; '
        + 'the failure is still reported, which is what is asserted below)',
    );
  }
  await waitFor(() => failures.length > 0, `${label}: the post-commit failure was never reported`);
  assert(failures.length === 1, `${label}: the post-commit failure was reported ${failures.length} times`);
  assert(failures[0].err?.message === FAILURE, `${label}: reported ${failures[0].err}, not the source's failure`);
  assert(failures[0].request?.path === '/late', `${label}: reported against ${failures[0].request?.path}, not /late`);
  assert(state.errorsHandled.length === 1, `${label}: the post-commit failure also reached the error handler`);

  // A client gone before the first chunk releases the source.
  const controller = new AbortController();
  const response = fetch(`${url}/never`, { signal: controller.signal }).catch(() => undefined);
  await waitFor(() => state.pulled !== undefined, `${label}: the never-ready route did not run`);
  await state.pulled;
  controller.abort();
  const settled = await response;
  await settled?.body?.cancel().catch(() => {});
  await waitFor(() => state.cancelled, `${label}: a client gone before the first chunk left the source open`);
}

/**
 * What a client saw: the status (0 when reset before one arrived) and whether
 * the body completed.  A body that never settles is a failure unless
 * `tolerateHang` says the runtime is known to leave it open; the deadline's
 * abort closes the socket either way, so nothing outlives the case.
 */
async function outcomeOf(url, { tolerateHang = false } = {}) {
  const signal = AbortSignal.timeout(SETTLE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (e) {
    if (signal.aborted) throw new Error(`no outcome within ${SETTLE_TIMEOUT_MS} ms for ${url}: the response hung`);
    return { status: 0, completed: false, body: '' };
  }
  try {
    return { status: response.status, completed: true, body: await response.text() };
  } catch (e) {
    if (signal.aborted) {
      if (tolerateHang) return { status: response.status, completed: false, hung: true, body: '' };
      throw new Error(`the body of ${url} never settled within ${SETTLE_TIMEOUT_MS} ms`);
    }
    return { status: response.status, completed: false, body: '' };
  }
}

/** One chunk, then a source that fails — `pull` runs a macrotask late, so the chunk is on the wire first. */
function failingAfterFirstChunk(first) {
  let sent = false;
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      throw new Error(FAILURE);
    },
  });
}

/** A source that fails before it has produced a byte. */
function failingAtOnce() {
  return new ReadableStream({
    async pull() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error(FAILURE);
    },
  });
}

/** A source whose first chunk never comes; `pulled` resolves once something asked for it. */
function neverFirstChunk(onCancel) {
  let signalPulled;
  const pulled = new Promise((resolve) => { signalPulled = resolve; });
  const body = new ReadableStream({
    pull() {
      signalPulled();
      return new Promise(() => { /* the first chunk never arrives */ });
    },
    cancel() { onCancel(); },
  }, { highWaterMark: 0 });
  return { body, pulled };
}

/**
 * A port that is free right now — `newServerAt(host, 0)` reports 0 back on
 * Deno's Hono runner, so the case asks for a concrete one (see case 24).
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

async function waitFor(condition, message) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
