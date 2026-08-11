import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DefaultMetricsRegistry } from '../../../src/metrics/Metrics.js';
import { MailboxDepthSampler } from '../../../src/metrics/MailboxDepthSampler.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricSample } from '../../../src/metrics/Metrics.js';

const FLOOR = 100;

const createSystem = (name: string): ActorSystem => ActorSystem.create(
  name,
  ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
);

const depthSamples = (registry: DefaultMetricsRegistry): ReadonlyArray<MetricSample> =>
  registry.collect().filter((s) => s.name === 'actor_mailbox_size');

/**
 * Wedges an actor on a latch so its queue depth is deterministic, then hands
 * back the release so the system can be shut down cleanly.
 */
function wedged(system: ActorSystem, queued: number): () => void {
  let release: () => void = () => {};
  const latch = new Promise<void>((resolve) => { release = resolve; });

  class Sink extends Actor<number> {
    override async onReceive(n: number): Promise<void> { if (n === 0) await latch; }
  }
  const ref = system.spawnAnonymous(Sink);
  for (let i = 0; i < queued; i++) ref.tell(i);
  return release;
}

describe('MailboxDepthSampler (#1148)', () => {
  test('an actor above the floor gets a series carrying its depth', async () => {
    const system = createSystem('depth-above');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);
    await Bun.sleep(10);   // let the cell run its `create`, so the class is known

    sampler.sample();

    const samples = depthSamples(registry);
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBeGreaterThanOrEqual(FLOOR);
    expect(samples[0]!.labels.path).toContain('$anonymous');
    expect(samples[0]!.labels.class).toBe('Sink');

    release();
    await system.terminate();
  });

  test('a cell flooded before its actor exists retires the `?` series instead of stranding it', async () => {
    // `CellInspection.className` reads `'?'` until the actor instance is
    // constructed, so a cell flooded in the same tick as its spawn reports
    // one label tuple and then a different one.  Without retiring the first,
    // the `'?'` reading would stand at its spike forever with the real one
    // beside it — one actor, two series, one of them permanently wrong.
    const system = createSystem('depth-relabel');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);

    sampler.sample();
    const before = depthSamples(registry);
    expect(before.length).toBe(1);
    expect(before[0]!.labels.class).toBe('?');
    expect(before[0]!.value).toBeGreaterThanOrEqual(FLOOR);

    await Bun.sleep(10);
    sampler.sample();

    const after = depthSamples(registry);
    expect(after.length).toBe(2);
    const stale = after.find((s) => s.labels.class === '?');
    const live = after.find((s) => s.labels.class === 'Sink');
    expect(stale!.value).toBe(0);
    expect(live!.value).toBeGreaterThanOrEqual(FLOOR);

    release();
    await system.terminate();
  });

  test('a system whose actors stay below the floor mints no series at all', async () => {
    // The floor is a cardinality bound, not a display filter: `path` under
    // sharding is attacker-influenced and the registry has no per-child
    // eviction (#745), so "quiet system, zero series" is the property that
    // matters, not "quiet system, series reading zero".
    const system = createSystem('depth-below');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR - 10);

    sampler.sample();

    expect(depthSamples(registry)).toEqual([]);

    release();
    await system.terminate();
  });

  test('a drained mailbox reads 0 rather than its last spike, under the same label tuple', async () => {
    const system = createSystem('depth-drain');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);

    sampler.sample();
    const spike = depthSamples(registry);
    expect(spike.length).toBe(1);
    const labels = spike[0]!.labels;

    release();
    await Bun.sleep(50);
    sampler.sample();

    const after = depthSamples(registry);
    // One series, not two: zeroing has to reuse the tuple it minted, or the
    // original would stand at its spike forever while a second appeared
    // beside it.
    expect(after.length).toBe(1);
    expect(after[0]!.value).toBe(0);
    expect(after[0]!.labels).toEqual(labels);

    await system.terminate();
  });

  test('metrics stay free until enabled — no gauge, no sampler', async () => {
    const system = createSystem('depth-noop');
    const metrics = system.extension(MetricsExtensionId);
    const release = wedged(system, FLOOR * 3);

    // The noop registry collects nothing, and `_sampleMailboxDepth` has no
    // sampler to drive.
    metrics._sampleMailboxDepth();
    expect(metrics.isEnabled()).toBe(false);
    expect(metrics.get().collect()).toEqual([]);

    release();
    await system.terminate();
  });

  test('enable() wires the gauge up without anyone asking for it by name', async () => {
    const system = createSystem('depth-enable');
    const metrics = system.extension(MetricsExtensionId);
    const registry = metrics.enable();
    const release = wedged(system, 20_000);

    metrics._sampleMailboxDepth();

    const samples = registry.collect().filter((s) => s.name === 'actor_mailbox_size');
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBeGreaterThanOrEqual(10_000);

    metrics.disable();
    release();
    await system.terminate();
  });
});
