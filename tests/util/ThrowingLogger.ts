import type { LogContextData } from '../../src/LogContext.js';
import { LogLevel, type Logger } from '../../src/Logger.js';

/**
 * A `Logger` whose every method throws — the caller-supplied sink that has
 * lost its transport, or was written wrong.
 *
 * `Logger` is a documented extension point, so a throwing implementation is
 * a shape the framework has to survive wherever it reports from inside a
 * callback nothing above it can catch: a `MessagePort`'s `onmessage`, a
 * worker's `close` listener.  A throw that escapes one of those is an
 * `uncaughtException` on Node and an exit on Bun — the host-killing shape
 * #701 and #945 closed on the wire path, reopened by the report itself.
 * The suites that pin the containment use this instead of a `spyOn` that
 * throws, because the seam under test is the `Logger` interface and not one
 * console method.  `calls` counts the attempts, so a test can tell "the
 * report was contained" from "the report never ran".
 */
export class ThrowingLogger implements Logger {
  readonly level: LogLevel = LogLevel.Debug;
  calls = 0;

  constructor(private readonly reason: string = 'the log sink is down') {}

  debug(_message: string): void { this.refuse(); }
  info(_message: string): void { this.refuse(); }
  warn(_message: string): void { this.refuse(); }
  error(_message: string): void { this.refuse(); }

  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  private refuse(): never {
    this.calls += 1;
    throw new Error(this.reason);
  }
}
