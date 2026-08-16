import { BatchingSink } from './BatchingSink.js';
import { basicAuthorization, postToEndpoint, type FetchLike } from './HttpDelivery.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import { logLevelName } from './LogLevelName.js';
import type { LogRecord } from './LogRecord.js';
import {
  DEFAULT_PARSEABLE_MIN_LEVEL,
  DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS,
  PARSEABLE_MAX_REQUEST_BYTES,
  ParseableSinkOptionsValidator,
  type ParseableSinkOptions,
  type ParseableSinkOptionsType,
} from './ParseableSinkOptions.js';
import { stripTrailing } from '../util/StripCharacters.js';

/**
 * Ships records to Parseable over its REST ingestion API.
 *
 *     const parseableSink = new ParseableSink(ParseableSinkOptions.create()
 *       .withUrl('https://parseable.internal')
 *       .withStream('app-logs')
 *       .withApiKey(process.env['PARSEABLE_KEY']!));
 *
 * No SDK exists and none is needed: a batch is a JSON array POSTed to
 * `/api/v1/ingest`, with the target dataset in the `X-P-Stream` header.
 * Parseable creates the dataset on first use.
 *
 * **Records are sent flat.**  Parseable flattens nested objects at ingest
 * anyway, so sending `{ timestamp, level, message, ...fields }` keeps every
 * field individually queryable and skips a round of server-side
 * rewriting — which is also why field names take precedence rules rather
 * than being nested under a prefix.
 *
 * Parseable also accepts OTLP/HTTP with a JSON body, so
 * [`OtlpHttpSink`](./OtlpHttpSink.ts) reaches it too.  This sink exists for
 * the simpler record shape and for deployments that do not want OTLP
 * semantics in the way.
 */
export class ParseableSink extends BatchingSink {
  private readonly endpoint: string;
  private readonly stream: string;
  private readonly authorization: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike | undefined;

  constructor(options: ParseableSinkOptions = {}) {
    const settings = validated(options);
    super('parseable', settings.minLevel ?? DEFAULT_PARSEABLE_MIN_LEVEL, settings.delivery);
    this.endpoint = `${stripTrailing(settings.url ?? '', '/')}/api/v1/ingest`;
    this.stream = settings.stream ?? 'actor-ts';
    this.authorization = settings.apiKey !== undefined
      ? { 'x-api-key': settings.apiKey }
      : settings.username !== undefined
        ? { authorization: basicAuthorization(settings.username, settings.password ?? '') }
        : {};
    this.requestTimeoutMs = settings.requestTimeoutMs ?? DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS;
    this.fetchFn = settings.fetchFn;
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    for (const body of requestBodiesFor(records)) {
      await postToEndpoint({
        url: this.endpoint,
        headers: {
          'content-type': 'application/json',
          'x-p-stream': this.stream,
          ...this.authorization,
        },
        body,
        timeoutMs: this.requestTimeoutMs,
        ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
      });
    }
  }
}

/**
 * Split a batch into request bodies no larger than Parseable accepts.
 *
 * The cap matters because exceeding it is **not** a retryable failure: the
 * server rejects the request outright, so an oversized batch would be
 * dropped in full.  Splitting turns that into two requests.
 *
 * A single record that cannot fit alone is sent anyway — refusing it here
 * would silently lose it, and letting the server judge produces a reported
 * rejection naming the record.
 */
export function requestBodiesFor(records: readonly LogRecord[]): string[] {
  const documents = records.map((record) => encodeRecord(record));
  const bodies: string[] = [];
  let current: string[] = [];
  // Two brackets plus one comma per document beyond the first.
  let size = 2;

  for (const document of documents) {
    const cost = document.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && size + cost > PARSEABLE_MAX_REQUEST_BYTES) {
      bodies.push(`[${current.join(',')}]`);
      current = [];
      size = 2;
    }
    current.push(document);
    size += cost;
  }
  if (current.length > 0) bodies.push(`[${current.join(',')}]`);
  return bodies;
}

/**
 * One record as a flat JSON object.
 *
 * `timestamp` is RFC 3339, which is what Parseable's docs ask for;
 * the server adds its own `p_timestamp` for arrival time regardless.
 */
function encodeRecord(record: LogRecord): string {
  const flat: Record<string, unknown> = {
    timestamp: new Date(record.timestampMs).toISOString(),
    level: logLevelName(record.level),
    ...(record.source !== undefined ? { source: record.source } : {}),
    message: record.message,
    ...record.fields,
  };
  if (record.args !== undefined && record.args.length > 0) {
    flat['args'] = record.args.map(normaliseArg);
  }
  try {
    return JSON.stringify(flat, jsonSafeReplacer());
  } catch {
    return JSON.stringify({
      timestamp: flat['timestamp'],
      level: flat['level'],
      message: flat['message'],
    });
  }
}

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first.
 */
function validated(options: ParseableSinkOptions): Partial<ParseableSinkOptionsType> {
  const settings = { ...(options as Partial<ParseableSinkOptionsType>) };
  new ParseableSinkOptionsValidator().validate(settings);
  return settings;
}
