/**
 * #1466 — what the published `actor-ts/tracing` barrel exports for the
 * OpenTelemetry adapters a system can configure.
 *
 * `package.json` maps `./tracing` to the build of `src/tracing/index.ts`, and
 * `tests/unit/ExportSurface.test.ts` checks only the barrels folded into the
 * root, so nothing imported this one: deleting `DEFAULT_OTEL_TRACER_NAME` and
 * `readOtelAdapterOptionsFromConfig` from it left every suite green, although
 * the CHANGELOG advertises the first.  Each name is checked to be the very
 * binding its own module exports, so a barrel that exported a look-alike, or
 * the right value under another name, fails as well as one that dropped it.
 */
import { describe, expect, test } from 'bun:test';
import { otelTracer } from '../../../src/tracing/OtelAdapter.js';
import * as otelAdapterOptions from '../../../src/tracing/OtelAdapterOptions.js';
import { otelLogger } from '../../../src/tracing/OtelLogsAdapter.js';
import * as otelLogsAdapterOptions from '../../../src/tracing/OtelLogsAdapterOptions.js';
import * as tracing from '../../../src/tracing/index.js';

/** Read through an index so a missing name is a failed assertion, not a compile error. */
const barrel = tracing as unknown as Readonly<Record<string, unknown>>;

describe('actor-ts/tracing exports the configured OpenTelemetry adapters (#1466)', () => {
  test.each([
    ['DEFAULT_OTEL_TRACER_NAME', otelAdapterOptions.DEFAULT_OTEL_TRACER_NAME],
    ['readOtelAdapterOptionsFromConfig', otelAdapterOptions.readOtelAdapterOptionsFromConfig],
    ['OtelAdapterOptions', otelAdapterOptions.OtelAdapterOptions],
    ['OtelAdapterOptionsBuilder', otelAdapterOptions.OtelAdapterOptionsBuilder],
    ['otelTracer', otelTracer],
    ['DEFAULT_OTEL_LOGGER_NAME', otelLogsAdapterOptions.DEFAULT_OTEL_LOGGER_NAME],
    ['readOtelLogsAdapterOptionsFromConfig', otelLogsAdapterOptions.readOtelLogsAdapterOptionsFromConfig],
    ['OtelLogsAdapterOptions', otelLogsAdapterOptions.OtelLogsAdapterOptions],
    ['OtelLogsAdapterOptionsBuilder', otelLogsAdapterOptions.OtelLogsAdapterOptionsBuilder],
    ['otelLogger', otelLogger],
  ] as const)('%s', (name, binding) => {
    expect(binding).toBeDefined();
    expect(Object.hasOwn(barrel, name)).toBe(true);
    expect(barrel[name]).toBe(binding);
  });
});
