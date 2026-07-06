/**
 * Router pool scaling — compare a single worker actor against a
 * round-robin Router pool of 2 / 4 / 8 / 16 routees.
 *
 * Each "job" is an async wait plus a small CPU burst, simulating a typical
 * I/O-bound handler (DB query, HTTP call, …).  Because JavaScript is
 * single-threaded, a pool of N routees does NOT give CPU parallelism —
 * what it does give is in-flight concurrency: while one routee is awaiting
 * its simulated I/O, another can make progress.  The benchmark shows the
 * resulting throughput lift.
 *
 *   bun run benchmarks/single-node/router-pool.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
  Props,
  Router,
  type ActorRef,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

const SIMULATED_IO_MS = 2;        // per-job async wait (Windows setTimeout granularity ~15ms)
const CPU_BURST_ITERS = 20_000;   // per-job tight arithmetic loop
const JOBS_PER_ITERATION = 100;   // work items per benchmark iteration
const MEASURED_ITERATIONS = 10;   // harness iterations — total walltime dominates here

interface Counter { n: number; }

function makeWorker(counter: Counter): Actor<'work'> {
  class Worker extends Actor<'work'> {
    override async onReceive(_m: 'work'): Promise<void> {
      await Bun.sleep(SIMULATED_IO_MS);
      let acc = 0;
      for (let i = 0; i < CPU_BURST_ITERS; i++) acc += (i * 7) % 13;
      if (acc < 0) throw new Error('impossible');
      counter.n++;
    }
  }
  return new Worker();
}

async function runPooled(system: ActorSystem, routees: number): Promise<void> {
  const counter: Counter = { n: 0 };
  const workerProps = Props.create(() => makeWorker(counter));
  const ref = (routees === 1
    ? system.spawnAnonymous(workerProps)
    : system.spawnAnonymous(Router.roundRobin(routees, workerProps))) as ActorRef<'work'>;

  // Warm-up: run one full batch before the measured loop so the routees
  // have started and the event loop has reached steady state.
  for (let i = 0; i < JOBS_PER_ITERATION; i++) ref.tell('work');
  while (counter.n < JOBS_PER_ITERATION) await Bun.sleep(1);
  counter.n = 0;

  const label = routees === 1 ? 'single worker (no router)' : `pool of ${routees}`;
  await runGroup(
    `single-node · router-pool (${JOBS_PER_ITERATION} jobs / iter, ${SIMULATED_IO_MS}ms I/O each)`,
    [
      {
        name: label,
        unit: 'job',
        iterations: MEASURED_ITERATIONS,
        opsPerIteration: JOBS_PER_ITERATION,
        run: async () => {
          const start = counter.n;
          for (let i = 0; i < JOBS_PER_ITERATION; i++) ref.tell('work');
          while (counter.n < start + JOBS_PER_ITERATION) await Bun.sleep(1);
        },
      },
    ],
  );

  ref.stop();
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-router', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

  console.log(
    `\n  Router pool scaling — ${JOBS_PER_ITERATION} async jobs per iteration,\n`
    + `  each job = ${SIMULATED_IO_MS}ms sleep + ${CPU_BURST_ITERS.toLocaleString('en-US')}-iter CPU burst\n`,
  );

  for (const routees of [1, 2, 4, 8, 16] as const) {
    await runPooled(system, routees);
  }

  await system.terminate();
}

void main();
