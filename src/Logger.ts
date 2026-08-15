import { LogContext, type LogContextData } from './LogContext.js';
import { jsonSafeReplacer, normaliseArg } from './logging/JsonSafe.js';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Off = 100,
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** Create a logger bound to a source (e.g. an actor path). */
  withSource(source: string): Logger;
  /**
   * Create a logger with extra **static** fields baked in.  Unlike
   * `LogContext` (which is dynamic / per-async-stack), `withFields`
   * stamps the same fields on every record this logger emits — handy
   * for component-level tagging like `{ component: 'shard-coordinator' }`
   * or `{ shardId: 12 }` on a per-entity logger.
   */
  withFields(fields: LogContextData): Logger;
}

/**
 * Reserved static-field key holding an actor's human-readable name — what
 * `Actor.displayName()` resolved to (#891).
 *
 * A field rather than a new `Logger` member, because `Logger` is a
 * documented extension point: adding a required method would break every
 * third-party implementation, while a field costs nothing.  It also
 * carries itself: `JsonLogger` and the OTel adapter already spread the
 * static fields, so the name lands there as a separate queryable
 * key/attribute with no code of their own.  Only `ConsoleLogger` treats it
 * specially, lifting it into the line head where a human reads it.
 *
 * The name never replaces `source` — the path stays the identity, and
 * everything that routes, correlates or aggregates keeps using it.
 */
export const DISPLAY_NAME_FIELD = 'displayName';

export class ConsoleLogger implements Logger {
  constructor(
    public level: LogLevel = LogLevel.Info,
    private readonly source: string = '',
    private readonly staticFields: LogContextData = {},
  ) {}

  private enabled(target: LogLevel): boolean {
    return target >= this.level;
  }

  /**
   * Build the log line.  Static fields (from `withFields`) and dynamic
   * MDC (from `LogContext.run`) are merged at emit time — dynamic wins
   * on key collision because that matches the "innermost scope wins"
   * intuition.  The fields appear as a `{k=v, k2=v2}` suffix when
   * non-empty so they don't clutter records that don't use MDC.
   *
   * {@link DISPLAY_NAME_FIELD} is the one exception: it is lifted out of
   * the suffix and rendered as its own `- name -` segment after the
   * source, because it is the part a human scans for.  Lifted from the
   * *static* fields only — a dynamic one arrives over the cluster wire
   * from a remote peer (#573) and has no business rewriting the head, so
   * it stays in the suffix where every other MDC key lives.
   */
  private render(tag: string, message: string): string {
    const ts = new Date().toISOString();
    const displayName = displayNameOf(this.staticFields);
    const prefix = [this.source, displayName].filter((part) => part !== '').join(' - ');
    const head = prefix
      ? `[${ts}] ${tag} ${prefix} - ${message}`
      : `[${ts}] ${tag} ${message}`;
    const dynamic = LogContext.get();
    const merged: Record<string, string | number | boolean> = { ...this.staticFields, ...dynamic };
    if (displayName !== '' && !(DISPLAY_NAME_FIELD in dynamic)) delete merged[DISPLAY_NAME_FIELD];
    const keys = Object.keys(merged);
    if (keys.length === 0) return head;
    const tail = keys.map((k) => `${k}=${formatValue(merged[k])}`).join(', ');
    return `${head} {${tail}}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Debug)) console.debug(this.render('DEBUG', message), ...args);
  }
  info(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Info)) console.log(this.render('INFO ', message), ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Warn)) console.warn(this.render('WARN ', message), ...args);
  }
  error(message: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Error)) console.error(this.render('ERROR', message), ...args);
  }

  withSource(source: string): Logger {
    return new ConsoleLogger(this.level, source, this.staticFields);
  }

  withFields(fields: LogContextData): Logger {
    return new ConsoleLogger(this.level, this.source, { ...this.staticFields, ...fields });
  }
}

/**
 * A logger that discards every call. Handy for tests and benchmarks.
 *
 * The parameters are spelled out and then discarded.  Leaving them off
 * still satisfies `implements Logger` — a function that ignores its
 * arguments is assignable to one that takes them — but this class is
 * exported, and a caller holding the concrete type rather than the
 * interface got `Expected 0 arguments, but got 1` on the ordinary
 * `log.info('hello')` (#540).
 */
export class NoopLogger implements Logger {
  readonly level = LogLevel.Off;
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(_message: string, ..._args: unknown[]): void {}
  error(_message: string, ..._args: unknown[]): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }
}

/* ----------------------------- JsonLogger (#311) ----------------------------- */

/**
 * Where a `JsonLogger` writes its records — by default `process.stdout`,
 * a `'\n'`-delimited stream that `jq`, `vector`, `fluent-bit`, the
 * Docker logging driver, and the Kubernetes log scraper all consume
 * out of the box.  Inject a custom sink in tests (capturing array) or
 * to route to `process.stderr` / a file descriptor.
 */
export interface JsonLogSink {
  write(line: string): void;
}

const stdoutSink: JsonLogSink = {
  write(line) {
    if (typeof process !== 'undefined' && process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(line);
    } else {
      // Browser / non-Node fallback — drop to console so the records
      // are still observable somewhere.
      console.log(line.endsWith('\n') ? line.slice(0, -1) : line);
    }
  },
};

const LEVEL_TAG: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Off]: 'off',
};

/**
 * Structured-logging logger that emits one **`\n`-delimited JSON object
 * per record** to `process.stdout` (or an injected `JsonLogSink`).
 *
 * Each record always carries `ts`, `level`, and `msg`; `source` is
 * emitted only when one is bound (via `withSource`).  These are
 * followed by the merged static + dynamic MDC
 * (static from `withFields`, dynamic from `LogContext.run`, with
 * dynamic winning on key collision to match the "innermost scope wins"
 * intuition).  Extra positional `...args` from
 * `log.info(msg, extra1, extra2)` go under an `args` array; the common
 * shape `log.info('processed', { items: 42 })` simply puts `{items:42}`
 * into `args[0]` so log aggregators can index nested keys.
 *
 * Wire it in at system construction:
 *
 *     const system = ActorSystem.create('my-app', ActorSystemOptions.create().withLogger(new JsonLogger()));
 *
 * Output (one line, line-wrapped here for readability):
 *
 *     {"ts":"2026-05-14T12:34:56.789Z","level":"info",
 *      "source":"actor-ts://my-app/user/order",
 *      "msg":"placing order",
 *      "correlationId":"abc-123","userId":"user-42",
 *      "args":[{"items":42}]}
 *
 * No pretty-printing, no colour codes, no level-prefix shorthand —
 * machine-readable by design.  For human-readable text logs use the
 * default `ConsoleLogger`; for OTel-pipeline ingestion bridge a
 * `JsonLogger`-equivalent via `otelLogger({ api })`.
 *
 * **Error rendering.**  Pass an `Error` and the logger serialises
 * `name`, `message`, and `stack` (the bare object would otherwise
 * become `"{}"` because `Error`'s own enumerable surface is empty).
 *
 * **JSON-safety.**  Values are sent through `JSON.stringify` with a
 * replacer that handles `BigInt`, circular references, and
 * `undefined`/function values gracefully — a log call never throws.
 */
export class JsonLogger implements Logger {
  constructor(
    public level: LogLevel = LogLevel.Info,
    private readonly source: string = '',
    private readonly staticFields: LogContextData = {},
    private readonly sink: JsonLogSink = stdoutSink,
  ) {}

  private enabled(target: LogLevel): boolean {
    return target >= this.level;
  }

  private emit(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.enabled(level)) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: LEVEL_TAG[level],
      ...(this.source ? { source: this.source } : {}),
      msg: message,
      ...this.staticFields,
      ...LogContext.get(),
    };
    if (args.length > 0) {
      record['args'] = args.map(normaliseArg);
    }
    let line: string;
    try {
      line = JSON.stringify(record, jsonSafeReplacer());
    } catch {
      // Replacer should already handle everything we hit; this is the
      // last-ditch "the user did something truly weird" path.  Drop
      // the args, keep the core record so the log line still appears.
      const { args: _drop, ...core } = record;
      line = JSON.stringify(core);
    }
    this.sink.write(line + '\n');
  }

  debug(message: string, ...args: unknown[]): void { this.emit(LogLevel.Debug, message, args); }
  info(message: string, ...args: unknown[]): void { this.emit(LogLevel.Info, message, args); }
  warn(message: string, ...args: unknown[]): void { this.emit(LogLevel.Warn, message, args); }
  error(message: string, ...args: unknown[]): void { this.emit(LogLevel.Error, message, args); }

  withSource(source: string): Logger {
    return new JsonLogger(this.level, source, this.staticFields, this.sink);
  }

  withFields(fields: LogContextData): Logger {
    return new JsonLogger(this.level, this.source, { ...this.staticFields, ...fields }, this.sink);
  }
}

/**
 * The display name a set of fields carries, or `''` for "none".  Only a
 * non-empty string counts: `LogContextData` also admits numbers and
 * booleans, and a `displayName=42` in the head would read as a rendering
 * bug rather than as the name someone chose.
 *
 * Exported for the multi-sink pipeline, which lifts the name into
 * `LogRecord.displayName` under exactly this rule.  Not re-exported from
 * the package root: it is an internal detail of how the field is read, not
 * API.
 */
export function displayNameOf(fields: LogContextData): string {
  const value = fields[DISPLAY_NAME_FIELD];
  return typeof value === 'string' ? value : '';
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
