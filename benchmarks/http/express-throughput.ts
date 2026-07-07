/**
 * HTTP Express-backend throughput — counterpart to fastify-throughput, for
 * a direct comparison of overhead per backend.
 *
 *   bun run benchmarks/http/express-throughput.ts
 */
import {
  ActorSystem,
  ActorSystemOptions,
  ExpressBackend,
  HttpExtensionId,
  LogLevel,
  NoopLogger,
  Status,
  complete,
  completeJson,
  concat,
  get,
  path,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

async function main(): Promise<void> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create('bench-http-express', sysOptions);
  const http = sys.extension(HttpExtensionId);
  const routes = concat(
    path('ok',   get(() => complete(Status.OK, 'ok'))),
    path('json', get(() => completeJson(Status.OK, { ok: true }))),
  );
  const backend = new ExpressBackend();
  const binding = await http.newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  const base = `http://${binding.host}:${binding.port}`;

  await runGroup('http · Express backend', [
    { name: 'GET /ok   (plain)', unit: 'req', iterations: 3_000, run: async () => { await (await fetch(`${base}/ok`)).text(); } },
    { name: 'GET /json (JSON)',  unit: 'req', iterations: 3_000, run: async () => { await (await fetch(`${base}/json`)).json(); } },
  ]);

  await binding.unbind();
  await sys.terminate();
}

void main();
