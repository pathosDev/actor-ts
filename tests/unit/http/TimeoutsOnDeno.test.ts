import { afterEach, describe, expect, test } from 'bun:test';
import { createServer as createHttpServer, type Server } from 'node:http';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import {
  applyServerOptions,
  type HttpServerBackend,
  type NodeHttpServerLike,
  nodeHttpTimeoutsApply,
  type ServerBinding,
} from '../../../src/http/backend/HttpServerBackend.js';
import { DENO_NODE_HTTP_TIMEOUTS_SINCE } from '../../../src/http/Constants.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel } from '../../../src/Logger.js';
import { runtimeVersion, setRuntimeOverride } from '../../../src/runtime/Detect.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * `idle-timeout` and `request-timeout` on a Deno before 2.7.13 report
 * themselves not in effect.
 *
 * Both are properties written onto the `node:http` server after `listen()` —
 * `keepAliveTimeout` and `requestTimeout` — and Deno's `node:http` shim accepts
 * both and applied neither until deno 2.7.13 (#1793).  Measured on deno 2.6.8 with Express and Fastify
 * under `idle-timeout = 600ms` and `request-timeout = 2s`: a keep-alive
 * connection was still open 3 s after its response, and a body announced at
 * 10 bytes that stopped after 1 was still open after 40 s with no `408` — while
 * the report said both were in effect, so `bind()` warned about nothing.  Node
 * v26.10.0 and bun 1.4.2 closed the idle connection at 1.6 s and answered the
 * stalled body `408` at 30.0 s, their sweep.
 *
 * Driven through the runtime seam, since `bun test` runs on Bun: the real
 * runtime's behaviour is the measurement above and smoke case
 * `55-node-http-timeouts-on-deno.mjs`, and this pins what the report and
 * `bind()` make of it — the shape `HeaderDeadlineOnDeno.test.ts` has.  The
 * seam forces the runtime and not its version, and a forced Deno under Bun
 * reads as the oldest release, so the cases below are the pre-2.7.13 answer;
 * which release answers which is pinned on {@link nodeHttpTimeoutsApply}.
 */

const IDLE_TIMEOUT_LEAF = 'actor-ts.http.server.idle-timeout';
const REQUEST_TIMEOUT_LEAF = 'actor-ts.http.server.request-timeout';

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

/** Bind `backend` under `serverOptions` and hand back the binding and the warnings `bind()` logged. */
async function bound(backend: HttpServerBackend, serverOptions: HttpServerOptions): Promise<{ binding: ServerBinding; warnings: string[] }> {
  const logger = new RecordingLogger(LogLevel.Info);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Info);
  const system = ActorSystem.create('http-timeouts-on-deno', systemOptions);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(backend)
    .withServerOptions(serverOptions)
    .bind(path('', get(() => completeText(200, 'ok'))));
  running.push({ system, binding });
  const warnings = logger.records.filter((record) => record.level === 'warn').map((record) => record.message);
  return { binding, warnings };
}

const backends = [
  ['express', (): HttpServerBackend => new ExpressBackend()],
  ['fastify', (): HttpServerBackend => new FastifyBackend()],
] as const;

describe('which Deno applies keepAliveTimeout and requestTimeout (#1793)', () => {
  test('a Deno before 2.7.13 applies neither, and 2.7.13 and every later one both', () => {
    // deno 2.6.8 … 2.7.12 held an idle connection past 4 s; 2.7.13 … 2.9.8 closed it at 1.6 s.
    expect(DENO_NODE_HTTP_TIMEOUTS_SINCE).toBe('2.7.13');
    for (const version of ['2.6.8', '2.7.0', '2.7.12']) expect(nodeHttpTimeoutsApply('deno', version)).toBe(false);
    for (const version of ['2.7.13', '2.7.14', '2.8.0', '2.9.8', '3.0.0']) expect(nodeHttpTimeoutsApply('deno', version)).toBe(true);
  });

  test('Node and Bun apply both, whatever their version says', () => {
    expect(nodeHttpTimeoutsApply('node', '24.0.0')).toBe(true);
    expect(nodeHttpTimeoutsApply('bun', '1.3.0')).toBe(true);
  });

  test('a Deno forced under another runtime reads as the oldest release, so its report stays the cautious one', () => {
    expect(runtimeVersion('deno')).toBe('0.0.0');
    expect(nodeHttpTimeoutsApply('deno')).toBe(false);
  });
});

describe('idle-timeout and request-timeout on a Deno before 2.7.13 report themselves not in effect', () => {
  test('applyServerOptions reports both not in effect on Deno, and the 0 opt-outs in effect', async () => {
    setRuntimeOverride('deno');
    const report = applyServerOptions(await listening(createHttpServer()), { idleTimeoutMs: 600, requestTimeoutMs: 2_000 });
    expect(report.idleTimeoutMs).toBe(false);
    expect(report.requestTimeoutMs).toBe(false);
    // `0` asks for no bound, and arming nothing is the whole of that.
    const optedOut = applyServerOptions(await listening(createHttpServer()), { idleTimeoutMs: 0, requestTimeoutMs: 0 });
    expect(optedOut.idleTimeoutMs).toBe(true);
    expect(optedOut.requestTimeoutMs).toBe(true);

    // The same server on a runtime whose node:http applies them.
    setRuntimeOverride(null);
    const elsewhere = applyServerOptions(await listening(createHttpServer()), { idleTimeoutMs: 600, requestTimeoutMs: 2_000 });
    expect(elsewhere.idleTimeoutMs).toBe(true);
    expect(elsewhere.requestTimeoutMs).toBe(true);
  });

  for (const [name, backendOf] of backends) {
    test(`bind() names both when they are set for ${name} on Deno`, async () => {
      setRuntimeOverride('deno');
      const serverOptions = HttpServerOptions.create()
        .withIdleTimeoutMs(600)
        .withRequestTimeoutMs(2_000);
      const { binding, warnings } = await bound(backendOf(), serverOptions);

      expect(binding.serverOptionsReport?.idleTimeoutMs).toBe(false);
      expect(binding.serverOptionsReport?.requestTimeoutMs).toBe(false);
      const inert = warnings.filter((warning) => warning.includes(`"${name}" backend reports`));
      expect(inert, warnings.join('\n')).toHaveLength(1);
      expect(inert[0]).toContain(IDLE_TIMEOUT_LEAF);
      expect(inert[0]).toContain(REQUEST_TIMEOUT_LEAF);
    });

    test(`off Deno the same bind on ${name} reports both held and warns about neither`, async () => {
      const serverOptions = HttpServerOptions.create()
        .withIdleTimeoutMs(600)
        .withRequestTimeoutMs(2_000);
      const { binding, warnings } = await bound(backendOf(), serverOptions);

      expect(binding.serverOptionsReport?.idleTimeoutMs).toBe(true);
      expect(binding.serverOptionsReport?.requestTimeoutMs).toBe(true);
      expect(warnings.filter((warning) => warning.includes(IDLE_TIMEOUT_LEAF) || warning.includes(REQUEST_TIMEOUT_LEAF))).toEqual([]);
    });
  }
});
