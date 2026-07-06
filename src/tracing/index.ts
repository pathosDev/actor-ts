export type {
  Tracer,
  Span,
  SpanContext,
  SpanOptions,
  SpanKind,
  SpanStatus,
  AttributeValue,
  TraceCarrier,
} from './Tracer.js';
export {
  encodeTraceparent,
  decodeTraceparent,
  newTraceId,
  newSpanId,
} from './Tracer.js';
export { NoopTracer, NOOP_TRACER } from './NoopTracer.js';
export { RecordingTracer } from './RecordingTracer.js';
export type {
  RecordedSpan,
  RecordingTracerOptions,
} from './RecordingTracer.js';
export {
  TracingExtension,
  TracingExtensionId,
  tracerOf,
} from './TracingExtension.js';
export { otelTracer, OtelAdapterOptions } from './OtelAdapter.js';
export type {
  OtelAdapterSettings,
  OtelApiLike,
  OtelContextApi,
  OtelContextLike,
  OtelPropagationApi,
  OtelSpanContextLike,
  OtelSpanLike,
  OtelTraceApi,
  OtelTracerLike,
} from './OtelAdapter.js';
export { otelLogger } from './OtelLogsAdapter.js';
export type {
  OtelLoggerAdapterOptions,
  OtelLogsApiLike,
  OtelLoggerProviderLike,
  OtelLoggerLike,
  OtelLogRecord,
  OtelSeverityNumber,
} from './OtelLogsAdapter.js';
