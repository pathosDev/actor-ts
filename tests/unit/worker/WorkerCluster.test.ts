/**
 * WorkerCluster tests — exercises the orchestration / handshake /
 * restart-policy logic against an in-memory `FakeWorkerBackend`.  The
 * real WorkerBackend spawns OS threads via worker_threads (Node) or
 * the Web Worker API (Bun/Deno); the fake skips all that and lets us
 * drive the handshake protocol by hand.
 *
 * The `mock.module` call replaces the runtime backend resolver so
 * `WorkerCluster.spawn(...)` picks up our fake.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  autoHandshake,
  FakeWorker,
  FakeWorkerBackend,
} from './__fixtures__/in-memory-worker-thread.js';

// Per-test mutable backend the WorkerCluster will resolve to.  Tests
// install their FakeWorkerBackend by assignment.
let activeBackend: FakeWorkerBackend = new FakeWorkerBackend();

mock.module('../../../src/runtime/worker/index.js', () => ({
  getWorkerBackend: async () => activeBackend,
  resetWorkerBackendCache: () => { /* no-op for tests */ },
}));

import { WorkerCluster } from '../../../src/worker/WorkerCluster.js';
import { WorkerClusterOptions } from '../../../src/worker/WorkerClusterOptions.js';

beforeEach(() => {
  activeBackend = new FakeWorkerBackend();
});

afterEach(() => {
  // Restore any env-var override.
  delete process.env.ACTOR_TS_WORKERS;
});

describe('WorkerCluster — spawn', () => {
  test('spawns the requested number of workers + completes handshake', async () => {
    // Auto-handshake every new worker.
    const backend = new FakeWorkerBackend({
      onSpawn: (w) => autoHandshake(w),
    });
    activeBackend = backend;

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake-bootstrap.js'))
      .withWorkers(3)
      .withSystemName('multi')
      .withHostname('host')
      .withBasePort(100);
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
    activeBackend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake-bootstrap.js'))
      .withWorkers(2);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );

    await cluster.terminate();
    expect(activeBackend.spawned.every(w => w.terminated)).toBe(true);
    expect(cluster.size).toBe(0);
    // Idempotent — second call is a no-op.
    await cluster.terminate();
    expect(cluster.size).toBe(0);
  });

  test('handshake timeout rejects spawn', async () => {
    // No autoHandshake — the worker never replies, so spawn rejects.
    activeBackend = new FakeWorkerBackend({ /* no hook */ });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withReadyTimeoutMs(50);
    await expect(WorkerCluster.spawn(
      workerOptions,
    )).rejects.toThrow(/did not become ready/);
  });

  test('passes init data through to the worker', async () => {
    activeBackend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withSystemName('sysA')
      .withInitData({ hello: 'world', n: 42 });
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );

    // The worker-init frame is captured in `posted` by the fake worker
    // before autoHandshake's postMessage patch replays it.  Look for
    // it directly.
    const worker = activeBackend.latest();
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
    activeBackend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(4)
      .withBasePort(7000);
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
    activeBackend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers('auto');
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

    activeBackend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });
    try {
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake.js'))
        .withWorkers('auto');
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
    activeBackend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1);
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(cluster.size).toBe(1);
    await cluster.terminate();
  });
});

describe('WorkerCluster — restart policy', () => {
  test('"on-failure" respawns when a worker crashes non-zero', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });
    activeBackend = backend;

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure');
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    const crashed = backend.spawned[0]!;
    crashed.simulateCrash(1);
    // Give the async spawnOne a tick.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // A new worker was spawned to replace it.
    expect(backend.spawned.length).toBeGreaterThanOrEqual(2);
    await cluster.terminate();
  });

  test('"never" does NOT respawn after a crash', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });
    activeBackend = backend;

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('never');
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    backend.spawned[0]!.simulateCrash(1);
    await Promise.resolve(); await Promise.resolve();
    // Still exactly one spawn — the crashed worker was not replaced.
    expect(backend.spawned.length).toBe(1);
    await cluster.terminate();
  });

  test('"always" respawns even on clean exit', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });
    activeBackend = backend;

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('always');
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    // Manually fire the 'close' event with code 0 (clean exit).
    const w = backend.spawned[0]!;
    // We can't use terminate() here because it would also fire close
    // *during cluster shutdown* — we want to test mid-operation.
    // Synthesise close directly:
    (w as unknown as { closeListeners: Set<(e: { code: number }) => void> })
      // simulateCrash with code 0 = clean exit, restartPolicy='always' must respawn.
      ;
    w.simulateCrash(0);
    await Promise.resolve(); await Promise.resolve();
    expect(backend.spawned.length).toBeGreaterThanOrEqual(2);
    await cluster.terminate();
  });

  test('"on-failure" does NOT respawn on clean exit (code=0)', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });
    activeBackend = backend;

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('on-failure');
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    expect(backend.spawned.length).toBe(1);
    backend.spawned[0]!.simulateCrash(0); // clean exit
    await Promise.resolve(); await Promise.resolve();
    // Still exactly one — clean exits are not failures.
    expect(backend.spawned.length).toBe(1);
    await cluster.terminate();
  });

  test('close event after cluster.terminate() does NOT spawn a replacement', async () => {
    const backend = new FakeWorkerBackend({ onSpawn: (w) => autoHandshake(w) });
    activeBackend = backend;

    const workerOptions = WorkerClusterOptions.create()
      .withBootstrap(new URL('file:///fake.js'))
      .withWorkers(1)
      .withRestartPolicy('always');
    const cluster = await WorkerCluster.spawn(
      workerOptions,
    );
    const w = backend.spawned[0]!;
    await cluster.terminate();
    const beforeCount = backend.spawned.length;
    // Once cluster is closed, late close events are ignored.
    w.simulateCrash(1);
    await Promise.resolve();
    expect(backend.spawned.length).toBe(beforeCount);
  });
});
