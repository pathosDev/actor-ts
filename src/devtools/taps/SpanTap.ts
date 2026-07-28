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
  TRACING_BUFFER_DEFAULT,
  TRACING_BUFFER_MAXIMUM,
  TRACING_BUFFER_MINIMUM,
  type TracingBufferParameters,
  type TracingBufferResult,
  type WireSpan,
} from '../protocol/index.js';
import type { DevToolsServer, DevToolsTap } from '../DevToolsServer.js';

/** Attributes the panel promotes out of the bag, for grouping. */
const ACTOR_PATH_ATTRIBUTE = 'actor.path';
const MESSAGE_TYPE_ATTRIBUTE = 'actor.message.type';
const SENDER_ATTRIBUTE = 'actor.sender';
const MESSAGE_PAYLOAD_ATTRIBUTE = 'actor.message.payload';

export class SpanTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'spans';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;
  /** Spans awaiting the next flush, oldest first. */
  private pending: WireSpan[] = [];
  /**
   * Everything still worth showing, oldest first.
   *
   * Recording runs from attach, so by the time a panel opens the
   * interesting messages have usually already happened.  This is what it
   * gets handed on subscribe.
   */
  private recent: WireSpan[] = [];
  /** How much of that to keep — the client's choice, within reason. */
  private retention = TRACING_BUFFER_DEFAULT;
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
    // Record from here, not from the first subscriber.  The messages
    // worth looking at are the ones that already went past; asking the
    // developer to press a button first means they are gone.
    tracing.recordRootSpans(true);
    tracing.captureMessagePayloads(true);
  }

  /** Register the buffer-size control on `server`. */
  installMethods(server: DevToolsServer): void {
    // `async` so a rejected parameter becomes a rejected promise rather
    // than a synchronous throw past the hub's error handling.
    server.registerMethod('tracing.buffer', async (p) => this.onBuffer(p));
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    this.stopTicking();
    this.recent = [];

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

  /** The recent past, so an opening panel is not blank. */
  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    if (this.recent.length === 0) return [];
    return [spanBatchPayload(Date.now(), [...this.recent], 0)];
  }

  subscribersChanged(count: number): void {
    // Recording does not stop when the last panel closes — that is the
    // point of recording from attach.  Only the flush ticker idles.
    if (count > 0) this.startTicking();
    else this.stopTicking();
  }

  /**
   * Resize the ring of retained spans.
   *
   * Clamped rather than rejected: a client asking for more than this
   * server is willing to hold should get the most it can have, told
   * plainly, instead of an error it can do nothing about.
   */
  private onBuffer(parameters: unknown): TracingBufferResult {
    const request = (parameters ?? {}) as Partial<TracingBufferParameters>;
    const wanted = request.capacity;
    if (typeof wanted !== 'number' || !Number.isFinite(wanted)) {
      throw new Error('`capacity` must be a number');
    }
    const ceiling = Math.min(this.bufferCapacity, TRACING_BUFFER_MAXIMUM);
    // Floor first, ceiling second, so a server configured below the
    // protocol minimum still gets what it asked for rather than being
    // overruled by it.
    this.retention = Math.min(Math.max(TRACING_BUFFER_MINIMUM, Math.floor(wanted)), ceiling);
    this.trimRecent();
    return { capacity: this.retention, retained: this.recent.length };
  }

  private onSpanEnd(span: RecordedSpan): void {
    const wire = toWireSpan(span);
    this.recent.push(wire);
    this.trimRecent();

    if (this.pending.length >= this.bufferCapacity) {
      // Drop the oldest: when a flame graph falls behind, the recent
      // past is what the developer is looking at.
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(wire);
  }

  private trimRecent(): void {
    if (this.recent.length > this.retention) {
      this.recent = this.recent.slice(this.recent.length - this.retention);
    }
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
    senderPath: emptyToNull(stringAttribute(span, SENDER_ATTRIBUTE)),
    messageType: stringAttribute(span, MESSAGE_TYPE_ATTRIBUTE),
    messagePayload: stringAttribute(span, MESSAGE_PAYLOAD_ATTRIBUTE),
    exceptions: span.exceptions.map((error) => error.message),
  };
}

function stringAttribute(span: RecordedSpan, key: string): string | null {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : null;
}

/** `''` is how the cell writes "no sender"; the wire says `null`. */
function emptyToNull(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}
