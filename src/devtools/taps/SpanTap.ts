/**
 * The `spans` stream (#217) — completed spans for the flame graph.
 *
 * Whatever tracer is installed keeps working: if tracing is off the tap
 * enables a recorder, and if something is already there (an OTel
 * adapter, say) it wraps it in a {@link TeeTracer}.  Nobody has to
 * choose between exporting traces and looking at them locally.
 *
 * Attaching also flips two system-wide switches on — root spans and
 * message payloads — so detaching has to put back the whole tracing
 * configuration and not merely the tracer.  The second of the two is
 * the one an operator can decline: see {@link SpanTap.capturePayloads}.
 *
 * The payload switch used to decide, on a system that was already
 * exporting, whether message bodies left the process.  It no longer
 * does: a capture DevTools turned on is withheld from the tracer that
 * was there first, so the panel gets its Payload column and the
 * operator's backend gets exactly the spans it would have got anyway
 * (#1420).  What the attach still costs that system is volume — one
 * root span per message, exported like all the rest.
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

/**
 * The systems that carry a live tap, so a second one is refused.
 *
 * The snapshot below is only right for the newest tap.  A second tap
 * installed over a first records the first's recorder as the tracer to
 * put back and both switches as on; uninstalling the pair in install
 * order — what two `DevToolsServer`s stopped separately do — then
 * re-enables a dead recorder and both switches on a system with no
 * DevTools left on it, the #714 end state by another route (#1512).
 * Refusing at install is cheaper and more honest than chaining the
 * snapshots, and the extension never asks for two.  Keyed by
 * `ActorSystem` and weak, like the persistence-id registry, so
 * disposable test systems leak nothing.
 */
const systemsWithLiveTap = new WeakSet<ActorSystem>();

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
  /**
   * The two tracing switches as we found them, restored on uninstall.
   *
   * `TracingExtension.disable()` clears both as a side effect, which is
   * why the branch where DevTools was the first thing to enable tracing
   * always looked symmetric.  The branch that matters — a tracer that
   * was already exporting — goes through `enable()`, which touches
   * neither, so `actor.message.payload` stayed on every span for the
   * rest of the process and kept being shipped to whatever backend that
   * tracer feeds (#714).
   */
  private previousRootSpans = false;
  private previousMessagePayloads = false;
  private installed = false;

  constructor(
    private readonly system: ActorSystem,
    private readonly bufferCapacity: number,
    private readonly flushIntervalMs: number,
    /**
     * Whether this attach may switch message-payload capture on at all.
     *
     * Defaults to `true`, and that is the interesting half of #1420: with
     * the export closed by the tee above, `on` no longer trades an
     * operator's safety for a filled panel — the only consumer left of a
     * capture DevTools turns on is the panel the operator deliberately
     * attached.  So this is an opt-*out*, for the shared staging box whose
     * DevTools port more people can reach than the message bodies should
     * be, and the documented behaviour that recording runs from attach
     * with no button to press stays true for everybody else.
     *
     * It is deliberately narrower than `panels.tracing: false`, which was
     * the only control before it: that one makes the tap not exist, taking
     * the spans, the timings and the flame graph with it.  This one leaves
     * every one of those and empties one column.
     */
    private readonly capturePayloads = true,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    if (systemsWithLiveTap.has(this.system)) {
      throw new Error(
        'A SpanTap is already installed on this ActorSystem — one DevTools attachment per '
        + 'system. Detach it before installing another.',
      );
    }
    systemsWithLiveTap.add(this.system);
    this.emit = emit;
    const tracing = this.system.extension(TracingExtensionId);
    this.previousTracer = tracing.isEnabled() ? tracing.get() : null;
    this.previousRootSpans = tracing.isRecordingRootSpans();
    this.previousMessagePayloads = tracing.isCapturingMessagePayloads();

    if (this.previousTracer === null) {
      // Nothing installed: record for the panel and keep no buffer of
      // our own — `onSpanEnd` is the sink.
      tracing.enable(new RecordingTracer({
        maxRecorded: 0,
        onSpanEnd: (span) => this.onSpanEnd(span),
      }));
    } else {
      // Something is already exporting.  Tee into it so it keeps its
      // spans — but withhold the message body from it whenever *we* are
      // the ones switching capture on, which is the whole of #1420: a
      // debugger attaching must not push message contents into a backend
      // the operator never pointed at them.  When the application had
      // capture on for itself the attribute is its own and is forwarded
      // untouched; DevTools only declines to add an export, never
      // removes one.
      //
      // Which is why `capturePayloads` belongs in this predicate and not
      // only at the switch below.  With it off the tap flips nothing, so
      // there is nothing of DevTools' to withhold, and a filter still
      // derived from `previousMessagePayloads` alone would strip the
      // attribute out of an export that was never ours — the tee's filter
      // is fixed here, at install, so an application that enables its own
      // capture later in the attach is exactly who that would hit.
      const withheld = this.capturePayloads && !this.previousMessagePayloads
        ? new Set([MESSAGE_PAYLOAD_ATTRIBUTE])
        : new Set<string>();
      tracing.enable(new TeeTracer(this.previousTracer, (span) => this.onSpanEnd(span), withheld));
    }
    this.installed = true;
    // Record from here, not from the first subscriber.  The messages
    // worth looking at are the ones that already went past; asking the
    // developer to press a button first means they are gone.
    //
    // Root spans are not behind the switch: without them a plain `tell`
    // opens no span at all and the panel is empty — which is what
    // `panels.tracing: false` already does, and what an operator who asked
    // for traces without bodies is explicitly not asking for.
    tracing.recordRootSpans(true);
    if (this.capturePayloads) tracing.captureMessagePayloads(true);
    this.warnAboutExportChanges();
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
    // Only a tap that installed gets here — the early return above is
    // what keeps a refused tap's `uninstall()` from releasing the live
    // tap's entry.  Released before the restore rather than after, so a
    // restore that threw would not also keep the system closed to the
    // next attach.
    systemsWithLiveTap.delete(this.system);
    this.stopTicking();
    this.recent = [];

    const tracing = this.system.extension(TracingExtensionId);
    // Put back exactly what we found, so a system that was exporting
    // traces before DevTools attached still is afterwards.
    if (this.previousTracer === null) tracing.disable();
    else tracing.enable(this.previousTracer);
    this.previousTracer = null;
    // The two switches as well, on both branches — restoring the tracer
    // alone left message bodies attached to every span a pre-existing
    // exporter kept shipping (#714).  After the swap, deliberately:
    // `disable()` clears both, so restoring first would also lose a
    // capture the application had set for itself, and `recordRootSpans`
    // wants the tracer already back.
    //
    // `recordRootSpans(true)` throws without a tracer, and cannot here —
    // but the reason is an invariant of `TracingExtension`, not of this
    // method: nothing can leave root spans on with no tracer installed,
    // so a saved `true` means a tracer was there at `install()` time,
    // which is the branch that has just put one back.  Load-bearing, and
    // it did not always hold: `enable(NOOP_TRACER)` used to report
    // disabled while leaving both switches on, so a system that turned
    // tracing off by swapping the exported no-op in rather than calling
    // `disable()` handed this restore a `true` it could not satisfy, and
    // detaching DevTools threw.  Both halves are pinned by
    // `tests/unit/devtools/SpanTap.test.ts` (#714).
    tracing.recordRootSpans(this.previousRootSpans);
    tracing.captureMessagePayloads(this.previousMessagePayloads);
    // The two switches are deliberately NOT reset to `false` here, and the
    // asymmetry with `previousTracer` above is the point: every read of
    // either boolean — the two restores on this line pair and
    // `warnAboutExportChanges` — happens after `install()` has
    // re-snapshotted both unconditionally, and `uninstall()` early-returns
    // when it is not installed, so a stale value can never be read.  Nulling
    // `previousTracer` earns its line for a different reason: it holds a
    // `Tracer`, and dropping the reference is what lets a replaced exporter
    // be collected.

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
   * Say out loud what the attach changed for someone else's exporter.
   *
   * Both switches change what a pre-existing tracer carries, and the
   * warning used to speak for only one of them.
   *
   * *Payloads:* attaching to a system that was already tracing used to
   * mean message bodies left the process — the {@link TeeTracer} handed
   * every span to the tracer that was already there, so
   * `actor.message.payload` reached whatever backend that tracer
   * exports to, under its retention and access rules rather than the
   * application's (#714).  It no longer does; the tee withholds the
   * attribute whenever the capture is ours (#1420).  Still worth a line,
   * because the tee stopped being transparent to make it true:
   * `isCapturingMessagePayloads()` reports the capture as on while the
   * operator's own backend shows no such attribute, and nothing else in
   * the process explains the discrepancy.
   *
   * *Root spans:* the half that was never warned about.  The framework
   * is propagate-only, so before the attach a plain `tell` opened no
   * span at all and the exporter saw only traces the application seeded
   * itself.  From the attach it sees one root span per actor message —
   * an unbudgeted ingest bill at a paid APM, and now the only half that
   * still reaches a foreign backend.  The old predicate returned early
   * on `previousMessagePayloads`, so an application that had set
   * payload capture for itself and left root spans off got nothing at
   * all (#1512).
   *
   * One line, naming the halves that actually flipped: two lines are two
   * things to read at the moment somebody is attaching a debugger.  Only
   * when a foreign tracer is there to be surprised, and only for a
   * switch *we* flipped — an operator who had both on already has an
   * export the attach does not change, and a warning on every attach is
   * a warning nobody reads.  `capturePayloads: false` is the third way a
   * switch can come out unflipped, and the payload sentence describes an
   * attribute that is then never attached at all: prose asserting the
   * opposite of the code beside it is worse than no prose (#1420).
   */
  private warnAboutExportChanges(): void {
    if (this.previousTracer === null) return;
    const changes: string[] = [];
    if (!this.previousRootSpans) {
      changes.push(
        'it opens one root span per actor message and the tracer installed before DevTools '
        + 'exports every one of them, so the span volume that backend ingests now follows '
        + 'your message rate rather than the traces you seed yourself',
      );
    }
    if (this.capturePayloads && !this.previousMessagePayloads) {
      changes.push(
        'it attaches `actor.message.payload` — the serialised message body — to those spans '
        + 'for its own panel, withholding that attribute from the tracer installed before '
        + 'DevTools, so message contents do not reach that backend even though '
        + 'message-payload capture now reports as on system-wide',
      );
    }
    if (changes.length === 0) return;
    this.system.log.warn(
      `DevTools attached to a system that was already tracing: ${changes.join('; and ')}. `
      + 'Detaching puts both switches back as they were.',
    );
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
