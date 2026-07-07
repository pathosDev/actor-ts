/**
 * OpenTelemetry SDK + Jaeger / OTLP exporter demo (#63).
 *
 *   bun examples/management/otel-jaeger.ts
 *
 * Wires the framework's tracing layer to the real `@opentelemetry/api`
 * tracer via the bundled `otelTracer` adapter.  Once installed, every
 * `onReceive` becomes a span on the user's OTel SDK and ships to
 * whichever exporter the user has configured (Jaeger, Tempo, Datadog,
 * Honeycomb, …) via OTLP.
 *
 * **Optional peer deps** — install before running:
 *
 *   npm install @opentelemetry/api \
 *               @opentelemetry/sdk-trace-node \
 *               @opentelemetry/exporter-trace-otlp-http
 *
 * Pointing at a local Jaeger:
 *
 *   docker run -d --name jaeger \
 *     -p 16686:16686 -p 4318:4318 \
 *     jaegertracing/all-in-one:latest
 *
 *   # then:  open http://localhost:16686 → search service "actor-ts-voice-demo"
 *
 * The framework instrumentation that ships with `actor-ts` produces
 * spans for: actor `onReceive` (one per message), cross-wire
 * `cluster.envelope.received` (the network hop), and
 * `cluster.envelope.sent` (the upstream side).  Trace continuity
 * across the cluster wire is automatic — the framework reads /
 * writes the W3C `traceparent` header on every envelope.
 */
import {
  Actor, ActorSystem, Props,
  TracingExtensionId,
  otelTracer, OtelAdapterOptions,
} from '../../src/index.js';

// 1. Bring up the OTel SDK with the OTLP exporter.  Loaded lazily so
//    the framework build still works without the peer deps installed.
const { api, shutdown } = await initOtel();

// 2. Wire the framework's tracing extension to the OTel API namespace.
const system = ActorSystem.create('actor-ts-voice-demo');
const otelAdapterOptions = OtelAdapterOptions.create()
  .withApi(api)
  .withTracerName('actor-ts')
  .withTracerVersion('0.2.0');
system.extension(TracingExtensionId).enable(otelTracer(otelAdapterOptions));

// 3. A toy actor that does some work — every `onReceive` becomes a span.
class Worker extends Actor<{ id: number }> {
  override async onReceive(_m: { id: number }): Promise<void> {
    await Bun.sleep(2 + Math.random() * 5);
  }
}
const worker = system.spawn(Props.create(() => new Worker()), 'worker');

let n = 0;
const tick = setInterval(() => {
  for (let i = 0; i < 5; i++) worker.tell({ id: n++ });
}, 100);

console.log('actor-ts → OTel → OTLP-HTTP exporter (default endpoint http://localhost:4318/v1/traces)');
console.log('press Ctrl+C to flush + exit');

process.on('SIGINT', async () => {
  clearInterval(tick);
  await system.terminate();
  await shutdown();   // flush spans before exit
  process.exit(0);
});

/**
 * Lazy-init the OTel SDK.  The framework adapter takes the API
 * namespace as a value, so we just hand it `import * as otel from
 * '@opentelemetry/api'` and a side-effect that installs the SDK.
 *
 * In a real app the SDK init lives at the top of `index.ts` /
 * `bootstrap.ts` and is the very first thing the process does;
 * the dynamic loading here is purely so the example runs against
 * the framework without forcing the peer deps on every reader.
 */
async function initOtel(): Promise<{ api: typeof import('@opentelemetry/api'); shutdown: () => Promise<void> }> {
  let api: typeof import('@opentelemetry/api');
  let NodeTracerProvider: typeof import('@opentelemetry/sdk-trace-node').NodeTracerProvider;
  let BatchSpanProcessor: typeof import('@opentelemetry/sdk-trace-base').BatchSpanProcessor;
  let OTLPTraceExporter: typeof import('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter;
  try {
    api = await import('@opentelemetry/api');
    ({ NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node'));
    ({ BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base'));
    ({ OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http'));
  } catch (e) {
    process.stderr.write(
      'This example needs the OpenTelemetry peer deps (optional).\n'
      + 'Install: npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http\n'
      + `Original error: ${(e as Error)?.message ?? e}\n`,
    );
    process.exit(1);
  }
  const provider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  return {
    api,
    shutdown: () => provider.shutdown(),
  };
}
