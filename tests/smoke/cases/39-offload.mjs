/**
 * Smoke case: `OffloadPool` on this runtime's real worker threads (#1558).
 *
 * The unit suite proves the protocol in-process and the multi-node suite
 * proves it on Bun's threads; this is the only gate that runs the shipped
 * `offload-worker` as a worker entry on **Node** (`worker_threads`, from
 * `dist/`) and **Deno** (Web Worker, from `dist/`) — three `Worker`
 * implementations, three resolutions of the bootstrap next to the package's
 * own files, and a task module imported by URL inside each.
 *
 * Four parallel tasks, one that throws, one that overruns its deadline and
 * has its thread stopped, and `system.terminate()` releasing every worker on
 * every path — a leftover thread would keep Deno's event loop alive past the
 * last green line (#1196).  Failures are settled through try/catch on
 * purpose: see the multi-node suite for what `expect(...).rejects` does to a
 * worker message on Bun.
 *
 * Two claims the blocking-and-cpu-bound-work page makes about what crosses
 * the boundary are held here on all three runtimes, because each is a
 * property of the runtime's structured clone rather than of the pool
 * (#1191): a `SharedArrayBuffer` among the arguments is shared — a worker's
 * `Atomics.store` is visible on this thread — and never accepted in a
 * transfer list; and a result is cloned back, however large, never moved —
 * the worker that produced a buffer still holds every byte of it.  The docs
 * used to hedge "untested on Deno"; this is where that hedge went.
 */
export const name = 'offload pool';
export const description = 'pure functions run on real worker threads; a SharedArrayBuffer is shared, a result is cloned; errors, deadlines and terminate() behave';

/** Large enough to be the "however large" the docs promise rather than a few inline bytes; small enough for a smoke case. */
const RESULT_BYTES = 4 * 1024 * 1024;

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, defineOffloadTask, OffloadArgumentsError, OffloadTaskError, OffloadTimeoutError } = actorTs;
  const { OffloadPool, OffloadPoolOptions } = await loadEntry('worker');

  const tasks = new URL('../fixtures/offload-tasks.mjs', import.meta.url);
  const fibonacci = defineOffloadTask(tasks, 'fibonacci');
  const boom = defineOffloadTask(tasks, 'boom');
  const busyWait = defineOffloadTask(tasks, 'busyWait');
  const storeShared = defineOffloadTask(tasks, 'storeShared');
  const bytesResult = defineOffloadTask(tasks, 'bytesResult');
  const heldByteLength = defineOffloadTask(tasks, 'heldByteLength');

  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-offload', systemOptions);
  const pool = OffloadPool.start(system, OffloadPoolOptions.create().withSize(4).withMaxRestarts(2));
  try {
    const results = await Promise.all([25, 25, 25, 25].map((n) => pool.run(fibonacci, [n], { timeoutMs: 30_000 })));
    if (results.some((r) => r !== 75025)) throw new Error(`fibonacci(25) answered ${JSON.stringify(results)}, expected 75025 x4`);
    if (pool.workerCount !== 4) throw new Error(`expected 4 workers, got ${pool.workerCount}`);

    // Shared, not copied: the worker writes into this thread's memory.
    const counters = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
    const echoed = await pool.run(storeShared, [counters, 2, 42], { timeoutMs: 30_000 });
    if (echoed !== 42) throw new Error(`storeShared read back ${echoed} on the worker, expected 42`);
    const seen = Atomics.load(counters, 2);
    if (seen !== 42) throw new Error(`the worker's Atomics.store is invisible here (slot 2 reads ${seen}, expected 42): the SharedArrayBuffer was copied, not shared`);

    // Not movable either: a SharedArrayBuffer in the transfer list is the
    // caller's mistake, refused on this side before any worker sees it.
    let refused = null;
    try { await pool.run(storeShared, [counters, 3, 1], { transfer: [counters.buffer] }); } catch (error) { refused = error; }
    if (!(refused instanceof OffloadArgumentsError) || refused.cause?.name !== 'DataCloneError') {
      throw new Error(`a SharedArrayBuffer in the transfer list rejected with ${refused?.name} (cause ${refused?.cause?.name}), expected OffloadArgumentsError over a DataCloneError`);
    }
    if (Atomics.load(counters, 3) !== 0) throw new Error('a refused run reached a worker: slot 3 was written');

    // Cloned back, however large, and never moved: every byte arrives here,
    // and the worker that produced them still holds them.  Four runs issued
    // in one tick do NOT land one per worker, though: the pool grows lazily,
    // counts a worker as alive from the moment it is spawned, and dispatches
    // only to one that has said it is ready — so on a runner where a thread
    // takes a while to boot, the fourth run queues behind whichever worker
    // frees first, which is the producer, and it answers twice (#1615,
    // `[4194304,-1,-1,4194304]` on the Windows Node leg).  Each reply names
    // its worker, and the claim is made over the distinct workers that
    // answered: the producer is ready by definition and idle after its reply,
    // so it is always among them.
    const bytes = await pool.run(bytesResult, [RESULT_BYTES, 7], { timeoutMs: 30_000 });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== RESULT_BYTES) {
      throw new Error(`bytesResult(${RESULT_BYTES}) came back as ${bytes?.constructor?.name} of ${bytes?.byteLength} bytes`);
    }
    if (bytes[0] !== 7 || bytes[RESULT_BYTES - 1] !== 7) throw new Error(`the result's bytes did not survive the clone: first ${bytes[0]}, last ${bytes[RESULT_BYTES - 1]}, expected 7`);
    const replies = await Promise.all(Array.from({ length: pool.workerCount }, () => pool.run(heldByteLength, [], { timeoutMs: 30_000 })));
    const heldByWorker = new Map(replies.map((reply) => [reply.worker, reply.held]));
    const held = [...heldByWorker.values()];
    if (held.filter((length) => length === RESULT_BYTES).length !== 1 || held.includes(0)) {
      throw new Error(`after the reply the ${heldByWorker.size} worker(s) that answered hold ${JSON.stringify(held)} bytes of the result, expected exactly one to hold ${RESULT_BYTES}: a 0 means the buffer was moved out of its worker rather than cloned`);
    }

    let thrown = null;
    try { await pool.run(boom, ['smoke boom']); } catch (error) { thrown = error; }
    if (!(thrown instanceof OffloadTaskError) || !thrown.message.includes('smoke boom')) {
      throw new Error(`a throwing task rejected with ${thrown?.name}: ${thrown?.message}`);
    }

    let overran = null;
    try { await pool.run(busyWait, [10_000], { timeoutMs: 200 }); } catch (error) { overran = error; }
    if (!(overran instanceof OffloadTimeoutError)) throw new Error(`a busy task rejected with ${overran?.name}, expected OffloadTimeoutError`);

    const afterwards = await pool.run(fibonacci, [10], { timeoutMs: 30_000 });
    if (afterwards !== 55) throw new Error(`fibonacci(10) after the deadline answered ${afterwards}`);
  } finally {
    await system.terminate();
  }
  if (pool.workerCount !== 0) throw new Error(`${pool.workerCount} worker(s) survived terminate()`);
}
