/**
 * Smoke case: actors on worker threads from configuration alone (#1563).
 *
 * The application code is the ordinary shape — `ActorSystem.create`,
 * `system.spawn`, `ask`, `system.terminate()` — and the only thing that
 * makes it multi-threaded is `actor-ts.parallelism.workers`.  Here that is
 * handed in as config, with the actor module named in code (the convention
 * would look for an `actors.mjs` next to this case, and the runner would take
 * that for a case).  Runs the shipped bootstrap as a worker entry on **Node**
 * and **Deno** from `dist/`, which the unit and multi-node suites cannot.
 *
 * Every handle released on every path: `terminate()` is the application's
 * one call, and it has to take the threads with it (#1196).
 */
export const name = 'parallelism';
export const description = 'system.spawn places actors on two real worker threads by config; terminate() takes them down';

export async function run({ actorTs }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, ParallelismOptions, PendingRemoteActorRef } = actorTs;

  const parallelism = ParallelismOptions.create()
    .withModule(new URL('../fixtures/parallelism-actors.mjs', import.meta.url));
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({
      'actor-ts': {
        parallelism: { workers: 2 },
        cluster: { 'gossip-interval': '40ms' },
        'worker-cluster': { 'ready-timeout': '20s' },
      },
    })
    .withParallelism(parallelism);
  const system = ActorSystem.create('smoke-para', systemOptions);
  try {
    const first = system.spawn(Where, 'first');
    const second = system.spawn(Where, 'second');
    const sum = system.spawn(Sum, 'sum');
    if (!(first instanceof PendingRemoteActorRef)) throw new Error('spawn() did not return a pending remote ref');
    for (let i = 1; i <= 100; i++) sum.tell({ kind: 'add', value: i });

    const homes = await Promise.all([first, second].map((ref) => ref.ask({ kind: 'where' }, 20_000)));
    for (const home of homes) {
      if (!String(home).startsWith('smoke-para@worker:')) throw new Error(`actor answered from ${home}, not a worker`);
    }
    const total = await sum.ask({ kind: 'sum' }, 20_000);
    if (total !== 5050) throw new Error(`sum answered ${total}, expected 5050`);
  } finally {
    await system.terminate();
  }
}

// The classes have to be the same module instances the main thread registers,
// so they are imported from the fixture rather than redefined here.
const { Where, Sum } = await import('../fixtures/parallelism-actors.mjs');
