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
 * A second half prices the `smallest-mailbox` depth scan against round-robin
 * at a fixed pool size — see {@link runStrategies} for what that group can
 * and cannot show.
 *
 *   bun run benchmarks/single-node/router-pool.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
  Router,
  type ActorRef,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

const SIMULATED_IO_MS = 2;        // per-job async wait (Windows setTimeout granularity ~15ms)
const CPU_BURST_ITERS = 20_000;   // per-job tight arithmetic loop
const JOBS_PER_ITERATION = 100;   // work items per benchmark iteration
const MEASURED_ITERATIONS = 10;   // harness iterations — total walltime dominates here
const STRATEGY_POOL_SIZE = 8;     // fixed pool size for the strategy comparison

type Counter = { n: number; };

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
  const workerFactory = () => makeWorker(counter);
  const ref = (routees === 1
    ? system.spawnAnonymous(workerFactory)
    : system.spawnAnonymous(Router.roundRobin(routees, workerFactory))) as ActorRef<'work'>;

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

/**
 * What `smallest-mailbox` costs versus `round-robin` (#154).
 *
 * The strategy reads every routee's queue depth per message where round-robin
 * does one modulo, which makes the pool size a per-message factor.  This group
 * prices that scan: the workload is uniform, so the depths stay level, the
 * scan can never pick a better routee than the rotation would have, and the
 * whole difference between the two rows is overhead.
 *
 * It deliberately does **not** try to show the strategy's *benefit*, because
 * this harness structurally cannot.  Two reasons, both worth knowing before
 * anyone extends this file expecting a win to appear:
 *
 *   1. Each iteration `tell`s the whole batch before any routee runs, so at
 *      routing time no message has completed anywhere — every mailbox depth
 *      equals its assigned count, and picking the minimum *is* round-robin.
 *      Showing a difference needs arrivals interleaved with completions.
 *   2. The per-job CPU burst is serialized across the whole pool (one thread),
 *      and at these settings it dominates the wall clock.  No routing decision
 *      can change how long serialized CPU takes.
 *
 * Smallest-mailbox pays off in queueing *latency* under a steady arrival rate
 * with uneven per-message cost — a different measurement than throughput.
 */
async function runStrategies(system: ActorSystem): Promise<void> {
  const roundRobinCounter: Counter = { n: 0 };
  const smallestCounter: Counter = { n: 0 };
  const roundRobinPool = system.spawnAnonymous(
    Router.roundRobin(STRATEGY_POOL_SIZE, () => makeWorker(roundRobinCounter)),
  ) as ActorRef<'work'>;
  const smallestPool = system.spawnAnonymous(
    Router.smallestMailbox(STRATEGY_POOL_SIZE, () => makeWorker(smallestCounter)),
  ) as ActorRef<'work'>;

  const feed = async (pool: ActorRef<'work'>, counter: Counter): Promise<void> => {
    const start = counter.n;
    for (let i = 0; i < JOBS_PER_ITERATION; i++) pool.tell('work');
    while (counter.n < start + JOBS_PER_ITERATION) await Bun.sleep(1);
  };

  // Warm-up outside the measured loop, same reasoning as the size sweep.
  await feed(roundRobinPool, roundRobinCounter);
  await feed(smallestPool, smallestCounter);

  await runGroup(
    `single-node · router-strategy (pool of ${STRATEGY_POOL_SIZE}, ${JOBS_PER_ITERATION} jobs / iter)`,
    [
      {
        name: 'round-robin',
        unit: 'job',
        iterations: MEASURED_ITERATIONS,
        opsPerIteration: JOBS_PER_ITERATION,
        run: async () => { await feed(roundRobinPool, roundRobinCounter); },
      },
      {
        name: 'smallest-mailbox',
        unit: 'job',
        iterations: MEASURED_ITERATIONS,
        opsPerIteration: JOBS_PER_ITERATION,
        run: async () => { await feed(smallestPool, smallestCounter); },
      },
    ],
  );

  roundRobinPool.stop();
  smallestPool.stop();
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-router', systemOptions);

  console.log(
    `\n  Router pool scaling — ${JOBS_PER_ITERATION} async jobs per iteration,\n`
    + `  each job = ${SIMULATED_IO_MS}ms sleep + ${CPU_BURST_ITERS.toLocaleString('en-US')}-iter CPU burst\n`,
  );

  for (const routees of [1, 2, 4, 8, 16] as const) {
    await runPooled(system, routees);
  }

  console.log(
    `\n  Routing strategy — what the smallest-mailbox depth scan costs\n`
    + `  against round-robin at a pool of ${STRATEGY_POOL_SIZE}\n`,
  );
  await runStrategies(system);

  await system.terminate();
}

void main();
