/**
 * The worker-mesh metrics relay (#1570) on real OS threads.
 *
 * `tests/unit/worker/WorkerMesh.test.ts` runs the identical relay in-process
 * and proves the protocol; this file proves the two things only a thread can:
 * that a snapshot — `registry.collect()` verbatim, `+Inf` histogram buckets
 * included — survives the structured clone a real `MessagePort` applies, and
 * that the request the main thread sends switches on a registry that lives
 * on another thread.  Kept apart from `WorkerMesh.test.ts` so the two suites
 * can move independently.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import type { MetricSample } from '../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import { renderPrometheusSamples } from '../../src/metrics/PrometheusExporter.js';
import { ParallelismOptions } from '../../src/parallelism/ParallelismOptions.js';
import { WorkerMesh } from '../../src/worker/WorkerMesh.js';
import { DEFAULT_MESH_METRICS_RELAY_INTERVAL_MS, WorkerMeshOptions } from '../../src/worker/WorkerMeshOptions.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import { Where } from './internal/ParallelismActors.js';
import type { WhereCommand } from './internal/WorkerMeshActors.js';

const ASKS_PER_WORKER = 5;

/** What both tests put in the HOCON leaf — a fraction of {@link RELAYED_WITHIN_MS}. */
const RELAY_INTERVAL_MS = 200;

/**
 * How long a counter minted on a worker may take to reach `collectAll()`:
 * half the **default** relay interval.  The relay asks once inside
 * `WorkerMesh.start` and then only on its ticker, so a counter minted after
 * the mesh is up crosses on the first tick after it — ten seconds in under the
 * default, a fifth of a second under the leaf both tests set.  A wait bounded
 * here can therefore be satisfied by the configured interval alone; the
 * fifteen-second budgets these tests used to carry were satisfied by the
 * default too, so with the `getDuration` read removed both stayed green and
 * the leaf reaching `WorkerMesh.start` was not what the suite proved.  The
 * elapsed-time assertions beside each wait hold the same bound against the
 * wall clock, because `awaitCondition` scales its budget with the test time
 * factor and the default interval does not.
 *
 * A literal, because `AwaitConditionBudgets` resolves a named budget only
 * from a `const NAME = <number>;`; the first test below pins it to the
 * default it is half of, so a raised default cannot leave the bound behind.
 */
const RELAYED_WITHIN_MS = 5_000;

const delivered = (samples: ReadonlyArray<MetricSample>, thread: string): number | undefined =>
  samples.find((s) => s.name === 'actor_messages_delivered_total' && s.labels.thread === thread)?.value;

/** Deliveries relayed from every worker thread, summed — the main thread's own row, if any, is not a worker's. */
const deliveredOnWorkers = (samples: ReadonlyArray<MetricSample>): number =>
  samples
    .filter((s) => s.name === 'actor_messages_delivered_total' && String(s.labels.thread).startsWith('worker-'))
    .reduce((sum, s) => sum + s.value, 0);

describe('WorkerMesh metrics relay on real worker threads', () => {
  test('the bound both waits rest on is half the default interval, and the leaf is a fraction of it', () => {
    // The two real-thread tests prove the leaf reached `WorkerMesh.start`
    // only while the default alone cannot satisfy their waits; this is that
    // premise, stated where a change to the default trips over it.
    expect(RELAYED_WITHIN_MS).toBe(DEFAULT_MESH_METRICS_RELAY_INTERVAL_MS / 2);
    expect(RELAY_INTERVAL_MS * 10).toBeLessThanOrEqual(RELAYED_WITHIN_MS);
  });

  test('two workers’ registries reach the main thread’s collectAll(), stamped, and leave with the mesh', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          cluster: {
            'gossip-interval': '40ms',
            'failure-detector': { 'heartbeat-interval': '100ms', 'unreachable-after': '2s', 'down-after': '4s' },
          },
          // From the config file rather than the builder, so the leaf is what
          // reaches `WorkerMesh.start` through the effective config.
          'worker-mesh': { 'metrics-relay-interval': `${RELAY_INTERVAL_MS}ms` },
        },
      });
    const system = ActorSystem.create('real-mesh-metrics', systemOptions);
    const metrics = system.extension(MetricsExtensionId);
    metrics.enable();
    const meshOptions = WorkerMeshOptions.create()
      .withModule(new URL('./internal/WorkerMeshActors.ts', import.meta.url))
      .withWorkers(2)
      .withReadyTimeoutMs(20_000);
    const mesh = await WorkerMesh.start(system, meshOptions);
    // The relay's ticker was armed inside `start()`, so every request from
    // here on is a tick of the interval the leaf set — see `RELAYED_WITHIN_MS`.
    const meshStartedAt = Date.now();
    try {
      for (const address of mesh.addresses) {
        const where = mesh.refFor<WhereCommand>(address, '/user/where');
        for (let i = 0; i < ASKS_PER_WORKER; i++) await where.ask<string>({ kind: 'where' }, 10_000);
      }

      await awaitCondition(
        () => (delivered(metrics.collectAll(), 'worker-0') ?? 0) >= ASKS_PER_WORKER
          && (delivered(metrics.collectAll(), 'worker-1') ?? 0) >= ASKS_PER_WORKER,
        { timeoutMs: RELAYED_WITHIN_MS, label: 'both workers’ delivered counters crossed the thread boundary' },
      );
      expect(Date.now() - meshStartedAt).toBeLessThan(RELAYED_WITHIN_MS);

      const merged = metrics.collectAll();
      const threads = new Set(merged.map((s) => String(s.labels.thread)));
      expect(threads).toEqual(new Set(['main', 'worker-0', 'worker-1']));
      // A histogram's `+Inf` bucket is `Infinity`, which JSON would have
      // turned into `null`; structured clone carries it.
      const infBuckets = merged.filter((s) => s.labels.thread === 'worker-0' && s.bucket === Number.POSITIVE_INFINITY);
      expect(infBuckets.length).toBeGreaterThan(0);
      // Rendered, one TYPE line per family however many threads contributed.
      const text = renderPrometheusSamples(merged);
      expect(text.match(/# TYPE actor_messages_delivered_total counter/g)).toHaveLength(1);
      expect(text.match(/# TYPE actor_created_total counter/g)).toHaveLength(1);
      // The main thread hosts no user actor here — the asks' replies land on
      // temporary refs, not cells — so its delivered counter never mints; the
      // created counter is the family every thread carries.
      expect(text).toMatch(/actor_created_total\{thread="main"\} \d+/);
      expect(text).toMatch(/actor_messages_delivered_total\{thread="worker-0"\} \d+/);
      expect(text).toMatch(/actor_messages_delivered_total\{thread="worker-1"\} \d+/);
      expect(text).toMatch(/worker_mesh_snapshot_age_seconds\{thread="main",worker="worker-1"\} /);
    } finally {
      await mesh.terminate();
      // Byte-for-byte the main thread's own exposition again, no thread anywhere.
      const after = metrics.collectAll();
      expect(after).toEqual(metrics.get().collect());
      expect(after.some((s) => 'thread' in s.labels)).toBe(false);
      expect(after.some((s) => s.name === 'worker_mesh_snapshot_age_seconds')).toBe(false);
      await system.terminate();
    }
  }, 40_000);

  test('the mesh the parallelism extension starts relays too — the same key, through the effective config', async () => {
    // The extension builds its mesh options without the relay interval, so
    // what reaches `WorkerMesh.start` is the HOCON leaf alone; this is the
    // deployment shape the issue was filed about, end to end.
    const parallelism = ParallelismOptions.create()
      .withWorkers(2)
      .withModule(new URL('./internal/ParallelismActors.ts', import.meta.url));
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          cluster: {
            'gossip-interval': '40ms',
            'failure-detector': { 'heartbeat-interval': '100ms', 'unreachable-after': '2s', 'down-after': '4s' },
          },
          'worker-cluster': { 'ready-timeout': '20s' },
          'worker-mesh': { 'metrics-relay-interval': `${RELAY_INTERVAL_MS}ms` },
        },
      })
      .withParallelism(parallelism);
    const system = ActorSystem.create('real-para-metrics', systemOptions);
    const metrics = system.extension(MetricsExtensionId);
    metrics.enable();
    try {
      // Two names that hash to two workers under consistent-hash placement is
      // not guaranteed, so place enough that both slots get one — every
      // spawn is a pending ref that buffers until the threads are up.
      const refs = Array.from({ length: 8 }, (_, i) => system.spawn(Where, `where-${i}`));
      const homes = await Promise.all(refs.map((ref) => ref.ask<string>({ kind: 'where' }, 20_000)));
      // The extension issues the buffered spawns only once `WorkerMesh.start`
      // has returned — and the relay's ticker is armed inside it — so every
      // answer above postdates the ticker, and the tick that carries the
      // deliveries is bounded from here the same way as in the first test.
      const asksAnsweredAt = Date.now();
      expect(new Set(homes)).toEqual(new Set(['real-para-metrics@worker:2', 'real-para-metrics@worker:3']));

      // Wait for the *sum*, not for one delivery per worker: a tick that lands
      // while the asks are still in flight stores a partial snapshot, and a
      // per-worker `>= 1` is satisfied by it while the total is still short.
      await awaitCondition(
        () => deliveredOnWorkers(metrics.collectAll()) >= homes.length,
        { timeoutMs: RELAYED_WITHIN_MS, label: 'every offloaded delivery was relayed into the main thread' },
      );
      expect(Date.now() - asksAnsweredAt).toBeLessThan(RELAYED_WITHIN_MS);
      const merged = metrics.collectAll();
      const perThread = new Map<string, number>();
      for (const s of merged.filter((sample) => sample.name === 'actor_messages_delivered_total')) {
        perThread.set(String(s.labels.thread), s.value);
      }
      // Eight asks, one delivery each, split across the two workers — and
      // both took some, as `homes` already said.
      expect(perThread.get('worker-0') ?? 0).toBeGreaterThanOrEqual(1);
      expect(perThread.get('worker-1') ?? 0).toBeGreaterThanOrEqual(1);
      expect(deliveredOnWorkers(merged)).toBe(homes.length);
      expect(merged.every((s) => typeof s.labels.thread === 'string')).toBe(true);
    } finally {
      // `terminate()` is the only call the application makes; it takes the
      // mesh, and with it the relay, down.
      await system.terminate();
      expect(metrics.collectAll().some((s) => 'thread' in s.labels)).toBe(false);
    }
  }, 40_000);
});
