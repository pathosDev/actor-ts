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
import { WorkerMeshOptions } from '../../src/worker/WorkerMeshOptions.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import { Where } from './internal/ParallelismActors.js';
import type { WhereCommand } from './internal/WorkerMeshActors.js';

const ASKS_PER_WORKER = 5;

const delivered = (samples: ReadonlyArray<MetricSample>, thread: string): number | undefined =>
  samples.find((s) => s.name === 'actor_messages_delivered_total' && s.labels.thread === thread)?.value;

describe('WorkerMesh metrics relay on real worker threads', () => {
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
          'worker-mesh': { 'metrics-relay-interval': '200ms' },
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
    try {
      for (const address of mesh.addresses) {
        const where = mesh.refFor<WhereCommand>(address, '/user/where');
        for (let i = 0; i < ASKS_PER_WORKER; i++) await where.ask<string>({ kind: 'where' }, 10_000);
      }

      await awaitCondition(
        () => (delivered(metrics.collectAll(), 'worker-0') ?? 0) >= ASKS_PER_WORKER
          && (delivered(metrics.collectAll(), 'worker-1') ?? 0) >= ASKS_PER_WORKER,
        { timeoutMs: 15_000, label: 'both workers’ delivered counters crossed the thread boundary' },
      );

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
          'worker-mesh': { 'metrics-relay-interval': '200ms' },
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
      expect(new Set(homes)).toEqual(new Set(['real-para-metrics@worker:2', 'real-para-metrics@worker:3']));

      await awaitCondition(
        () => (delivered(metrics.collectAll(), 'worker-0') ?? 0) >= 1
          && (delivered(metrics.collectAll(), 'worker-1') ?? 0) >= 1,
        { timeoutMs: 15_000, label: 'both offloaded workers were relayed into the main thread' },
      );
      const merged = metrics.collectAll();
      const perThread = new Map<string, number>();
      for (const s of merged.filter((sample) => sample.name === 'actor_messages_delivered_total')) {
        perThread.set(String(s.labels.thread), s.value);
      }
      // Eight asks, one delivery each, split across the two workers.
      expect((perThread.get('worker-0') ?? 0) + (perThread.get('worker-1') ?? 0)).toBe(homes.length);
      expect(merged.every((s) => typeof s.labels.thread === 'string')).toBe(true);
    } finally {
      // `terminate()` is the only call the application makes; it takes the
      // mesh, and with it the relay, down.
      await system.terminate();
      expect(metrics.collectAll().some((s) => 'thread' in s.labels)).toBe(false);
    }
  }, 40_000);
});
