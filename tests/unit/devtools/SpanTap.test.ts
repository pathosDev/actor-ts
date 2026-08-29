import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { tracerOf } from '../../../src/tracing/TracingExtension.js';
import { SpanTap } from '../../../src/devtools/taps/SpanTap.js';
import { TRACING_BUFFER_MINIMUM } from '../../../src/devtools/protocol/index.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';
import { Actor } from '../../../src/Actor.js';
import type { DevToolsStreamPayload, SpanBatchPayload } from '../../../src/devtools/protocol/index.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/**
 * Give the tap time to emit whatever the exchange above produced.
 *
 * A fixed delay and not `awaitCondition`, because the two things this file
 * checks are both unpollable.  Several assertions are absences — a filtered tap
 * must emit *nothing* (`expect(emitted).toHaveLength(0)`), and a predicate over
 * an already-empty array is true at t = 0.  The rest are exact:
 * `expect(batch.spans).toHaveLength(3)` beside `expect(batch.dropped).toBe(3)`
 * is the drop accounting, and a poll that stopped at three spans would never see
 * a fourth leak through.
 */
const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Collect every span across the flushed batches. */
function spansOf(payloads: ReadonlyArray<DevToolsStreamPayload>) {
  return payloads
    .filter((p): p is SpanBatchPayload => p.kind === 'span-batch')
    .flatMap((p) => p.spans);
}

describe('SpanTap — tracer installation', () => {
  test('enables a tracer when none is installed', () => {
    const system = newSystem('span-enable');
    const tap = new SpanTap(system, 100, 20);
    expect(system.extension(TracingExtensionId).isEnabled()).toBe(false);
    tap.install(() => {});
    try {
      expect(system.extension(TracingExtensionId).isEnabled()).toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('restores the previous absence of a tracer on uninstall', () => {
    const system = newSystem('span-restore-none');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    tap.uninstall();
    expect(system.extension(TracingExtensionId).isEnabled()).toBe(false);
  });

  test('keeps an existing tracer working instead of replacing it', () => {
    // The whole point of teeing: exporting traces and watching them
    // locally must not be an either/or.
    const system = newSystem('span-tee');
    const existing = new RecordingTracer();
    system.extension(TracingExtensionId).enable(existing);

    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => emitted.push(payload));
    try {
      tap.subscribersChanged(1);
      tracerOf(system).startSpan('work').end();
      expect(existing.recorded().map((span) => span.name)).toEqual(['work']);
    } finally {
      tap.uninstall();
    }
  });

  test('puts the original tracer back on uninstall', () => {
    const system = newSystem('span-restore-existing');
    const existing = new RecordingTracer();
    system.extension(TracingExtensionId).enable(existing);
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    tap.uninstall();
    expect(tracerOf(system)).toBe(existing);
  });

  test('uninstalling twice is harmless', () => {
    const system = newSystem('span-double-uninstall');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    tap.uninstall();
    expect(() => tap.uninstall()).not.toThrow();
  });
});

describe('SpanTap — streaming', () => {
  test('flushes recorded spans in a batch', async () => {
    const system = newSystem('span-flush');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => emitted.push(payload));
    try {
      tap.subscribersChanged(1);
      tracerOf(system).startSpan('actor.receive', {
        kind: 'consumer',
        attributes: { 'actor.path': '/user/a', 'actor.message.type': 'Ping' },
      }).end();
      await settle();

      const spans = spansOf(emitted);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('actor.receive');
      expect(spans[0]!.spanKind).toBe('consumer');
      // The two attributes the panel groups by are lifted out.
      expect(spans[0]!.actorPath).toBe('/user/a');
      expect(spans[0]!.messageType).toBe('Ping');
    } finally {
      tap.uninstall();
    }
  });

  test('carries the parent link so a flame graph can be built', async () => {
    const system = newSystem('span-parent');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => emitted.push(payload));
    try {
      tap.subscribersChanged(1);
      const tracer = tracerOf(system);
      const outer = tracer.startSpan('outer');
      tracer.withActiveSpan(outer, () => tracer.startSpan('inner').end());
      outer.end();
      await settle();

      const spans = spansOf(emitted);
      const inner = spans.find((span) => span.name === 'inner')!;
      const outerSpan = spans.find((span) => span.name === 'outer')!;
      expect(inner.parentSpanId).toBe(outerSpan.spanId);
      expect(outerSpan.parentSpanId).toBeNull();
      expect(inner.traceId).toBe(outerSpan.traceId);
    } finally {
      tap.uninstall();
    }
  });

  test('reports high-resolution timings, since spans finish inside a millisecond', async () => {
    const system = newSystem('span-hires');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => emitted.push(payload));
    try {
      tap.subscribersChanged(1);
      tracerOf(system).startSpan('quick').end();
      await settle();

      const span = spansOf(emitted)[0]!;
      expect(span.startHighResolutionMs).not.toBeNull();
      expect(span.endHighResolutionMs).toBeGreaterThanOrEqual(span.startHighResolutionMs!);
    } finally {
      tap.uninstall();
    }
  });

  test('drops the oldest span when the buffer is full and says how many', async () => {
    const system = newSystem('span-overflow');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 3, 30);
    tap.install((payload) => emitted.push(payload));
    try {
      tap.subscribersChanged(1);
      const tracer = tracerOf(system);
      for (let i = 0; i < 6; i++) tracer.startSpan(`s${i}`).end();
      await settle();

      const batch = emitted.find((p): p is SpanBatchPayload => p.kind === 'span-batch')!;
      expect(batch.spans).toHaveLength(3);
      expect(batch.dropped).toBe(3);
      // The RECENT past survives — that is what the panel shows.
      expect(batch.spans.map((span) => span.name)).toEqual(['s3', 's4', 's5']);
    } finally {
      tap.uninstall();
    }
  });

  test('does not flush while nobody is subscribed', async () => {
    const system = newSystem('span-idle');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => emitted.push(payload));
    try {
      tracerOf(system).startSpan('unwatched').end();
      await settle();
      expect(emitted).toHaveLength(0);
    } finally {
      tap.uninstall();
    }
  });

  test('hands a new subscriber the recent past', () => {
    // Recording starts at attach precisely so the messages worth looking
    // at are already there when the panel is opened.  Withholding them
    // would make that pointless.
    const system = newSystem('span-snapshot');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    try {
      tracerOf(system).startSpan('before').end();
      expect(spansOf(tap.snapshot()).map((span) => span.name)).toEqual(['before']);
    } finally {
      tap.uninstall();
    }
  });

  test('an error span carries its status and exception', async () => {
    const system = newSystem('span-error');
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => emitted.push(payload));
    try {
      tap.subscribersChanged(1);
      const span = tracerOf(system).startSpan('failing');
      span.setStatus('error', 'handler threw');
      span.recordException(new Error('boom'));
      span.end();
      await settle();

      const wire = spansOf(emitted)[0]!;
      expect(wire.status).toBe('error');
      expect(wire.statusMessage).toBe('handler threw');
      expect(wire.exceptions).toEqual(['boom']);
    } finally {
      tap.uninstall();
    }
  });
});

describe('SpanTap — recording every message', () => {
  test('an ordinary tell is recorded, with nobody having asked', async () => {
    const system = newSystem('span-record');
    const tap = new SpanTap(system, 100, 20);
    const payloads: DevToolsStreamPayload[] = [];
    tap.install((payload) => payloads.push(payload));
    tap.subscribersChanged(1);
    try {
      const ref = system.spawn(EchoActor, 'echo');
      // The framework is propagate-only — no active span, no trace — so
      // this only produces anything because the tap seeds roots itself.
      ref.tell('hello');
      await settle(80);

      const spans = spansOf(payloads);
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.some((span) => span.actorPath?.endsWith('/echo') === true)).toBe(true);
      // A root span, because nothing upstream had one.
      expect(spans[0]!.parentSpanId).toBeNull();
    } finally {
      tap.uninstall();
    }
  });

  test('closing the last panel does not stop recording', async () => {
    const system = newSystem('span-record-stop');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    const tracing = system.extension(TracingExtensionId);
    try {
      expect(tracing.isRecordingRootSpans()).toBe(true);

      tap.subscribersChanged(1);
      tap.subscribersChanged(0);
      // Only the flush ticker idles.  Stopping here would empty the
      // buffer the next panel is supposed to open onto.
      expect(tracing.isRecordingRootSpans()).toBe(true);

      const ref = system.spawn(EchoActor, 'echo');
      ref.tell('unobserved');
      await settle(80);
      expect(spansOf(tap.snapshot()).length).toBeGreaterThan(0);
    } finally {
      tap.uninstall();
    }
  });

  test('detaching stops recording and leaves the tracer as it was', () => {
    const system = newSystem('span-record-detach');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    tap.uninstall();

    const tracing = system.extension(TracingExtensionId);
    expect(tracing.isRecordingRootSpans()).toBe(false);
    expect(tracing.isEnabled()).toBe(false);
  });

  test('the retained ring is resizable, and clamped at both ends', async () => {
    const system = newSystem('span-buffer');
    // Ceiling of 20, so a client asking for more cannot have it.
    const tap = new SpanTap(system, 20, 20);
    tap.install(() => {});
    try {
      expect(await bufferMethod(tap)({ capacity: 10 })).toEqual({ capacity: 10, retained: 0 });

      const tracer = tracerOf(system);
      for (let i = 0; i < 12; i++) tracer.startSpan(`s${i}`).end();
      const kept = spansOf(tap.snapshot()).map((span) => span.name);
      expect(kept).toHaveLength(10);
      expect(kept[0]).toBe('s2');

      // Both ends clamp, and the answer says what was settled on rather
      // than erroring at a caller who can do nothing about it.
      expect((await bufferMethod(tap)({ capacity: 10_000 }) as { capacity: number }).capacity)
        .toBe(20);
      expect((await bufferMethod(tap)({ capacity: 1 }) as { capacity: number }).capacity)
        .toBe(TRACING_BUFFER_MINIMUM);

      await expect(bufferMethod(tap)({ capacity: 'lots' })).rejects.toThrow('must be a number');
    } finally {
      tap.uninstall();
    }
  });
});

class EchoActor extends Actor<string> {
  override onReceive(): void {}
}

/** Takes the house-style tagged object, so the labels are realistic. */
class OrderActor extends Actor<{ kind: string; id: number }> {
  override onReceive(): void {}
}

/**
 * The handler `installMethods` registers, without standing up a server.
 * Only `registerMethod` is exercised, so a stub of that one call is a
 * truer test subject than a whole `DevToolsServer`.
 */
function bufferMethod(tap: SpanTap): DevToolsRequestHandler {
  const registered = new Map<string, DevToolsRequestHandler>();
  tap.installMethods({
    registerMethod(method: string, handler: DevToolsRequestHandler) {
      registered.set(method, handler);
    },
  } as unknown as DevToolsServer);
  const handler = registered.get('tracing.buffer');
  if (handler === undefined) throw new Error('SpanTap did not register tracing.buffer');
  return handler;
}

describe('SpanTap — sender and payload', () => {
  test('carries who sent it, what it was, and the message itself', async () => {
    const system = newSystem('span-payload');
    const tap = new SpanTap(system, 100, 20);
    const payloads: DevToolsStreamPayload[] = [];
    tap.install((payload) => payloads.push(payload));
    tap.subscribersChanged(1);          // also switches payload capture on
    try {
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle(80);

      const span = spansOf(payloads).find((s) => s.actorPath?.endsWith('/orders') === true);
      expect(span).toBeDefined();
      // Not "Object" — the discriminant is the name a developer uses.
      expect(span!.messageType).toBe('place');
      expect(span!.messagePayload).toBe('{"kind":"place","id":7}');
      // A bare `tell` has no sender, and the wire says so rather than ''.
      expect(span!.senderPath).toBeNull();
    } finally {
      tap.uninstall();
    }
  });

  test('captures payloads from attach, and stops at detach', () => {
    const system = newSystem('span-payload-off');
    const tap = new SpanTap(system, 100, 20);
    const tracing = system.extension(TracingExtensionId);

    tap.install(() => {});
    // Payloads are part of what is recorded, not something the panel
    // switches on — a span kept without one is a row that cannot say
    // which message it was.
    expect(tracing.isCapturingMessagePayloads()).toBe(true);

    tap.subscribersChanged(1);
    tap.subscribersChanged(0);
    expect(tracing.isCapturingMessagePayloads()).toBe(true);

    tap.uninstall();
    expect(tracing.isCapturingMessagePayloads()).toBe(false);
  });
});
