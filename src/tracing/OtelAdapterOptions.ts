import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { OtelApiLike, OtelTracerLike } from './OtelAdapter.js';

/** Plain settings-object shape accepted by {@link otelTracer}. */
export interface OtelAdapterOptionsType {
  /** The `@opentelemetry/api` namespace (`import * as otel from '@opentelemetry/api'`). */
  readonly api: OtelApiLike;
  /** Optional pre-built tracer; defaults to `api.trace.getTracer(tracerName, tracerVersion)`. */
  readonly tracer?: OtelTracerLike;
  /** Tracer name passed to `getTracer`.  Default: `'actor-ts'`. */
  readonly tracerName?: string;
  /** Tracer version passed to `getTracer`. */
  readonly tracerVersion?: string;
}

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

  /** Tracer name passed to `getTracer`.  Default: `'actor-ts'`. */
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
