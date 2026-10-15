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
