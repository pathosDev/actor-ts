import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import {
  applyServerOptions,
  enforceMaxConnections,
  type HttpServerBackend,
  type NodeHttpServerLike,
  type RouteRegistration,
  type ServerBinding,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { requestTimeout } from '../../../src/http/middleware/Timeout.js';
import { completeText, get, path, withMiddleware, type Route } from '../../../src/http/Route.js';
import { LogLevel } from '../../../src/Logger.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/**
 * #870 — an `actor-ts.http.server` bound the backend could not put into effect
 * is said out loud at `bind()`, once, by name.
 *
 * All three backends used to discard what `applyServerOptions` reported, so an
 * operator who set `max-connections` on the Hono backend under Bun — where
 * `Bun.serve` exposes no server for any of these bounds — got a server that
 * accepted every connection and a log that said nothing about it.  Measured on
 * the tree before this report: two records at bind, neither a warning.
 *
 * Under `bun test` the Hono backend runs on `Bun.serve`, so it is the backend
 * that installs none of the four; Fastify and Express hand over a `node:http`
 * server and install all of them.
 *
 * "Set" means what the deployment chose: a field named in `withServerOptions`,
 * or a leaf of the HOCON block that differs from what `reference.conf` ships —
 * the rule the unread-middleware warning uses too.  The shipped `header-timeout`
 * and `request-timeout` are in every resolved policy, and a warning for them on
 * every Hono-on-Bun bind would be noise about a choice nobody made.
 */

const running: Array<{ system: ActorSystem; binding: ServerBinding }> = [];
afterEach(async () => {
  while (running.length) {
    const { system, binding } = running.pop()!;
    await binding.unbind();
    await system.terminate();
  }
});

const routes = path('', get(() => completeText(200, 'ok')));

const INERT_BLOCK = `
  max-connections = 5
  request-timeout = 20s
`;

type Bound = { readonly binding: ServerBinding; readonly records: readonly RecordedLog[]; readonly warnings: readonly string[] };

/** Bind `boundRoutes` under `hocon` with `configure` applied, and hand back the binding and what the system logged. */
async function bindUnder(
  hocon: string,
  configure: (builder: ServerBuilder) => ServerBuilder = (builder) => builder,
  boundRoutes: Route = routes,
): Promise<Bound> {
  const logger = new RecordingLogger(LogLevel.Info);
  const options = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create('http-server-options-report', options);
  const binding = await configure(system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0)).bind(boundRoutes);
  running.push({ system, binding });
  const warnings = logger.records.filter((record) => record.level === 'warn').map((record) => record.message);
  return { binding, records: logger.records, warnings };
}

/** HOCON selecting `backend`, with an `actor-ts.http.server` block only when one is given. */
const onBackend = (backend: string, serverBlock?: string): string =>
  serverBlock === undefined
    ? `actor-ts.http.backend = ${backend}`
    : `actor-ts.http { backend = ${backend}, server { ${serverBlock} } }`;

describe('a configured server bound the backend did not install is reported at bind()', () => {
  test('on the Hono backend, once, naming every key it left inert and the backend', async () => {
    const { binding, records, warnings } = await bindUnder(onBackend('hono', INERT_BLOCK));

    expect(warnings, 'an inert actor-ts.http.server block was bound in silence').toHaveLength(1);
    const [warning] = warnings as [string];
    expect(warning.startsWith(`[http] ${binding.host}:${binding.port}: `), warning).toBe(true);
    expect(warning).toContain('actor-ts.http.server.max-connections');
    expect(warning).toContain('actor-ts.http.server.request-timeout');
    expect(warning).toContain('"hono"');
    // Nobody set these two, so the warning has no business naming them.
    expect(warning).not.toContain('header-timeout');
    expect(warning).not.toContain('idle-timeout');
    // After the bound line, so it names the port actually taken.
    const boundAt = records.findIndex((record) => record.level === 'info' && record.message.startsWith('HTTP server bound on'));
    const warnedAt = records.findIndex((record) => record.level === 'warn');
    expect(boundAt).toBeGreaterThanOrEqual(0);
    expect(warnedAt).toBeGreaterThan(boundAt);
  });

  test('the binding bind() returns carries the backend\'s report', async () => {
    const { binding } = await bindUnder(onBackend('hono', INERT_BLOCK));

    // The two caps fixed when the server is built are absent rather than
    // false: INERT_BLOCK sets neither, so there was nothing to build in.
    expect(binding.serverOptionsReport).toEqual({
      idleTimeoutMs: false,
      headerTimeoutMs: false,
      requestTimeoutMs: false,
      maxConnections: false,
    });
    expect(binding.serverOptionsReport).not.toHaveProperty('maxContentLength');
    expect(binding.serverOptionsReport).not.toHaveProperty('maxHeaderBytes');
  });

  test('max-header-bytes on the Hono backend under Bun is named in the warning — Bun.serve has no per-server header cap', async () => {
    // The "reported unavailable" half of the header cap (#1488): Bun.serve and
    // Deno.serve take no per-server maxHeaderSize, so the runner applies
    // nothing and bind() says so rather than binding a cap that holds nothing.
    const { binding, warnings } = await bindUnder(onBackend('hono', 'max-header-bytes = 1KiB'));

    expect(binding.serverOptionsReport?.maxHeaderBytes).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('actor-ts.http.server.max-header-bytes');
    expect(warnings[0]).toContain('"hono"');
  });

  test.each(['fastify', 'express'])('max-header-bytes is in effect on %s, which builds its server with it, and nothing is said', async (backend) => {
    const { binding, warnings } = await bindUnder(onBackend(backend, 'max-header-bytes = 1KiB'));

    expect(binding.serverOptionsReport?.maxHeaderBytes).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('an unset max-header-bytes is absent from the report on every backend — there was nothing to build in', async () => {
    for (const backend of ['fastify', 'express', 'hono']) {
      const { binding } = await bindUnder(onBackend(backend));
      expect(binding.serverOptionsReport).not.toHaveProperty('maxHeaderBytes');
    }
  });

  test.each(['fastify', 'express', 'hono'])('max-content-length is in effect on %s — each backend caps bodies itself — and never warned', async (backend) => {
    // The one bound every shipped backend holds wherever it runs: the body cap
    // is the backend's own code, not a property of a node:http server, so
    // Hono under Bun holds it as Fastify and Express do (#1488).
    const { binding, warnings } = await bindUnder(onBackend(backend, 'max-content-length = 4KiB'));

    expect(binding.serverOptionsReport?.maxContentLength).toBe(true);
    expect(warnings).toEqual([]);
  });

  test.each(['fastify', 'express'])('the same block on %s is in effect, and nothing is said', async (backend) => {
    const { binding, warnings } = await bindUnder(onBackend(backend, INERT_BLOCK));

    expect(warnings).toEqual([]);
    expect(binding.serverOptionsReport?.maxConnections).toBe(true);
    expect(binding.serverOptionsReport?.requestTimeoutMs).toBe(true);
  });

  test('withServerOptions values are reported like HOCON ones', async () => {
    const serverOptions = HttpServerOptions.create()
      .withHeaderTimeoutMs(10_000)
      .withMaxConnections(5);
    const { warnings } = await bindUnder(onBackend('hono'), (builder) => builder.withServerOptions(serverOptions));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('actor-ts.http.server.header-timeout');
    expect(warnings[0]).toContain('actor-ts.http.server.max-connections');
    expect(warnings[0]).not.toContain('request-timeout');
  });

  test('an unset block is never warned — the shipped header-timeout and request-timeout are nobody\'s choice', async () => {
    const { warnings } = await bindUnder(onBackend('hono'));

    expect(warnings).toEqual([]);
  });

  test('a block set to exactly its shipped values is not warned either', async () => {
    // The same rule the unread-middleware warning applies: a value equal to
    // what reference.conf ships configures exactly what not setting it does.
    const { warnings } = await bindUnder(onBackend('hono', 'header-timeout = 60s\nrequest-timeout = 300s'));

    expect(warnings).toEqual([]);
  });

  test('Infinity is the code spelling of an unset cap, and is not warned', async () => {
    const serverOptions = HttpServerOptions.create().withMaxConnections(Infinity);
    const { warnings } = await bindUnder(onBackend('hono'), (builder) => builder.withServerOptions(serverOptions));

    expect(warnings).toEqual([]);
  });

  test('the layer that wins a field decides whether it was set — a HOCON cap lifted in code is not warned', async () => {
    // The configured 5 governs nothing once code says Infinity, so a warning
    // naming it would send the operator after a key that is not in play.
    const serverOptions = HttpServerOptions.create().withMaxConnections(Infinity);
    const { warnings } = await bindUnder(
      onBackend('hono', 'max-connections = 5'),
      (builder) => builder.withServerOptions(serverOptions),
    );

    expect(warnings).toEqual([]);
  });

  test('a server whose connection event never fires is still reported as guarded — the one gap the report cannot see', () => {
    // Pinned rather than fixed.  Deno's node:http shim offers `on` but never
    // emits 'connection' — a complete request fires 'request' and nothing
    // else (deno 2.6.8) — so on Fastify or Express under Deno, pairs this
    // project does not support, the header deadline and the connection cap
    // both install, report in effect, and never fire, and bind() has nothing
    // to warn about.  The configuration reference's http.server section states
    // that gap in both languages.  Nothing at install time can tell this
    // server from Node's; seeing it means noticing the first 'request' that
    // arrives with no 'connection' before it — after the bind-time warning has
    // run.  The day the report learns to, this case goes red, and the
    // sentence in the docs goes with it.
    const listeners = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
    const record = (event: string, listener: (...args: ReadonlyArray<unknown>) => void): unknown => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    };
    const shim: NodeHttpServerLike = { on: record as NodeHttpServerLike['on'] };

    const report = applyServerOptions(shim, { headerTimeoutMs: 1_000, maxConnections: 1 });
    const cap = enforceMaxConnections(shim, 1);
    // What the shim does emit: one 'request' per complete request, never a
    // 'connection' — so the cap counts nothing and no deadline is ever armed.
    for (let i = 0; i < 3; i++) {
      for (const listener of listeners.get('request') ?? []) listener({}, {});
    }

    expect(report.headerTimeoutMs).toBe(true);
    expect(report.maxConnections).toBe(true);
    expect(cap()).toEqual({ installed: true, seen: 0, refused: 0, held: 0 });
  });

  test('idle-timeout set on the Hono backend under Bun is in effect and no longer named — Bun.serve holds it (#1487)', async () => {
    // Beside a key Bun still cannot hold, so the warning that remains shows
    // the idle timeout is left out of it rather than the warning gone.
    const { binding, warnings } = await bindUnder(onBackend('hono', 'idle-timeout = 30s\nmax-connections = 5'));

    expect(binding.serverOptionsReport?.idleTimeoutMs).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('actor-ts.http.server.max-connections');
    expect(warnings[0]).not.toContain('idle-timeout');

    const alone = await bindUnder(onBackend('hono', 'idle-timeout = 30s'));
    expect(alone.warnings).toEqual([]);
  });

  describe('a derived idle timeout held at Bun\'s 255 s ceiling is said once at bind() (#1487)', () => {
    // Bun closes a connection whose handler has written nothing for the idle
    // timeout, so unset it is derived from the request deadline — and 255 s,
    // all Bun.serve holds, covers a deadline up to 250 s and no further.
    const heldAtCeiling = (warnings: readonly string[]): string[] =>
      warnings.filter((warning) => warning.includes('the most this runtime can hold'));
    // A tree whose requestTimeout() reads the configured deadline, so the
    // block is not also reported as configured-but-unread.
    const timedRoutes = path('', withMiddleware(requestTimeout(), get(() => completeText(200, 'ok'))));
    const bindTimed = (hocon: string): Promise<Bound> => bindUnder(hocon, undefined, timedRoutes);

    test('a configured deadline past 250 s, naming the key and the deadline it cannot cover', async () => {
      const { binding, warnings } = await bindTimed('actor-ts.http { backend = hono, request-timeout { deadline = 300s } }');

      expect(binding.serverOptionsReport?.idleTimeoutHeldAtCeilingMs).toBe(255_000);
      expect(warnings).toHaveLength(1);
      const [warning] = warnings as [string];
      expect(warning.startsWith(`[http] ${binding.host}:${binding.port}: `), warning).toBe(true);
      expect(warning).toContain('actor-ts.http.server.idle-timeout');
      expect(warning).toContain('300000 ms');
      expect(warning).toContain('255000 ms');
      expect(warning).toContain('withIdleTimeoutMs');
    });

    test('a compiled requestTimeout() past 250 s under the built-in deadline', async () => {
      const longRoute = path('', withMiddleware(requestTimeout(400_000), get(() => completeText(200, 'ok'))));
      const { warnings } = await bindUnder(onBackend('hono'), undefined, longRoute);

      expect(heldAtCeiling(warnings)).toHaveLength(1);
      expect(heldAtCeiling(warnings)[0]).toContain('400000 ms');
    });

    test('the configured deadline counts with no requestTimeout() in the tree at all', async () => {
      // The deployment's word on how long a handler may take holds for every
      // handler, wrapped or not: a plain one silent past the derived timeout
      // is cut just the same.  The block is also reported as unread — no
      // middleware applies it — which is the other warning here.
      const { binding, warnings } = await bindUnder('actor-ts.http { backend = hono, request-timeout { deadline = 300s } }');

      expect(binding.serverOptionsReport?.idleTimeoutHeldAtCeilingMs).toBe(255_000);
      expect(heldAtCeiling(warnings)).toHaveLength(1);
      expect(heldAtCeiling(warnings)[0]).toContain('300000 ms');
    });

    test('nothing is said where 255 s still covers the deadline, where the key is set, or on a backend that derives nothing', async () => {
      expect((await bindTimed('actor-ts.http { backend = hono, request-timeout { deadline = 250s } }')).warnings).toEqual([]);
      expect((await bindTimed('actor-ts.http { backend = hono, request-timeout { deadline = 300s }, server { idle-timeout = 255s } }')).warnings).toEqual([]);
      expect((await bindTimed('actor-ts.http { backend = hono, request-timeout { deadline = 300s }, server { idle-timeout = 0 } }')).warnings).toEqual([]);
      for (const backend of ['fastify', 'express']) {
        const { binding, warnings } = await bindTimed(`actor-ts.http { backend = ${backend}, request-timeout { deadline = 300s } }`);
        expect(warnings, backend).toEqual([]);
        expect(binding.serverOptionsReport, backend).not.toHaveProperty('idleTimeoutHeldAtCeilingMs');
      }
    });
  });

  test('a backend that does not report is taken at its silence', async () => {
    // A backend written outside this repository need not say anything, and
    // "did not say" is not "did not install": nothing is warned.
    const silent: HttpServerBackend = {
      name: 'silent',
      registerRoute(_route: RouteRegistration): void { /* answers nothing */ },
      async listen(host: string, port: number): Promise<ServerBinding> {
        return { host, port, unbind: async () => { /* nothing to close */ } };
      },
    };
    const { binding, warnings } = await bindUnder(onBackend('fastify', INERT_BLOCK), (builder) => builder.useBackend(silent));

    expect(warnings).toEqual([]);
    expect(binding.serverOptionsReport).toBeUndefined();
  });
});
