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
 */
export const name = 'offload pool';
export const description = 'pure functions run on real worker threads; errors, deadlines and terminate() behave';

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, defineOffloadTask, OffloadTaskError, OffloadTimeoutError } = actorTs;
  const { OffloadPool, OffloadPoolOptions } = await loadEntry('worker');

  const tasks = new URL('../fixtures/offload-tasks.mjs', import.meta.url);
  const fibonacci = defineOffloadTask(tasks, 'fibonacci');
  const boom = defineOffloadTask(tasks, 'boom');
  const busyWait = defineOffloadTask(tasks, 'busyWait');

  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('smoke-offload', systemOptions);
  const pool = OffloadPool.start(system, OffloadPoolOptions.create().withSize(4).withMaxRestarts(2));
  try {
    const results = await Promise.all([25, 25, 25, 25].map((n) => pool.run(fibonacci, [n], { timeoutMs: 30_000 })));
    if (results.some((r) => r !== 75025)) throw new Error(`fibonacci(25) answered ${JSON.stringify(results)}, expected 75025 x4`);
    if (pool.workerCount !== 4) throw new Error(`expected 4 workers, got ${pool.workerCount}`);

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
