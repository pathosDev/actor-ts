import { afterEach, describe, expect, test } from 'bun:test';
import {
  compressorFor,
  resetCompressionCache,
  type CompressionAlgo,
} from '../../../../src/persistence/object-storage/Compression.js';

/**
 * The event loop keeps turning while an object-storage body compresses or
 * decompresses (#1540).
 *
 * `Compression.ts` used `gzipSync` / `gunzipSync` and the sync zstd forms
 * inside `async` arrows, and every compression test in the repository was
 * green: the `Compressor` interface was promise-shaped from the start, so the
 * bytes came back right and nothing asked whether anything else had run in the
 * meantime.  Nothing had.  A compressor is called from inside an actor's turn,
 * so a `*Sync` there holds the one thread every actor in the process runs on —
 * the cost of one store's 24 MiB body landed in the p99 of actors that had
 * nothing to do with it.
 *
 * The observable is a 1 ms interval running across the `await`.  Under the
 * sync implementation it fires exactly **zero** times, however long the call
 * runs — a timer cannot fire while the thread is held — so the assertion is a
 * count against zero, not a ratio with a threshold to argue about.  Under the
 * async forms the deflate runs on the libuv pool and the ticks land (64–110
 * were measured here per leg).
 *
 * Two counts, because one was not enough.  `ticks >= 1` alone is satisfied by
 * `await new Promise((r) => setTimeout(r, 0)); return gzipSync(...)` — the
 * interval fires once before the block starts, and that wrong fix was run
 * against this file and passed it.  That shape is not hypothetical either: it
 * is exactly what Deno's async `node:zlib` does today.  So the second count is
 * over the **second half** of the window: a call that defers and then blocks
 * can only ever be ticked before the work begins, while a call whose work is
 * off the thread is ticked all the way through.  Still zero against non-zero,
 * still no ratio.
 *
 * The fixture has to be big enough that the call takes long enough for a
 * tick to be *possible*; otherwise a fast machine passes `ticks >= 1`
 * vacuously with a sub-millisecond call, or fails it for the wrong reason.
 * So each leg asserts the precondition first — the work took at least
 * {@link MINIMUM_WORK_MS} — and names the fix ("grow the fixture") when it
 * does not hold.  The margin is judged on the fastest machine that runs the
 * suite, not on the one the fixture was sized on: 48 MiB of a repeated
 * 16 KiB pseudo-random block took 135 ms for gzip level 9 here on Bun 1.4.2,
 * 123–128 ms on two Linux runners and **49.5 ms** on a third, faster one —
 * every leg 2.5× quicker in that run — which is the precondition tripping
 * on a runner class, not a slow day (#1621).  So the gzip compress leg and
 * both decompress legs work on 160 MiB: gzip level 9 scales gently (139–186
 * ms at 48 MiB, 557–616 ms at 160 MiB here), which puts the fastest runner
 * near 165 ms, over three times the floor.
 *
 * The zstd compress leg stays at 48 MiB, as a prefix of the same buffer,
 * because level 22 has a cliff rather than a slope: 48 MiB compresses in
 * 0.26–0.38 s here, 96 MiB in 3.7–5.4 s and 128 MiB in 5.2–5.4 s — the
 * ultra levels run a 128 MiB window — and 5 s is the per-test cap.  The
 * ultra level is still the right one for the work: level 3 finishes the
 * 48 MiB in 20 ms and level 19 in 85 ms, neither a safe margin over the
 * floor.  The decode legs are unaffected, because they produce their frame
 * at the default level and measure only the bytes coming back out (0.6–0.8 s
 * for either algorithm at 160 MiB here).
 *
 * Bun only, like every `bun test` file — the cross-runtime half lives in
 * `tests/smoke/cases/41-object-storage-gzip-cap-liveness.mjs`, where Deno's
 * measured behaviour (async `node:zlib` defers the call and then blocks on it)
 * is gated on a capability probe rather than asserted away.
 */

/** Below this the call is too short for a 1 ms interval to prove anything. */
const MINIMUM_WORK_MS = 50;
const TICK_INTERVAL_MS = 1;

const FIXTURE_BYTES = 160 * 1024 * 1024;
/** The zstd level-22 compress leg's input — see the header for the cliff above this. */
const ZSTD_COMPRESS_BYTES = 48 * 1024 * 1024;
const BLOCK_BYTES = 16 * 1024;

/**
 * A pseudo-random block repeated to the fixture size: real compression work
 * (the block itself is incompressible) that still shrinks, so the decompress
 * legs read a small frame back out to 160 MiB.  `Math.imul` keeps the LCG in
 * 32-bit arithmetic — a plain `*` overflows 2^53 and the sequence collapses
 * into a short cycle that compresses to nothing and finishes in no time.
 */
function fixture(): Uint8Array {
  const block = new Uint8Array(BLOCK_BYTES);
  let seed = 0x9e3779b9;
  for (let index = 0; index < BLOCK_BYTES; index++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    block[index] = seed >>> 24;
  }
  const bytes = new Uint8Array(FIXTURE_BYTES);
  for (let offset = 0; offset < FIXTURE_BYTES; offset += BLOCK_BYTES) bytes.set(block, offset);
  return bytes;
}

const FIXTURE = fixture();

type LivenessReading = {
  /** Interval callbacks that ran while `work` was pending. */
  readonly ticks: number;
  /** Of those, the ones that ran after the window's midpoint. */
  readonly ticksInSecondHalf: number;
  readonly elapsedMs: number;
};

/** Run `work` with a 1 ms interval alive across it and count how often, and when, the loop turned. */
async function measure(work: () => Promise<unknown>): Promise<LivenessReading> {
  const tickTimesMs: number[] = [];
  const started = performance.now();
  const interval = setInterval(() => { tickTimesMs.push(performance.now() - started); }, TICK_INTERVAL_MS);
  try {
    await work();
  } finally {
    clearInterval(interval);
  }
  const elapsedMs = performance.now() - started;
  return {
    ticks: tickTimesMs.length,
    ticksInSecondHalf: tickTimesMs.filter((at) => at >= elapsedMs / 2).length,
    elapsedMs,
  };
}

function expectLive(reading: LivenessReading, what: string): void {
  const elapsed = reading.elapsedMs.toFixed(1);
  expect(
    reading.elapsedMs,
    `${what} finished in ${elapsed} ms, under the ${MINIMUM_WORK_MS} ms the tick assertion needs `
    + 'to mean anything — grow the fixture, never lower the floor.',
  ).toBeGreaterThanOrEqual(MINIMUM_WORK_MS);
  expect(
    reading.ticks,
    `no timer tick landed in the ${elapsed} ms ${what} took: the call held the event loop for `
    + 'its whole duration, which is what a *Sync form does. Every actor in the process waited '
    + 'with it.',
  ).toBeGreaterThanOrEqual(1);
  expect(
    reading.ticksInSecondHalf,
    `${reading.ticks} tick(s) landed during ${what}, all of them in the first half of its `
    + `${elapsed} ms: the call deferred itself and then held the event loop for the work. That `
    + 'is a *Sync form behind an await, not an async one.',
  ).toBeGreaterThanOrEqual(1);
}

type LivenessLeg = {
  readonly algorithm: CompressionAlgo;
  /** The level the compress leg runs at — chosen for work, not for ratio. */
  readonly compressLevel: number;
  /** What the compress leg encodes: the whole fixture, or the prefix that keeps zstd 22 off its cliff. */
  readonly compressInput: Uint8Array;
};

const LEGS: readonly LivenessLeg[] = [
  { algorithm: 'gzip', compressLevel: 9, compressInput: FIXTURE },
  { algorithm: 'zstd', compressLevel: 22, compressInput: FIXTURE.subarray(0, ZSTD_COMPRESS_BYTES) },
];

afterEach(() => {
  // A clean lazy per test, so a leg never inherits the resolution of the one
  // before it — the same hygiene `CompressionLevels.test.ts` keeps.
  resetCompressionCache();
});

describe.each([...LEGS])('$algorithm keeps the event loop turning (#1540)', ({ algorithm, compressLevel, compressInput }) => {
  test('compress yields to a 1 ms interval while the body encodes', async () => {
    const compressor = compressorFor(algorithm);
    const reading = await measure(() => compressor.compress(compressInput, compressLevel));
    expectLive(reading, `${algorithm} compress at level ${compressLevel} of ${compressInput.byteLength} bytes`);
  });

  test('decompress yields to a 1 ms interval while the body decodes', async () => {
    const compressor = compressorFor(algorithm);
    // The default level — the decode leg is about the 160 MiB coming back
    // out, and the frame that produces it is not what is being measured.
    const frame = await compressor.compress(FIXTURE);
    const reading = await measure(() => compressor.decompress(frame));
    expectLive(reading, `${algorithm} decompress of ${FIXTURE_BYTES} bytes`);
  });
});
