import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import {
  applyServerOptions,
  enforceMaxConnections,
  type NodeHttpServerLike,
  type ServerBinding,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel } from '../../../src/Logger.js';
import { setRuntimeOverride } from '../../../src/runtime/Detect.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * The connection cap cannot hold on Deno, and the report has to say so — the
 * twin of `HeaderDeadlineOnDeno.test.ts`.
 *
 * `enforceMaxConnections` counts connections on `'connection'`, which Deno's
 * `node:http` and `node:https` never emit.  Measured on deno 2.6.8 through
 * `applyServerOptions` with a cap of one: a second kept-alive connection was
 * answered while the first was still open — node v26.10.0 and bun 1.4.2
 * refused it — and the report said `maxConnections` was in effect, so `bind()`
 * had nothing to warn about.  That is the server Express builds on every
 * runtime, plaintext or TLS, and the one Fastify builds too.
 *
 * Driven through the runtime seam, since `bun test` runs on Bun: the real
 * runtime's behaviour is the measurement above, and this pins what the report
 * and `bind()` make of it.  Whether the cap itself holds off Deno is
 * `MaxConnectionsGuard.test.ts`'s question.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const MAX_CONNECTIONS_LEAF = 'actor-ts.http.server.max-connections';

const servers: Server[] = [];
const running: Array<{ system: ActorSystem; binding: ServerBinding }> = [];

afterEach(async () => {
  setRuntimeOverride(null);
  for (const { system, binding } of running.splice(0)) {
    await binding.unbind().catch(() => {});
    await system.terminate().catch(() => {});
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listening(server: Server): Promise<NodeHttpServerLike> {
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return server as unknown as NodeHttpServerLike;
}

/** Bind an Express backend under `serverOptions` and hand back the binding and the warnings `bind()` logged. */
async function boundOnExpress(serverOptions: HttpServerOptions): Promise<{ binding: ServerBinding; warnings: string[] }> {
  const logger = new RecordingLogger(LogLevel.Info);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info);
  const system = ActorSystem.create('http-connection-cap-on-deno', systemOptions);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new ExpressBackend())
    .withServerOptions(serverOptions)
    .bind(path('', get(() => completeText(200, 'ok'))));
  running.push({ system, binding });
  const warnings = logger.records.filter((record) => record.level === 'warn').map((record) => record.message);
  return { binding, warnings };
}

describe('the connection cap on Deno reports itself not in effect', () => {
  test('on Deno the cap reports itself not installed, on a node:http and a node:https server', async () => {
    setRuntimeOverride('deno');
    const plain = await listening(createHttpServer());
    const secure = await listening(createHttpsServer({ cert: CERT, key: KEY }));
    expect(applyServerOptions(plain, { maxConnections: 2 }).maxConnections).toBe(false);
    expect(applyServerOptions(secure, { maxConnections: 2 }).maxConnections).toBe(false);
    // The live reader says the same, counters and all: nothing was installed.
    const reader = enforceMaxConnections(await listening(createHttpServer()), 1);
    expect(reader()).toEqual({ installed: false, seen: 0, refused: 0, held: 0 });

    // The same servers on a runtime that emits the event report it held.
    setRuntimeOverride(null);
    expect(applyServerOptions(await listening(createHttpServer()), { maxConnections: 2 }).maxConnections).toBe(true);
    expect(enforceMaxConnections(await listening(createHttpServer()), 1)().installed).toBe(true);
  });

  test('bind() warns when max-connections is set for Express on Deno, plaintext and TLS', async () => {
    setRuntimeOverride('deno');
    const plainOptions = HttpServerOptions.create().withMaxConnections(64);
    const plain = await boundOnExpress(plainOptions);
    expect(plain.binding.serverOptionsReport?.maxConnections).toBe(false);
    expect(plain.warnings.some((warning) => warning.includes(MAX_CONNECTIONS_LEAF) && warning.includes('"express"')), plain.warnings.join('\n')).toBe(true);

    const secureOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withMaxConnections(64);
    const secure = await boundOnExpress(secureOptions);
    expect(secure.binding.serverOptionsReport?.maxConnections).toBe(false);
    expect(secure.warnings.some((warning) => warning.includes(MAX_CONNECTIONS_LEAF)), secure.warnings.join('\n')).toBe(true);
  });

  test('off Deno the same bind reports the cap held and warns about nothing', async () => {
    const serverOptions = HttpServerOptions.create().withMaxConnections(64);
    const elsewhere = await boundOnExpress(serverOptions);
    expect(elsewhere.binding.serverOptionsReport?.maxConnections).toBe(true);
    expect(elsewhere.warnings.filter((warning) => warning.includes(MAX_CONNECTIONS_LEAF))).toEqual([]);
  });
});
