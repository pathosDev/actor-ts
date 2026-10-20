import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import {
  applyServerOptions,
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
 * The header deadline cannot hold on Deno, and the report has to say so.
 *
 * The guard arms on `'connection'` and follows a TLS connection at
 * `'secureConnection'`.  Deno's `node:http` and `node:https` emit neither:
 * measured on deno 2.6.8 against both, with the deadline armed through
 * `applyServerOptions`, no `'connection'` and no `'secureConnection'` fired, and
 * a slow-loris was still open 3 s after an 800 ms deadline — while the report
 * said `headerTimeoutMs: true`, so `bind()` had nothing to warn about.  Node
 * v26.10.0 and Bun 1.4.2 cut the same slow-loris with a `408` on both
 * transports.  That is the server Express builds on every runtime, plaintext or
 * TLS, and the one Fastify builds too.
 *
 * Driven through the runtime seam, since `bun test` runs on Bun: the real
 * runtime's behaviour is the measurement above, and this pins what the report
 * and `bind()` make of it.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const HEADER_TIMEOUT_LEAF = 'actor-ts.http.server.header-timeout';

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
  const system = ActorSystem.create('http-header-deadline-on-deno', systemOptions);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new ExpressBackend())
    .withServerOptions(serverOptions)
    .bind(path('', get(() => completeText(200, 'ok'))));
  running.push({ system, binding });
  const warnings = logger.records.filter((record) => record.level === 'warn').map((record) => record.message);
  return { binding, warnings };
}

describe('the header deadline on Deno reports itself not in effect', () => {
  test('applyServerOptions reports it not in effect on Deno, on a node:http and a node:https server', async () => {
    setRuntimeOverride('deno');
    const plain = await listening(createHttpServer());
    const secure = await listening(createHttpsServer({ cert: CERT, key: KEY }));
    expect(applyServerOptions(plain, { headerTimeoutMs: 1_000 }).headerTimeoutMs).toBe(false);
    expect(applyServerOptions(secure, { headerTimeoutMs: 1_000 }).headerTimeoutMs).toBe(false);
    // The opt-out arms nothing, which is the whole of what it asks for, so it
    // is in effect wherever the policy reached a server — Deno included.
    const optedOut = await listening(createHttpServer());
    expect(applyServerOptions(optedOut, { headerTimeoutMs: 0 }).headerTimeoutMs).toBe(true);

    // The same servers on a runtime that emits the event report it held.
    setRuntimeOverride(null);
    const plainElsewhere = await listening(createHttpServer());
    expect(applyServerOptions(plainElsewhere, { headerTimeoutMs: 1_000 }).headerTimeoutMs).toBe(true);
  });

  test('bind() warns when header-timeout is set for Express on Deno, plaintext and TLS', async () => {
    setRuntimeOverride('deno');
    const plainOptions = HttpServerOptions.create().withHeaderTimeoutMs(1_000);
    const plain = await boundOnExpress(plainOptions);
    expect(plain.binding.serverOptionsReport?.headerTimeoutMs).toBe(false);
    expect(plain.warnings.some((warning) => warning.includes(HEADER_TIMEOUT_LEAF) && warning.includes('"express"')), plain.warnings.join('\n')).toBe(true);

    const secureOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withHeaderTimeoutMs(1_000);
    const secure = await boundOnExpress(secureOptions);
    expect(secure.binding.serverOptionsReport?.headerTimeoutMs).toBe(false);
    expect(secure.warnings.some((warning) => warning.includes(HEADER_TIMEOUT_LEAF)), secure.warnings.join('\n')).toBe(true);
  });

  test('off Deno the same bind reports the deadline held and warns about nothing', async () => {
    const serverOptions = HttpServerOptions.create().withHeaderTimeoutMs(1_000);
    const elsewhere = await boundOnExpress(serverOptions);
    expect(elsewhere.binding.serverOptionsReport?.headerTimeoutMs).toBe(true);
    expect(elsewhere.warnings.filter((warning) => warning.includes(HEADER_TIMEOUT_LEAF))).toEqual([]);
  });
});
