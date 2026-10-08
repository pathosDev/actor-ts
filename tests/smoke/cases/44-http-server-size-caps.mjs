/**
 * Smoke case: the two server size caps, `actor-ts.http.server.max-content-length`
 * and `max-header-bytes`, on the runtime the user actually runs (#1488).
 *
 * `tests/unit/http/BodySizeParity.test.ts` and `HeaderSizeParity.test.ts`
 * prove the mechanism under `bun test`.  What they cannot show is the Hono
 * backend on the other two runtimes, because the backend picks its runner by
 * runtime: under `bun test` it is always `Bun.serve`.  This case binds the
 * Hono backend from HOCON on whichever runtime the harness is on.
 *
 *   - **Body cap, every runtime.**  The backend reads bodies in code of its
 *     own, so a 1 KiB POST under `max-content-length = 16` is refused before
 *     the handler runs on Bun, Node and Deno alike.
 *   - **Header cap, Node.**  The Node runner writes the cap into
 *     `@hono/node-server`'s `serverOptions` as `maxHeaderSize` — the first
 *     thing anything puts in that bag, and nothing else exercises the channel
 *     on a real Node — so a request carrying a 4 KiB header under
 *     `max-header-bytes = 1024` never reaches the handler.
 *   - **Header cap, Bun and Deno.**  `Bun.serve` and `Deno.serve` take no
 *     per-server header cap, so the binding's report must say the cap is not
 *     installed — the state `bind()` warns about — rather than claim it.
 *
 * Every assertion about a refusal reads "the handler was not reached" and
 * "the exchange ended", never a particular status: a server that gives up on
 * a request mid-write can reset the connection, and the client then sees the
 * reset instead of the `413` or `431` that was sent.  The client is
 * `node:http`, which all three runtimes provide, and every request is
 * destroyed on every path, so no outcome leaves a handle open.
 *
 * Skips when `hono` cannot be loaded on this runtime, like the other Hono
 * cases — but once a server binds, every check below MUST hold.
 */
import { request as httpRequest } from 'node:http';

export const name = 'http server size caps';
export const description = 'the Hono backend refuses a body over max-content-length on every runtime, keeps an oversized header from the handler on Node, and reports the header cap not installed on Bun and Deno';

const SETTLE_TIMEOUT_MS = 5_000;
const BODY_CAP_BYTES = 16;
const HEADER_CAP_BYTES = 1024;

/**
 * One request through `node:http`.  Resolves with the status, or with
 * `'hung up'` when the server ended the exchange without an answer the
 * client could read; rejects only when nothing at all happened before the
 * deadline.  The request is destroyed on every path.
 */
function exchange({ port, method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome, failed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (failed) reject(outcome);
      else resolve(outcome);
    };
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      finish(res.statusCode, false);
    });
    req.on('error', () => finish('hung up', false));
    const timer = setTimeout(() => finish(new Error(`no answer and no hang-up within ${SETTLE_TIMEOUT_MS}ms`), true), SETTLE_TIMEOUT_MS);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

export async function run({ actorTs, runtime, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, completeText, concat, get, path, post } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({
      'actor-ts': {
        http: {
          backend: 'hono',
          server: { 'max-content-length': BODY_CAP_BYTES, 'max-header-bytes': HEADER_CAP_BYTES },
        },
      },
    });
  const system = ActorSystem.create('smoke-http-size-caps', systemOptions);
  const reached = { get: 0, post: 0 };
  const routes = concat(
    path('', get(() => {
      reached.get += 1;
      return completeText(200, 'reached');
    })),
    path('up', post(() => {
      reached.post += 1;
      return completeText(200, 'reached');
    })),
  );
  let binding;
  try {
    try {
      binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
    } catch (e) {
      console.log(`  (skipped: could not bind the Hono backend on this runtime — ${e.message})`);
      return;
    }
    const port = binding.port;
    const report = binding.serverOptionsReport;

    /* --- 1. the body cap holds on every runtime ---------------------------- */
    if (report?.maxContentLength !== true) {
      throw new Error(`the binding reports max-content-length ${JSON.stringify(report?.maxContentLength)}, not in effect, on ${runtime}`);
    }
    const small = await exchange({ port, method: 'POST', path: '/up', headers: { 'content-type': 'application/octet-stream' }, body: 'x'.repeat(BODY_CAP_BYTES) });
    if (small !== 200 || reached.post !== 1) {
      throw new Error(`a body at the cap was answered ${small} with the handler reached ${reached.post} time(s) — the server refuses what it should take`);
    }
    const oversized = await exchange({ port, method: 'POST', path: '/up', headers: { 'content-type': 'application/octet-stream' }, body: 'x'.repeat(1024) });
    if (reached.post !== 1) {
      throw new Error(`a 1 KiB body reached the handler through max-content-length = ${BODY_CAP_BYTES} (answered ${oversized})`);
    }
    if (oversized !== 413 && oversized !== 'hung up') {
      throw new Error(`a 1 KiB body over max-content-length = ${BODY_CAP_BYTES} was answered ${oversized}`);
    }

    /* --- 2. the header cap: built in on Node, reported absent on Bun/Deno ---- */
    const plain = await exchange({ port, method: 'GET', path: '/' });
    if (plain !== 200 || reached.get !== 1) {
      throw new Error(`a request with ordinary headers was answered ${plain} — the server refuses what it should take`);
    }
    if (runtime === 'node') {
      if (report?.maxHeaderBytes !== true) {
        throw new Error(`the binding reports max-header-bytes ${JSON.stringify(report?.maxHeaderBytes)} on Node, where @hono/node-server builds it in`);
      }
      const padded = await exchange({ port, method: 'GET', path: '/', headers: { 'x-padding': 'a'.repeat(4 * HEADER_CAP_BYTES) } });
      if (reached.get !== 1) {
        throw new Error(`a 4 KiB header reached the handler through max-header-bytes = ${HEADER_CAP_BYTES} (answered ${padded}) — the cap never reached @hono/node-server`);
      }
    } else if (report?.maxHeaderBytes !== false) {
      throw new Error(`the binding reports max-header-bytes ${JSON.stringify(report?.maxHeaderBytes)} on ${runtime}, whose serve() takes no per-server header cap — it must say not installed`);
    }
  } finally {
    if (binding) await binding.unbind().catch(() => {});
    await system.terminate();
  }
}
