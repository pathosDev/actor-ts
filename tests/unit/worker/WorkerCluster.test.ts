/**
 * WorkerCluster tests — exercises the orchestration / handshake /
 * restart-policy logic against an in-memory `FakeWorkerBackend`.  The
 * real WorkerBackend spawns OS threads via worker_threads (Node) or
 * the Web Worker API (Bun/Deno); the fake skips all that and lets us
 * drive the handshake protocol by hand.
 *
 * The fake goes in through the `backend` option.  It used to go in
 * through `mock.module`, which in Bun is process-global and permanent:
 * it outlived this file and handed the fake to every later test that
 * resolved a backend (#520).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  autoHandshake,
  FakeWorker,
  FakeWorkerBackend,
} from './__fixtures__/InMemoryWorkerThread.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
import { ThrowingLogger } from '../../util/ThrowingLogger.js';
import { NoopLogger } from '../../../src/Logger.js';
import { WorkerCluster } from '../../../src/worker/WorkerCluster.js';
import { availableParallelism, resetAvailableParallelismCache } from '../../../src/runtime/Parallelism.js';
import { WorkerClusterOptions } from '../../../src/worker/WorkerClusterOptions.js';
import type { WorkerPermanentlyDownInfo } from '../../../src/worker/WorkerClusterOptions.js';

afterEach(() => {
  // Restore any env-var override.
  delete process.env.ACTOR_TS_WORKERS;
});

/**
 * Respawns go through an exponential backoff now (#734), so every restart test
 * shrinks the delay to something a unit test can wait out and drops the jitter
 * that would otherwise make the wait non-deterministic.
 */
const FAST_RESTART_BACKOFF_MS = 2;
/**
 * Comfortably past a `FAST_RESTART_BACKOFF_MS` respawn plus its handshake — used
 * only where the assertion is that *nothing* happened, which cannot be polled
 * for.
 */
const RESPAWN_SETTLED_MS = 60;

describe('WorkerCluster — spawn', () => {
  test('spawns the requested number of workers + completes handshake', async () => {
    // Auto-handshake every new worker.
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => autoHandshake(spawned),
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake-bootstrap.js'))
      .withWorkers(3)
      .withSystemName('multi')
      .withHostname('host')
      .withBasePort(100)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );

    expect(cluster.size).toBe(3);
    expect(backend.spawned.length).toBe(3);
    // Addresses are basePort, basePort+1, basePort+2 (ports stay in
    // spawn order though splice() can change the order of `handles`).
    const ports = cluster.addresses.map(a => a.port).sort();
    expect(ports).toEqual([100, 101, 102]);

    await cluster.terminate();
  });

  test('terminate kills every worker + closes broker + idempotent', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake-bootstrap.js'))
      .withWorkers(2)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );

    await cluster.terminate();
    expect(backend.spawned.every(spawned => spawned.terminated)).toBe(true);
    expect(cluster.size).toBe(0);
    // Idempotent — second call is a no-op.
    await cluster.terminate();
    expect(cluster.size).toBe(0);
  });

  test('handshake timeout rejects spawn', async () => {
    // No autoHandshake — the worker never replies, so spawn rejects.
    const backend = new FakeWorkerBackend({ /* no hook */ });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withReadyTimeoutMs(50)
      .withBackend(backend);
    await expect(WorkerCluster.spawn(
      workerOptions,
    )).rejects.toThrow(/did not become ready/);
  });

  test('passes init data through to the worker', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withSystemName('sysA')
      .withInitData({ hello: 'world', n: 42 })
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );

    // The worker-init frame is captured in `posted` by the fake worker
    // before autoHandshake's postMessage patch replays it.  Look for
    // it directly.
    const worker = backend.latest();
    const init = worker.posted.find((m) =>
      (m as { kind?: string })?.kind === 'worker-init',
    ) as { kind: string; systemName: string; data: unknown };
    expect(init).toBeDefined();
    expect(init.kind).toBe('worker-init');
    expect(init.systemName).toBe('sysA');
    expect(init.data).toEqual({ hello: 'world', n: 42 });
    await cluster.terminate();
  });

  test('basePort + index assigns sequential ports', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(4)
      .withBasePort(7000)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );

    const ports = cluster.addresses.map(a => a.port).sort();
    expect(ports).toEqual([7000, 7001, 7002, 7003]);
    await cluster.terminate();
  });

  test('a repeated worker-hello posts the init frame only once, per worker', async () => {
    // Driven by hand rather than through `autoHandshake`, and that is the whole
    // point: the auto-handshake replies `worker-ready` to the first init, which
    // tears the handshake listener down before a second hello could arrive.  A
    // test built on it would pass against the unlatched code too (#775).
    //
    // Two workers, not one, for the mirror-image reason: a latch hoisted to the
    // cluster instead of the handshake also survives "one worker, three hellos,
    // one init", and would starve every sibling of its init frame.
    const backend = new FakeWorkerBackend({ /* no hook — we drive the frames */ });
    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(2)
      .withInitData({ payload: 'a blob worth cloning' })
      .withBackend(backend);
    const spawning = WorkerCluster.spawn(workerOptions);

    await awaitCondition(() => backend.spawned.length === 2, {
      label: 'the cluster spawned both workers and installed their handshake listeners',
    });
    const [noisy, quiet] = backend.spawned as [FakeWorker, FakeWorker];
    const initFramesOf = (worker: FakeWorker): unknown[] =>
      worker.posted.filter((m) => (m as { kind?: string })?.kind === 'worker-init');

    noisy.deliverMessage({ kind: 'worker-hello' });
    expect(initFramesOf(noisy).length).toBe(1);

    // Further hellos from the same worker, handshake still open: the latch must
    // swallow them.  Unlatched, each is another structured clone of `initData`
    // on the main thread — one per frame for the whole ready window.
    noisy.deliverMessage({ kind: 'worker-hello' });
    noisy.deliverMessage({ kind: 'worker-hello' });
    expect(initFramesOf(noisy).length).toBe(1);

    // The sibling's first hello is still its first: the latch is per handshake.
    quiet.deliverMessage({ kind: 'worker-hello' });
    expect(initFramesOf(quiet).length).toBe(1);

    // Finish both handshakes so `spawn()` resolves and the mesh tears down clean.
    for (const worker of [noisy, quiet]) {
      const init = initFramesOf(worker)[0] as { self: unknown };
      worker.deliverMessage({ kind: 'worker-ready', self: init.self });
    }
    const cluster = await spawning;
    expect(cluster.size).toBe(2);
    await cluster.terminate();
  });
});

describe('WorkerCluster — worker-count resolution', () => {
  test('"auto" honours ACTOR_TS_WORKERS env var', async () => {
    process.env.ACTOR_TS_WORKERS = '5';
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers('auto')
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(cluster.size).toBe(5);
    await cluster.terminate();
  });

  /**
   * `'auto'` without the env override is the machine's available parallelism
   * — the framework's own probe, which prefers `os.availableParallelism()`
   * over `navigator.hardwareConcurrency` because the latter reports the host
   * inside a container (#1440, #1562).  The navigator is removed so a runtime
   * without `os.availableParallelism` would exercise the probe's floor of 2
   * instead of its second source; on one *with* it, the answer is the OS's.
   */
  test('"auto" without env resolves through availableParallelism()', async () => {
    delete process.env.ACTOR_TS_WORKERS;
    const realNav = (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { navigator?: unknown }).navigator;
    resetAvailableParallelismCache();

    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers('auto')
        .withBackend(backend);
      const cluster = await WorkerCluster.spawn(
        workerOptions,
      );
      expect(cluster.size).toBe(await availableParallelism());
      expect(cluster.size).toBeGreaterThanOrEqual(2);
      await cluster.terminate();
    } finally {
      if (realNav) (globalThis as { navigator?: unknown }).navigator = realNav;
      resetAvailableParallelismCache();
    }
  });

  test('numeric workers value is used as-is even if env var is set', async () => {
    process.env.ACTOR_TS_WORKERS = '99'; // would override 'auto' but not a number
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(cluster.size).toBe(1);
    await cluster.terminate();
  });
});

describe('WorkerCluster — restart policy', () => {
  test('"on-failure" respawns when a worker crashes non-zero', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    const crashed = backend.spawned[0]!;
    crashed.simulateCrash(1);
    await awaitCondition(() => backend.spawned.length >= 2, {
      label: 'the crashed worker was replaced',
    });
    await cluster.terminate();
  });

  test('"never" does NOT respawn after a crash', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('never')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    backend.spawned[0]!.simulateCrash(1);
    // Absence: a respawn would now be scheduled behind the backoff, so the wait
    // has to outlast it before "still one" means anything.  Not pollable — the
    // condition is already true at t=0.
    await sleep(RESPAWN_SETTLED_MS);
    expect(backend.spawned.length).toBe(1);
    await cluster.terminate();
  });

  test('"always" respawns even on clean exit', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('always')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    // Fire `close` with code 0 by hand rather than via terminate(), which would
    // also close the cluster and suppress the restart we are testing.
    backend.spawned[0]!.simulateCrash(0);
    await awaitCondition(() => backend.spawned.length >= 2, {
      label: "a cleanly exited worker was replaced under 'always'",
    });
    await cluster.terminate();
  });

  test('"on-failure" does NOT respawn on clean exit (code=0)', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    backend.spawned[0]!.simulateCrash(0); // clean exit
    // Absence, same reasoning as the 'never' case above.
    await sleep(RESPAWN_SETTLED_MS);
    expect(backend.spawned.length).toBe(1);
    await cluster.terminate();
  });

  test('close event after cluster.terminate() does NOT spawn a replacement', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('always')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    const spawned = backend.spawned[0]!;
    await cluster.terminate();
    const beforeCount = backend.spawned.length;
    // Once cluster is closed, late close events are ignored.
    spawned.simulateCrash(1);
    // Absence: outlast the backoff a respawn would have used.
    await sleep(RESPAWN_SETTLED_MS);
    expect(backend.spawned.length).toBe(beforeCount);
  });
});

/* ------------------------------------------------------------------------ */
/* #700 — an uncaught throw inside a worker                                  */
/* ------------------------------------------------------------------------ */

describe('WorkerCluster — worker error containment', () => {
  test("an 'error' with no following 'close' still respawns — the Deno shape", async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    expect(backend.spawned.length).toBe(1);

    // Deno's parent-side Worker emits no `close` at all, so `error` is the only
    // signal there is — the restart path has to be reachable from it alone.
    backend.spawned[0]!.simulateError('uncaught in worker');
    await awaitCondition(() => backend.spawned.length >= 2, {
      label: 'an error-only failure was replaced',
    });
    await cluster.terminate();
  });

  test("'error' followed by 'close' respawns exactly once", async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);

    // Both Node and Bun emit `error` and *then* the exit for one throw.  Routing
    // the new event into the existing close path — which is what the issue asked
    // for — would spawn two replacements here.
    backend.spawned[0]!.simulateUncaughtThrow();
    await awaitCondition(() => backend.spawned.length >= 2, {
      label: 'the throwing worker was replaced',
    });
    // Absence of a *second* replacement: give both events' respawn windows time
    // to elapse, then prove only one landed.
    await sleep(RESPAWN_SETTLED_MS);
    expect(backend.spawned.length).toBe(2);
    expect(cluster.size).toBe(1);
    await cluster.terminate();
  });

  test('a stale event from a dead worker does not tear down its replacement', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure')
      // No delay, so the replacement is registered before the second event of
      // the pair arrives — which is what makes the latch observable at all.
      .withRestartMinBackoffMs(0)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    const dead = backend.spawned[0]!;

    dead.simulateError('uncaught in worker');
    await awaitCondition(() => backend.spawned.length === 2 && cluster.size === 1, {
      label: 'the replacement is registered and serving the slot',
    });

    // The second half of the pair Node and Bun emit for one throw.  The
    // replacement now owns the same address, so without the per-worker latch
    // this unregisters and respawns a perfectly healthy worker.
    dead.simulateCrash(1);
    // Absence: a zero backoff means the damage would land on the next turn.
    await sleep(RESPAWN_SETTLED_MS);
    expect(backend.spawned.length).toBe(2);
    expect(cluster.size).toBe(1);
    expect(backend.spawned[1]!.terminated).toBe(false);
    await cluster.terminate();
  });

  test('an error during the handshake rejects spawn without waiting out readyTimeoutMs', async () => {
    const backend = new FakeWorkerBackend({
      // Fired after the cluster has installed its handshake listeners, and
      // deliberately without autoHandshake: this is a bootstrap that throws.
      onSpawn: (spawned) => { queueMicrotask(() => spawned.simulateError('bootstrap blew up')); },
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      // Large enough that reaching it would be unmistakable in the elapsed time.
      .withReadyTimeoutMs(30_000)
      .withBackend(backend);
    const startedAt = performance.now();
    await expect(WorkerCluster.spawn(workerOptions))
      .rejects.toThrow(/failed during startup: bootstrap blew up/);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    // And the worker that failed to start is not left running (#735).
    expect(backend.spawned[0]!.terminated).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* #702 / #734 — a failing respawn, the backoff, and the budget              */
/* ------------------------------------------------------------------------ */

describe('WorkerCluster — respawn failure and restart budget', () => {
  test('a replacement that never becomes ready degrades the mesh instead of killing the host', async () => {
    // Only the first incarnation handshakes; every replacement times out.  The
    // rejection used to be dropped by `void this.spawnOne(index)`, which bun
    // test surfaces as an unhandled rejection and attributes to this test.
    let spawns = 0;
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => { if (spawns++ === 0) autoHandshake(spawned); },
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withReadyTimeoutMs(20)
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withMaxRestarts(1)
      .withOnWorkerPermanentlyDown(() => { /* keep the default console sink quiet */ })
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    expect(cluster.size).toBe(1);

    backend.spawned[0]!.simulateCrash(1);
    await awaitCondition(() => cluster.size === 0 && backend.spawned.length >= 2, {
      label: 'the failed respawn left the mesh one worker short',
    });
    // The half-started replacement is not left running either (#735).
    await awaitCondition(() => backend.spawned[1]!.terminated, {
      label: 'the timed-out replacement was terminated',
    });
    await cluster.terminate();
  });

  test('the restart budget retires the slot and reports it exactly once', async () => {
    // Nothing ever handshakes after the first worker, so every respawn fails and
    // the budget is the only thing that can end the loop.
    let spawns = 0;
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => { if (spawns++ === 0) autoHandshake(spawned); },
    });
    const down: WorkerPermanentlyDownInfo[] = [];

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withReadyTimeoutMs(10)
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartMaxBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withMaxRestarts(3)
      .withOnWorkerPermanentlyDown((info) => { down.push(info); })
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);

    backend.spawned[0]!.simulateCrash(1);
    await awaitCondition(() => down.length > 0, {
      label: 'the slot was reported permanently down',
      timeoutMs: 4_000,
    });
    // One original + exactly `maxRestarts` replacements, and no more.
    await sleep(RESPAWN_SETTLED_MS);
    expect(backend.spawned.length).toBe(4);
    expect(down.length).toBe(1);
    expect(down[0]!.index).toBe(0);
    expect(down[0]!.restarts).toBe(3);
    expect(down[0]!.address.port).toBe(1);
    expect(cluster.size).toBe(0);
    await cluster.terminate();
  });

  test('the respawn waits out the backoff instead of firing inside the close listener', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartMinBackoffMs(120)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);

    const startedAt = performance.now();
    backend.spawned[0]!.simulateCrash(1);
    // The respawn is not synchronous any more, which is the whole point.
    expect(backend.spawned.length).toBe(1);
    await awaitCondition(() => backend.spawned.length >= 2, {
      label: 'the delayed respawn happened',
    });
    // The elapsed time IS the assertion here — a floor under the first backoff.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
    await cluster.terminate();
  });

  test('terminate() cancels a pending respawn and leaves the broker empty', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartMinBackoffMs(150)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);

    backend.spawned[0]!.simulateCrash(1);
    const spawnsBefore = backend.spawned.length;
    await cluster.terminate();
    // Absence: outlast the 150ms backoff and prove the cancelled timer never
    // registered a fresh port into the closed broker.
    await sleep(300);
    expect(backend.spawned.length).toBe(spawnsBefore);
    expect(cluster.broker.registered()).toEqual([]);
    expect(cluster.size).toBe(0);
  });
});

/* ------------------------------------------------------------------------ */
/* #735 — worker threads must not outlive the failure that dropped them      */
/* ------------------------------------------------------------------------ */

describe('WorkerCluster — no leaked threads on the failure paths', () => {
  test('a handshake timeout terminates its own worker', async () => {
    const backend = new FakeWorkerBackend({ /* nobody handshakes */ });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withReadyTimeoutMs(20)
      .withBackend(backend);
    await expect(WorkerCluster.spawn(workerOptions)).rejects.toThrow(/did not become ready/);
    expect(backend.spawned.length).toBe(1);
    expect(backend.spawned[0]!.terminated).toBe(true);
  });

  test('a partial spawn failure terminates the workers that did start', async () => {
    // Slot 1 never handshakes; slots 0 and 2 come up fine and would otherwise be
    // unreachable live threads, since `spawn()` never returns the instance.
    let spawns = 0;
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => { if (spawns++ !== 1) autoHandshake(spawned); },
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(3)
      .withReadyTimeoutMs(30)
      .withBackend(backend);
    await expect(WorkerCluster.spawn(workerOptions)).rejects.toThrow(/did not become ready/);
    expect(backend.spawned.length).toBe(3);
    expect(backend.spawned.map(spawned => spawned.terminated)).toEqual([true, true, true]);
  });

  test('a spawn failure also terminates a sibling still mid-handshake', async () => {
    // Slot 1 fails immediately, slot 2 hangs.  `spawn()` therefore rejects while
    // slot 2's handshake is still in flight, which is a worker no `handles`
    // entry points at yet — and the only reason it can be reached at all is the
    // in-flight set.  Without it, slot 2 keeps running until its own
    // `readyTimeoutMs`, which here is two seconds away.
    let spawns = 0;
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => {
        const slot = spawns++;
        if (slot === 0) { autoHandshake(spawned); return; }
        if (slot === 1) { queueMicrotask(() => spawned.simulateError('slot 1 blew up')); }
      },
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(3)
      .withReadyTimeoutMs(2_000)
      .withBackend(backend);
    const startedAt = performance.now();
    await expect(WorkerCluster.spawn(workerOptions)).rejects.toThrow(/slot 1 blew up/);

    // Well inside slot 2's handshake window, so a leaked slot 2 would still be
    // running here rather than already timed out.
    expect(performance.now() - startedAt).toBeLessThan(500);
    await awaitCondition(() => backend.spawned.every(spawned => spawned.terminated), {
      label: 'every worker, including the one still starting, was terminated',
      timeoutMs: 500,
    });
  });

  test('terminate() does not resolve before every worker is actually gone', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(3)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);

    // The fake reports `terminated` when its termination promise resolves, not
    // when `terminate()` is called — so a fire-and-forget teardown reads false
    // here even though the call was made.
    await cluster.terminate();
    expect(backend.spawned.map(spawned => spawned.terminated)).toEqual([true, true, true]);
  });

  test('a replacement whose handshake completes after terminate() is cleaned up, not registered', async () => {
    // Only the first incarnation handshakes automatically; the replacement's is
    // driven by hand below so it can straddle terminate().
    let spawns = 0;
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => { if (spawns++ === 0) autoHandshake(spawned); },
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withReadyTimeoutMs(2_000)
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      // The crash below is the subject; its report is not, and the default
      // sink would put it on stderr of a green run (#1276).
      .withLogger(new NoopLogger())
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);

    backend.spawned[0]!.simulateCrash(1);
    await awaitCondition(() => backend.spawned.length >= 2, {
      label: 'the replacement was spawned',
    });
    const replacement = backend.spawned[1]!;

    // `terminate()` runs synchronously up to its own await, so the handshake
    // below resolves into a cluster that is already closed.
    const shuttingDown = cluster.terminate();
    completeHandshake(replacement);
    await shuttingDown;
    await awaitCondition(() => replacement.terminated, {
      label: 'the replacement that finished after shutdown was terminated',
    });

    // `size` is what binds the re-check: the broker would refuse the late
    // registration on its own, but nothing else stops the handle being pushed
    // into an array that is never cleared again.
    expect(cluster.size).toBe(0);
    expect(cluster.broker.registered()).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* #1276 — what the pool reports, and through which sink                    */
/* ------------------------------------------------------------------------ */

describe('WorkerCluster — what the pool reports (#1276)', () => {
  /**
   * `RecordingLogger` records the message string and drops `...args`, so every
   * fact these tests read has to be inside the line — which is also the rule
   * the reports follow, because a structured argument is invisible to a
   * console sink and to most log shippers.
   */
  const reportingOptions = (logger: RecordingLogger, backend: FakeWorkerBackend) => WorkerClusterOptions.create()
    .withBootstrap(new URL('file:///fake.js'))
    .withWorkers(1)
    .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
    .withRestartRandomFactor(0)
    .withLogger(logger)
    .withBackend(backend);

  const messagesAt = (logger: RecordingLogger, level: string): string[] =>
    logger.records.filter((record) => record.level === level).map((record) => record.message);

  test('a close event that reads as a crash is reported, and so is the restart it buys', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend).withRestartPolicy('on-failure');
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      expect(logger.records).toEqual([]);
      backend.spawned[0]!.simulateCrash(1);

      // Both lines are synchronous with the event: the exit is a fact the
      // moment it arrives, and the restart is granted before its timer is armed.
      const warnings = messagesAt(logger, 'warn');
      expect(warnings.filter((m) => /\[worker\] worker 0 \(worker-cluster@worker:1\) exited with code 1$/.test(m))).toHaveLength(1);
      expect(warnings.filter((m) => /\[worker\] respawning worker 0 \(worker-cluster@worker:1\) in \d+ ms \(restart 1 of 10 inside 60000 ms\)$/.test(m))).toHaveLength(1);
      expect(warnings).toHaveLength(2);
      // The code is a fact, never a verdict: the line does not say "crashed".
      expect(warnings.some((m) => /crash/.test(m))).toBe(false);
      expect(messagesAt(logger, 'error')).toEqual([]);

      await awaitCondition(() => backend.spawned.length >= 2, {
        label: 'the reported respawn actually happened',
      });
    } finally {
      await cluster.terminate();
    }
  });

  test("a clean exit under 'on-failure' is reported at info, together with the decision not to respawn", async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend).withRestartPolicy('on-failure');
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      backend.spawned[0]!.simulateCrash(0);

      const infos = messagesAt(logger, 'info');
      expect(infos.filter((m) => /\[worker\] worker 0 \(worker-cluster@worker:1\) exited with code 0$/.test(m))).toHaveLength(1);
      expect(infos.filter((m) => /\[worker\] worker 0 \(worker-cluster@worker:1\) is not respawned — restartPolicy 'on-failure'$/.test(m))).toHaveLength(1);
      expect(messagesAt(logger, 'warn')).toEqual([]);
      expect(logger.records.some((record) => /respawning/.test(record.message))).toBe(false);
      // Absence: a respawn would be scheduled behind the backoff, so the wait
      // has to outlast it before "still one" means anything.
      await sleep(RESPAWN_SETTLED_MS);
      expect(backend.spawned.length).toBe(1);
    } finally {
      await cluster.terminate();
    }
  });

  test("a crash under 'never' is reported as an exit and as a slot the policy leaves down", async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend).withRestartPolicy('never');
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      backend.spawned[0]!.simulateCrash(1);

      expect(messagesAt(logger, 'warn')).toEqual([
        '[worker] worker 0 (worker-cluster@worker:1) exited with code 1',
      ]);
      expect(messagesAt(logger, 'info')).toEqual([
        "[worker] worker 0 (worker-cluster@worker:1) is not respawned — restartPolicy 'never'",
      ]);
      expect(logger.records.some((record) => /respawning/.test(record.message))).toBe(false);
    } finally {
      await cluster.terminate();
    }
  });

  test('shutdown is silent — the synthetic close events terminate() raises are not reported', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend)
      .withWorkers(3)
      .withRestartPolicy('always');
    const cluster = await WorkerCluster.spawn(workerOptions);
    const before = logger.records.length;
    // The fixture synthesises a `{ code: 0 }` close per worker on a macrotask,
    // and `terminate()` resolves only after every one of them has fired — so
    // by the time this returns, three closes have been through `onClose`.
    await cluster.terminate();
    expect(backend.spawned.every((spawned) => spawned.terminated)).toBe(true);
    expect(logger.records.length).toBe(before);
    // A late event from a worker that outlived the pool says nothing either.
    backend.spawned[0]!.simulateCrash(1);
    expect(logger.records.length).toBe(before);
  });

  test('under an unlimited budget the restart line says so instead of quoting a tally that is never kept', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend).withMaxRestarts(-1);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      backend.spawned[0]!.simulateCrash(1);

      const respawning = messagesAt(logger, 'warn').filter((m) => /respawning worker 0/.test(m));
      expect(respawning).toHaveLength(1);
      // `RestartBudget.registerRestart` records nothing when the allowance is
      // negative (#1255), so "restart 0 of -1" is what a naive line would say.
      expect(respawning[0]).toMatch(/\(restart budget unlimited\)$/);
      expect(respawning[0]).not.toMatch(/of -1/);
      await awaitCondition(() => backend.spawned.length >= 2, {
        label: 'the unlimited budget granted the respawn',
      });
    } finally {
      await cluster.terminate();
    }
  });

  test('an error event is reported at error with the failure text inside the line', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      backend.spawned[0]!.simulateError('worker boom');

      expect(messagesAt(logger, 'error')).toEqual([
        '[worker] worker 0 (worker-cluster@worker:1) failed: worker boom',
      ]);
      // An error is a crash for the policy, so the granted restart follows.
      expect(messagesAt(logger, 'warn').filter((m) => /respawning worker 0/.test(m))).toHaveLength(1);
      await awaitCondition(() => backend.spawned.length >= 2, {
        label: 'the error-driven respawn happened',
      });
    } finally {
      await cluster.terminate();
    }
  });

  test('a spent budget with no callback is reported once, at error, with the last failure appended', async () => {
    // Only the first incarnation handshakes; the one granted replacement times
    // out, spends the budget of one, and retires the slot.
    let spawns = 0;
    const backend = new FakeWorkerBackend({
      onSpawn: (spawned) => { if (spawns++ === 0) autoHandshake(spawned); },
    });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend)
      .withReadyTimeoutMs(20)
      .withMaxRestarts(1);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      backend.spawned[0]!.simulateCrash(1);
      await awaitCondition(
        () => messagesAt(logger, 'error').some((m) => /is permanently down/.test(m)),
        { label: 'the retired slot was reported', timeoutMs: 4_000 },
      );
      const errors = messagesAt(logger, 'error');
      expect(errors.filter((m) => /^\[worker\] respawning worker 0 \(worker-cluster@worker:1\) failed: Worker worker-cluster@worker:1 did not become ready within 20ms$/.test(m))).toHaveLength(1);
      expect(errors.filter((m) => /^\[worker\] worker 0 \(worker-cluster@worker:1\) is permanently down — 1 restarts inside 60000 ms exhausted its budget; last failure: Worker worker-cluster@worker:1 did not become ready within 20ms$/.test(m))).toHaveLength(1);
      expect(errors).toHaveLength(2);
    } finally {
      await cluster.terminate();
    }
  });

  test('a pool that builds its own broker hands it the same logger, so a dropped frame reports there too', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new RecordingLogger();
    const workerOptions = reportingOptions(logger, backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      // What a worker's transport puts on its channel reaches the broker
      // through the cluster's facade; a frame that is not an envelope is the
      // broker's `malformed` drop.
      backend.spawned[0]!.deliverMessage({ kind: 'worker-transport', envelope: 'not-an-envelope' });

      expect(cluster.broker.dropped()).toEqual({ malformed: 1, 'unknown-destination': 0, unroutable: 0 });
      expect(messagesAt(logger, 'warn')).toEqual([
        '[worker] broker dropped 1 frame(s), most recently from worker-cluster@worker:1 — the envelope is not a BrokeredMessage — '
        + 'its address fields failed the shape check, and nothing past them was read',
      ]);
    } finally {
      await cluster.terminate();
    }
  });

  test('without withLogger the reports reach the console — a default sink beats silence', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers(1)
        .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
        .withRestartRandomFactor(0)
        .withBackend(backend);
      const cluster = await WorkerCluster.spawn(workerOptions);
      try {
        backend.spawned[0]!.simulateCrash(1);
        // `ConsoleLogger` renders a timestamp and a tag ahead of the message,
        // so the line is looked for inside the first argument, not equal to it.
        const warned = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(warned.some((line) => line.includes('[worker] worker 0 (worker-cluster@worker:1) exited with code 1'))).toBe(true);
        expect(warned.some((line) => line.includes('[worker] respawning worker 0 (worker-cluster@worker:1) in'))).toBe(true);

        await awaitCondition(() => backend.spawned.length >= 2, { label: 'the replacement was spawned' });
        backend.spawned[1]!.simulateError('worker boom');
        const errored = errorSpy.mock.calls.map((call) => String(call[0]));
        expect(errored.some((line) => line.includes('[worker] worker 0 (worker-cluster@worker:1) failed: worker boom'))).toBe(true);
      } finally {
        await cluster.terminate();
      }
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('a NoopLogger keeps the whole pool quiet — nothing bypasses the seam to reach the console', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers(1)
        .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
        .withRestartRandomFactor(0)
        .withLogger(new NoopLogger())
        .withBackend(backend);
      const cluster = await WorkerCluster.spawn(workerOptions);
      try {
        backend.spawned[0]!.simulateUncaughtThrow('worker boom', 1);
        await awaitCondition(() => backend.spawned.length >= 2, { label: 'the replacement was spawned' });
      } finally {
        await cluster.terminate();
      }
      expect(warnSpy.mock.calls).toEqual([]);
      expect(errorSpy.mock.calls).toEqual([]);
      expect(logSpy.mock.calls).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  /**
   * Every close-path report runs inside the worker's `close` listener, where
   * nothing above the pool catches, and `Logger` is a caller-supplied
   * extension point.  A sink that throws used to escape that listener — the
   * host-killing shape #701 closed — and it cost the respawn too: the exit
   * line comes before `onWorkerDown`, so the throw left the dead slot
   * unregistered and unreplaced.  Both facts are pinned: the throw is
   * contained, and the pool still degrades the way it would have without it.
   */
  test('a logger that throws cannot escape the close listener, and the respawn it stood in front of still happens', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new ThrowingLogger('the log sink is down');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers(1)
        .withRestartPolicy('on-failure')
        .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
        .withRestartRandomFactor(0)
        .withLogger(logger)
        .withBackend(backend);
      const cluster = await WorkerCluster.spawn(workerOptions);
      try {
        expect(() => backend.spawned[0]!.simulateCrash(1)).not.toThrow();
        // The exit line and the granted-restart line were both attempted.
        expect(logger.calls).toBe(2);
        await awaitCondition(() => backend.spawned.length >= 2, {
          label: 'the respawn survived the throwing logger',
        });
        // The lines are not lost: each lands on the console with the reason.
        const fallback = errorSpy.mock.calls.map((call) => String(call[0]));
        expect(fallback.filter((line) => /^\[worker\] worker 0 \(worker-cluster@worker:1\) exited with code 1 \(the configured logger threw while reporting this: the log sink is down\)$/.test(line))).toHaveLength(1);
        expect(fallback.filter((line) => /^\[worker\] respawning worker 0 \(worker-cluster@worker:1\) in \d+ ms \(restart 1 of 10 inside 60000 ms\) \(the configured logger threw/.test(line))).toHaveLength(1);
      } finally {
        await cluster.terminate();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a logger that throws cannot escape the error listener either', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    const logger = new ThrowingLogger();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers(1)
        .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
        .withRestartRandomFactor(0)
        .withLogger(logger)
        .withBackend(backend);
      const cluster = await WorkerCluster.spawn(workerOptions);
      try {
        expect(() => backend.spawned[0]!.simulateError('worker boom')).not.toThrow();
        await awaitCondition(() => backend.spawned.length >= 2, {
          label: 'the error-driven respawn survived the throwing logger',
        });
        const fallback = errorSpy.mock.calls.map((call) => String(call[0]));
        expect(fallback.some((line) => line.startsWith('[worker] worker 0 (worker-cluster@worker:1) failed: worker boom ('))).toBe(true);
      } finally {
        await cluster.terminate();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* #1288 — a backend that declares it does not contain worker errors        */
/* ------------------------------------------------------------------------ */

describe('WorkerCluster — backend containment declaration (#1288)', () => {
  const uncontainedLine = (logger: RecordingLogger): string[] =>
    logger.records.filter((record) => /containsWorkerErrors=false/.test(record.message)).map((record) => record.message);

  test('a backend declaring false is reported exactly once for the whole pool, before its workers exist', async () => {
    const logger = new RecordingLogger();
    // How many lines the log held when the first worker was spawned: the
    // report has to precede that worker, because it is the one that can kill
    // the host before anything else says why.
    let linesAtFirstSpawn = -1;
    const backend = new FakeWorkerBackend({
      containsWorkerErrors: false,
      onSpawn: (spawned) => {
        if (linesAtFirstSpawn < 0) linesAtFirstSpawn = uncontainedLine(logger).length;
        autoHandshake(spawned);
      },
    });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(2)
      .withLogger(logger)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      expect(backend.spawned).toHaveLength(2);
      // One line for two workers — the declaration is a fact about the
      // backend, not about a spawn.
      const lines = uncontainedLine(logger);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        '[worker] worker backend FakeWorkerBackend declares containsWorkerErrors=false — an uncaught throw inside '
        + "a worker will terminate this process instead of reaching the framework's error handler; wire error "
        + 'containment into its WorkerLike adapter (see cluster/worker-mesh, Failure containment)',
      );
      expect(logger.records.filter((record) => /containsWorkerErrors/.test(record.message)).every((record) => record.level === 'error')).toBe(true);
      expect(linesAtFirstSpawn).toBe(1);
    } finally {
      await cluster.terminate();
    }
  });

  test('a respawn through the same backend adds no second line — the latch is per backend instance', async () => {
    const logger = new RecordingLogger();
    const backend = new FakeWorkerBackend({
      containsWorkerErrors: false,
      onSpawn: (spawned) => autoHandshake(spawned),
    });
    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure')
      .withRestartMinBackoffMs(FAST_RESTART_BACKOFF_MS)
      .withRestartRandomFactor(0)
      .withLogger(logger)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      expect(uncontainedLine(logger)).toHaveLength(1);
      // The fake still delivers the simulated throw to the `error` listeners
      // — it declared `false` about a real runtime's behaviour, not about
      // itself — so the respawn path runs and goes through the resolver again.
      backend.spawned[0]!.simulateUncaughtThrow();
      await awaitCondition(() => backend.spawned.length >= 2, {
        label: 'the throwing worker was replaced through the same backend',
      });
      expect(uncontainedLine(logger)).toHaveLength(1);
    } finally {
      await cluster.terminate();
    }
  });

  test('the default fake — and so every shipped backend — produces no such line', async () => {
    const logger = new RecordingLogger();
    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    expect(backend.containsWorkerErrors).toBe(true);
    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(2)
      .withLogger(logger)
      .withBackend(backend);
    const cluster = await WorkerCluster.spawn(workerOptions);
    try {
      expect(logger.records).toEqual([]);
    } finally {
      await cluster.terminate();
    }
  });
});

/**
 * Drive the hello/init/ready handshake from the worker's side by hand, for the
 * cases that need it to complete at a chosen moment rather than as soon as the
 * parent subscribes (which is all {@link autoHandshake} can do).
 */
function completeHandshake(worker: FakeWorker): void {
  worker.deliverMessage({ kind: 'worker-hello' });
  const init = worker.posted.find(
    (posted) => (posted as { kind?: string } | null)?.kind === 'worker-init',
  ) as { self: unknown } | undefined;
  if (init === undefined) throw new Error('completeHandshake: no worker-init was posted');
  worker.deliverMessage({ kind: 'worker-ready', self: init.self });
}
