/**
 * Smoke case: `idle-timeout` and `request-timeout` on the Express and Fastify
 * backends say what they hold on the runtime the user actually runs.
 *
 * Both are properties written onto the `node:http` server after `listen()` —
 * `keepAliveTimeout` and `requestTimeout`.  Node and Bun apply them; Deno's
 * `node:http` shim accepted both and applied neither until deno 2.7.13.
 * Measured on deno 2.6.8 under `idle-timeout = 600ms` and
 * `request-timeout = 2s`, with Express and with Fastify: a keep-alive
 * connection was still open 3 s after its response, and a stalled body still
 * open after 40 s with no `408`, while the report said both were in effect and
 * `bind()` warned about nothing.  From 2.7.13 on Deno closes both as Node does
 * (#1793).  `bun test` runs on Bun, so only this case sees the real Deno.
 * Each runtime's outcome is asserted:
 *
 *   - **Bun and Node** — both reported in effect, nothing warned, and an idle
 *     keep-alive connection closed within 3 s of its response (1.6 s measured:
 *     the 600 ms plus the second Node adds to `keepAliveTimeout`).
 *   - **Deno** — whichever release runs, the report must say what the
 *     connection does, so the idle close is measured first and is the probe:
 *     closed within 3 s, and both must be reported in effect with nothing
 *     warned; still open, and both must be reported not in effect, with one
 *     warning at `bind()` naming both keys.  The two halves moved in one Deno
 *     release, so the idle close answers for the stalled body too, which is
 *     not waited out here: it needs the 30 s sweep to tell the two apart.
 *
 * The client is `node:net`, which all three runtimes provide.  The socket is
 * destroyed and every timer cleared on every path, the server unbound and the
 * system terminated in `finally`, so no outcome leaves a handle open (#1196).
 * A backend whose package cannot be loaded on this runtime is skipped by name;
 * once a server binds, every check below must hold.
 */
import { connect } from 'node:net';

export const name = 'node:http timeouts on deno';
export const description = 'the Express and Fastify backends report idle-timeout and request-timeout in effect on Bun and Node, where an idle connection closes, and on Deno exactly as its release behaves: in effect where the connection closes, not in effect where it stays open, with bind() naming both';

const IDLE_TIMEOUT_MS = 600;
const REQUEST_TIMEOUT_MS = 2_000;
/** Past the 1.6 s Node and Bun close in; on Deno the connection must still be open then. */
const WINDOW_MS = 3_000;
const ANSWER_WITHIN_MS = 5_000;
const IDLE_TIMEOUT_LEAF = 'actor-ts.http.server.idle-timeout';
const REQUEST_TIMEOUT_LEAF = 'actor-ts.http.server.request-timeout';

/** A logger that keeps the warnings and drops everything else. */
function warningLogger(level) {
  const warnings = [];
  const logger = {
    level,
    debug() {},
    info() {},
    error() {},
    warn(message) { warnings.push(String(message)); },
    withSource() { return logger; },
    withFields() { return logger; },
  };
  return { logger, warnings };
}

/**
 * One request on a fresh keep-alive connection, then wait: resolves with how
 * long after the complete response the server closed the connection, or with
 * `null` when it was still open `withinMs` later.  Rejects when no complete
 * response arrives.  The socket is destroyed and every timer cleared on every
 * path.
 */
function idleCloseAfterResponse(port, withinMs) {
  return new Promise((resolve, reject) => {
    let received = '';
    let answeredAt;
    let answerTimer;
    let idleTimer;
    let settled = false;
    const finish = (outcome, failed) => {
      if (settled) return;
      settled = true;
      clearTimeout(answerTimer);
      clearTimeout(idleTimer);
      socket.destroy();
      if (failed) reject(outcome);
      else resolve(outcome);
    };
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    });
    answerTimer = setTimeout(() => finish(new Error(`no complete response within ${ANSWER_WITHIN_MS} ms: ${JSON.stringify(received)}`), true), ANSWER_WITHIN_MS);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      if (answeredAt === undefined && /\r\n\r\n[\s\S]*idle/.test(received)) {
        answeredAt = performance.now();
        clearTimeout(answerTimer);
        idleTimer = setTimeout(() => finish(null, false), withinMs);
      }
    });
    socket.on('error', () => { /* observed as the close that follows */ });
    socket.on('close', () => {
      if (answeredAt === undefined) finish(new Error(`closed before a complete response: ${JSON.stringify(received)}`), true);
      else finish(Math.round(performance.now() - answeredAt), false);
    });
  });
}

async function checkBackend({ actorTs, runtime, http, backend, backendInstance }) {
  const { ActorSystem, ActorSystemOptions, LogLevel } = actorTs;
  const { HttpExtensionId, HttpServerOptions, completeText, get, path } = http;
  const { logger, warnings } = warningLogger(LogLevel.Info);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info);
  const system = ActorSystem.create(`smoke-timeouts-${backend}`, systemOptions);
  const serverOptions = HttpServerOptions.create()
    .withIdleTimeoutMs(IDLE_TIMEOUT_MS)
    .withRequestTimeoutMs(REQUEST_TIMEOUT_MS);
  let binding;
  try {
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(backendInstance)
        .withServerOptions(serverOptions)
        .bind(path('', get(() => completeText(200, 'idle'))));
    } catch (e) {
      console.log(`  (skipped ${backend}: could not bind on this runtime — ${e.message})`);
      return;
    }
    const report = binding.serverOptionsReport;
    const naming = warnings.filter((warning) => warning.includes(IDLE_TIMEOUT_LEAF) || warning.includes(REQUEST_TIMEOUT_LEAF));

    if (runtime === 'deno') {
      const closedAfterMs = await idleCloseAfterResponse(binding.port, WINDOW_MS);
      const applied = closedAfterMs !== null;
      const said = `Deno ${applied ? `closed an idle ${backend} connection ${closedAfterMs} ms after its response` : `held an idle ${backend} connection open ${WINDOW_MS} ms after its response`} under idle-timeout = ${IDLE_TIMEOUT_MS}ms`;
      if (report?.idleTimeoutMs !== applied || report?.requestTimeoutMs !== applied) {
        throw new Error(`${said}, but ${backend} reports idle-timeout ${JSON.stringify(report?.idleTimeoutMs)} and request-timeout ${JSON.stringify(report?.requestTimeoutMs)} — both must be ${applied}`);
      }
      if (applied && naming.length !== 0) {
        throw new Error(`${said}, but bind() warned about bounds that hold: ${JSON.stringify(naming)}`);
      }
      if (!applied && (naming.length !== 1 || !naming[0].includes(IDLE_TIMEOUT_LEAF) || !naming[0].includes(REQUEST_TIMEOUT_LEAF))) {
        throw new Error(`${said}: bind() must name both keys in one warning, logged ${JSON.stringify(warnings)}`);
      }
      return;
    }

    if (report?.idleTimeoutMs !== true || report?.requestTimeoutMs !== true) {
      throw new Error(`${backend} reports idle-timeout ${JSON.stringify(report?.idleTimeoutMs)} and request-timeout ${JSON.stringify(report?.requestTimeoutMs)} on ${runtime}, whose node:http applies both`);
    }
    if (naming.length !== 0) {
      throw new Error(`${backend} on ${runtime}: bind() warned about bounds that hold: ${JSON.stringify(naming)}`);
    }
    const closedAfterMs = await idleCloseAfterResponse(binding.port, WINDOW_MS);
    if (closedAfterMs === null) {
      throw new Error(`an idle ${backend} connection was still open ${WINDOW_MS} ms after its response under idle-timeout = ${IDLE_TIMEOUT_MS}ms on ${runtime}`);
    }
  } finally {
    if (binding) await binding.unbind();
    await system.terminate();
  }
}

export async function run({ actorTs, runtime, loadEntry }) {
  const http = await loadEntry('http');

  let expressLoadable = true;
  try {
    await import('express');
  } catch (e) {
    expressLoadable = false;
    console.log(`  (skipped express: not loadable on this runtime — ${e.message})`);
  }
  if (expressLoadable) {
    await checkBackend({ actorTs, runtime, http, backend: 'express', backendInstance: new http.ExpressBackend() });
  }

  let fastifyLoadable = true;
  try {
    await import('fastify');
  } catch (e) {
    fastifyLoadable = false;
    console.log(`  (skipped fastify: not loadable on this runtime — ${e.message})`);
  }
  if (fastifyLoadable) {
    await checkBackend({ actorTs, runtime, http, backend: 'fastify', backendInstance: new http.FastifyBackend() });
  }
}
