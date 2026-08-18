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
import { afterEach, describe, expect, test } from 'bun:test';
import {
  autoHandshake,
  FakeWorker,
  FakeWorkerBackend,
} from './__fixtures__/InMemoryWorkerThread.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';
import { WorkerCluster } from '../../../src/worker/WorkerCluster.js';
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

  test('"auto" without env / nav fallback returns 2', async () => {
    // Ensure the env var is not set.
    delete process.env.ACTOR_TS_WORKERS;
    // Also clear any navigator.hardwareConcurrency so the fallback hits.
    const realNav = (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { navigator?: unknown }).navigator;

    const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers('auto')
        .withBackend(backend);
      const cluster = await WorkerCluster.spawn(
        workerOptions,
      );
      expect(cluster.size).toBe(2);
      await cluster.terminate();
    } finally {
      if (realNav) (globalThis as { navigator?: unknown }).navigator = realNav;
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
