/**
 * The task module of the real-thread offload test (#1558): pure CPU work a
 * worker thread imports by URL.  No framework import — a task is a function.
 */

export function fibonacci(n: number): number {
  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

/** Burns the thread for `ms` — what a task that overruns its deadline looks like. */
export function busyWait(ms: number): number {
  const until = Date.now() + ms;
  let spins = 0;
  while (Date.now() < until) spins++;
  return spins;
}

export function boom(message: string): never {
  throw new RangeError(message);
}

/** Sums a buffer handed over by transfer, and reports its length — zero after a transfer on the caller's side. */
export function sumBuffer(buffer: ArrayBuffer): number {
  let total = 0;
  for (const byte of new Uint8Array(buffer)) total += byte;
  return total;
}
