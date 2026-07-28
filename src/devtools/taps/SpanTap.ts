/**
 * The `spans` stream (#217) — completed spans for the flame graph.
 *
 * Whatever tracer is installed keeps working: if tracing is off the tap
 * enables a recorder, and if something is already there (an OTel
 * adapter, say) it wraps it in a {@link TeeTracer}.  Nobody has to
 * choose between exporting traces and looking at them locally.
 *
 * Spans are buffered and flushed on a tick rather than sent one by one.
 * A single actor message can produce several spans, and a busy system
 * would otherwise turn a debugging aid into a firehose.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import { RecordingTracer, type RecordedSpan } from '../../tracing/RecordingTracer.js';
import { TeeTracer } from '../../tracing/TeeTracer.js';
import { TracingExtensionId } from '../../tracing/TracingExtension.js';
import type { Tracer } from '../../tracing/Tracer.js';
import {
  spanBatchPayload,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type TracingRecordParameters,
  type TracingRecordResult,
  type WireSpan,
} from '../protocol/index.js';
import type { DevToolsServer, DevToolsTap } from '../DevToolsServer.js';

/** Attributes the panel promotes out of the bag, for grouping. */
const ACTOR_PATH_ATTRIBUTE = 'actor.path';
const MESSAGE_TYPE_ATTRIBUTE = 'actor.message.type';

export class SpanTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'spans';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;
  /** Spans awaiting the next flush, oldest first. */
  private pending: WireSpan[] = [];
  /** Spans dropped since the last flush, so the panel can say so. */
  private dropped = 0;
  /** Tracer that was installed before us, restored on uninstall. */
  private previousTracer: Tracer | null = null;
  private installed = false;

  constructor(
    private readonly system: ActorSystem,
    private readonly bufferCapacity: number,
    private readonly flushIntervalMs: number,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    const tracing = this.system.extension(TracingExtensionId);
    this.previousTracer = tracing.isEnabled() ? tracing.get() : null;

    if (this.previousTracer === null) {
      // Nothing installed: record for the panel and keep no buffer of
      // our own — `onSpanEnd` is the sink.
      tracing.enable(new RecordingTracer({
        maxRecorded: 0,
        onSpanEnd: (span) => this.onSpanEnd(span),
      }));
    } else {
      tracing.enable(new TeeTracer(this.previousTracer, (span) => this.onSpanEnd(span)));
    }
    this.installed = true;
  }

  /** Register the recording switch on `server`. */
  installMethods(server: DevToolsServer): void {
    // `async` so a rejected parameter becomes a rejected promise rather
    // than a synchronous throw past the hub's error handling.
    server.registerMethod('tracing.record', async (p) => this.onRecord(p));
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    this.stopTicking();
    this.setRecording(false);

    const tracing = this.system.extension(TracingExtensionId);
    // Put back exactly what we found, so a system that was exporting
    // traces before DevTools attached still is afterwards.
    if (this.previousTracer === null) tracing.disable();
    else tracing.enable(this.previousTracer);
    this.previousTracer = null;

    this.pending = [];
    this.dropped = 0;
    this.emit = null;
  }

  /**
   * Nothing.  A flame graph is built from spans recorded *while you
   * watch*; replaying a buffer captured before the panel opened would
   * show a trace the developer cannot correlate with anything they did.
   */
  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [];
  }

  subscribersChanged(count: number): void {
    if (count > 0) {
      this.startTicking();
      return;
    }
    this.stopTicking();
    // Closing the panel must switch recording off.  A system that keeps
    // tracing every message because somebody once opened a tab and
    // walked away is a performance bug we handed the user.
    this.setRecording(false);
  }

  /**
   * Turn root-span recording on or off.
   *
   * Without it the panel is empty on a busy system: the framework only
   * traces a message that already belongs to a trace, so nothing a
   * plain `tell` does is ever recorded.
   */
  private onRecord(parameters: unknown): TracingRecordResult {
    const request = (parameters ?? {}) as Partial<TracingRecordParameters>;
    if (typeof request.enabled !== 'boolean') {
      throw new Error('`enabled` must be a boolean');
    }
    this.setRecording(request.enabled);
    return { recording: this.system.extension(TracingExtensionId).isRecordingRootSpans() };
  }

  private setRecording(enabled: boolean): void {
    const tracing = this.system.extension(TracingExtensionId);
    // `recordRootSpans(true)` refuses without a tracer; ours is only
    // installed between `install` and `uninstall`.
    if (enabled && !this.installed) return;
    tracing.recordRootSpans(enabled);
  }

  private onSpanEnd(span: RecordedSpan): void {
    if (this.pending.length >= this.bufferCapacity) {
      // Drop the oldest: when a flame graph falls behind, the recent
      // past is what the developer is looking at.
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(toWireSpan(span));
  }

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.flushIntervalMs,
      this.flushIntervalMs,
      () => this.flush(),
    );
  }

  private stopTicking(): void {
    this.ticker?.cancel();
    this.ticker = null;
    // Stop buffering for nobody; the next subscriber starts clean.
    this.pending = [];
    this.dropped = 0;
  }

  private flush(): void {
    if (this.pending.length === 0 && this.dropped === 0) return;
    const batch = this.pending;
    const dropped = this.dropped;
    this.pending = [];
    this.dropped = 0;
    this.emit?.(spanBatchPayload(Date.now(), batch, dropped));
  }
}

/** Project a recorded span onto the wire shape. */
function toWireSpan(span: RecordedSpan): WireSpan {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    // Attribute values may be arrays; the panel renders scalars, and a
    // joined string beats dropping the attribute entirely.
    attributes[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    name: span.name,
    spanKind: span.kind,
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    parentSpanId: span.parent?.spanId ?? null,
    startMs: span.startTimeMs,
    endMs: span.endTimeMs,
    startHighResolutionMs: span.startHighResolutionMs ?? null,
    endHighResolutionMs: span.endHighResolutionMs ?? null,
    status: span.status,
    statusMessage: span.statusMessage ?? null,
    attributes,
    actorPath: stringAttribute(span, ACTOR_PATH_ATTRIBUTE),
    messageType: stringAttribute(span, MESSAGE_TYPE_ATTRIBUTE),
    exceptions: span.exceptions.map((error) => error.message),
  };
}

function stringAttribute(span: RecordedSpan, key: string): string | null {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : null;
}
