import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DEFAULT_OTEL_TRACER_NAME,
  readOtelAdapterOptionsFromConfig,
} from '../../../src/tracing/OtelAdapterOptions.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * `actor-ts.tracing` (#1466): the name and version
 * `TracingExtension.enableOtel` asks OpenTelemetry's `getTracer` for, layered
 * under the caller's explicit options.  `tracer-name` ships its default;
 * `tracer-version` ships as a comment only, because unset is what passes no
 * version at all — so the reference case has one key, and the comment-only
 * leaf is bound by the cases that write it.
 *
 * Every case asserts with `expectExactOptions` rather than `toEqual`: the
 * reader promises that a leaf nobody set is omitted, not written as an own
 * `undefined`, because the extension layers its answer under the caller's
 * explicit options with `mergeOptions`, and an own `undefined` there would be
 * indistinguishable from "configured" in everything but the result.
 *
 * `Config.parseString` throughout, never `Config.fromObject` with dotted keys:
 * the latter keeps `'actor-ts.tracing.x'` as one literal top-level key, so
 * `hasPath` would miss it and these cases would test nothing.
 */

function configOf(hocon: string): Config {
  return Config.parseString(hocon);
}

describe('readOtelAdapterOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented name and no version', () => {
    expectExactOptions(readOtelAdapterOptionsFromConfig(configOf(REFERENCE_CONF)), {
      tracerName: DEFAULT_OTEL_TRACER_NAME,
    });
  });

  test('tracer-name reaches tracerName, and the unset version stays absent', () => {
    expectExactOptions(
      readOtelAdapterOptionsFromConfig(configOf('actor-ts.tracing.tracer-name = "billing"')),
      { tracerName: 'billing' },
    );
  });

  test('tracer-version, a comment in reference.conf, reaches tracerVersion when a file writes it', () => {
    expectExactOptions(
      readOtelAdapterOptionsFromConfig(configOf('actor-ts.tracing.tracer-version = "2.4.0"')),
      { tracerVersion: '2.4.0' },
    );
  });

  test('both leaves together', () => {
    expectExactOptions(
      readOtelAdapterOptionsFromConfig(configOf(`
        actor-ts.tracing {
          tracer-name    = "billing"
          tracer-version = "2.4.0"
        }
      `)),
      { tracerName: 'billing', tracerVersion: '2.4.0' },
    );
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readOtelAdapterOptionsFromConfig(configOf('actor-ts.system.name = x')), {});
  });

  test('an unquoted 1.0 is a number to HOCON before the reader sees it, which is why the reference quotes it', () => {
    // The reference comment tells operators to quote the version.  This is
    // the parse that advice rests on: the trailing zero is gone by the time
    // the leaf is read as a string, so it cannot be put back here.
    expectExactOptions(
      readOtelAdapterOptionsFromConfig(configOf('actor-ts.tracing.tracer-version = 1.0')),
      { tracerVersion: '1' },
    );
  });

  test('the api namespace and a pre-built tracer have no leaf a file could name', () => {
    // Both are live objects — the `@opentelemetry/api` import and a tracer an
    // SDK built — which HOCON has no way to express, so they stay code-only.
    expectExactOptions(
      readOtelAdapterOptionsFromConfig(configOf(`
        actor-ts.tracing {
          api    = "@opentelemetry/api"
          tracer = "default"
        }
      `)),
      {},
    );
  });
});

describe('ConfigKeys.tracing', () => {
  test('every leaf is spelled out, not covered by a block root', () => {
    expect(ConfigKeys.tracing).toEqual({
      tracerName: 'actor-ts.tracing.tracer-name',
      tracerVersion: 'actor-ts.tracing.tracer-version',
    });
  });
});
