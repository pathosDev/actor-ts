import { LogLevel } from '../Logger.js';
import { BatchingSink } from './BatchingSink.js';
import { postToEndpoint, type FetchLike } from './HttpDelivery.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import { logLevelName } from './LogLevelName.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSinkContext } from './LogSink.js';
import {
  DEFAULT_OTLP_MIN_LEVEL,
  DEFAULT_OTLP_REQUEST_TIMEOUT_MS,
  DEFAULT_OTLP_SCOPE_NAME,
  DEFAULT_OTLP_URL,
  OtlpHttpSinkOptionsValidator,
  type OtlpHttpSinkOptions,
  type OtlpHttpSinkOptionsType,
} from './OtlpHttpSinkOptions.js';
import { nanosecondsOf } from './Timestamps.js';

/**
 * OpenTelemetry severity numbers.  The spec assigns each level a band of
 * four (DEBUG 5–8, INFO 9–12, …); the framework has one level per band, so
 * it sends the band's base value.
 */
const SEVERITY_NUMBER: Record<LogLevel, number> = {
  [LogLevel.Debug]: 5,
  [LogLevel.Info]: 9,
  [LogLevel.Warn]: 13,
  [LogLevel.Error]: 17,
  [LogLevel.Off]: 0,
};

/** An OTLP `AnyValue`, in the proto3 JSON shape. */
type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

/**
 * Ships records to any OpenTelemetry collector — and, through them or
 * directly, to most log platforms — as OTLP/HTTP with a JSON body.
 *
 *     const otlpSink = new OtlpHttpSink(OtlpHttpSinkOptions.create()
 *       .withUrl('http://collector:4318/v1/logs'));
 *
 * **Why this sink pays for itself first.**  One endpoint format reaches
 * Grafana Loki 3+, Parseable, SigNoz, Datadog, Axiom, Honeycomb, New Relic
 * and every OpenTelemetry Collector.  A native sink per platform is only
 * worth building where OTLP does not reach (Graylog accepts OTLP over gRPC
 * only) or where it loses something the platform does better itself.
 *
 * **Why it is hand-rolled rather than delegating to the OTel SDK.**  The
 * protocol is stable and the JSON encoding is specified; the JavaScript
 * logs SDK is still an experimental 0.x whose releases may break.
 * Depending on it would trade a fixed wire format for a moving library —
 * and the framework's tracing and logs-bridge adapters already take the
 * other position, accepting the user's own OTel import rather than
 * importing one.
 */
export class OtlpHttpSink extends BatchingSink {
  private readonly url: string;
  private readonly configuredServiceName: string | undefined;
  private readonly scopeName: string;
  private readonly gzip: boolean;
  private readonly requestTimeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchFn: FetchLike | undefined;
  /** Falls back to the system name once attached. */
  private serviceName: string;

  constructor(options: OtlpHttpSinkOptions = {}) {
    const settings = validated(options);
    super('otlp', settings.minLevel ?? DEFAULT_OTLP_MIN_LEVEL, settings.delivery);
    this.url = settings.url ?? DEFAULT_OTLP_URL;
    this.configuredServiceName = settings.serviceName;
    this.serviceName = settings.serviceName ?? 'actor-ts';
    this.scopeName = settings.scopeName ?? DEFAULT_OTLP_SCOPE_NAME;
    this.gzip = settings.gzip ?? false;
    this.requestTimeoutMs = settings.requestTimeoutMs ?? DEFAULT_OTLP_REQUEST_TIMEOUT_MS;
    this.headers = settings.headers ?? {};
    this.fetchFn = settings.fetchFn;
  }

  override attach(context: LogSinkContext): void {
    super.attach(context);
    // `service.name` is what every backend groups by, so it should say what
    // the service is called rather than what the library is called.
    if (this.configuredServiceName === undefined && context.systemName !== undefined) {
      this.serviceName = context.systemName;
    }
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    await postToEndpoint({
      url: this.url,
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(this.exportRequestFor(records)),
      timeoutMs: this.requestTimeoutMs,
      gzip: this.gzip,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    });
  }

  /** The `ExportLogsServiceRequest` body, in proto3 JSON. */
  private exportRequestFor(records: readonly LogRecord[]): unknown {
    return {
      resourceLogs: [{
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: this.serviceName } }],
        },
        scopeLogs: [{
          scope: { name: this.scopeName },
          logRecords: records.map((record) => this.logRecordFor(record)),
        }],
      }],
    };
  }

  private logRecordFor(record: LogRecord): unknown {
    const nanos = nanosecondsOf(record.timestampMs);
    return {
      timeUnixNano: nanos,
      observedTimeUnixNano: nanos,
      severityNumber: SEVERITY_NUMBER[record.level],
      severityText: logLevelName(record.level).toUpperCase(),
      body: { stringValue: record.message },
      attributes: this.attributesFor(record),
    };
  }

  private attributesFor(record: LogRecord): OtlpKeyValue[] {
    const attributes: OtlpKeyValue[] = [];
    if (record.source !== undefined) {
      attributes.push({ key: 'actor.path', value: { stringValue: record.source } });
    }
    if (record.displayName !== undefined) {
      attributes.push({ key: 'actor.name', value: { stringValue: record.displayName } });
    }
    for (const [key, value] of Object.entries(record.fields)) {
      attributes.push({ key, value: anyValueOf(value) });
    }
    if (record.args !== undefined && record.args.length > 0) {
      // OTLP's array/kvlist values exist, but a log argument is arbitrary
      // and would need a recursive encoder for one field; a JSON string
      // stays queryable in every backend and cannot fail to encode.
      attributes.push({
        key: 'args',
        value: { stringValue: safeJson(record.args.map(normaliseArg)) },
      });
    }
    return attributes;
  }
}

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first, and the base class should not build a
 * queue for options that turn out to be invalid.
 */
function validated(options: OtlpHttpSinkOptions): Partial<OtlpHttpSinkOptionsType> {
  const settings = { ...(options as Partial<OtlpHttpSinkOptionsType>) };
  new OtlpHttpSinkOptionsValidator().validate(settings);
  return settings;
}

/**
 * Map a field value onto OTLP's `AnyValue` union.  Integers go as
 * `intValue` — a **string**, since proto3 JSON encodes 64-bit integers
 * that way to survive JavaScript's number precision.
 */
function anyValueOf(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, jsonSafeReplacer()) ?? '[]';
  } catch {
    return '[]';
  }
}
