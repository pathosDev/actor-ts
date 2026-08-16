import { BatchingSink } from './BatchingSink.js';
import { postToEndpoint, type FetchLike } from './HttpDelivery.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import { logLevelName } from './LogLevelName.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSinkContext } from './LogSink.js';
import {
  DEFAULT_SPLUNK_MIN_LEVEL,
  DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS,
  DEFAULT_SPLUNK_SOURCE,
  DEFAULT_SPLUNK_SOURCETYPE,
  SplunkSinkOptionsValidator,
  type SplunkSinkOptions,
  type SplunkSinkOptionsType,
} from './SplunkSinkOptions.js';
import { stripTrailing } from '../util/StripCharacters.js';

/**
 * Ships records to Splunk's HTTP Event Collector.
 *
 *     const splunkSink = new SplunkSink(SplunkSinkOptions.create()
 *       .withUrl('https://splunk.internal:8088')
 *       .withToken(process.env['SPLUNK_HEC_TOKEN']!));
 *
 * A token-authenticated JSON endpoint — no SDK, and nothing to negotiate.
 */
export class SplunkSink extends BatchingSink {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly index: string | undefined;
  private readonly source: string;
  private readonly sourcetype: string;
  private readonly configuredHostName: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike | undefined;
  private hostName: string | undefined;

  constructor(options: SplunkSinkOptions = {}) {
    const settings = validated(options);
    super('splunk', settings.minLevel ?? DEFAULT_SPLUNK_MIN_LEVEL, settings.delivery);
    this.endpoint = `${stripTrailing(settings.url ?? '', '/')}/services/collector/event`;
    this.token = settings.token ?? '';
    this.index = settings.index;
    this.source = settings.source ?? DEFAULT_SPLUNK_SOURCE;
    this.sourcetype = settings.sourcetype ?? DEFAULT_SPLUNK_SOURCETYPE;
    this.configuredHostName = settings.hostName;
    this.hostName = settings.hostName;
    this.requestTimeoutMs = settings.requestTimeoutMs ?? DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS;
    this.fetchFn = settings.fetchFn;
  }

  override attach(context: LogSinkContext): void {
    super.attach(context);
    if (this.configuredHostName === undefined && context.systemName !== undefined) {
      this.hostName = context.systemName;
    }
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    await postToEndpoint({
      url: this.endpoint,
      headers: {
        'content-type': 'application/json',
        authorization: `Splunk ${this.token}`,
      },
      // Concatenated JSON objects, not an array.  Newer Splunk versions
      // accept an array too, but back-to-back objects are the batch format
      // every version understands, and the difference is one join.
      body: records.map((record) => this.envelopeFor(record)).join(''),
      timeoutMs: this.requestTimeoutMs,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    });
  }

  private envelopeFor(record: LogRecord): string {
    const envelope: Record<string, unknown> = {
      // Epoch seconds with millisecond precision, as HEC documents.
      time: record.timestampMs / 1_000,
      ...(this.hostName !== undefined ? { host: this.hostName } : {}),
      source: this.source,
      sourcetype: this.sourcetype,
      ...(this.index !== undefined ? { index: this.index } : {}),
      event: {
        level: logLevelName(record.level),
        message: record.message,
        ...(record.source !== undefined ? { actorPath: record.source } : {}),
        ...(record.displayName !== undefined ? { actorName: record.displayName } : {}),
        ...(record.args !== undefined && record.args.length > 0
          ? { args: record.args.map(normaliseArg) }
          : {}),
      },
    };
    const fields = flatFieldsOf(record);
    if (Object.keys(fields).length > 0) envelope['fields'] = fields;

    try {
      return JSON.stringify(envelope, jsonSafeReplacer());
    } catch {
      return JSON.stringify({
        time: envelope['time'],
        source: this.source,
        sourcetype: this.sourcetype,
        event: { level: logLevelName(record.level), message: record.message },
      });
    }
  }
}

/**
 * Indexed fields, as a **flat** object.
 *
 * HEC rejects a nested value under `fields`, and the key only works on the
 * `/event` endpoint at all — which is why this sink never uses `/raw`.
 * Values are stringified rather than dropped: an indexed field that
 * silently disappears is worse than one that reads `[object]`.
 */
function flatFieldsOf(record: LogRecord): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    fields[key] = typeof value === 'string' ? value : String(value);
  }
  return fields;
}

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first.
 */
function validated(options: SplunkSinkOptions): Partial<SplunkSinkOptionsType> {
  const settings = { ...(options as Partial<SplunkSinkOptionsType>) };
  new SplunkSinkOptionsValidator().validate(settings);
  return settings;
}
