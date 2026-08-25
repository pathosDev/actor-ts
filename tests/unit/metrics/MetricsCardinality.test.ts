/**
 * Per-family cardinality cap on the in-process registry (#131).
 *
 * A label value that arrives from user-controlled input would otherwise
 * mint one time series per distinct value and take the monitoring
 * backend down with it.  These tests pin the containment: the cap bites,
 * everything past it lands in ONE overflow series, families budget
 * independently, the warning fires once, and `0` opts out.
 */
import { describe, expect, test } from 'bun:test';
import {
  bucketize,
  DefaultMetricsRegistry,
  METRICS_OVERFLOW_LABEL_VALUE,
  overflowLabelsOf,
} from '../../../src/metrics/Metrics.js';
import {
  DEFAULT_MAX_SERIES_PER_FAMILY,
  MetricsRegistryOptions,
} from '../../../src/metrics/MetricsRegistryOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';

/**
 * Run `body` with `console.warn` captured.  The overflow warning is a
 * bare `console.warn` (the registry has no `ActorSystem` behind it), so
 * this is the only seam for asserting on it — and it keeps the noise out
 * of the test output either way.
 */
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

/** Series of `name`, as `collect()` sees them. */
function seriesOf(registry: DefaultMetricsRegistry, name: string): ReadonlyArray<{ labels: Record<string, unknown>; value: number }> {
  return registry.collect()
    .filter((sample) => sample.name === name)
    .map((sample) => ({ labels: sample.labels as Record<string, unknown>, value: sample.value }));
}

describe('DefaultMetricsRegistry — cardinality cap', () => {
  test('mints up to the cap, then folds every further tuple into one overflow series', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 4 });
    captureWarnings(() => {
      for (let i = 0; i < 10; i++) registry.counter('hits', { path: `/p-${i}` }).inc();
    });

    const series = seriesOf(registry, 'hits');
    // 4 real series + exactly one overflow series, no matter how many
    // distinct tuples arrived after the cap.
    expect(series).toHaveLength(5);
    const overflow = series.filter((s) => s.labels['path'] === METRICS_OVERFLOW_LABEL_VALUE);
    expect(overflow).toHaveLength(1);
    // Tuples 0..3 kept their own series; 4..9 (six of them) merged.
    expect(overflow[0]!.value).toBe(6);
    expect(series.filter((s) => s.labels['path'] === '/p-0')[0]!.value).toBe(1);
  });

  test('the overflow series keeps the label NAMES of the family (only the values are the marker)', () => {
    // Prometheus reserves `__`-prefixed label names and strips them at
    // ingestion, so the marker has to live in the value.  Anything else
    // silently merges the overflow series into the unlabeled one.
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    captureWarnings(() => {
      registry.counter('dropped', { path: '/a', reason: 'drop-head' }).inc();
      registry.counter('dropped', { path: '/b', reason: 'drop-new' }).inc();
    });

    const overflow = seriesOf(registry, 'dropped')
      .find((s) => s.labels['path'] === METRICS_OVERFLOW_LABEL_VALUE)!;
    expect(Object.keys(overflow.labels).sort()).toEqual(['path', 'reason']);
    expect(overflow.labels['reason']).toBe(METRICS_OVERFLOW_LABEL_VALUE);
    expect(Object.keys(overflow.labels).some((k) => k.startsWith('__'))).toBe(false);
  });

  test('an already-minted tuple still resolves to its own series after the cap is hit', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 2 });
    captureWarnings(() => {
      registry.counter('hits', { path: '/a' }).inc();
      registry.counter('hits', { path: '/b' }).inc();
      registry.counter('hits', { path: '/c' }).inc();   // overflows
      registry.counter('hits', { path: '/a' }).inc(5);  // pre-cap tuple, untouched
    });

    const series = seriesOf(registry, 'hits');
    expect(series.find((s) => s.labels['path'] === '/a')!.value).toBe(6);
    expect(series.find((s) => s.labels['path'] === METRICS_OVERFLOW_LABEL_VALUE)!.value).toBe(1);
  });

  test('the overflow series accumulates across gauges and histograms too', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    captureWarnings(() => {
      registry.gauge('depth', { queue: 'a' }).set(1);
      registry.gauge('depth', { queue: 'b' }).set(7);
      registry.gauge('depth', { queue: 'c' }).set(9);
      registry.histogram('latency', { route: 'a' }, { buckets: [1] }).observe(0.5);
      registry.histogram('latency', { route: 'b' }, { buckets: [1] }).observe(0.5);
    });

    const depthOverflow = seriesOf(registry, 'depth')
      .find((s) => s.labels['queue'] === METRICS_OVERFLOW_LABEL_VALUE)!;
    // Both overflowing tuples write the SAME gauge — last write wins.
    expect(depthOverflow.value).toBe(9);

    const latencySamples = registry.collect().filter((s) => s.name === 'latency');
    const overflowCount = latencySamples
      .find((s) => s.labels['route'] === METRICS_OVERFLOW_LABEL_VALUE && s.count !== undefined);
    expect(overflowCount?.count).toBe(1);
  });

  test('each family gets its own budget', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 2 });
    captureWarnings(() => {
      for (let i = 0; i < 3; i++) registry.counter('foo', { path: `/p-${i}` }).inc();
      for (let i = 0; i < 2; i++) registry.counter('bar', { path: `/p-${i}` }).inc();
    });

    expect(seriesOf(registry, 'foo')).toHaveLength(3);   // 2 + overflow
    expect(seriesOf(registry, 'bar')).toHaveLength(2);   // still under its own cap
    expect(seriesOf(registry, 'bar').some((s) => s.labels['path'] === METRICS_OVERFLOW_LABEL_VALUE)).toBe(false);
  });

  test('warns exactly once per family, naming the family and the first rejected tuple', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    const { warnings } = captureWarnings(() => {
      registry.counter('hits', { path: '/a' }).inc();
      registry.counter('hits', { path: '/b' }).inc();
      registry.counter('hits', { path: '/c' }).inc();
      registry.counter('other', { path: '/a' }).inc();
      registry.counter('other', { path: '/b' }).inc();
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("family 'hits'");
    expect(warnings[0]).toContain('maxSeriesPerFamily=1');
    expect(warnings[0]).toContain('"/b"');          // first rejected tuple, not '/c'
    expect(warnings[1]).toContain("family 'other'");
  });

  test('maxSeriesPerFamily 0 disables the cap', () => {
    const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(0);
    const registry = new DefaultMetricsRegistry(metricsOptions);
    const { warnings } = captureWarnings(() => {
      for (let i = 0; i < 5_000; i++) registry.counter('hits', { path: `/p-${i}` }).inc();
    });

    expect(seriesOf(registry, 'hits')).toHaveLength(5_000);
    expect(warnings).toHaveLength(0);
  });

  test('an unset cap falls back to DEFAULT_MAX_SERIES_PER_FAMILY', () => {
    const registry = new DefaultMetricsRegistry();
    captureWarnings(() => {
      for (let i = 0; i <= DEFAULT_MAX_SERIES_PER_FAMILY; i++) {
        registry.counter('hits', { path: `/p-${i}` }).inc();
      }
    });

    expect(seriesOf(registry, 'hits')).toHaveLength(DEFAULT_MAX_SERIES_PER_FAMILY + 1);
  });

  test('an unlabeled family is never capped away', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    const { warnings } = captureWarnings(() => {
      registry.counter('hits').inc();
      registry.counter('hits').inc(2);
    });

    const series = seriesOf(registry, 'hits');
    expect(series).toHaveLength(1);
    expect(series[0]!.value).toBe(3);
    expect(warnings).toHaveLength(0);
  });

  test('clear() releases the cap along with the series', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    captureWarnings(() => {
      registry.counter('hits', { path: '/a' }).inc();
      registry.counter('hits', { path: '/b' }).inc();
      registry.clear();
      registry.counter('hits', { path: '/c' }).inc();
    });

    const series = seriesOf(registry, 'hits');
    expect(series).toHaveLength(1);
    expect(series[0]!.labels['path']).toBe('/c');
  });
});

describe('MetricsRegistryOptions', () => {
  test('the builder and the plain object are interchangeable', () => {
    const built = new DefaultMetricsRegistry(MetricsRegistryOptions.create().withMaxSeriesPerFamily(1));
    const plain = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    captureWarnings(() => {
      for (const registry of [built, plain]) {
        registry.counter('hits', { path: '/a' }).inc();
        registry.counter('hits', { path: '/b' }).inc();
      }
    });

    expect(seriesOf(built, 'hits')).toHaveLength(2);
    expect(seriesOf(plain, 'hits')).toHaveLength(2);
  });

  test('rejects a negative, fractional or non-integer cap', () => {
    expect(() => new DefaultMetricsRegistry({ maxSeriesPerFamily: -1 })).toThrow(OptionsError);
    expect(() => new DefaultMetricsRegistry({ maxSeriesPerFamily: 2.5 })).toThrow(/must be an integer >= 0/);
    // `Infinity` is deliberately NOT the opt-out — it is not an integer.
    expect(() => new DefaultMetricsRegistry({ maxSeriesPerFamily: Number.POSITIVE_INFINITY }))
      .toThrow(/must be an integer >= 0/);
  });

  test('an explicitly undefined cap falls through to the default rather than shadowing it', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: undefined });
    captureWarnings(() => {
      registry.counter('hits', { path: '/a' }).inc();
      registry.counter('hits', { path: '/b' }).inc();
    });
    expect(seriesOf(registry, 'hits')).toHaveLength(2);
  });
});

describe('MetricsExtension.enable(options)', () => {
  test('forwards the cap to the registry it installs', () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('metrics-cardinality', systemOptions);
    try {
      const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(1);
      const registry = system.extension(MetricsExtensionId).enable(metricsOptions);
      captureWarnings(() => {
        registry.counter('hits', { path: '/a' }).inc();
        registry.counter('hits', { path: '/b' }).inc();
      });

      const labels = registry.collect().filter((s) => s.name === 'hits').map((s) => s.labels['path']);
      expect(labels).toContain(METRICS_OVERFLOW_LABEL_VALUE);
    } finally {
      void system.terminate();
    }
  });
});

describe('DefaultMetricsRegistry — eviction against the cap (#745)', () => {
  test('a removed series gives its slot back, so the next tuple is real again', () => {
    // The cap bounds how many series a family holds; removal is what makes
    // that a bound on how many are *live* rather than on how many can ever
    // have existed.  Without it a family that reached its cap once stayed at
    // it for the life of the process, folding every later tuple into the
    // overflow series even after everything it was measuring had gone.
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 4 });
    captureWarnings(() => {
      for (let index = 0; index < 4; index++) registry.gauge('depth', { path: `/p-${index}` }).set(1);
      registry.gauge('depth', { path: '/p-4' }).set(1);      // folds into overflow
    });
    expect(seriesOf(registry, 'depth').map((s) => s.labels.path))
      .toContain(METRICS_OVERFLOW_LABEL_VALUE);

    // Two of the four entities passivated.
    expect(registry.remove('depth', { path: '/p-0' })).toBe(true);
    expect(registry.remove('depth', { path: '/p-1' })).toBe(true);

    registry.gauge('depth', { path: '/p-5' }).set(3);
    const minted = seriesOf(registry, 'depth').find((s) => s.labels.path === '/p-5');
    expect(minted?.value).toBe(3);
  });

  test('the overflow series is the one child that cannot be removed', () => {
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 2 });
    const { warnings } = captureWarnings(() => {
      for (let index = 0; index < 5; index++) registry.counter('hits', { route: `/r-${index}` }).inc();

      // It is the record that this family discarded tuples — and its counter
      // still holds how many — so removing it would erase evidence of loss.
      expect(registry.remove('hits', overflowLabelsOf(['route']))).toBe(false);

      // Removing it would also re-arm the once-per-family warning, since the
      // overflow key doubles as that flag.  Freeing a real slot and
      // overflowing again therefore stays silent.
      registry.remove('hits', { route: '/r-0' });
      registry.counter('hits', { route: '/r-6' }).inc();
    });

    const overflow = seriesOf(registry, 'hits')
      .find((s) => s.labels.route === METRICS_OVERFLOW_LABEL_VALUE);
    expect(overflow).toBeDefined();
    // /r-2, /r-3 and /r-4 before the removal, /r-6 after: the overflow child
    // occupies one of the family's two slots itself, so freeing one real
    // series leaves the family still at its cap.  Its total accumulates
    // across that rather than restarting.
    expect(overflow!.value).toBe(4);
    expect(warnings).toHaveLength(1);
  });
});

describe('bucketize', () => {
  test('passes an allowed value through and maps everything else to "other"', () => {
    const allowedRoutes = ['/orders', '/users/:id', '/health'] as const;
    expect(bucketize('/orders', allowedRoutes)).toBe('/orders');
    expect(bucketize('/health', allowedRoutes)).toBe('/health');
    expect(bucketize('/orders/17?evil=1', allowedRoutes)).toBe('other');
    expect(bucketize('', allowedRoutes)).toBe('other');
  });

  test('bounds a family at the allow-list size no matter what arrives', () => {
    const allowedRoutes = ['/orders', '/health'] as const;
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 4 });
    const { warnings } = captureWarnings(() => {
      for (let i = 0; i < 1_000; i++) {
        registry.counter('http_requests_total', { route: bucketize(`/attack-${i}`, allowedRoutes) }).inc();
      }
      registry.counter('http_requests_total', { route: bucketize('/health', allowedRoutes) }).inc();
    });

    // One `other` series + one `/health` series — the cap never came near.
    expect(seriesOf(registry, 'http_requests_total')).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });
});
