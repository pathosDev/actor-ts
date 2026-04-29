import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { NOOP_TRACER } from './NoopTracer.js';
import type { Tracer } from './Tracer.js';

/**
 * `system.extension(TracingExtensionId)` accessor.  Hands back the
 * currently-installed {@link Tracer} (defaults to the noop), so
 * framework instrumentation can call `tracerOf(system).activeSpan()`
 * etc. without conditional checks.  Opt in by calling `enable(tracer)`
 * with either a `RecordingTracer` (for tests) or an adapter around
 * `@opentelemetry/api`'s tracer.
 */
export class TracingExtension implements Extension {
  private tracer: Tracer = NOOP_TRACER;

  constructor(private readonly _system: ActorSystem) {}

  /** Currently-installed tracer (noop until `enable(...)` is called). */
  get(): Tracer { return this.tracer; }

  /** Plug in a tracer.  Idempotent if you re-pass the same instance. */
  enable(tracer: Tracer): Tracer {
    this.tracer = tracer;
    return tracer;
  }

  /** True if a real (non-noop) tracer is installed. */
  isEnabled(): boolean { return this.tracer !== NOOP_TRACER; }

  /** Reset back to the noop — primarily for tests. */
  disable(): void { this.tracer = NOOP_TRACER; }
}

export const TracingExtensionId: ExtensionId<TracingExtension> =
  extensionId<TracingExtension>(
    'actor-ts/tracing',
    (system) => new TracingExtension(system),
  );

/**
 * Convenience accessor used by framework instrumentation.  Cheap on
 * the no-tracer hot path because the extension chain returns a
 * cached `TracingExtension` and `get()` returns the singleton noop.
 */
export function tracerOf(system: ActorSystem): Tracer {
  return system.extension(TracingExtensionId).get();
}
