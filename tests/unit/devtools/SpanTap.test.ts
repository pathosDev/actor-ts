import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { tracerOf } from '../../../src/tracing/TracingExtension.js';
import { SpanTap } from '../../../src/devtools/taps/SpanTap.js';
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
