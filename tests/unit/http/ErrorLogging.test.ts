/**
 * What survives on the server when a 500 tells the client nothing (#130).
 *
 * The default 500 deliberately withholds the thrown text, so the server-side
 * log is the only remaining copy.  These tests pin that it is emitted at a
 * level operators actually run at, that it carries the error itself, and
 * that a handler's *deliberate* `HttpError` does not get dragged into the
 * error log with it.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { concat, fallback, get, path, type Route } from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/types.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';

type LogRecord = { readonly level: string; readonly message: string; readonly args: unknown[] };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string, args: unknown[]): void {
    this.sink.records.push({ level, message, args });
  }

  debug(message: string, ...args: unknown[]): void { this.record('debug', message, args); }
  info(message: string, ...args: unknown[]): void { this.record('info', message, args); }
  warn(message: string, ...args: unknown[]): void { this.record('warn', message, args); }
  error(message: string, ...args: unknown[]): void { this.record('error', message, args); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/** The kind of text an unhandled throw drags along in production. */
const LEAK = "ENOENT: open '/srv/app/config/credentials.json'";

type Fixture = {
  readonly system: ActorSystem;
  readonly binding: ServerBinding;
  readonly log: RecordingLogger;
};

async function bind(name: string, routes: Route): Promise<Fixture> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(name, systemOptions);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new FastifyBackend({ logger: false }))
    .bind(routes);
  return { system, binding, log };
}

const close = async (fixture: Fixture): Promise<void> => {
  await fixture.binding.unbind();
  await fixture.system.terminate();
};

const errorRecords = (fixture: Fixture): LogRecord[] =>
  fixture.log.records.filter((r) => r.level === 'error');

const url = (fixture: Fixture, suffix: string): string =>
  `http://${fixture.binding.host}:${fixture.binding.port}${suffix}`;

describe('HttpExtension — an escaped throw is logged where operators look', () => {
  test('logged at error with the error value, while the client gets the redacted 500', async () => {
    const fixture = await bind('http-error-log', path('boom', get(() => { throw new Error(LEAK); })));

    const response = await fetch(url(fixture, '/boom'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });

    const records = errorRecords(fixture);
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toContain('GET /boom');
    expect(records[0]!.message).toContain('500');
    // The value, not `.message` — a sink that formats stacks needs the object.
    expect(records[0]!.args[0]).toBeInstanceOf(Error);
    expect((records[0]!.args[0] as Error).message).toBe(LEAK);
    // …and the leak stayed out of the line itself, which some sinks truncate.
    expect(records[0]!.message).not.toContain(LEAK);
    await close(fixture);
  });

  test('a deliberate HttpError is ordinary traffic — no error record', async () => {
    const fixture = await bind(
      'http-error-log-httperror',
      path('missing', get(() => { throw new HttpError(Status.NotFound, 'no such user'); })),
    );

    const response = await fetch(url(fixture, '/missing'));
    expect(response.status).toBe(404);
    expect(errorRecords(fixture)).toHaveLength(0);
    expect(fixture.log.records.some((r) => r.level === 'debug' && r.message.includes('404'))).toBe(true);
    await close(fixture);
  });

  test('a throw inside fallback() is logged too — nothing downstream ever sees it', async () => {
    const fixture = await bind(
      'http-error-log-fallback',
      concat(
        path('ok', get(() => ({ status: Status.OK, body: 'ok' }))),
        fallback(() => { throw new Error(LEAK); }),
      ),
    );

    const response = await fetch(url(fixture, '/nowhere'));
    expect(response.status).toBe(500);
    const records = errorRecords(fixture);
    expect(records).toHaveLength(1);
    expect((records[0]!.args[0] as Error).message).toBe(LEAK);
    await close(fixture);
  });
});

describe('HttpExtension — correlating the error line with the caller', () => {
  test('a well-formed x-request-id is named on the line', async () => {
    const fixture = await bind('http-error-log-correlation', path('boom', get(() => { throw new Error(LEAK); })));

    await fetch(url(fixture, '/boom'), { headers: { 'x-request-id': 'abc-123_XYZ.9' } });
    expect(errorRecords(fixture)[0]!.message).toContain('[x-request-id=abc-123_XYZ.9]');
    await close(fixture);
  });

  test('a malformed one is dropped rather than pasted into the log', async () => {
    const fixture = await bind('http-error-log-bad-id', path('boom', get(() => { throw new Error(LEAK); })));

    // Spaces and colons are outside the accepted id shape — the guard exists
    // because a raw client string on a log line can forge whole records.
    await fetch(url(fixture, '/boom'), { headers: { 'x-request-id': 'evil INFO: user promoted' } });
    const message = errorRecords(fixture)[0]!.message;
    expect(message).not.toContain('x-request-id');
    expect(message).not.toContain('user promoted');
    await close(fixture);
  });
});
