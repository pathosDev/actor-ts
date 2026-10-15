import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DEFAULT_MAX_SERIES_PER_FAMILY,
  readMetricsRegistryOptionsFromConfig,
} from '../../../src/metrics/MetricsRegistryOptions.js';
import {
  DEFAULT_PROM_CLIENT_NAME_PREFIX,
  readPromClientAdapterOptionsFromConfig,
} from '../../../src/metrics/PromClientAdapterOptions.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * `actor-ts.metrics` (#1466): one block, two readers, because the two
 * registries `MetricsExtension` can build take different slices of it.  The
 * in-process registry has a cap and no prefix concept — its exposition is the
 * framework's own `GET /metrics` — while the prom-client bridge takes both.
 *
 * Every case asserts with `expectExactOptions` rather than `toEqual`: the
 * readers promise that a leaf nobody set is omitted, not written as an own
 * `undefined`, because the extension layers their answer under the caller's
 * explicit options with `mergeOptions`, and an own `undefined` there would be
 * indistinguishable from "configured" in everything but the result.
 *
 * `Config.parseString` throughout, never `Config.fromObject` with dotted keys:
 * the latter keeps `'actor-ts.metrics.x'` as one literal top-level key, so
 * `hasPath` would miss it and these cases would test nothing.
 */

function configOf(hocon: string): Config {
  return Config.parseString(hocon);
}

describe('readMetricsRegistryOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented default', () => {
    expectExactOptions(readMetricsRegistryOptionsFromConfig(configOf(REFERENCE_CONF)), {
      maxSeriesPerFamily: DEFAULT_MAX_SERIES_PER_FAMILY,
    });
  });

  test('max-series-per-family reaches maxSeriesPerFamily', () => {
    expectExactOptions(
      readMetricsRegistryOptionsFromConfig(configOf('actor-ts.metrics.max-series-per-family = 3')),
      { maxSeriesPerFamily: 3 },
    );
  });

  test('0, the documented opt-out, is passed through rather than read as unset', () => {
    expectExactOptions(
      readMetricsRegistryOptionsFromConfig(configOf('actor-ts.metrics.max-series-per-family = 0')),
      { maxSeriesPerFamily: 0 },
    );
  });

  test('name-prefix is not this reader\'s leaf: the in-process registry has no prefix', () => {
    expectExactOptions(
      readMetricsRegistryOptionsFromConfig(configOf('actor-ts.metrics.name-prefix = "app_"')),
      {},
    );
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readMetricsRegistryOptionsFromConfig(configOf('actor-ts.system.name = x')), {});
  });

  test('a fractional cap is refused as the wrong kind, not truncated', () => {
    // The cap is a count of series.  `getNumber` would hand `2.5` on to the
    // validator, which refuses it too, but only once a registry is built; the
    // reader refusing it names the key instead of the options field.
    expect(() => readMetricsRegistryOptionsFromConfig(configOf('actor-ts.metrics.max-series-per-family = 2.5')))
      .toThrow(ConfigError);
  });
});

describe('readPromClientAdapterOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented defaults', () => {
    expectExactOptions(readPromClientAdapterOptionsFromConfig(configOf(REFERENCE_CONF)), {
      namePrefix: DEFAULT_PROM_CLIENT_NAME_PREFIX,
      maxSeriesPerFamily: DEFAULT_MAX_SERIES_PER_FAMILY,
    });
  });

  test('name-prefix reaches namePrefix', () => {
    expectExactOptions(
      readPromClientAdapterOptionsFromConfig(configOf('actor-ts.metrics.name-prefix = "actor_ts_"')),
      { namePrefix: 'actor_ts_' },
    );
  });

  test('max-series-per-family reaches maxSeriesPerFamily', () => {
    expectExactOptions(
      readPromClientAdapterOptionsFromConfig(configOf('actor-ts.metrics.max-series-per-family = 50000')),
      { maxSeriesPerFamily: 50_000 },
    );
  });

  test('an empty prefix written out is a value, not an absence', () => {
    // `""` is the published default rather than a placeholder for "unset": the
    // bridge registers bare names unless told otherwise, so a file that says
    // so has said something, and it outranks nothing but the built-in floor.
    expectExactOptions(
      readPromClientAdapterOptionsFromConfig(configOf('actor-ts.metrics.name-prefix = ""')),
      { namePrefix: '' },
    );
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readPromClientAdapterOptionsFromConfig(configOf('actor-ts.system.name = x')), {});
  });

  test('the client and registry namespaces have no leaf a file could name', () => {
    // Both are live objects — the `prom-client` import and its `Registry` —
    // which HOCON has no way to express, so they stay code-only.
    expectExactOptions(
      readPromClientAdapterOptionsFromConfig(configOf(`
        actor-ts.metrics {
          client   = "prom-client"
          registry = "default"
        }
      `)),
      {},
    );
  });
});

describe('ConfigKeys.metrics', () => {
  test('every leaf is spelled out, not covered by a block root', () => {
    expect(ConfigKeys.metrics).toEqual({
      maxSeriesPerFamily: 'actor-ts.metrics.max-series-per-family',
      namePrefix: 'actor-ts.metrics.name-prefix',
    });
  });
});
