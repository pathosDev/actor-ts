/**
 * The one CPU-bound loop every worker benchmark in this directory burns.
 *
 * It lives in its own module so the *same bytes* run on both sides of a
 * thread boundary: `_cpu-worker.ts` runs it inside a worker, and
 * `task-offload-breakeven.ts` runs it inline on the main thread as the
 * baseline the pool rows are compared against.  A break-even measured with
 * two loops that merely look alike would measure the difference between the
 * loops.
 *
 * A tight, branch-heavy loop the JIT cannot fold away — `acc` stays live and
 * is returned, so the work is observable and a reply carrying it is proof the
 * loop ran.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
export function crunch(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = (acc + (i * 2654435761)) | 0;
    acc = ((acc << 5) | (acc >>> 27)) ^ i;
  }
  return acc;
}
