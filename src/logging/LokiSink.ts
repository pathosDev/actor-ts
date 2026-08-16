import { BatchingSink } from './BatchingSink.js';
import { postToEndpoint, type FetchLike } from './HttpDelivery.js';
import { formatJsonLine, formatTextLine } from './LogFormat.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSinkContext } from './LogSink.js';
import { logLevelName } from './LogLevelName.js';
import {
  DEFAULT_LOKI_MIN_LEVEL,
  DEFAULT_LOKI_REQUEST_TIMEOUT_MS,
  LokiSinkOptionsValidator,
  type LokiLineFormat,
  type LokiSinkOptions,
  type LokiSinkOptionsType,
} from './LokiSinkOptions.js';
import { nanosecondsOf } from './Timestamps.js';
import { stripTrailing } from '../util/StripCharacters.js';

/**
 * Pushes records to Grafana Loki's native ingestion API.
 *
 *     const lokiSink = new LokiSink(LokiSinkOptions.create()
 *       .withUrl('http://loki:3100')
 *       .withLabels({ service: 'orders', env: 'prod' }));
 *
 * Loki accepts plain JSON as an alternative to snappy-compressed
 * protobuf, so no compression or protobuf library is involved.
 *
 * **Loki 3+ also ingests OTLP** at `/otlp/v1/logs`, which the
 * [OTLP sink](./OtlpHttpSink.ts) already speaks.  This sink exists for
 * direct push and for explicit control over the label set — which is the
 * one thing about Loki worth controlling explicitly.
 *
 * **Labels are static by construction.**  Loki's labels are its index;
 * every distinct combination is a separate stream, and a per-record value
 * in there multiplies streams without bound.  Sending an actor path as a
 * label is the standard way to make a Loki cluster unusable, so the
 * options type does not offer it: variable data goes into structured
 * metadata, which Loki stores per entry rather than indexing.
 */
export class LokiSink extends BatchingSink {
  private readonly endpoint: string;
  private readonly configuredLabels: Readonly<Record<string, string>>;
  private readonly tenantId: string | undefined;
  private readonly structuredMetadata: boolean;
  private readonly format: LokiLineFormat;
  private readonly requestTimeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchFn: FetchLike | undefined;
  private labels: Record<string, string>;

  constructor(options: LokiSinkOptions = {}) {
    const settings = validated(options);
    super('loki', settings.minLevel ?? DEFAULT_LOKI_MIN_LEVEL, settings.delivery);
    this.endpoint = `${stripTrailing(settings.url ?? '', '/')}/loki/api/v1/push`;
    this.configuredLabels = settings.labels ?? {};
    this.labels = { ...this.configuredLabels };
    this.tenantId = settings.tenantId;
    this.structuredMetadata = settings.structuredMetadata ?? true;
    this.format = settings.format ?? 'text';
    this.requestTimeoutMs = settings.requestTimeoutMs ?? DEFAULT_LOKI_REQUEST_TIMEOUT_MS;
    this.headers = settings.headers ?? {};
    this.fetchFn = settings.fetchFn;
  }

  override attach(context: LogSinkContext): void {
    super.attach(context);
    if (this.configuredLabels['service'] === undefined && context.systemName !== undefined) {
      this.labels = { service: context.systemName, ...this.configuredLabels };
    }
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    await postToEndpoint({
      url: this.endpoint,
      headers: {
        'content-type': 'application/json',
        ...(this.tenantId !== undefined ? { 'x-scope-orgid': this.tenantId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(this.pushRequestFor(records)),
      timeoutMs: this.requestTimeoutMs,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    });
  }

  /**
   * One stream carrying every record of the batch.
   *
   * All records share a stream because the labels are static — which is
   * the design, not a simplification.
   */
  private pushRequestFor(records: readonly LogRecord[]): unknown {
    return {
      streams: [{
        stream: this.labels,
        values: records.map((record) => this.valueFor(record)),
      }],
    };
  }

  private valueFor(record: LogRecord): unknown[] {
    const line = this.format === 'json' ? formatJsonLine(record) : formatTextLine(record);
    // The timestamp must be a **string** of nanoseconds: Loki answers a
    // JSON number with a 400, and the value is past what a double holds
    // exactly anyway.
    const entry: unknown[] = [nanosecondsOf(record.timestampMs), line];
    if (this.structuredMetadata) {
      const metadata = this.metadataFor(record);
      if (Object.keys(metadata).length > 0) entry.push(metadata);
    }
    return entry;
  }

  /**
   * Per-entry metadata.  Flat and all-strings: Loki flattens nested values
   * with `_` and stores metadata as string pairs, so anything else would
   * be converted on arrival and stop matching what the sender wrote.
   */
  private metadataFor(record: LogRecord): Record<string, string> {
    const metadata: Record<string, string> = { level: logLevelName(record.level) };
    if (record.source !== undefined) metadata['actor_path'] = record.source;
    if (record.displayName !== undefined) metadata['actor_name'] = record.displayName;
    for (const [key, value] of Object.entries(record.fields)) {
      metadata[key.replace(/[^a-zA-Z0-9_]/g, '_')] = String(value);
    }
    return metadata;
  }
}

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first.
 */
function validated(options: LokiSinkOptions): Partial<LokiSinkOptionsType> {
  const settings = { ...(options as Partial<LokiSinkOptionsType>) };
  new LokiSinkOptionsValidator().validate(settings);
  return settings;
}
