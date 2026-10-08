import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type { HttpServerBackend, RouteRegistration, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
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

/** Bind under `hocon` with `configure` applied, and hand back the binding and what the system logged. */
async function bindUnder(hocon: string, configure: (builder: ServerBuilder) => ServerBuilder = (builder) => builder): Promise<Bound> {
  const logger = new RecordingLogger(LogLevel.Info);
  const options = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create('http-server-options-report', options);
  const binding = await configure(system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0)).bind(routes);
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

    expect(binding.serverOptionsReport).toEqual({
      idleTimeoutMs: false,
      headerTimeoutMs: false,
      requestTimeoutMs: false,
      maxConnections: false,
    });
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
