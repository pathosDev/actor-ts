/**
 * OpenTelemetry distributed-tracing demo (#10).
 *
 *   bun run examples/management/opentelemetry-tracing.ts
 *
 * This example uses the built-in `RecordingTracer` rather than the
 * full `@opentelemetry/api` SDK so it runs with no extra installs.
 * To wire a real OTel exporter (Jaeger, Tempo, OTLP, …):
 *
 *   1. `npm i @opentelemetry/api @opentelemetry/sdk-trace-node
 *      @opentelemetry/exporter-trace-otlp-http`
 *   2. Initialise the OTel SDK as you normally would.
 *   3. Write a thin adapter that implements the `Tracer` interface in
 *      this package by delegating to `trace.getTracer('actor-ts')`.
 *      Each `startSpan` becomes `tracer.startSpan(...)`; `withActiveSpan`
 *      becomes `context.with(trace.setSpan(context.active(), span), fn)`;
 *      `injectContext` / `extractContext` use
 *      `propagation.inject` / `propagation.extract` with the
 *      `W3CTraceContextPropagator`.
 *
 * The framework instruments the actor lifecycle automatically — every
 * `onReceive` becomes a span, parent/child relationships propagate
 * through tells (local + cluster wire), and `cluster.envelope.received`
 * marks the network hop.
 */
import {
  Actor,
  ActorSystem,
  Props,
  RecordingTracer,
  TracingExtensionId,
} from '../../src/index.js';

class Step extends Actor<{ name: string; next?: ActorRef<{ name: string }> }> {
  override async onReceive(m: { name: string; next?: ActorRef<{ name: string }> }): Promise<void> {
    // Pretend this step does real work — the auto-span captures the
    // duration, attributes, status, and exceptions.
    await Bun.sleep(5 + Math.random() * 10);
    if (m.next) m.next.tell({ name: `${m.name}-forwarded` });
  }
}

import type { ActorRef } from '../../src/index.js';

const tracer = new RecordingTracer();
const system = ActorSystem.create('otel-demo');
system.extension(TracingExtensionId).enable(tracer);

const step3 = system.spawn(Props.create(() => new Step()), 'step-3');
const step2 = system.spawn(Props.create(() => new Step()), 'step-2');
const step1 = system.spawn(Props.create(() => new Step()), 'step-1');

// Drive a request.  The client span is the trace root; downstream
// actor.receive spans link back through the chain step1 → step2 → step3.
const root = tracer.startSpan('client.request', {
  attributes: { 'request.id': 'req-001' },
});
tracer.withActiveSpan(root, () => {
  step1.tell({ name: 'first', next: step2 });
  // Schedule the second leg from inside the same context so it shares
  // the trace.
  setTimeout(() => {
    tracer.withActiveSpan(root, () => step2.tell({ name: 'second', next: step3 }));
  }, 30);
});

setTimeout(async () => {
  root.end();
  console.log(`recorded ${tracer.recorded().length} spans:`);
  for (const s of tracer.recorded()) {
    console.log(
      `  ${s.name.padEnd(24)} traceId=${s.context.traceId.slice(0, 8)}.. `
      + `spanId=${s.context.spanId.slice(0, 8)}.. `
      + `parent=${s.parent?.spanId.slice(0, 8) ?? '(root)     '}.. `
      + `${(s.endTimeMs - s.startTimeMs).toString().padStart(3, ' ')}ms`,
    );
  }
  await system.terminate();
}, 200);
