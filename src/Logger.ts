import { LogContext, type LogContextData } from './LogContext.js';

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
   */
  private render(tag: string, msg: string): string {
    const ts = new Date().toISOString();
    const head = this.source
      ? `[${ts}] ${tag} ${this.source} - ${msg}`
      : `[${ts}] ${tag} ${msg}`;
    const merged = { ...this.staticFields, ...LogContext.get() };
    const keys = Object.keys(merged);
    if (keys.length === 0) return head;
    const tail = keys.map((k) => `${k}=${formatValue(merged[k])}`).join(', ');
    return `${head} {${tail}}`;
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Debug)) console.debug(this.render('DEBUG', msg), ...args);
  }
  info(msg: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Info)) console.log(this.render('INFO ', msg), ...args);
  }
  warn(msg: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Warn)) console.warn(this.render('WARN ', msg), ...args);
  }
  error(msg: string, ...args: unknown[]): void {
    if (this.enabled(LogLevel.Error)) console.error(this.render('ERROR', msg), ...args);
  }

  withSource(source: string): Logger {
    return new ConsoleLogger(this.level, source, this.staticFields);
  }

  withFields(fields: LogContextData): Logger {
    return new ConsoleLogger(this.level, this.source, { ...this.staticFields, ...fields });
  }
}

/** A logger that discards every call. Handy for tests and benchmarks. */
export class NoopLogger implements Logger {
  readonly level = LogLevel.Off;
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  withSource(): Logger { return this; }
  withFields(): Logger { return this; }
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
 * Each record always carries the four core fields — `ts`, `level`,
 * `source`, and `msg` — followed by the merged static + dynamic MDC
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

  private emit(level: LogLevel, msg: string, args: unknown[]): void {
    if (!this.enabled(level)) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: LEVEL_TAG[level],
      ...(this.source ? { source: this.source } : {}),
      msg,
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

  debug(msg: string, ...args: unknown[]): void { this.emit(LogLevel.Debug, msg, args); }
  info(msg: string, ...args: unknown[]): void { this.emit(LogLevel.Info, msg, args); }
  warn(msg: string, ...args: unknown[]): void { this.emit(LogLevel.Warn, msg, args); }
  error(msg: string, ...args: unknown[]): void { this.emit(LogLevel.Error, msg, args); }

  withSource(source: string): Logger {
    return new JsonLogger(this.level, source, this.staticFields, this.sink);
  }

  withFields(fields: LogContextData): Logger {
    return new JsonLogger(this.level, this.source, { ...this.staticFields, ...fields }, this.sink);
  }
}

/**
 * Turn an `Error` into a plain object so `JSON.stringify` doesn't
 * collapse it to `"{}"` (Error's enumerable surface is empty).
 * Other values pass through unchanged — the replacer handles
 * remaining quirks (BigInt, circular).
 */
function normaliseArg(v: unknown): unknown {
  if (v instanceof Error) {
    return {
      name: v.name,
      message: v.message,
      ...(v.stack ? { stack: v.stack } : {}),
    };
  }
  return v;
}

/**
 * JSON.stringify replacer:
 *  - BigInt → string (BigInt can't be JSON-serialised natively)
 *  - circular → `'[Circular]'`
 *  - function → undefined (drop)
 */
function jsonSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (_key, value) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return undefined;
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
