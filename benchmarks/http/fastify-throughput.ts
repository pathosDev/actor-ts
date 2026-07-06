/**
 * HTTP Fastify-backend throughput — how many requests/sec can the DSL
 * serve on top of Fastify?  Keeps everything local: fetch hits
 * 127.0.0.1 directly.
 *
 *   bun run benchmarks/http/fastify-throughput.ts
 */
import {
  ActorSystem,
  ActorSystemOptions,
  FastifyBackend,
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
  const sys = ActorSystem.create('bench-http-fastify', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const http = sys.extension(HttpExtensionId);
  const routes = concat(
    path('ok',   get(() => complete(Status.OK, 'ok'))),
    path('json', get(() => completeJson(Status.OK, { ok: true }))),
  );
  const backend = new FastifyBackend({ logger: false });
  const binding = await http.newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  const base = `http://${binding.host}:${binding.port}`;

  await runGroup('http · Fastify backend', [
    { name: 'GET /ok   (plain)', unit: 'req', iterations: 3_000, run: async () => { await (await fetch(`${base}/ok`)).text(); } },
    { name: 'GET /json (JSON)',  unit: 'req', iterations: 3_000, run: async () => { await (await fetch(`${base}/json`)).json(); } },
  ]);

  await binding.unbind();
  await sys.terminate();
}

void main();
