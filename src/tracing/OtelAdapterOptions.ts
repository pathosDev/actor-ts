import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { OtelAdapterSettings, OtelApiLike, OtelTracerLike } from './OtelAdapter.js';

/**
 * Fluent builder for {@link OtelAdapterSettings}:
 *
 *     otelTracer(OtelAdapterOptions.create().withApi(otel).withTracerName('my-svc'))
 *
 * `withApi` is mandatory — the adapter has nothing to delegate to without
 * the `@opentelemetry/api` namespace.
 */
export class OtelAdapterOptions extends OptionsBuilder<OtelAdapterSettings> {
  /** Start a fresh builder.  Equivalent to `new OtelAdapterOptions()`. */
  static create(): OtelAdapterOptions {
    return new OtelAdapterOptions();
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
