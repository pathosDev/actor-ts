import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { OtelApiLike, OtelTracerLike } from './OtelAdapter.js';

/**
 * Built-in tracer name {@link otelTracer} asks `getTracer` for.  OpenTelemetry
 * files every span under the name of the tracer that started it — the
 * instrumentation scope, which names the library that made the span — so the
 * default is this library's name.  It is the scope the OTLP log sink publishes
 * too (`DEFAULT_OTLP_SCOPE_NAME`), so the framework's spans and log records
 * arrive under one name.
 */
export const DEFAULT_OTEL_TRACER_NAME = 'actor-ts';

/** Plain options-object shape accepted by {@link otelTracer}. */
export type OtelAdapterOptionsType = {
  /** The `@opentelemetry/api` namespace (`import * as otel from '@opentelemetry/api'`). */
  readonly api: OtelApiLike;
  /** Optional pre-built tracer; defaults to `api.trace.getTracer(tracerName, tracerVersion)`. */
  readonly tracer?: OtelTracerLike;
  /** Tracer name passed to `getTracer`.  Default {@link DEFAULT_OTEL_TRACER_NAME}. */
  readonly tracerName?: string;
  /** Tracer version passed to `getTracer`. */
  readonly tracerVersion?: string;
};

/**
 * Fluent builder for {@link OtelAdapterOptionsType}:
 *
 *     otelTracer(OtelAdapterOptions.create().withApi(otel).withTracerName('my-svc'))
 *
 * `withApi` is mandatory — the adapter has nothing to delegate to without
 * the `@opentelemetry/api` namespace.
 */
export class OtelAdapterOptionsBuilder extends OptionsBuilder<OtelAdapterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new OtelAdapterOptionsBuilder()`. */
  static create(): OtelAdapterOptionsBuilder {
    return new OtelAdapterOptionsBuilder();
  }

  /** The `@opentelemetry/api` namespace (`import * as otel from '@opentelemetry/api'`). */
  withApi(api: OtelApiLike): this {
    return this.set('api', api);
  }

  /** Optional pre-built tracer; defaults to `api.trace.getTracer(tracerName, tracerVersion)`. */
  withTracer(tracer: OtelTracerLike): this {
    return this.set('tracer', tracer);
  }

  /** Tracer name passed to `getTracer`.  Default {@link DEFAULT_OTEL_TRACER_NAME}. */
  withTracerName(tracerName: string): this {
    return this.set('tracerName', tracerName);
  }

  /** Tracer version passed to `getTracer`. */
  withTracerVersion(tracerVersion: string): this {
    return this.set('tracerVersion', tracerVersion);
  }
}

/**
 * Accepted input for {@link otelTracer}: the fluent
 * {@link OtelAdapterOptionsBuilder} OR a plain
 * {@link OtelAdapterOptionsType} object.
 */
export type OtelAdapterOptions = OtelAdapterOptionsBuilder | Partial<OtelAdapterOptionsType>;
/** Value alias so `OtelAdapterOptions.create()` / `new OtelAdapterOptions()` resolve to the builder. */
export const OtelAdapterOptions = OtelAdapterOptionsBuilder;

/**
 * The slice of the tracer's settings HOCON can supply.  `api` and `tracer` are
 * missing on purpose: both are live objects — the `@opentelemetry/api`
 * namespace the application imports and a tracer an SDK built — which a config
 * file cannot hold, so they stay code-only.
 */
export type OtelAdapterConfigDefaults = Pick<OtelAdapterOptionsType, 'tracerName' | 'tracerVersion'>;

/**
 * Read `actor-ts.tracing.*`: the name and version `getTracer` is asked for.
 *
 * The `Config` is a **required argument**, and nothing here calls
 * `Config.load()`.  The one consumer is `TracingExtension.enableOtel()`, which
 * holds an `ActorSystem` and passes `system.config`; `otelTracer` itself stays
 * the pure code path and never reads a file, so a tracer built without a
 * system behaves exactly as its options say.
 *
 * An absent leaf stays absent rather than being filled with
 * {@link DEFAULT_OTEL_TRACER_NAME}, so `mergeOptions` layers the caller's
 * options over this answer per field.  That matters most for `tracer-version`,
 * which `reference.conf` ships only as a comment: absent is what passes no
 * version to `getTracer`, and an own `undefined` would read as configured.
 */
export function readOtelAdapterOptionsFromConfig(config: Config): OtelAdapterConfigDefaults {
  const keys = ConfigKeys.tracing;
  const out: { -readonly [K in keyof OtelAdapterConfigDefaults]: OtelAdapterConfigDefaults[K] } = {};
  if (config.hasPath(keys.tracerName)) out.tracerName = config.getString(keys.tracerName);
  if (config.hasPath(keys.tracerVersion)) out.tracerVersion = config.getString(keys.tracerVersion);
  return out;
}
