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

  /**
   * Trace **every** message, not only the ones already inside a trace.
   *
   * Normally an actor opens a span only when the message arrived with a
   * trace context or a span was active at the call site, which makes the
   * framework propagate-only: a plain `ref.tell(…)` from outside any
   * span produces nothing.  That is the right default for production —
   * you decide what is worth a trace — but it means a tracing UI shows
   * an empty screen on a system that is plainly busy.
   *
   * Switch this on and every message becomes a root span.  Expect the
   * volume to match the traffic; this is a debugging mode, not a
   * sampling policy.
   *
   * @throws if no tracer is installed — root spans against the noop
   *   tracer would cost work and record nothing.
   */
  recordRootSpans(enabled: boolean): void {
    if (enabled && !this.isEnabled()) {
      throw new Error(
        'recordRootSpans(true) needs a tracer — call enable(new RecordingTracer()) first',
      );
    }
    this._system._traceRootSpans = enabled;
  }

  isRecordingRootSpans(): boolean { return this._system._traceRootSpans; }

  /** Reset back to the noop — primarily for tests. */
  disable(): void {
    this.tracer = NOOP_TRACER;
    // Root spans without a tracer are pure cost, so they go with it.
    this._system._traceRootSpans = false;
  }
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
