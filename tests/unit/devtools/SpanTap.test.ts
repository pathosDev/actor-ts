import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { tracerOf } from '../../../src/tracing/TracingExtension.js';
import { SpanTap } from '../../../src/devtools/taps/SpanTap.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';
import { Actor } from '../../../src/Actor.js';
import { Props } from '../../../src/Props.js';
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

  test('gives a new subscriber nothing rather than a stale trace', () => {
    // A flame graph is built from spans recorded while you watch;
    // replaying an older buffer shows a trace you cannot correlate.
    const system = newSystem('span-snapshot');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    try {
      tracerOf(system).startSpan('before').end();
      expect(tap.snapshot()).toEqual([]);
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
  test('an ordinary tell records nothing until recording is switched on', async () => {
    const system = newSystem('span-record');
    const tap = new SpanTap(system, 100, 20);
    const payloads: DevToolsStreamPayload[] = [];
    tap.install((payload) => payloads.push(payload));
    tap.subscribersChanged(1);
    try {
      const ref = system.spawn(Props.create(() => new EchoActor()), 'echo');

      // The framework is propagate-only: no active span, no trace.
      ref.tell('quiet');
      await settle(80);
      expect(spansOf(payloads)).toHaveLength(0);

      await recordMethod(tap)({ enabled: true });
      ref.tell('loud');
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

  test('closing the panel stops recording — a walked-away tab must not trace forever', async () => {
    const system = newSystem('span-record-stop');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    tap.subscribersChanged(1);
    try {
      await recordMethod(tap)({ enabled: true });
      expect(system.extension(TracingExtensionId).isRecordingRootSpans()).toBe(true);

      tap.subscribersChanged(0);
      expect(system.extension(TracingExtensionId).isRecordingRootSpans()).toBe(false);
    } finally {
      tap.uninstall();
    }
  });

  test('detaching leaves the system as it was found', async () => {
    const system = newSystem('span-record-detach');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    tap.subscribersChanged(1);
    await recordMethod(tap)({ enabled: true });

    tap.uninstall();
    expect(system.extension(TracingExtensionId).isRecordingRootSpans()).toBe(false);
    expect(system.extension(TracingExtensionId).isEnabled()).toBe(false);
  });

  test('rejects a request that is not a boolean', async () => {
    const system = newSystem('span-record-bad');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    try {
      await expect(recordMethod(tap)({ enabled: 'yes' })).rejects.toThrow('must be a boolean');
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
function recordMethod(tap: SpanTap): DevToolsRequestHandler {
  const registered = new Map<string, DevToolsRequestHandler>();
  tap.installMethods({
    registerMethod(method: string, handler: DevToolsRequestHandler) {
      registered.set(method, handler);
    },
  } as unknown as DevToolsServer);
  const handler = registered.get('tracing.record');
  if (handler === undefined) throw new Error('SpanTap did not register tracing.record');
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
      await recordMethod(tap)({ enabled: true });
      const ref = system.spawn(Props.create(() => new OrderActor()), 'orders');
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

  test('stops capturing payloads when nobody is watching', async () => {
    const system = newSystem('span-payload-off');
    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    const tracing = system.extension(TracingExtensionId);

    tap.subscribersChanged(1);
    expect(tracing.isCapturingMessagePayloads()).toBe(true);

    tap.subscribersChanged(0);
    expect(tracing.isCapturingMessagePayloads()).toBe(false);

    tap.subscribersChanged(1);
    tap.uninstall();
    expect(tracing.isCapturingMessagePayloads()).toBe(false);
  });
});
