/**
 * Config scaling — the same application under `actor-ts.parallelism.workers
 * = 0, 1, 2, 4, 8, auto`.  Nothing but that number changes between the rows:
 * the same actor classes, spawned by the same `system.spawn` calls, driven
 * by the same asks (#1563, #1566).
 *
 * Two shapes of load, because the answer differs by shape and the number
 * that justifies the `offload` default has to come from the second:
 *
 *   cpu    N actors × one message each, every message `X` microseconds of
 *          the shared `crunch` loop, X swept — the row where threads should
 *          win, and the sweep says from which X on they do.
 *   chatty N actors × one message each, no work at all — the row where
 *          threads *lose*, by the cost of a clone and two relay hops per
 *          message (`worker/mesh-message-cost.ts` has the per-hop figure);
 *          how much they lose is what an `offload` allow-list is for.
 *
 * `workers = 0` is the baseline and the regression watch: it has to be
 * today's single-threaded figure, bit for bit.  Every reply carries the
 * loop's result, so a worker that skipped the work would fail the
 * completion check rather than produce a faster row (#1027).  The table at
 * the end names which value `auto` resolved to and from where.
 *
 * Measured 2026-09-16 (Bun 1.4.2, Windows 11, 32 hardware threads → auto = 31,
 * 16 actors, 76 rounds ≈ 1 µs, speed-up against `workers = 0`):
 *
 * | shape / workers | 1     | 2     | 4     | 8     | auto (31) |
 * | --------------- | ----- | ----- | ----- | ----- | --------- |
 * | cpu · 10 µs     | 0.16x | 0.19x | 0.17x | 0.15x | 0.13x     |
 * | cpu · 100 µs    | 0.57x | 0.97x | 1.15x | 1.17x | 0.64x     |
 * | cpu · 1 ms      | 0.86x | 1.67x | 3.01x | 4.03x | 4.60x     |
 * | chatty          | 0.05x | 0.05x | 0.05x | 0.04x | 0.01x     |
 *
 * So the threads pay from about a hundred microseconds of work per message
 * and scale with it — 4x at a millisecond — and a chatty actor is twenty
 * times slower on a worker than at home, which is the figure behind the
 * `offload` allow-list.  The ceiling is the star: every frame, and every
 * gossip round of a 32-member mesh, is relayed by the main thread (#1191),
 * which is why `auto` on 32 threads loses to 8 workers at 100 µs and gains
 * little at 1 ms — sixteen actors cannot use thirty-one workers, and the
 * fifteen idle ones still cost the relay their heartbeats.
 *
 *   bun run benchmarks/parallelism/config-scaling.ts
 */
import type { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ParallelismExtensionId } from '../../src/parallelism/ParallelismExtension.js';
import { ParallelismOptions } from '../../src/parallelism/ParallelismOptions.js';
import { highResNow } from '../../src/runtime/Detect.js';
import { runGroup, type BenchmarkResult } from '../lib/harness.js';
import { availableParallelism } from '../worker/_available-parallelism.js';
import { crunch } from '../worker/_crunch.js';
import { Cruncher, Ponger, type CrunchCommand, type PingCommand } from './_actors.js';

/** The rows: the config values under test, in the order the table prints them. */
const WORKER_VALUES: ReadonlyArray<number | 'auto'> = [0, 1, 2, 4, 8, 'auto'];
/** Work per message for the cpu shape, in microseconds of this machine's time. */
const WORK_TARGETS_US: ReadonlyArray<number> = [10, 100, 1_000];
/** Actors per system — well above any worker count in the sweep, so every worker has several. */
const ACTOR_COUNT = 16;
/** Iterations used to calibrate rounds-per-microsecond before any row runs. */
const CALIBRATION_ROUNDS = 4_000_000;
const ASK_TIMEOUT_MS = 60_000;

const smokeMode = process.env.ACTOR_TS_BENCH_SMOKE === '1';

type Application = {
  readonly system: ActorSystem;
  readonly crunchers: ReadonlyArray<ActorRef<CrunchCommand>>;
  readonly pongers: ReadonlyArray<ActorRef<PingCommand>>;
  readonly resolvedWorkers: number;
};

/**
 * The application under test.  Identical for every row except the one
 * option; `auto` is resolved by the extension exactly as it would be for an
 * application, and read back here for the table.
 */
async function startApplication(workers: number | 'auto'): Promise<Application> {
  const parallelism = ParallelismOptions.create()
    .withWorkers(workers)
    .withModule(new URL('./_actors.ts', import.meta.url));
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '40ms' }, 'worker-cluster': { 'ready-timeout': '30s' } } })
    .withParallelism(parallelism);
  const system = ActorSystem.create('config-scaling', systemOptions);
  const crunchers: ActorRef<CrunchCommand>[] = [];
  const pongers: ActorRef<PingCommand>[] = [];
  for (let i = 0; i < ACTOR_COUNT; i++) {
    crunchers.push(system.spawn(Cruncher, `cruncher-${i}`));
    pongers.push(system.spawn(Ponger, `ponger-${i}`));
  }
  const extension = system.extension(ParallelismExtensionId);
  await extension.whenReady();
  // One round trip per actor before anything is measured: the spawns are
  // acknowledged, the module is imported on every worker, the JIT is warm.
  await Promise.all(crunchers.map((ref) => ref.ask<number>({ kind: 'crunch', rounds: 1_000 }, ASK_TIMEOUT_MS)));
  await Promise.all(pongers.map((ref, i) => ref.ask<number>({ kind: 'ping', sequence: i }, ASK_TIMEOUT_MS)));
  return { system, crunchers, pongers, resolvedWorkers: extension.workerMesh?.size ?? 0 };
}

function calibrateRoundsPerMicrosecond(): number {
  crunch(CALIBRATION_ROUNDS);
  const startNs = highResNow();
  const acc = crunch(CALIBRATION_ROUNDS);
  const elapsedNs = highResNow() - startNs;
  if (acc === Number.MAX_SAFE_INTEGER) console.log('(unreachable)');
  return CALIBRATION_ROUNDS / (elapsedNs / 1_000);
}

/** Aim for ~2 s of single-threaded work per row, floored at 5, capped at 200. */
function iterationsFor(workUs: number): number {
  const target = Math.round(2_000_000 / (workUs * ACTOR_COUNT));
  return Math.max(5, Math.min(200, target));
}

function requireComplete(expected: number, replies: ReadonlyArray<number>, row: string): void {
  if (replies.length !== expected) throw new Error(`${row}: expected ${expected} replies, saw ${replies.length}`);
}

async function measure(application: Application, label: string, roundsPerUs: number): Promise<BenchmarkResult[]> {
  const rows = WORK_TARGETS_US.map((workUs) => {
    const rounds = Math.max(1, Math.round(workUs * roundsPerUs));
    const expected = application.crunchers.map(() => crunch(rounds));
    return {
      name: `cpu · ${workUs.toLocaleString('en-US')} µs · ${label}`,
      unit: 'message',
      iterations: iterationsFor(workUs),
      opsPerIteration: ACTOR_COUNT,
      run: async (): Promise<void> => {
        const replies = await Promise.all(
          application.crunchers.map((ref) => ref.ask<number>({ kind: 'crunch', rounds }, ASK_TIMEOUT_MS)),
        );
        requireComplete(ACTOR_COUNT, replies, label);
        for (let i = 0; i < replies.length; i++) {
          if (replies[i] !== expected[i]) throw new Error(`${label}: actor ${i} returned ${replies[i]}, expected ${expected[i]}`);
        }
      },
    };
  });
  let sequence = 0;
  rows.push({
    name: `chatty · ${label}`,
    unit: 'message',
    iterations: 200,
    opsPerIteration: ACTOR_COUNT,
    run: async (): Promise<void> => {
      const base = sequence;
      sequence += ACTOR_COUNT;
      const replies = await Promise.all(
        application.pongers.map((ref, i) => ref.ask<number>({ kind: 'ping', sequence: base + i }, ASK_TIMEOUT_MS)),
      );
      requireComplete(ACTOR_COUNT, replies, label);
    },
  });
  return runGroup(`parallelism · config scaling (${ACTOR_COUNT} actors, ${label})`, rows);
}

async function main(): Promise<void> {
  const parallelism = await availableParallelism();
  const roundsPerUs = calibrateRoundsPerMicrosecond();
  const values = smokeMode ? ([0, 1] as const) : WORKER_VALUES;
  console.log(
    `\n  Config scaling — ${ACTOR_COUNT} actors, ${roundsPerUs.toFixed(0)} crunch rounds ≈ 1 µs on this machine,\n`
    + `  available parallelism ${parallelism} (os.availableParallelism() where the runtime has it, `
    + 'navigator.hardwareConcurrency otherwise)\n',
  );

  const table = new Map<string, Map<string, number>>();
  const columns: string[] = [];
  for (const workers of values) {
    const application = await startApplication(workers);
    const label = workers === 'auto' ? `auto (${application.resolvedWorkers})` : `workers = ${workers}`;
    columns.push(label);
    try {
      const results = await measure(application, label, roundsPerUs);
      for (const result of results) {
        const shape = result.name.slice(0, result.name.lastIndexOf(' · '));
        let row = table.get(shape);
        if (row === undefined) { row = new Map(); table.set(shape, row); }
        row.set(label, result.perOpNs);
      }
    } finally {
      await application.system.terminate();
    }
  }

  const baseline = columns[0]!;
  console.log(`\n  Speed-up against ${baseline} (>1 means the threads are faster):\n`);
  const header = ['shape', ...columns.slice(1)];
  console.log(`  | ${header.join(' | ')} |`);
  console.log(`  | ${header.map(() => '---').join(' | ')} |`);
  for (const [shape, row] of table) {
    const base = row.get(baseline)!;
    const cells = columns.slice(1).map((column) => `${(base / row.get(column)!).toFixed(2)}x`);
    console.log(`  | ${shape} | ${cells.join(' | ')} |`);
  }
  console.log('');
}

await main();
