import { LogLevel } from '../Logger.js';
import { BatchingSink } from './BatchingSink.js';
import { postToEndpoint, type FetchLike } from './HttpDelivery.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import type { LogRecord } from './LogRecord.js';
import {
  DEFAULT_SEQ_MIN_LEVEL,
  DEFAULT_SEQ_REQUEST_TIMEOUT_MS,
  SEQ_CLEF_CONTENT_TYPE,
  SeqSinkOptionsValidator,
  type SeqSinkOptions,
  type SeqSinkOptionsType,
} from './SeqSinkOptions.js';
import { stripTrailing } from '../util/StripCharacters.js';

/**
 * CLEF level names.  Seq requires a **string** here, and it uses Serilog's
 * vocabulary — `Information`, not `Info`, which is the one value everybody
 * gets wrong on the first attempt.
 */
const CLEF_LEVEL: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'Debug',
  [LogLevel.Info]: 'Information',
  [LogLevel.Warn]: 'Warning',
  [LogLevel.Error]: 'Error',
  [LogLevel.Off]: 'Information',
};

/**
 * Ships records to Seq as CLEF — newline-delimited JSON with `@`-prefixed
 * reserved keys.
 *
 *     const seqSink = new SeqSink(SeqSinkOptions.create()
 *       .withUrl('http://seq:5341')
 *       .withApiKey(process.env['SEQ_API_KEY']!));
 *
 * The cheapest sink in the set: CLEF is the NDJSON the framework already
 * emits with four keys renamed, so there is nothing to translate beyond
 * the reserved names.
 */
export class SeqSink extends BatchingSink {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike | undefined;

  constructor(options: SeqSinkOptions = {}) {
    const settings = validated(options);
    super('seq', settings.minLevel ?? DEFAULT_SEQ_MIN_LEVEL, settings.delivery);
    this.endpoint = `${stripTrailing(settings.url ?? '', '/')}/ingest/clef`;
    this.apiKey = settings.apiKey;
    this.requestTimeoutMs = settings.requestTimeoutMs ?? DEFAULT_SEQ_REQUEST_TIMEOUT_MS;
    this.fetchFn = settings.fetchFn;
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    await postToEndpoint({
      url: this.endpoint,
      headers: {
        'content-type': SEQ_CLEF_CONTENT_TYPE,
        ...(this.apiKey !== undefined ? { 'x-seq-apikey': this.apiKey } : {}),
      },
      body: records.map((record) => clefDocumentFor(record)).join('\n'),
      timeoutMs: this.requestTimeoutMs,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    });
  }
}

/**
 * One CLEF document.
 *
 * `@t` (timestamp) and `@l` (level) are reserved; so is every other
 * `@`-prefixed key.  A user field starting with `@` is escaped by doubling
 * the sigil — CLEF's own rule — so a field named `@t` arriving over the
 * cluster wire cannot forge the record's timestamp.
 */
export function clefDocumentFor(record: LogRecord): string {
  const document: Record<string, unknown> = {
    '@t': new Date(record.timestampMs).toISOString(),
    '@m': record.message,
    '@l': CLEF_LEVEL[record.level],
  };
  const error = record.args?.find((argument): argument is Error => argument instanceof Error);
  if (error !== undefined) document['@x'] = error.stack ?? `${error.name}: ${error.message}`;
  if (record.source !== undefined) document['source'] = record.source;
  if (record.displayName !== undefined) document['displayName'] = record.displayName;
  for (const [key, value] of Object.entries(record.fields)) {
    document[escapeReserved(key)] = value;
  }
  const rest = record.args?.filter((argument) => !(argument instanceof Error)) ?? [];
  if (rest.length > 0) document['args'] = rest.map(normaliseArg);

  try {
    return JSON.stringify(document, jsonSafeReplacer());
  } catch {
    return JSON.stringify({ '@t': document['@t'], '@m': document['@m'], '@l': document['@l'] });
  }
}

/**
 * CLEF escapes a property name that would look reserved by doubling the
 * leading `@`.  Without it, a field named `@l` would silently become the
 * event's level.
 */
function escapeReserved(key: string): string {
  return key.startsWith('@') ? `@${key}` : key;
}

/**
 * Spread and validate before `super()` — a derived constructor cannot run
 * `this`-touching statements first.
 */
function validated(options: SeqSinkOptions): Partial<SeqSinkOptionsType> {
  const settings = { ...(options as Partial<SeqSinkOptionsType>) };
  new SeqSinkOptionsValidator().validate(settings);
  return settings;
}
