/**
 * Child process of `streamed-upload-rss.ts`: one server with a
 * `streamedBody()` upload route on the backend named in argv, measured from
 * the inside — its own RSS, sampled while uploads run, is the number the
 * parent reports.  Kept apart from the client so the client's buffers never
 * show up in it.
 *
 * Prints `PORT <n>` once bound; `GET /rss` answers `{ baseline, peak }` and
 * restarts the peak.
 */
import { createHash } from 'node:crypto';
import { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { HttpExtensionId, Status, completeJson, concat, get, path, put, streamedBody } from '../../src/http/index.js';

const backend = process.argv[2] ?? 'fastify';
const GiB = 1024 * 1024 * 1024;
const SAMPLE_INTERVAL_MS = 20;

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend } } });
  const system = ActorSystem.create('bench-streamed-upload', systemOptions);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, SAMPLE_INTERVAL_MS);
  const routes = concat(
    path('upload', put(streamedBody({ maxBytes: GiB }, async (request) => {
      // md5 and sha-256 over every chunk — what a consumer computing an
      // object store's checksums while it pipes does.
      const md5 = createHash('md5');
      const sha256 = createHash('sha256');
      let length = 0;
      for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
        md5.update(chunk);
        sha256.update(chunk);
        length += chunk.byteLength;
      }
      return completeJson(Status.OK, { length, md5: md5.digest('hex'), sha256: sha256.digest('hex') });
    }))),
    path('rss', get(() => {
      const answer = { baseline, peak };
      peak = process.memoryUsage().rss;
      return completeJson(Status.OK, answer);
    })),
  );
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);
  console.log(`PORT ${binding.port}`);
  process.stdin.on('data', () => undefined);
  process.stdin.on('end', () => {
    clearInterval(sampler);
    void binding.unbind().then(() => system.terminate()).then(() => process.exit(0));
  });
}

void main();
