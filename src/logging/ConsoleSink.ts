import type { LogLevel } from '../Logger.js';
import { LogLevel as Level } from '../Logger.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import { formatJsonLine, formatTextLine } from './LogFormat.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSink } from './LogSink.js';
import {
  ConsoleSinkOptionsValidator,
  DEFAULT_CONSOLE_SINK_FORMAT,
  DEFAULT_CONSOLE_SINK_MIN_LEVEL,
  DEFAULT_CONSOLE_SINK_STREAM,
  type ConsoleSinkFormat,
  type ConsoleSinkOptions,
  type ConsoleSinkOptionsType,
  type ConsoleSinkStream,
} from './ConsoleSinkOptions.js';

/**
 * Writes records to the console — the sink equivalent of `ConsoleLogger`,
 * and the one every other sink is compared against.
 *
 * It is the only sink that writes **synchronously**.  There is nothing to
 * batch: the destination is a file descriptor the runtime already buffers,
 * and deferring a console line would cost the one property that makes a
 * console useful, namely that what you see is what has happened.  That also
 * means it has no `flush` or `close` to speak of — by the time `write`
 * returns, its work is done.
 *
 * In `text` mode the positional arguments are passed through to
 * `console.*` untouched, so an `Error` still renders with its stack and an
 * object still opens as an inspectable preview — the reason
 * {@link LogRecord.args} keeps them raw.
 */
export class ConsoleSink implements LogSink {
  readonly name = 'console';
  readonly minLevel: LogLevel;
  private readonly format: ConsoleSinkFormat;
  private readonly stream: ConsoleSinkStream;

  constructor(options: ConsoleSinkOptions = {}) {
    const settings = { ...(options as Partial<ConsoleSinkOptionsType>) };
    new ConsoleSinkOptionsValidator().validate(settings);
    this.minLevel = settings.minLevel ?? DEFAULT_CONSOLE_SINK_MIN_LEVEL;
    this.format = settings.format ?? DEFAULT_CONSOLE_SINK_FORMAT;
    this.stream = settings.stream ?? DEFAULT_CONSOLE_SINK_STREAM;
  }

  write(record: LogRecord): void {
    try {
      if (this.format === 'json') {
        writeLine(this.stream === 'stderr' ? 'stderr' : 'stdout', formatJsonLine(record) + '\n');
        return;
      }
      const line = formatTextLine(record);
      const args = record.args ?? [];
      if (this.stream === 'auto') {
        routeByLevel(record.level, line, args);
        return;
      }
      // A raw stream has no console to inspect objects for us, so the
      // arguments have to be rendered into the line or they are lost.
      writeLine(this.stream, line + renderArgs(args) + '\n');
    } catch {
      // The console is the last thing standing when everything else has
      // failed; if even this throws there is nowhere left to report it.
    }
  }
}

/**
 * Level-routed console output — what `ConsoleLogger` does, and what gives
 * a browser or devtools console its colouring and grouping.
 */
function routeByLevel(level: LogLevel, line: string, args: readonly unknown[]): void {
  if (level >= Level.Error) console.error(line, ...args);
  else if (level >= Level.Warn) console.warn(line, ...args);
  else if (level >= Level.Info) console.log(line, ...args);
  else console.debug(line, ...args);
}

/**
 * Render positional arguments into a text line for a raw stream write:
 * `Error`s become `{name, message, stack}`, and everything else goes
 * through JSON with the same safety net the structured formatters use.
 * Never throws — a value that defeats even the replacer is shown as its
 * type rather than taking the line down with it.
 */
function renderArgs(args: readonly unknown[]): string {
  if (args.length === 0) return '';
  const rendered = args.map((arg) => {
    const value = normaliseArg(arg);
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, jsonSafeReplacer()) ?? String(value);
    } catch {
      return `[unserialisable ${typeof value}]`;
    }
  });
  return ' ' + rendered.join(' ');
}

/**
 * Write a complete line to a process stream, falling back to the console
 * where there is no `process` (a browser, a worker, a runtime shim without
 * stdio).  The fallback strips the trailing newline because `console.log`
 * adds one of its own.
 */
function writeLine(stream: 'stdout' | 'stderr', line: string): void {
  const target = typeof process !== 'undefined' ? process[stream] : undefined;
  if (target && typeof target.write === 'function') {
    target.write(line);
    return;
  }
  const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (stream === 'stderr') console.error(withoutNewline);
  else console.log(withoutNewline);
}
