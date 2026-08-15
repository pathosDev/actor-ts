import { DISPLAY_NAME_FIELD, LogLevel } from '../Logger.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import type { LogRecord } from './LogRecord.js';

/**
 * The two record renderings the framework ships, extracted so a sink can
 * pick one instead of inventing a third.  Both reproduce the output of the
 * single-destination logger they are named after, so switching a deployment
 * from `new JsonLogger()` to a `MultiSinkLogger` with a JSON console sink
 * does not break anybody's log parser.
 */

/** Level → the lowercase tag `JsonLogger` writes into `level`. */
const LEVEL_TAG: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Off]: 'off',
};

/** Level → the fixed-width tag `ConsoleLogger` writes into the line head. */
const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO ',
  [LogLevel.Warn]: 'WARN ',
  [LogLevel.Error]: 'ERROR',
  [LogLevel.Off]: 'OFF  ',
};

/**
 * Human-readable single line, matching `ConsoleLogger`:
 *
 *     [2026-08-12T09:41:02.113Z] INFO  actor-ts://app/user/order - Order 42 - placing order {correlationId=abc}
 *
 * The display name is rendered as its own `- name -` segment after the
 * source rather than in the `{k=v}` suffix, because it is the part a human
 * scans for.
 *
 * **One documented difference from `ConsoleLogger`.**  When a remote MDC
 * sets `displayName` to the *same* string the actor already carries
 * statically, `ConsoleLogger` prints it twice (head and suffix) while this
 * formatter prints it once.  Suppression is by value here, and no
 * information is lost — the name is in the head either way.
 */
export function formatTextLine(record: LogRecord): string {
  const timestamp = new Date(record.timestampMs).toISOString();
  const prefix = [record.source ?? '', record.displayName ?? ''].filter((part) => part !== '').join(' - ');
  const head = prefix
    ? `[${timestamp}] ${LEVEL_LABEL[record.level]} ${prefix} - ${record.message}`
    : `[${timestamp}] ${LEVEL_LABEL[record.level]} ${record.message}`;

  const fields: Record<string, string | number | boolean> = { ...record.fields };
  if (record.displayName !== undefined && fields[DISPLAY_NAME_FIELD] === record.displayName) {
    delete fields[DISPLAY_NAME_FIELD];
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return head;
  const tail = keys.map((key) => `${key}=${formatValue(fields[key])}`).join(', ');
  return `${head} {${tail}}`;
}

/**
 * One JSON object, matching `JsonLogger` — key order `ts`, `level`,
 * `source?`, `msg`, then the merged fields, then `args`:
 *
 *     {"ts":"2026-08-12T09:41:02.113Z","level":"info","source":"actor-ts://app/user/order",
 *      "msg":"placing order","correlationId":"abc","args":[{"items":42}]}
 *
 * No trailing newline — a sink that writes NDJSON appends its own
 * delimiter, and a sink that puts the object into an array must not have
 * one.
 *
 * Never throws: values go through {@link jsonSafeReplacer} (BigInt,
 * circular, functions), and if serialisation still fails the arguments are
 * dropped so the record itself survives.
 */
export function formatJsonLine(record: LogRecord): string {
  const object: Record<string, unknown> = {
    ts: new Date(record.timestampMs).toISOString(),
    level: LEVEL_TAG[record.level],
    ...(record.source ? { source: record.source } : {}),
    msg: record.message,
    ...record.fields,
  };
  if (record.args !== undefined && record.args.length > 0) {
    object['args'] = record.args.map(normaliseArg);
  }
  try {
    return JSON.stringify(object, jsonSafeReplacer());
  } catch {
    // The replacer already covers everything we know how to hit; this is
    // the "someone handed us a truly exotic value" path.  Drop the args,
    // keep the core record so the line still appears.
    const { args: _drop, ...core } = object;
    return JSON.stringify(core);
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
