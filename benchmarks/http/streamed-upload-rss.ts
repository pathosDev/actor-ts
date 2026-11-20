/**
 * Server memory under a streamed upload (#1868) — how much the server's RSS
 * grows while a `streamedBody()` route takes a large body, per backend.
 *
 *   bun run benchmarks/http/streamed-upload-rss.ts
 *
 * The point of a streamed route is that this does not scale with the body:
 * the handler holds one chunk at a time and the client is held back in
 * between.  So the body is 256 MiB and the number to read is the growth, which
 * should stay a small constant — the issue measured +14 MB on Fastify under
 * Bun, against about +100 MB for a 48 MiB body through a buffering parser.
 * Anything over {@link GROWTH_LIMIT_MIB} is flagged and fails the run.
 *
 * The server runs in a child process (`_streamed-upload-server.ts`) so the
 * client's own buffers never enter the measurement; the client is `fetch`
 * with a `ReadableStream` body generated on the fly, which Bun sends with the
 * declared `Content-Length` and constant memory.  Under `bench:smoke` the
 * body shrinks to 8 MiB: that run proves the suite works, not the number.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ansi } from '../lib/stats.js';

const MiB = 1024 * 1024;
const SMOKE = process.env.ACTOR_TS_BENCH_SMOKE === '1';
const BODY_BYTES = (SMOKE ? 8 : 256) * MiB;
const CHUNK_BYTES = 256 * 1024;
const GROWTH_LIMIT_MIB = 32;
const BACKENDS = ['fastify', 'express', 'hono'] as const;

type Rss = { readonly baseline: number; readonly peak: number };

function generatedBody(total: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x5a);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const piece = sent + chunk.byteLength > total ? chunk.subarray(0, total - sent) : chunk;
      sent += piece.byteLength;
      controller.enqueue(piece);
    },
  }, { highWaterMark: 0 });
}

async function measure(backend: string): Promise<{ growthMiB: number; seconds: number }> {
  const child = spawn(process.execPath, [join(import.meta.dirname, '_streamed-upload-server.ts'), backend], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let errors = '';
    child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (data: Buffer) => {
        out += data.toString();
        const found = /PORT (\d+)/.exec(out);
        if (found) resolve(Number(found[1]));
      });
      child.once('exit', (code) => reject(new Error(`server for ${backend} exited with ${code} before binding: ${errors.trim()}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    await (await fetch(`${base}/rss`)).json();
    const startedAt = performance.now();
    const response = await fetch(`${base}/upload`, {
      method: 'PUT',
      body: generatedBody(BODY_BYTES),
      headers: { 'content-length': String(BODY_BYTES) },
      duplex: 'half',
    } as RequestInit);
    const text = await response.text();
    const result = (response.status === 200 ? JSON.parse(text) : { length: -1, text }) as { length: number; text?: string };
    const seconds = (performance.now() - startedAt) / 1000;
    if (response.status !== 200 || result.length !== BODY_BYTES) {
      throw new Error(`${backend}: the upload came back ${response.status} with ${result.length} bytes ${result.text ?? ''}`);
    }
    const rss = await (await fetch(`${base}/rss`)).json() as Rss;
    return { growthMiB: (rss.peak - rss.baseline) / MiB, seconds };
  } finally {
    child.stdin.end();
    child.kill();
  }
}

async function main(): Promise<void> {
  console.log(ansi.bold(`\n▸ http · streamed upload, server RSS growth for a ${BODY_BYTES / MiB} MiB body`));
  let over = 0;
  for (const backend of BACKENDS) {
    const { growthMiB, seconds } = await measure(backend);
    const verdict = growthMiB < GROWTH_LIMIT_MIB ? ansi.green('ok') : ansi.red(`over ${GROWTH_LIMIT_MIB} MiB`);
    if (growthMiB >= GROWTH_LIMIT_MIB && !SMOKE) over += 1;
    console.log(`  ${backend.padEnd(8)} +${growthMiB.toFixed(1).padStart(6)} MiB   ${(BODY_BYTES / MiB / seconds).toFixed(0).padStart(5)} MiB/s   ${verdict}`);
  }
  if (over > 0) process.exit(1);
}

void main();
