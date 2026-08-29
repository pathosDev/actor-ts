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
    this.install(tracer);
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

  /**
   * Attach the message itself, as JSON, to every `actor.receive` span.
   *
   * A span otherwise records only the message's *type*, which answers
   * "what happened" but not "to what" — and for a `kind`-tagged object
   * literal the type alone is thin.  The cost is a `JSON.stringify` per
   * traced message, bounded in depth and length, which is why it is a
   * separate switch from {@link recordRootSpans} rather than implied by
   * it.
   */
  captureMessagePayloads(enabled: boolean): void {
    this._system._traceMessagePayloads = enabled;
  }

  isCapturingMessagePayloads(): boolean { return this._system._traceMessagePayloads; }

  /** Reset back to the noop — primarily for tests. */
  disable(): void {
    this.install(NOOP_TRACER);
    // Both are pure cost without a tracer, so they go with it.
    this._system._traceRootSpans = false;
    this._system._traceMessagePayloads = false;
  }

  /**
   * The one writer of {@link ActorSystem._tracer}, so the field and this
   * extension's own `tracer` cannot drift apart.
   *
   * The field is the hot-path mirror: `null` exactly when {@link isEnabled} is
   * false, so the receive path resolves a tracer with one field read instead
   * of walking the extension chain twice per message (#411).  Assigning both
   * here rather than at the call sites is what keeps "enabled" meaning the
   * same thing to `tracerOf(...)` and to the per-message read — and this
   * extension is swapped at runtime with live cells draining, so the two
   * agreeing at every instant is the actual requirement.
   */
  private install(tracer: Tracer): void {
    this.tracer = tracer;
    this._system._tracer = tracer === NOOP_TRACER ? null : tracer;
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
