/**
 * Task-offload break-even — from how much CPU work per call does handing a
 * pure function to a worker thread beat running it inline?
 *
 * Every hop to a worker costs a structured clone each way plus two event-loop
 * turns, on the order of tens of microseconds.  Below some amount of work per
 * call that overhead is the whole bill and a pool *loses* to the main thread;
 * above it the pool's parallelism wins.  The crossover is the one number the
 * offload documentation has to state, and it belongs to the machine and the
 * runtime rather than to intuition — so it is measured here rather than
 * asserted (#1558, #1566).
 *
 * Three rows per work size:
 *
 *   inline      the loop on the main thread — the baseline
 *   pool(1)     one worker — the boundary cost alone, with no parallelism to
 *               hide it; this row can never beat inline and says how much a
 *               hop costs at each size
 *   pool(auto)  as many workers as the machine can run at once — the row
 *               whose crossover is the answer
 *
 * The work is the same `crunch` loop on both sides of the boundary
 * (`_crunch.ts`), and the sizes are calibrated at startup from how fast this
 * machine runs it, so a "100 µs" row is a hundred microseconds of *this*
 * CPU's time rather than a round count that meant that on some other box.
 * Every reply carries the loop's result, so a worker that skipped the work
 * would be caught by the completion check rather than produce a faster row.
 *
 * The worker is reached through `getWorkerBackend()` — the same seam the
 * framework's own pool will use — so the numbers are the framework's numbers,
 * not raw `Worker` numbers.
 *
 * Measured 2026-09-16 (Bun 1.4.2, Windows 11, 32 hardware threads → pool(31),
 * 77 rounds ≈ 1 µs), speed-up against inline, 32 tasks per iteration:
 *
 * | work per call | pool(1) | pool(31) |
 * | ------------- | ------- | -------- |
 * |          1 µs |   0.26x |    0.14x |
 * |         10 µs |   0.66x |    1.23x |
 * |        100 µs |   0.91x |    8.2x  |
 * |       1 ms    |   0.96x |   14.6x  |
 * |      10 ms    |   0.96x |   15.0x  |
 *
 * So the crossover is about ten microseconds of work per call on this
 * machine, a hundred microseconds is where the pool clearly wins, and the
 * boundary itself costs about three microseconds a task when the calls are
 * pipelined (the `pool(1)` row at 1 µs: 4.0 µs against 1.0 µs inline).  The
 * ceiling of ~15x rather than ~31x is the batch, not the pool: 32 tasks over
 * 31 workers leaves the dispatch and fan-in on the critical path — the
 * benchmark asks where the pool starts to pay, not how far it scales.
 *
 *   bun run benchmarks/worker/task-offload-breakeven.ts
 */
import { getWorkerBackend, type WorkerLike } from '../../src/runtime/worker/index.js';
import { highResNow } from '../../src/runtime/Detect.js';
import { runGroup, type BenchmarkResult } from '../lib/harness.js';
import { availableParallelism } from './_available-parallelism.js';
import { crunch } from './_crunch.js';

/** Work per call, in microseconds of this machine's time — one row group each. */
const WORK_TARGETS_US: ReadonlyArray<number> = [1, 10, 100, 1_000, 10_000];
/**
 * Calls per measured iteration.  Fixed across rows so the three tiers of one
 * size do identical work; large enough that `pool(auto)` has something to
 * spread, small enough that the 10 ms row finishes inline in a few seconds.
 */
const TASKS_PER_ITERATION = 32;
/** Iterations used to calibrate rounds-per-microsecond before any row runs. */
const CALIBRATION_ROUNDS = 4_000_000;

type PendingReply = (acc: number) => void;

type PoolWorker = {
  readonly worker: WorkerLike;
  readonly pending: Map<number, PendingReply>;
};

type CrunchReply = { kind: 'done'; id: number; acc: number };

async function spawnPool(size: number): Promise<PoolWorker[]> {
  const backend = await getWorkerBackend();
  const url = new URL('./_cpu-worker.ts', import.meta.url);
  const pool: PoolWorker[] = [];
  for (let i = 0; i < size; i++) {
    const worker = backend.spawn(url, { name: `offload-${i}` });
    const pending = new Map<number, PendingReply>();
    worker.addEventListener('message', (event) => {
      const reply = event.data as CrunchReply | undefined;
      if (!reply || reply.kind !== 'done') return;
      const resolve = pending.get(reply.id);
      if (resolve === undefined) return;
      pending.delete(reply.id);
      resolve(reply.acc);
    });
    pool.push({ worker, pending });
  }
  return pool;
}

function offload(target: PoolWorker, id: number, iterations: number): Promise<number> {
  return new Promise((resolve) => {
    target.pending.set(id, resolve);
    target.worker.postMessage({ kind: 'crunch', iterations, id });
  });
}

async function terminatePool(pool: PoolWorker[]): Promise<void> {
  await Promise.all(pool.map((p) => p.worker.terminate()));
}

/**
 * How many `crunch` rounds this machine gets through in a microsecond.
 *
 * One warm pass so the JIT has compiled the loop, then a timed pass.  The
 * warm pass matters: the first execution runs in the interpreter and would
 * calibrate every row against a loop several times slower than the one the
 * rows actually run.
 */
function calibrateRoundsPerMicrosecond(): number {
  crunch(CALIBRATION_ROUNDS);
  const startNs = highResNow();
  const acc = crunch(CALIBRATION_ROUNDS);
  const elapsedNs = highResNow() - startNs;
  // Keep `acc` observable so the calibration loop is not folded either.
  if (acc === Number.MAX_SAFE_INTEGER) console.log('(unreachable)');
  return CALIBRATION_ROUNDS / (elapsedNs / 1_000);
}

/**
 * Enough iterations that a row measures something, few enough that the 10 ms
 * row does not run for a minute: aim for ~2 s of inline work per row, floored
 * at 5 so p50/p99 mean something and capped at 200.
 */
function iterationsFor(workUs: number): number {
  const target = Math.round(2_000_000 / (workUs * TASKS_PER_ITERATION));
  return Math.max(5, Math.min(200, target));
}

/** The loop's result must arrive for every task, or the row is fiction (#1027). */
function requireComplete(expected: number, replies: ReadonlyArray<number>, tier: string): void {
  if (replies.length !== expected) {
    throw new Error(`${tier}: expected ${expected} completed tasks, saw ${replies.length}`);
  }
}

async function measureWorkSize(
  workUs: number,
  rounds: number,
  autoPool: PoolWorker[],
  singlePool: PoolWorker[],
): Promise<BenchmarkResult[]> {
  const iterations = iterationsFor(workUs);
  let sequence = 0;

  const inline = (): void => {
    const results: number[] = [];
    for (let i = 0; i < TASKS_PER_ITERATION; i++) results.push(crunch(rounds));
    requireComplete(TASKS_PER_ITERATION, results, 'inline');
  };

  const viaPool = (pool: PoolWorker[], tier: string) => async (): Promise<void> => {
    const inFlight: Array<Promise<number>> = [];
    for (let i = 0; i < TASKS_PER_ITERATION; i++) {
      inFlight.push(offload(pool[i % pool.length]!, ++sequence, rounds));
    }
    const results = await Promise.all(inFlight);
    requireComplete(TASKS_PER_ITERATION, results, tier);
  };

  const label = `${workUs.toLocaleString('en-US')} µs`;
  return runGroup(
    `worker · task-offload break-even (${TASKS_PER_ITERATION} tasks × ${label} ≈ ${rounds.toLocaleString('en-US')} rounds)`,
    [
      { name: `${label} · inline`, unit: 'task', iterations, opsPerIteration: TASKS_PER_ITERATION, run: inline },
      { name: `${label} · pool(1)`, unit: 'task', iterations, opsPerIteration: TASKS_PER_ITERATION, run: viaPool(singlePool, 'pool(1)') },
      { name: `${label} · pool(${autoPool.length})`, unit: 'task', iterations, opsPerIteration: TASKS_PER_ITERATION, run: viaPool(autoPool, `pool(${autoPool.length})`) },
    ],
  );
}

async function main(): Promise<void> {
  const parallelism = await availableParallelism();
  // Leave the main thread its own core: it is the one dispatching and
  // collecting, and a pool that squeezes it out measures contention instead
  // of parallelism.  Same rule `WorkerMesh` will apply to its default (#1562).
  const poolSize = Math.max(1, parallelism - 1);
  const roundsPerUs = calibrateRoundsPerMicrosecond();

  console.log(
    `\n  Task-offload break-even — ${TASKS_PER_ITERATION} tasks per iteration,\n`
    + `  ${roundsPerUs.toFixed(0)} crunch rounds ≈ 1 µs on this machine,\n`
    + `  available parallelism ${parallelism} → pool(auto) = ${poolSize} worker${poolSize === 1 ? '' : 's'}\n`,
  );

  const autoPool = await spawnPool(poolSize);
  const singlePool = await spawnPool(1);
  // Warm every worker once so module init and the loop's JIT happen before
  // any measured iteration.
  await Promise.all([...autoPool, ...singlePool].map((p, i) => offload(p, -1 - i, 1_000)));

  const speedups: Array<{ workUs: number; single: number; auto: number }> = [];
  for (const workUs of WORK_TARGETS_US) {
    const rounds = Math.max(1, Math.round(workUs * roundsPerUs));
    const [inline, single, auto] = await measureWorkSize(workUs, rounds, autoPool, singlePool);
    speedups.push({
      workUs,
      single: inline!.perOpNs / single!.perOpNs,
      auto: inline!.perOpNs / auto!.perOpNs,
    });
  }

  await terminatePool(autoPool);
  await terminatePool(singlePool);

  console.log('\n  Speed-up against inline (>1 means the pool is faster):\n');
  console.log('    work/call     pool(1)   pool(auto)');
  for (const row of speedups) {
    console.log(
      `    ${(row.workUs.toLocaleString('en-US') + ' µs').padEnd(12)}`
      + `${row.single.toFixed(2).padStart(9)}x`
      + `${row.auto.toFixed(2).padStart(12)}x`,
    );
  }
  const crossover = speedups.find((row) => row.auto >= 1);
  console.log(
    crossover
      ? `\n  Break-even: pool(auto) overtakes inline at ≈ ${crossover.workUs.toLocaleString('en-US')} µs of work per call.\n`
      : '\n  Break-even: pool(auto) never overtook inline in this range.\n',
  );
}

void main();
