/**
 * Cap on the number of metric families (#1068).
 *
 * The per-family cap (#131) bounds the label tuples of one family; a metric
 * *name* built from request data mints a new family per value and walked
 * straight past it.  A family cannot be folded into an overflow series the way
 * a tuple can — the name is the family's identity — so past `maxFamilies` an
 * instrument factory hands back a no-op instrument and warns once.  It never
 * throws: the call sites are instrumentation inside actors and request
 * handlers, and a metrics failure must not become a request failure.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DefaultMetricsRegistry, type MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import {
  DEFAULT_MAX_FAMILIES,
  MetricsRegistryOptions,
} from '../../../src/metrics/MetricsRegistryOptions.js';
import { promClientRegistry } from '../../../src/metrics/PromClientAdapter.js';
import { PromClientAdapterOptions } from '../../../src/metrics/PromClientAdapterOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

function captureWarnings<T>(body: () => T): { readonly result: T; readonly warnings: ReadonlyArray<string> } {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => { warnings.push(args.map((a) => String(a)).join(' ')); };
  try {
    return { result: body(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function familyNamesOf(registry: MetricsRegistry): ReadonlyArray<string> {
  return [...new Set(registry.collect().map((sample) => sample.name))];
}

describe('DefaultMetricsRegistry — family cap', () => {
  test('the reproduction from the issue: 5000 names mint at most maxFamilies families', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: 10 });
    captureWarnings(() => {
      for (let i = 0; i < 5000; i++) registry.counter(`http_requests_${i}_total`).inc();
    });

    expect(familyNamesOf(registry)).toHaveLength(10);
  });

  test('past the cap every factory returns a working no-op instrument, never a throw', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: 1 });
    captureWarnings(() => {
      registry.counter('kept_total').inc();
      const counter = registry.counter('refused_total', { path: '/a' });
      const gauge = registry.gauge('refused_gauge');
      const histogram = registry.histogram('refused_seconds', {}, { buckets: [1] });
      expect(() => counter.inc(3)).not.toThrow();
      expect(() => { gauge.set(5); gauge.inc(); gauge.dec(); }).not.toThrow();
      expect(() => histogram.observe(0.5)).not.toThrow();
      expect(counter.value).toBe(0);
      expect(gauge.value).toBe(0);
      expect(histogram.count).toBe(0);
    });

    expect(familyNamesOf(registry)).toEqual(['kept_total']);
  });

  test('a family minted before the cap keeps recording after it', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: 2 });
    captureWarnings(() => {
      registry.counter('a_total').inc();
      registry.gauge('b').set(1);
      registry.counter('c_total').inc();
      registry.counter('a_total', { path: '/x' }).inc(4);
      registry.gauge('b').set(9);
    });

    const samples = registry.collect();
    expect(samples.filter((s) => s.name === 'a_total').map((s) => s.value).sort()).toEqual([1, 4]);
    expect(samples.find((s) => s.name === 'b')!.value).toBe(9);
  });

  test('warns exactly once, naming the cap and the first refused family', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: 1 });
    const { warnings } = captureWarnings(() => {
      registry.counter('a_total').inc();
      registry.counter('b_total').inc();
      registry.counter('c_total').inc();
      registry.gauge('d').set(1);
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('maxFamilies=1');
    expect(warnings[0]).toContain('"b_total"');
  });

  test('a malformed name is still refused past the cap', () => {
    // The cap is not a way around name validation (#784): the name is checked
    // before the count, so a bad name throws wherever the registry stands.
    const registry = new DefaultMetricsRegistry({ maxFamilies: 1 });
    captureWarnings(() => registry.counter('a_total').inc());
    expect(() => registry.counter('http_/orders_total')).toThrow();
  });

  test('a kind clash on a name the registry holds is still refused past the cap', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: 1 });
    captureWarnings(() => registry.counter('a_total').inc());
    expect(() => registry.gauge('a_total')).toThrow(/already registered as counter/);
  });

  test('maxFamilies 0 disables the cap', () => {
    const metricsOptions = MetricsRegistryOptions.create().withMaxFamilies(0);
    const registry = new DefaultMetricsRegistry(metricsOptions);
    const { warnings } = captureWarnings(() => {
      for (let i = 0; i < DEFAULT_MAX_FAMILIES + 5; i++) registry.counter(`f_${i}_total`).inc();
    });

    expect(familyNamesOf(registry)).toHaveLength(DEFAULT_MAX_FAMILIES + 5);
    expect(warnings).toHaveLength(0);
  });

  test('an unset cap falls back to DEFAULT_MAX_FAMILIES', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: undefined });
    captureWarnings(() => {
      for (let i = 0; i < DEFAULT_MAX_FAMILIES + 5; i++) registry.counter(`f_${i}_total`).inc();
    });

    expect(familyNamesOf(registry)).toHaveLength(DEFAULT_MAX_FAMILIES);
  });

  test('clear() releases the cap and re-arms the warning', () => {
    const registry = new DefaultMetricsRegistry({ maxFamilies: 1 });
    const { warnings } = captureWarnings(() => {
      registry.counter('a_total').inc();
      registry.counter('b_total').inc();
      registry.clear();
      registry.counter('c_total').inc();
      registry.counter('d_total').inc();
    });

    expect(familyNamesOf(registry)).toEqual(['c_total']);
    expect(warnings).toHaveLength(2);
  });

  test('rejects a negative or fractional cap', () => {
    expect(() => new DefaultMetricsRegistry({ maxFamilies: -1 })).toThrow(OptionsError);
    expect(() => new DefaultMetricsRegistry({ maxFamilies: 2.5 })).toThrow(/must be an integer >= 0/);
  });
});

/* --------------------------- prom-client bridge --------------------------- */

type FakeMetric = { readonly name: string; readonly calls: number[] };

/** Just enough of prom-client to count what the bridge constructs. */
function fakeClient(constructed: FakeMetric[]): Record<string, unknown> {
  function Metric(this: Record<string, unknown>, options: { name: string }): void {
    const metric: FakeMetric = { name: options.name, calls: [] };
    constructed.push(metric);
    const child = {
      inc: (v = 1): void => { metric.calls.push(v); },
      dec: (v = 1): void => { metric.calls.push(-v); },
      set: (v: number): void => { metric.calls.push(v); },
      observe: (v: number): void => { metric.calls.push(v); },
    };
    this['labels'] = (): typeof child => child;
    this['remove'] = (): void => {};
  }
  return { Counter: Metric, Gauge: Metric, Histogram: Metric };
}

const fakeRegistry = { registerMetric: (): void => {}, getSingleMetric: (): undefined => undefined };

describe('promClientRegistry — family cap', () => {
  test('constructs at most maxFamilies prom-client metrics and hands back no-ops past it', () => {
    const constructed: FakeMetric[] = [];
    const promOptions = PromClientAdapterOptions.create()
      .withClient(fakeClient(constructed) as never)
      .withRegistry(fakeRegistry)
      .withMaxFamilies(3);
    const bridge = promClientRegistry(promOptions);
    const { warnings } = captureWarnings(() => {
      for (let i = 0; i < 50; i++) bridge.counter(`http_requests_${i}_total`).inc();
      expect(() => bridge.gauge('late_gauge').set(1)).not.toThrow();
      expect(() => bridge.histogram('late_seconds').observe(1)).not.toThrow();
    });

    expect(constructed.map((m) => m.name)).toEqual([
      'http_requests_0_total', 'http_requests_1_total', 'http_requests_2_total',
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('maxFamilies=3');
  });

  test('a family minted before the cap keeps writing through', () => {
    const constructed: FakeMetric[] = [];
    const bridge = promClientRegistry({
      client: fakeClient(constructed) as never, registry: fakeRegistry, maxFamilies: 1,
    });
    captureWarnings(() => {
      bridge.counter('a_total').inc();
      bridge.counter('b_total').inc();
      bridge.counter('a_total').inc(2);
    });

    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.calls).toEqual([1, 2]);
  });

  test('maxFamilies 0 disables the cap on the bridge too', () => {
    const constructed: FakeMetric[] = [];
    const bridge = promClientRegistry({
      client: fakeClient(constructed) as never, registry: fakeRegistry, maxFamilies: 0,
    });
    for (let i = 0; i < DEFAULT_MAX_FAMILIES + 5; i++) bridge.counter(`f_${i}_total`).inc();
    expect(constructed).toHaveLength(DEFAULT_MAX_FAMILIES + 5);
  });

  test('an unset cap on the bridge falls back to DEFAULT_MAX_FAMILIES', () => {
    const constructed: FakeMetric[] = [];
    const bridge = promClientRegistry({ client: fakeClient(constructed) as never, registry: fakeRegistry });
    captureWarnings(() => {
      for (let i = 0; i < DEFAULT_MAX_FAMILIES + 5; i++) bridge.counter(`f_${i}_total`).inc();
    });
    expect(constructed).toHaveLength(DEFAULT_MAX_FAMILIES);
  });

  test('rejects a negative cap', () => {
    expect(() => promClientRegistry({ client: fakeClient([]) as never, registry: fakeRegistry, maxFamilies: -1 }))
      .toThrow(OptionsError);
  });
});

/* ------------------------------- HOCON leaf ------------------------------- */

let systemCounter = 0;

function systemWith(hocon: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  return ActorSystem.create(`metrics-family-cap-${systemCounter++}`, systemOptions);
}

describe('actor-ts.metrics.max-families', () => {
  test('bounds the registry a bare enable() installs', () => {
    const system = systemWith('actor-ts.metrics.max-families = 2');
    try {
      const registry = system.extension(MetricsExtensionId).enable();
      captureWarnings(() => {
        for (let i = 0; i < 5; i++) registry.counter(`app_${i}_total`).inc();
      });
      expect(familyNamesOf(registry).filter((name) => name.startsWith('app_')).length).toBeLessThanOrEqual(2);
      expect(familyNamesOf(registry).length).toBeLessThanOrEqual(2);
    } finally {
      void system.terminate();
    }
  });

  test('bounds the bridge enablePromClient() builds', () => {
    const system = systemWith('actor-ts.metrics.max-families = 2');
    try {
      const constructed: FakeMetric[] = [];
      const promOptions = PromClientAdapterOptions.create()
        .withClient(fakeClient(constructed) as never)
        .withRegistry(fakeRegistry);
      const bridge = system.extension(MetricsExtensionId).enablePromClient(promOptions);
      captureWarnings(() => {
        for (let i = 0; i < 5; i++) bridge.counter(`app_${i}_total`).inc();
      });
      expect(constructed.length).toBeLessThanOrEqual(2);
    } finally {
      void system.terminate();
    }
  });

  test('an explicit cap beats the configured one', () => {
    const system = systemWith('actor-ts.metrics.max-families = 2');
    try {
      const metricsOptions = MetricsRegistryOptions.create().withMaxFamilies(0);
      const registry = system.extension(MetricsExtensionId).enable(metricsOptions);
      for (let i = 0; i < 5; i++) registry.counter(`app_${i}_total`).inc();
      expect(familyNamesOf(registry).filter((name) => name.startsWith('app_'))).toHaveLength(5);
    } finally {
      void system.terminate();
    }
  });

  test('a refused configured cap names the key', () => {
    const system = systemWith('actor-ts.metrics.max-families = -1');
    try {
      expect(() => system.extension(MetricsExtensionId).enable()).toThrow(/actor-ts\.metrics\.max-families/);
    } finally {
      void system.terminate();
    }
  });
});
