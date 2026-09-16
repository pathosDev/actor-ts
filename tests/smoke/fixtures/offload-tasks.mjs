/**
 * The task module of the offload smoke case: pure functions every real
 * worker thread imports by URL on Bun, Node and Deno.  No framework import —
 * a task is a function, which is the whole point of the pool.
 */
export function fibonacci(n) {
  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

export function boom(message) {
  throw new RangeError(message);
}

/** Burns the thread for `ms`: what a task that overruns its deadline looks like. */
export function busyWait(ms) {
  const until = Date.now() + ms;
  let spins = 0;
  while (Date.now() < until) spins++;
  return spins;
}
