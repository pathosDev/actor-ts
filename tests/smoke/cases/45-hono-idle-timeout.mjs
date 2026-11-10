/**
 * Smoke case: `actor-ts.http.server.idle-timeout` on the Hono backend, on the
 * runtime the user actually runs (#1487).
 *
 * The Hono backend picks its runner by runtime, so under `bun test` it is
 * always `Bun.serve` and `tests/unit/http/HonoBunIdleTimeout.test.ts` cannot
 * see the other two.  Each runtime holds the key differently, and this case
 * asserts each outcome rather than one behaviour everywhere:
 *
 *   - **Bun** — `Bun.serve`'s own `idleTimeout`, in whole seconds and checked
 *     on a 4 s sweep: an idle keep-alive connection is closed within one sweep
 *     of a 2 s setting.
 *   - **Node** — `keepAliveTimeout` on the `node:http` server
 *     `@hono/node-server` hands back: closed 2 s after the response plus the
 *     second Node adds to it — 3.0 s on node v26.10.0, the `Keep-Alive` header
 *     telling the client `timeout=2` — and not at once.
 *   - **Deno** — `Deno.serve` has no idle knob, so nothing is installed: the
 *     connection stays open past the window the other two close it in, and the
 *     binding's report says idle-timeout is not in effect — the state `bind()`
 *     warns about — rather than claim it.
 *
 * The client is `node:net`, which all three runtimes provide.  The socket is
 * destroyed and every timer cleared on every path, the server unbound and the
 * system terminated in `finally`, so no outcome leaves a handle open — a socket
 * abandoned on a failure path would keep Deno's event loop alive after the
 * last green line (#1196).
 *
 * Skips when `hono` cannot be loaded on this runtime, like the other Hono
 * cases — but once a server binds, every check below MUST hold.
 */
import { connect } from 'node:net';

export const name = 'hono idle-timeout';
export const description = 'the Hono backend closes an idle keep-alive connection under idle-timeout = 2s within one sweep on Bun and after 2 s plus its padding on Node, and reports it not installed on Deno, where the connection stays open';

const IDLE_TIMEOUT_MS = 2_000;
/** Bun's idle sweep plus slack: the latest an idle connection may close on Bun or Node. */
const CLOSE_WITHIN_MS = 5_000;
/** How long the connection must survive on Deno — past every window the other two close it in. */
const DENO_OPEN_FOR_MS = 6_000;
const ANSWER_WITHIN_MS = 5_000;

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
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      // `idle` is the whole body: once it is in, the connection is idle.
      if (answeredAt === undefined && received.endsWith('idle')) {
        answeredAt = Date.now();
        clearTimeout(answerTimer);
        idleTimer = setTimeout(() => finish(null, false), withinMs);
      }
    });
    socket.on('error', () => { /* observed as the close that follows */ });
    socket.on('close', () => {
      if (answeredAt === undefined) finish(new Error(`the connection closed before a complete response: ${JSON.stringify(received.slice(0, 200))}`), true);
      else finish(Date.now() - answeredAt, false);
    });
    answerTimer = setTimeout(() => finish(new Error(`no complete response within ${ANSWER_WITHIN_MS}ms`), true), ANSWER_WITHIN_MS);
  });
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpServerOptions, completeText, get, path } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend: 'hono' } } });
  const system = ActorSystem.create('smoke-hono-idle-timeout', systemOptions);
  const serverOptions = HttpServerOptions.create().withIdleTimeoutMs(IDLE_TIMEOUT_MS);
  let binding;
  try {
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .withServerOptions(serverOptions)
        .bind(path('', get(() => completeText(200, 'idle'))));
    } catch (e) {
      console.log(`  (skipped: could not bind the Hono backend on this runtime — ${e.message})`);
      return;
    }
    const report = binding.serverOptionsReport;

    if (runtime === 'deno') {
      if (report?.idleTimeoutMs !== false) {
        throw new Error(`the binding reports idle-timeout ${JSON.stringify(report?.idleTimeoutMs)} on Deno, whose Deno.serve has no idle knob — it must say not installed`);
      }
      const closedAfterMs = await idleCloseAfterResponse(binding.port, DENO_OPEN_FOR_MS);
      if (closedAfterMs !== null) {
        throw new Error(`Deno closed an idle connection ${closedAfterMs} ms after its response under idle-timeout = 2s, which it reports not installed — the report or this case is wrong`);
      }
      return;
    }

    if (report?.idleTimeoutMs !== true) {
      throw new Error(`the binding reports idle-timeout ${JSON.stringify(report?.idleTimeoutMs)} on ${runtime}, where the Hono runner installs it`);
    }
    const closedAfterMs = await idleCloseAfterResponse(binding.port, CLOSE_WITHIN_MS);
    if (closedAfterMs === null) {
      throw new Error(`an idle keep-alive connection was still open ${CLOSE_WITHIN_MS} ms after its response under idle-timeout = 2s on ${runtime}`);
    }
    // Node arms keepAliveTimeout plus a second and is not swept, so a close
    // well before the value means something other than the idle timeout
    // closed the connection.  Bun's sweep can close it up to one sweep early,
    // so there is no floor there.
    if (runtime === 'node' && closedAfterMs < IDLE_TIMEOUT_MS - 500) {
      throw new Error(`Node closed an idle keep-alive connection ${closedAfterMs} ms after its response, before idle-timeout = 2s`);
    }
  } finally {
    if (binding) await binding.unbind().catch(() => {});
    await system.terminate();
  }
}
