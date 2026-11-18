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
import { HttpExtensionId, type ServerBuilder } from '../../../src/http/HttpExtension.js';
import { requestId, requestIdOfError } from '../../../src/http/middleware/RequestId.js';
import { concat, fallback, get, path, withMiddleware, type Route } from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/Types.js';
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

async function bind(
  name: string,
  routes: Route,
  configure: (builder: ServerBuilder) => ServerBuilder = (builder) => builder,
): Promise<Fixture> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(name, systemOptions);
  const builder = system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new FastifyBackend({ logger: false }));
  const binding = await configure(builder).bind(routes);
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
    const response = await fetch(url(fixture, '/boom'), { headers: { 'x-request-id': 'evil INFO: user promoted' } });
    const message = errorRecords(fixture)[0]!.message;
    expect(message).not.toContain('user promoted');
    // A generated id stands in for it, on the line and on the 500 alike (#1064).
    const generated = response.headers.get('x-request-id');
    expect(generated).toMatch(WELL_FORMED_ID);
    expect(message).toContain(`[x-request-id=${generated}]`);
    await close(fixture);
  });
});

const WELL_FORMED_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The `[header=id]` a line names, or null. */
const correlationOnLine = (message: string): { readonly headerName: string; readonly id: string } | null => {
  const found = /\[([a-z-]+)=([A-Za-z0-9._-]+)\]/.exec(message);
  return found ? { headerName: found[1]!, id: found[2]! } : null;
};

describe('HttpExtension — a 500 always carries the id its log line names (#1064)', () => {
  test('requestId() with no incoming id: the generated id is on the 500 and on the line', async () => {
    const fixture = await bind(
      'http-500-correlation-generated',
      withMiddleware(requestId(), path('boom', get(() => { throw new Error(LEAK); }))),
    );
    const response = await fetch(url(fixture, '/boom'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(WELL_FORMED_ID);
    expect(correlationOnLine(errorRecords(fixture)[0]!.message)).toEqual({ headerName: 'x-request-id', id: id! });
    await close(fixture);
  });

  test('the id requestId() replaced an incoming one with is the one reported', async () => {
    const options = { trustIncoming: false, generate: () => 'server-made-1' };
    const fixture = await bind(
      'http-500-correlation-untrusted',
      withMiddleware(requestId(options), path('boom', get(() => { throw new Error(LEAK); }))),
    );
    const response = await fetch(url(fixture, '/boom'), { headers: { 'x-request-id': 'client-said-2' } });
    expect(response.headers.get('x-request-id')).toBe('server-made-1');
    expect(errorRecords(fixture)[0]!.message).toContain('[x-request-id=server-made-1]');
    await close(fixture);
  });

  test('a renamed header is the one written and named', async () => {
    const fixture = await bind(
      'http-500-correlation-renamed',
      withMiddleware(requestId({ headerName: 'x-correlation-id' }), path('boom', get(() => { throw new Error(LEAK); }))),
    );
    const response = await fetch(url(fixture, '/boom'));
    const id = response.headers.get('x-correlation-id');
    expect(id).toMatch(WELL_FORMED_ID);
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(errorRecords(fixture)[0]!.message).toContain(`[x-correlation-id=${id}]`);
    await close(fixture);
  });

  test('without requestId() at all, the 500 still gets a generated id', async () => {
    const fixture = await bind('http-500-correlation-bare', path('boom', get(() => { throw new Error(LEAK); })));
    const response = await fetch(url(fixture, '/boom'));
    expect(response.status).toBe(500);
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(WELL_FORMED_ID);
    expect(errorRecords(fixture)[0]!.message).toContain(`[x-request-id=${id}]`);
    await close(fixture);
  });

  test('a throw inside fallback() gets one too', async () => {
    const fixture = await bind('http-500-correlation-fallback', fallback(() => { throw new Error(LEAK); }));
    const response = await fetch(url(fixture, '/nowhere'));
    expect(response.status).toBe(500);
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(WELL_FORMED_ID);
    expect(errorRecords(fixture)[0]!.message).toContain(`[x-request-id=${id}]`);
    await close(fixture);
  });

  test('withErrorHandler still receives the thrown value itself, and can read the id off it', async () => {
    const boom = new Error(LEAK);
    let received: unknown;
    const fixture = await bind(
      'http-500-correlation-handler',
      withMiddleware(requestId(), path('boom', get(() => { throw boom; }))),
      (builder) => builder.withErrorHandler((err) => {
        received = err;
        const correlation = requestIdOfError(err);
        return { status: 503, headers: correlation ? { [correlation.headerName]: correlation.id } : {}, body: 'down' };
      }),
    );
    const response = await fetch(url(fixture, '/boom'));
    expect(response.status).toBe(503);
    expect(received).toBe(boom);
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(WELL_FORMED_ID);
    expect(errorRecords(fixture)[0]!.message).toContain(`[x-request-id=${id}]`);
    await close(fixture);
  });

  test('without requestId(), withErrorHandler reads the id the server generated', async () => {
    const fixture = await bind(
      'http-500-correlation-handler-bare',
      path('boom', get(() => { throw new Error(LEAK); })),
      (builder) => builder.withErrorHandler((err) => ({ status: 503, body: requestIdOfError(err)?.id ?? 'none' })),
    );
    const response = await fetch(url(fixture, '/boom'));
    expect(response.status).toBe(503);
    const id = await response.text();
    expect(id).toMatch(WELL_FORMED_ID);
    expect(errorRecords(fixture)[0]!.message).toContain(`[x-request-id=${id}]`);
    await close(fixture);
  });
});
