/**
 * Bun worker count scaling — dispatch a fixed CPU-bound workload across
 * 1 / 2 / 4 / 8 / auto Bun `Worker`s and measure total throughput.
 * Unlike a Router pool inside one ActorSystem (which shares the main
 * thread), Bun workers run on separate OS threads, so this is the test
 * that actually exercises multi-core CPU parallelism.
 *
 * The "auto" row uses the same resolution rule as `WorkerCluster.spawn
 * ({ workers: 'auto' })`: `ACTOR_TS_WORKERS` env var → `navigator.
 * hardwareConcurrency` → fallback 2.  It answers the practical question
 * "how does the framework's default sizing behave on this machine?".
 *
 * This benchmark is intentionally framework-agnostic — each worker is a
 * bare Bun Worker loop (see ./_cpu-worker.ts).  The goal is to measure
 * the machine's CPU parallelism and the worker-channel overhead, not
 * actor-ts itself.  Use it together with router-pool.ts to see the
 * distinction between in-process concurrency and true multi-core
 * throughput on the same hardware.
 *
 *   bun run benchmarks/worker/worker-count-scaling.ts
 */
import { runGroup } from '../lib/harness.js';

const ITERATIONS_PER_TASK = 200_000;   // arithmetic ops per crunch message
const TASKS_PER_ITERATION = 200;       // work items dispatched per harness iteration
const MEASURED_ITERATIONS = 20;

interface WorkerHandle {
  readonly worker: Worker;
  pending: Map<number, (acc: number) => void>;
}

function spawnWorker(): WorkerHandle {
  const url = new URL('./_cpu-worker.ts', import.meta.url);
  const worker = new Worker(url, { type: 'module' });
  const handle: WorkerHandle = { worker, pending: new Map() };
  worker.onmessage = (ev: MessageEvent<{ kind: string; id: number; acc: number }>) => {
    const resolver = handle.pending.get(ev.data.id);
    if (resolver) {
      handle.pending.delete(ev.data.id);
      resolver(ev.data.acc);
    }
  };
  return handle;
}

function send(handle: WorkerHandle, id: number): Promise<number> {
  return new Promise((resolve) => {
    handle.pending.set(id, resolve);
    handle.worker.postMessage({ kind: 'crunch', iterations: ITERATIONS_PER_TASK, id });
  });
}

async function runWithWorkers(count: number, label: string): Promise<void> {
  const handles = Array.from({ length: count }, () => spawnWorker());

  // Warm each worker once so module init + JIT for _cpu-worker.ts happen
  // before the measured iterations.
  await Promise.all(handles.map((h, i) => send(h, i * 1_000_000 + 999)));

  let seq = 0;
  await runGroup(
    `worker · Bun workers (${TASKS_PER_ITERATION} tasks × ${ITERATIONS_PER_TASK.toLocaleString('en-US')}-iter crunch)`,
    [
      {
        name: label,
        unit: 'task',
        iterations: MEASURED_ITERATIONS,
        opsPerIteration: TASKS_PER_ITERATION,
        run: async () => {
          const pending: Array<Promise<number>> = [];
          for (let i = 0; i < TASKS_PER_ITERATION; i++) {
            const h = handles[i % handles.length]!;
            pending.push(send(h, ++seq));
          }
          await Promise.all(pending);
        },
      },
    ],
  );

  for (const h of handles) h.worker.terminate();
}

/**
 * Mirrors `WorkerCluster.spawn({ workers: 'auto' })`'s resolution order:
 * explicit `ACTOR_TS_WORKERS` env override → `navigator.hardwareConcurrency`
 * → conservative fallback of 2.  Keeping the logic identical means the
 * "auto" benchmark row reports exactly what a real app would see.
 */
function resolveAuto(): number {
  if (typeof process !== 'undefined' && process.env?.ACTOR_TS_WORKERS) {
    const n = parseInt(process.env.ACTOR_TS_WORKERS, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const nav = (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav && typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0) {
    return nav.hardwareConcurrency;
  }
  return 2;
}

async function main(): Promise<void> {
  const bun = (globalThis as { Bun?: unknown }).Bun;
  if (!bun) {
    console.error('  This benchmark requires Bun (globalThis.Bun).  Skipping.');
    return;
  }

  const auto = resolveAuto();

  console.log(
    `\n  Bun worker count scaling — ${TASKS_PER_ITERATION} CPU-bound tasks / iter,\n`
    + `  each task = ${ITERATIONS_PER_TASK.toLocaleString('en-US')}-iter arithmetic loop on a separate worker thread\n`
    + `  (auto = ${auto} on this machine — matches WorkerCluster.spawn({ workers: 'auto' }))\n`,
  );

  const fixed = [1, 2, 4, 8] as const;
  for (const workers of fixed) {
    await runWithWorkers(workers, `${workers} worker${workers === 1 ? '' : 's'}`);
  }
  // Only add the auto row if it would actually differ from the fixed set —
  // otherwise we'd just duplicate a line.
  if (!fixed.includes(auto as (typeof fixed)[number])) {
    await runWithWorkers(auto, `auto (${auto} workers)`);
  } else {
    await runWithWorkers(auto, `auto (${auto} workers — same as fixed row above)`);
  }
}

void main();
