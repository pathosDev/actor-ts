import { LogLevel } from '../Logger.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import type { LogRecord } from './LogRecord.js';

/**
 * Turning a {@link LogRecord} into a GELF 1.1 message.
 *
 * Kept apart from the transports because all three of them — UDP, TCP and
 * HTTP — send the identical JSON document and differ only in how they
 * frame it.
 */

/**
 * Syslog severities, which GELF's `level` field uses.  The framework's
 * four levels map onto the four an operator actually filters on; `Off`
 * never reaches a sink and is mapped only for exhaustiveness.
 */
const SYSLOG_LEVEL: Record<LogLevel, number> = {
  [LogLevel.Debug]: 7,
  [LogLevel.Info]: 6,
  [LogLevel.Warn]: 4,
  [LogLevel.Error]: 3,
  [LogLevel.Off]: 7,
};

/**
 * Characters GELF allows in an additional-field name.  Anything else is
 * replaced rather than rejected: a record must not be lost because a
 * field name has a space in it.
 */
const ILLEGAL_FIELD_CHARACTERS = /[^\w.\-]/g;

/**
 * Field names GELF reserves or forbids.
 *
 * `_id` is explicitly forbidden by the spec.  The rest are the top-level
 * keys the message already defines: a field that collided with one of them
 * would overwrite the timestamp, the level or the message itself — and a
 * field can arrive over the cluster wire from a remote peer (#573), so
 * this is a trust boundary, not a tidiness rule.
 */
const RESERVED_FIELD_NAMES = new Set(['id']);
const RESERVED_TOP_LEVEL = new Set([
  'version', 'host', 'short_message', 'full_message', 'timestamp', 'level',
]);

/**
 * Build the GELF document for a record.
 *
 * `short_message` is the first line and `full_message` carries the rest
 * plus the first `Error`'s stack, which is what Graylog's UI expects: the
 * list shows short messages, the detail view shows the full one.
 */
export function gelfPayloadFor(record: LogRecord, hostName: string): Record<string, unknown> {
  const [firstLine, ...restOfMessage] = record.message.split('\n');
  const detail = [restOfMessage.join('\n'), stackOf(record.args)].filter((part) => part !== '').join('\n');

  const payload: Record<string, unknown> = {
    version: '1.1',
    host: hostName,
    short_message: firstLine === '' ? '(empty)' : firstLine,
    ...(detail !== '' ? { full_message: detail } : {}),
    // GELF timestamps are epoch *seconds* with a fractional part.
    timestamp: record.timestampMs / 1_000,
    level: SYSLOG_LEVEL[record.level],
  };

  if (record.source !== undefined) payload['_source'] = record.source;
  if (record.displayName !== undefined) payload['_display_name'] = record.displayName;
  for (const [key, value] of Object.entries(record.fields)) {
    const name = additionalFieldName(key);
    if (name === undefined) continue;
    payload[name] = value;
  }
  if (record.args !== undefined && record.args.length > 0) {
    payload['_args'] = safeJson(record.args.map(normaliseArg));
  }
  return payload;
}

/**
 * The `_`-prefixed name a field is sent under, or `undefined` when it must
 * be dropped.
 *
 * Sanitising rather than rejecting keeps a record with an awkward field
 * name; dropping is reserved for the two cases where sending the field
 * would corrupt the message — the forbidden `_id`, and a name that would
 * land on one of GELF's own top-level keys.
 */
export function additionalFieldName(key: string): string | undefined {
  const cleaned = key.replace(ILLEGAL_FIELD_CHARACTERS, '_');
  if (cleaned === '' || RESERVED_FIELD_NAMES.has(cleaned)) return undefined;
  if (RESERVED_TOP_LEVEL.has(cleaned)) return undefined;
  return `_${cleaned}`;
}

/** Serialise a payload, never throwing on an exotic value. */
export function encodeGelf(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, jsonSafeReplacer());
  } catch {
    return JSON.stringify({
      version: payload['version'],
      host: payload['host'],
      short_message: payload['short_message'],
      timestamp: payload['timestamp'],
      level: payload['level'],
    });
  }
}

function stackOf(args: readonly unknown[] | undefined): string {
  const error = args?.find((arg): arg is Error => arg instanceof Error);
  return error?.stack ?? '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, jsonSafeReplacer()) ?? '[]';
  } catch {
    return '[]';
  }
}
