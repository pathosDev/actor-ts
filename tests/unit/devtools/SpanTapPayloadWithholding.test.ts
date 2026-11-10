/**
 * #1420 — DevTools must not push message bodies into someone else's backend.
 *
 * Attaching switches `captureMessagePayloads` on system-wide, and on a system
 * that was already exporting, the {@link TeeTracer} handed every span — body
 * included — to the tracer that was there first.  The operator never asked for
 * that: they asked for a flame graph in their browser.
 *
 * The fix is a withheld-attribute list on the tee rather than an option: the
 * panel keeps its Payload column, the docs sentence and
 * `SpanTap.test.ts`'s "captures payloads from attach" assertion stay true, and
 * nothing leaves the process because DevTools attached.
 *
 * Both halves are pinned here — the tee mechanism on its own, and the
 * consequence through a real `SpanTap` — because the mechanism is only ever
 * reachable through the tap: `TeeTracer` is not exported from the package, and
 * its third constructor argument exists for exactly this caller.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { NoopLogger, type Logger } from '../../../src/Logger.js';
import { RecordingTracer, type RecordedSpan } from '../../../src/tracing/RecordingTracer.js';
import { TeeTracer } from '../../../src/tracing/TeeTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { SpanTap } from '../../../src/devtools/taps/SpanTap.js';
import { Actor } from '../../../src/Actor.js';
import type { DevToolsStreamPayload, SpanBatchPayload } from '../../../src/devtools/protocol/index.js';

/** The attribute the whole unit is about, spelled once. */
const PAYLOAD_ATTRIBUTE = 'actor.message.payload';

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string, logger: Logger = new NoopLogger()): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(logger);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/**
 * Give the tap time to emit whatever the exchange above produced.
 *
 * A fixed delay and not `awaitCondition`, for the reason `SpanTap.test.ts`
 * gives: the assertions here are absences, and a predicate over an
 * already-empty array is true at t = 0.
 */
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function spansOf(payloads: ReadonlyArray<DevToolsStreamPayload>) {
  return payloads
    .filter((p): p is SpanBatchPayload => p.kind === 'span-batch')
    .flatMap((p) => p.spans);
}

class OrderActor extends Actor<{ kind: string; id: number }> {
  override onReceive(): void {}
}

function tee(withheld?: ReadonlySet<string>): {
  inner: RecordingTracer;
  tracer: TeeTracer;
  observed: RecordedSpan[];
} {
  const inner = new RecordingTracer();
  const observed: RecordedSpan[] = [];
  const tracer = withheld === undefined
    ? new TeeTracer(inner, (span) => observed.push(span))
    : new TeeTracer(inner, (span) => observed.push(span), withheld);
  return { inner, tracer, observed };
}

describe('TeeTracer — withheld attributes', () => {
  test('a withheld initial attribute reaches the observer and not the inner tracer', () => {
    const { inner, tracer, observed } = tee(new Set([PAYLOAD_ATTRIBUTE]));
    tracer.startSpan('actor.receive', {
      attributes: { 'actor.path': '/user/orders', [PAYLOAD_ATTRIBUTE]: '{"kind":"place"}' },
    }).end();

    expect(observed[0]!.attributes[PAYLOAD_ATTRIBUTE]).toBe('{"kind":"place"}');
    expect(inner.recorded()[0]!.attributes[PAYLOAD_ATTRIBUTE]).toBeUndefined();
    // Withholding is per key, not per span: everything else still goes through.
    expect(inner.recorded()[0]!.attributes['actor.path']).toBe('/user/orders');
  });

  test('a withheld attribute set after the fact is withheld too', () => {
    // `ActorCell` writes the payload into the initial bag, but `setAttribute`
    // is the other door into the same span and a filter on one of them is not
    // a filter.
    const { inner, tracer, observed } = tee(new Set([PAYLOAD_ATTRIBUTE]));
    const span = tracer.startSpan('actor.receive');
    span.setAttribute(PAYLOAD_ATTRIBUTE, '{"kind":"place"}');
    span.setAttribute('actor.message.type', 'place');
    span.end();

    expect(observed[0]!.attributes[PAYLOAD_ATTRIBUTE]).toBe('{"kind":"place"}');
    expect(inner.recorded()[0]!.attributes[PAYLOAD_ATTRIBUTE]).toBeUndefined();
    expect(inner.recorded()[0]!.attributes['actor.message.type']).toBe('place');
  });

  test('with nothing withheld the tee is transparent, as it always was', () => {
    // The default has to stay the old behaviour: every other caller of the tee
    // — and every `SpanTap` attaching to a system that already captures
    // payloads for itself — depends on it.
    const { inner, tracer } = tee();
    tracer.startSpan('actor.receive', {
      attributes: { [PAYLOAD_ATTRIBUTE]: '{"kind":"place"}' },
    }).end();
    expect(inner.recorded()[0]!.attributes[PAYLOAD_ATTRIBUTE]).toBe('{"kind":"place"}');
  });

  test('withholding does not disturb the span identity the two sides share', () => {
    // The filtered options are a copy; a copy that dropped `parent` or `kind`
    // would silently re-root every span the exporter sees.
    const { inner, tracer, observed } = tee(new Set([PAYLOAD_ATTRIBUTE]));
    const outer = tracer.startSpan('outer', { kind: 'server' });
    tracer.withActiveSpan(outer, () => {
      tracer.startSpan('inner', { attributes: { [PAYLOAD_ATTRIBUTE]: 'x' } }).end();
    });
    outer.end();

    const innerRecorded = inner.recorded().find((span) => span.name === 'inner')!;
    const outerRecorded = inner.recorded().find((span) => span.name === 'outer')!;
    expect(innerRecorded.parent!.spanId).toBe(outerRecorded.context.spanId);
    expect(outerRecorded.kind).toBe('server');
    expect(observed.find((span) => span.name === 'inner')!.context.spanId)
      .toBe(innerRecorded.context.spanId);
  });
});

describe('SpanTap — the pre-existing exporter never receives message bodies', () => {
  test('a tracer that was already there keeps exporting spans, without the body', async () => {
    const system = newSystem('span-withhold-exporter');
    const exporter = new RecordingTracer();
    system.extension(TracingExtensionId).enable(exporter);

    const payloads: DevToolsStreamPayload[] = [];
    const tap = new SpanTap(system, 100, 20);
    tap.install((payload) => payloads.push(payload));
    tap.subscribersChanged(1);
    try {
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle();

      // The exporter is still doing its job — this is a tee, not a takeover.
      const exported = exporter.recorded()
        .filter((span) => span.attributes['actor.path']?.toString().endsWith('/orders') === true);
      expect(exported.length).toBeGreaterThan(0);
      // And not one of its spans carries the message body.
      expect(exported.filter((span) => span.attributes[PAYLOAD_ATTRIBUTE] !== undefined))
        .toHaveLength(0);

      // The panel still has its Payload column — that is the whole point of
      // withholding on the tee rather than switching capture off.
      const row = spansOf(payloads).find((s) => s.actorPath?.endsWith('/orders') === true);
      expect(row).toBeDefined();
      expect(row!.messagePayload).toBe('{"kind":"place","id":7}');
    } finally {
      tap.uninstall();
    }
  });

  test('a capture the application asked for itself is not withheld from it', async () => {
    // The narrow half of the rule.  Withholding whenever a tee exists would
    // take away an export the operator configured deliberately — DevTools
    // only declines to *add* one.
    const system = newSystem('span-withhold-operator-capture');
    const tracing = system.extension(TracingExtensionId);
    const exporter = new RecordingTracer();
    tracing.enable(exporter);
    tracing.captureMessagePayloads(true);

    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    try {
      const ref = system.spawn(OrderActor, 'orders');
      ref.tell({ kind: 'place', id: 7 });
      await settle();

      const exported = exporter.recorded()
        .filter((span) => span.attributes[PAYLOAD_ATTRIBUTE] !== undefined);
      expect(exported.length).toBeGreaterThan(0);
    } finally {
      tap.uninstall();
    }
  });

  test('the system-wide switch still reads as on, which is why the log says so', () => {
    // Withholding is a property of the tee, not of the capture: everything
    // downstream of `TracingExtension` — the panel, an application's own
    // reading of the flag — still sees capture enabled.  An operator whose
    // APM stops showing the attribute has no other way to find out why.
    const system = newSystem('span-withhold-switch-still-on');
    const tracing = system.extension(TracingExtensionId);
    tracing.enable(new RecordingTracer());

    const tap = new SpanTap(system, 100, 20);
    tap.install(() => {});
    try {
      expect(tracing.isCapturingMessagePayloads()).toBe(true);
    } finally {
      tap.uninstall();
    }
  });
});
