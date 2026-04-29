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

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
