/**
 * What #411 actually removed from the receive path, pinned as behaviour.
 *
 * #411 landed as a throughput change with no test that fails without it: its
 * own five cases guard against a regression it chose not to introduce, and
 * pass unchanged against the pre-#411 tree.  The benchmark corroborates the
 * *pair* #409 + #411 and cannot separate them.  So the work rested on reading
 * the diff.
 *
 * A heap assertion would be the obvious binding and does not work here.
 * Measured over 8 rounds of 50 000 messages with a forced `Bun.gc(true)` in
 * front of each, bytes-per-message came out as
 * `[39.4, -5.1, -30.2, -0.0, -0.0, -0.0, 24.4, -24.4]` — and the tree with
 * the allocations *restored* produced `[40.1, -5.5, -26.7, -0.0, 0.0, 0.0,
 * 24.0, -23.9]`, which is the same distribution.  Everything #411 removed is
 * short-lived garbage that never survives a collection, so a retention metric
 * reads it as noise on both sides; #411's own commit body says as much about
 * the issue's "Δheap/message" criterion.  A threshold over that spread would
 * pass for the wrong reason, which is worse than not asserting it.
 *
 * What *is* exact is the count of calls that would do the allocating.  Both
 * counters below scale linearly with messages delivered when the caching is
 * removed, and sit at flat zero with it in place.  That is the claim, stated
 * so that removing the caching fails the test.
 *
 * Each case was checked against an injected fault rather than assumed to
 * bite:
 *
 * | fault put back into `src/`                        | goes red        |
 * |---------------------------------------------------|-----------------|
 * | `metricsOf` / `tracerOf` resolved per message      | chain walks (4) |
 * | `Object.keys(context).length > 0` in `tell`        | keys arrays (1) |
 * | mirror left stale when the extension is disabled   | mirror + skip   |
 *
 * The first two report exactly 4.0 and 1.0 per message with the pre-#411
 * resolution restored.  The third matters because a stale mirror is silent:
 * the extension says disabled, the cell keeps recording, and nothing else
 * looks.  Note that the fault has to be injected *alone* — restoring the
 * per-message resolution masks a stale mirror, since a cell that walks the
 * chain never reads the field.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import { RecordingTracer } from '../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../src/tracing/TracingExtension.js';
import type { MetricsRegistry } from '../../src/metrics/Metrics.js';

class Echo extends Actor<string> {
  override onReceive(): void { /* the cheapest possible handler */ }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

const drain = (): Promise<void> => Bun.sleep(150);

function valueFor(registry: MetricsRegistry, name: string): number {
  return registry.collect().find((sample) => sample.name === name)?.value ?? 0;
}

/** A histogram's observation count — the one sample carrying no bucket. */
function observationsOf(registry: MetricsRegistry, name: string): number {
  return registry.collect()
    .find((sample) => sample.name === name && sample.count !== undefined)?.count ?? 0;
}

/**
 * Run `body` for two different message counts and report the slope.
 *
 * Counting per message and asserting zero would break on any *constant*
 * background call, which is not what is being claimed — the claim is that
 * the work does not scale with traffic.  Two sample sizes and a difference
 * say exactly that, and stay honest if something else on the path starts
 * making one call at startup.
 */
async function perMessage(
  count: (messages: number) => Promise<number>,
): Promise<number> {
  const few = await count(50);
  const many = await count(250);
  return (many - few) / 200;
}

describe('receive path — the per-message work #411 removed', () => {
  test('delivering a message walks the extension chain zero times', async () => {
    // `metricsOf` / `tracerOf` are `system.extension(...)` plus a `get()`.
    // The receive path used to call them four times per message — once for
    // the registry, twice for the tracer (the second hidden behind a `||`
    // that short-circuits the wrong way), once more from `tell`.  They now
    // read `_metricsRegistry` / `_tracer`, which are plain fields.
    const system = newSystem('lookups');
    const ref = system.spawn(Echo, 'echo');
    for (let i = 0; i < 50; i++) ref.tell('warm');
    await drain();

    let lookups = 0;
    const chain = system.extension.bind(system);
    (system as unknown as { extension: unknown }).extension = (id: never) => {
      lookups++;
      return chain(id);
    };

    const slope = await perMessage(async (messages) => {
      lookups = 0;
      for (let i = 0; i < messages; i++) ref.tell('x');
      await drain();
      return lookups;
    });

    // Restored: 4.0.  Cached: 0.
    expect(slope).toBe(0);
  });

  test('a tell allocates no keys array to find an empty log context', async () => {
    // `Object.keys(context).length > 0` built a throwaway array per `tell`
    // to discover that the frozen empty context is empty.  `LogContext.isEmpty`
    // puts an identity check in front of that — and deliberately keeps the
    // general check behind it, so an empty-but-not-frozen scope is still
    // recognised as empty.
    const system = newSystem('keys');
    const ref = system.spawn(Echo, 'echo');
    for (let i = 0; i < 50; i++) ref.tell('warm');
    await drain();

    const nativeKeys = Object.keys;
    let keysCalls = 0;
    (Object as { keys: unknown }).keys = (target: object): string[] => {
      keysCalls++;
      return nativeKeys(target);
    };
    try {
      const slope = await perMessage(async (messages) => {
        keysCalls = 0;
        for (let i = 0; i < messages; i++) ref.tell('x');
        await drain();
        return keysCalls;
      });
      // Restored: 1.0.  Short-circuited: 0.
      expect(slope).toBe(0);
    } finally {
      (Object as { keys: unknown }).keys = nativeKeys;
    }
  });
});

describe('receive path — the mirrors the caching depends on', () => {
  /*
   * Reading a cached handle per message is only safe while the cache cannot
   * disagree with the extension that owns it.  Both extensions are swapped at
   * runtime with live cells draining, so "`_metricsRegistry` is null exactly
   * when `isEnabled()` is false" is a real invariant and not an
   * implementation note — and nothing asserted it.
   */

  test('the metrics mirror is null exactly when the extension is disabled', () => {
    const system = newSystem('metrics-mirror');
    const extension = system.extension(MetricsExtensionId);

    expect(extension.isEnabled()).toBe(false);
    expect(system._metricsRegistry).toBeNull();

    const registry = extension.enable();
    expect(extension.isEnabled()).toBe(true);
    expect(system._metricsRegistry).toBe(registry);

    extension.disable();
    expect(extension.isEnabled()).toBe(false);
    expect(system._metricsRegistry).toBeNull();

    // A registry plugged in by hand is still a real one, so the mirror has to
    // follow it too — `useRegistry` is the third door onto the same field.
    extension.useRegistry(registry);
    expect(extension.isEnabled()).toBe(true);
    expect(system._metricsRegistry).toBe(registry);
  });

  test('the tracer mirror is null exactly when the extension is disabled', () => {
    const system = newSystem('tracer-mirror');
    const extension = system.extension(TracingExtensionId);

    expect(extension.isEnabled()).toBe(false);
    expect(system._tracer).toBeNull();

    const tracer = new RecordingTracer();
    extension.enable(tracer);
    expect(extension.isEnabled()).toBe(true);
    expect(system._tracer).toBe(tracer);

    extension.disable();
    expect(extension.isEnabled()).toBe(false);
    expect(system._tracer).toBeNull();
  });
});

describe('receive path — instrumentation still instruments', () => {
  test('skipping the metric is a skip, not a silent drop', async () => {
    // The counterpart to the two counting tests: the cheap path is only
    // legitimate if the expensive one still does its job.  `_metricsRegistry`
    // is `null` rather than the noop registry precisely so the call site can
    // skip building the label and help objects — which is indistinguishable
    // from forgetting to record, unless something checks.
    const system = newSystem('metrics-live');
    const registry = system.extension(MetricsExtensionId).enable();
    const ref = system.spawn(Echo, 'echo');
    await drain();

    const baseline = valueFor(registry, 'actor_messages_delivered_total');
    for (let i = 0; i < 40; i++) ref.tell('counted');
    await drain();
    const delivered = valueFor(registry, 'actor_messages_delivered_total');
    expect(delivered - baseline).toBe(40);

    // Handler duration lands in its histogram over the same messages — the
    // second of the two literals-building call sites #411 put behind a null
    // check, and the one the explain plan does not cover.
    expect(observationsOf(registry, 'actor_message_handler_seconds')).toBeGreaterThanOrEqual(40);

    // Switched off mid-stream, the registry stops moving — the actor does not.
    system.extension(MetricsExtensionId).disable();
    for (let i = 0; i < 40; i++) ref.tell('uncounted');
    await drain();
    expect(valueFor(registry, 'actor_messages_delivered_total')).toBe(delivered);
  });

  test('a span is still opened, and still parents a tell made from the handler', async () => {
    // The `_traceRootSpans` read moved out of a `||` chain that was resolving
    // the tracing extension a second time per message.  The condition it sits
    // in is what decides whether a span exists at all, so it is worth pinning
    // that the rewrite left the decision alone.
    const system = newSystem('tracing-live');
    const tracer = new RecordingTracer();
    system.extension(TracingExtensionId).enable(tracer);
    system.extension(TracingExtensionId).recordRootSpans(true);

    const leaf = system.spawn(Echo, 'leaf');
    class Middle extends Actor<string> {
      override onReceive(): void { leaf.tell('onward'); }
    }
    const middle = system.spawn(Middle, 'middle');
    middle.tell('start');
    await drain();

    const receives = tracer.recorded().filter((span) => span.name === 'actor.receive');
    const endsWith = (span: typeof receives[number], suffix: string): boolean =>
      String(span.attributes['actor.path'] ?? '').endsWith(suffix);
    const middleSpan = receives.find((span) => endsWith(span, '/middle'));
    const leafSpan = receives.find((span) => endsWith(span, '/leaf'));
    expect(middleSpan).toBeDefined();
    expect(leafSpan).toBeDefined();
    // The tell issued inside `middle`'s handler inherits its span as parent,
    // which only holds while the handler runs under `withActiveSpan`.
    expect(leafSpan!.parent?.spanId).toBe(middleSpan!.context.spanId);
    expect(leafSpan!.context.traceId).toBe(middleSpan!.context.traceId);
  });
});
