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

/**
 * Writes `value` into `counters[index]` and reads it back.  `counters` is an
 * `Int32Array` over a `SharedArrayBuffer`, so the write is meant to land in
 * the caller's memory rather than in a copy of it — the case compares on its
 * own view afterwards, which is the only observation that tells shared from
 * copied.
 */
export function storeShared(counters, index, value) {
  Atomics.store(counters, index, value);
  return Atomics.load(counters, index);
}

let heldResult = null;

/**
 * One id per worker: every thread imports its own instance of this module,
 * and `crypto.randomUUID()` is a global on all three runtimes.  The case
 * groups `heldByteLength` replies by it, because four runs issued in one
 * tick are not guaranteed to land on four different workers (#1615).
 */
const WORKER_ID = crypto.randomUUID();

/**
 * Returns `size` bytes of `fill` and keeps its own reference to them, so that
 * `heldByteLength` can say afterwards whether the reply cloned the buffer
 * (this worker still holds `size` bytes) or moved it (detached, so 0).
 */
export function bytesResult(size, fill) {
  heldResult = new Uint8Array(size).fill(fill);
  return heldResult;
}

/**
 * What this worker still holds of its last `bytesResult` — -1 on a worker
 * that never ran one — tagged with the worker it comes from.
 */
export function heldByteLength() {
  return { worker: WORKER_ID, held: heldResult === null ? -1 : heldResult.byteLength };
}
