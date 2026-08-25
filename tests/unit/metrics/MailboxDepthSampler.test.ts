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
    //
    // Since #745 retiring means *removing*.  Zeroing was what the registry
    // could do at the time, and it left the `'?'` tuple standing at 0 for the
    // life of the process — a series asserting that an actor of a class that
    // never existed has no backlog.
    const system = createSystem('depth-relabel');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);

    sampler.sample();
    const before = depthSamples(registry);
    expect(before.length).toBe(1);
    expect(before[0]!.labels.class).toBe('?');
    expect(before[0]!.value).toBeGreaterThanOrEqual(FLOOR);

    // Give the cell time to learn its actor's class, so the second sample mints a
    // different label tuple than the first.  Not pollable: the registry only
    // changes when `sample()` runs, and calling it inside a predicate would be
    // mutating the very thing the assertions below read.
    await Bun.sleep(10);
    sampler.sample();

    const after = depthSamples(registry);
    expect(after.length).toBe(1);
    expect(after[0]!.labels.class).toBe('Sink');
    expect(after[0]!.value).toBeGreaterThanOrEqual(FLOOR);

    release();
    await system.terminate();
  });

  test('a system whose actors stay below the floor mints no series at all', async () => {
    // The floor is a cardinality bound, not a display filter: `path` under
    // sharding is attacker-influenced (#745), so "quiet system, zero series"
    // is the property that matters, not "quiet system, series reading zero".
    // Eviction reclaims what has stopped; only the floor keeps a remote party
    // from holding an arbitrary number of entity ids above it at once.
    const system = createSystem('depth-below');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR - 10);

    sampler.sample();

    expect(depthSamples(registry)).toEqual([]);

    release();
    await system.terminate();
  });

  test('a drained mailbox loses its series rather than standing at its last spike (#745)', async () => {
    // The family's contract is that a series exists only for an actor that is
    // *already* deeply backlogged, so its presence is the alert and a healthy
    // system is empty.  A drained actor is a healthy one, and until #745 gave
    // the registry a `remove` it stayed represented for ever — at 0, which is
    // a truthful reading of a metric that should not have been there at all,
    // and which held its slot under the cardinality cap regardless.
    const system = createSystem('depth-drain');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);

    sampler.sample();
    const spike = depthSamples(registry);
    expect(spike.length).toBe(1);

    release();
    // Let the released backlog drain before the second sample.  Not pollable for
    // the same reason as above: mailbox depth reaches the registry only through
    // `sample()`, which is itself under test.
    await Bun.sleep(50);
    sampler.sample();

    expect(depthSamples(registry)).toEqual([]);

    await system.terminate();
  });

  test('a path that falls behind again is minted fresh, not resumed at its old depth', async () => {
    // The consequence of removing rather than zeroing that a caller can
    // actually observe: a gauge child holds its last value, so a re-minted
    // tuple that resumed an evicted one would report the earlier spike until
    // the next `set` — and between the two samples a scrape would read a
    // backlog that had already drained.
    const system = createSystem('depth-remint');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);

    sampler.sample();
    // The tuple the sampler minted, taken from the sample rather than rebuilt,
    // so this is provably the one it went on to evict.
    const labels = depthSamples(registry)[0]!.labels;

    release();
    // Let the released backlog drain before the second sample.  Not pollable:
    // mailbox depth reaches the registry only through `sample()`, and calling
    // that inside a predicate would mutate what the assertions then read.
    await Bun.sleep(50);
    sampler.sample();
    expect(depthSamples(registry)).toEqual([]);

    expect(registry.gauge('actor_mailbox_size', labels).value).toBe(0);

    await system.terminate();
  });

  test('stop() retires everything it minted, so a restart cannot strand a series', async () => {
    // `reported` is the only record of which tuples are live, so a `stop()`
    // that cleared it without removing would leave every series it had minted
    // unreachable in a registry that outlives the sampler —
    // `MetricsExtension.useRegistry` stops one while the old registry is still
    // installed, and a fresh sampler starts from an empty map.
    const system = createSystem('depth-stop');
    const registry = new DefaultMetricsRegistry();
    const sampler = new MailboxDepthSampler(system, registry, 60_000, FLOOR);
    const release = wedged(system, FLOOR * 3);
    // Let the cell run its `create`, so the class label has settled before the
    // sample — `stop()` has to remove the tuple it actually minted, and a `'?'`
    // reading here would let a wrong-tuple removal pass by coincidence.
    await Bun.sleep(10);

    sampler.sample();
    expect(depthSamples(registry).length).toBe(1);

    sampler.stop();
    expect(depthSamples(registry)).toEqual([]);

    release();
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
