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
}

export class ConsoleLogger implements Logger {
  constructor(public level: LogLevel = LogLevel.Info, private readonly source: string = '') {}

  private enabled(target: LogLevel): boolean {
    return target >= this.level;
  }

  private render(tag: string, msg: string): string {
    const ts = new Date().toISOString();
    return this.source ? `[${ts}] ${tag} ${this.source} - ${msg}` : `[${ts}] ${tag} ${msg}`;
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
    return new ConsoleLogger(this.level, source);
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
}
