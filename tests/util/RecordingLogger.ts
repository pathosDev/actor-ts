import type { LogContextData } from '../../src/LogContext.js';
import { LogLevel, type Logger } from '../../src/Logger.js';

export type RecordedLog = { readonly level: string; readonly message: string };

/**
 * Collects everything the system logger was told, including through
 * `withSource` / `withFields` children — the shape
 * `tests/unit/cluster/ClusterTlsStartupWarning.test.ts` established for
 * asserting on startup advisories, shared here because the storage-locality
 * tests (#1356) need the identical instrument.
 */
export class RecordingLogger implements Logger {
  readonly records: RecordedLog[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}
