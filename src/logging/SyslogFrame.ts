import { LogLevel } from '../Logger.js';
import { formatTextLine } from './LogFormat.js';
import type { LogRecord } from './LogRecord.js';

/**
 * RFC 5424 message construction, kept apart from the transports because
 * the frame is a fixed textual layout — the kind of thing worth asserting
 * character for character without a socket in the test.
 */

/** Syslog severities.  Same mapping the GELF sink uses; both come from RFC 5424. */
const SEVERITY: Record<LogLevel, number> = {
  [LogLevel.Debug]: 7,
  [LogLevel.Info]: 6,
  [LogLevel.Warn]: 4,
  [LogLevel.Error]: 3,
  [LogLevel.Off]: 7,
};

/**
 * `local0`.  The `local0`–`local7` range is the one reserved for
 * applications; everything below it belongs to the system (kernel, mail,
 * cron), where an application's records would be misfiled.
 */
export const DEFAULT_SYSLOG_FACILITY = 16;

/** RFC 5424's placeholder for a field with no value. */
const NIL = '-';

/**
 * Longest value RFC 5424 allows for `APP-NAME` and `HOSTNAME`.
 *
 * A receiver is entitled to truncate beyond it, and a truncated hostname
 * is worse than a shortened one: it splits one sender's records across two
 * apparent origins.
 */
const MAX_APP_NAME = 48;
const MAX_HOST_NAME = 255;

/** How a message is delimited on a stream transport. */
export type SyslogFraming = 'octet-counting' | 'lf';

export type SyslogFrameParts = {
  readonly facility: number;
  readonly hostName: string;
  readonly appName: string;
  readonly processId: string;
};

/**
 * Build the RFC 5424 message for a record:
 *
 *     <134>1 2026-08-12T09:41:02.113Z web-01 orders 1234 - - placing order {tenant=acme}
 *
 * **The structured-data element is deliberately `-`.**  A well-formed
 * `SD-ID` needs an IANA private enterprise number, which this project does
 * not have; inventing one would put records under somebody else's
 * identifier.  The record's fields are appended to `MSG` in the same
 * `{k=v}` form the text formatter uses, so nothing is lost — it is just
 * not machine-parsed by the receiver.
 */
export function syslogMessageFor(record: LogRecord, parts: SyslogFrameParts): string {
  const priority = parts.facility * 8 + SEVERITY[record.level];
  const timestamp = new Date(record.timestampMs).toISOString();
  const message = messageTextOf(record);
  return `<${priority}>1 ${timestamp} ${nilOr(parts.hostName, MAX_HOST_NAME)}`
    + ` ${nilOr(parts.appName, MAX_APP_NAME)} ${nilOr(parts.processId, 128)} ${NIL} ${NIL} ${message}`;
}

/**
 * Wrap a message for a stream transport.
 *
 * `octet-counting` (RFC 6587) prefixes the byte length, which is the only
 * framing that survives a message containing a newline — and a stack trace
 * always does.  `lf` exists because some receivers only accept that, and
 * it therefore has to strip the newlines it cannot represent.
 */
export function frameForStream(message: string, framing: SyslogFraming): string {
  if (framing === 'lf') return `${message.replace(/[\r\n]+/g, ' ')}\n`;
  // Byte length, not character length: a multi-byte character would
  // otherwise make the receiver cut the frame short.
  return `${new TextEncoder().encode(message).length} ${message}`;
}

/**
 * The `MSG` part: the record's message, with its fields appended in the
 * same shape a human reads on the console.
 */
function messageTextOf(record: LogRecord): string {
  // Reuse the text formatter's field rendering, then drop its timestamp
  // and level head — syslog carries both in the frame already.
  const line = formatTextLine(record);
  const withoutHead = line.replace(/^\[[^\]]*\] [A-Z ]{5} /, '');
  return withoutHead === '' ? record.message : withoutHead;
}

/**
 * RFC 5424 fields are printable ASCII without spaces, and empty means the
 * nil value.  A space in a `HOSTNAME` would shift every field after it.
 */
function nilOr(value: string, maxLength: number): string {
  const cleaned = value.replace(/[^\x21-\x7e]/g, '').slice(0, maxLength);
  return cleaned === '' ? NIL : cleaned;
}
