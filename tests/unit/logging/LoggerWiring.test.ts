import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConsoleLogger, LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MultiSinkLogger } from '../../../src/logging/MultiSinkLogger.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import type { LogSink, LogSinkContext } from '../../../src/logging/LogSink.js';

/**
 * How the sinks reach — and leave — a running system: construction
 * precedence, the `attach` that hands them the scheduler, and the flush
 * `terminate()` owes them.
 */

class RecordingSink implements LogSink {
  readonly records: LogRecord[] = [];
  readonly contexts: LogSinkContext[] = [];
  closes = 0;

  constructor(readonly name = 'recording', readonly minLevel: LogLevel = LogLevel.Debug) {}

  write(record: LogRecord): void { this.records.push(record); }
  attach(context: LogSinkContext): void { this.contexts.push(context); }
  async close(): Promise<void> { this.closes += 1; }
}

let consoleErrors: unknown[][] = [];
const originalError = console.error;

beforeEach(() => {
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});
afterEach(() => { console.error = originalError; });

describe('logger construction precedence', () => {
  it('keeps the single ConsoleLogger when nothing asks for sinks', async () => {
    const system = ActorSystem.create('logging-default');
    expect(system.log).toBeInstanceOf(ConsoleLogger);
    await system.terminate();
  });

  it('wraps logSinks in a MultiSinkLogger', async () => {
    const sink = new RecordingSink();
    const system = ActorSystem.create('logging-sinks', ActorSystemOptions.create().withLogSinks([sink]));

    expect(system.log).toBeInstanceOf(MultiSinkLogger);
    system.log.info('hello');
    expect(sink.records.map((r) => r.message)).toEqual(['hello']);
    await system.terminate();
  });

  it('lets an explicit logger win over logSinks', async () => {
    const sink = new RecordingSink();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogSinks([sink]);
    const system = ActorSystem.create('logging-explicit', systemOptions);

    expect(system.log).toBeInstanceOf(NoopLogger);
    system.log.info('ignored');
    expect(sink.records).toHaveLength(0);
    await system.terminate();
  });

  it('builds a MultiSinkLogger from an enabled HOCON sink', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withConfig({ 'actor-ts': { logger: { sinks: { console: { enabled: true } } } } });
    const system = ActorSystem.create('logging-hocon', systemOptions);

    expect(system.log).toBeInstanceOf(MultiSinkLogger);
    await system.terminate();
  });

  it('lets logSinks replace the HOCON sink set wholesale', async () => {
    const sink = new RecordingSink();
    const systemOptions = ActorSystemOptions.create()
      .withLogSinks([sink])
      .withConfig({ 'actor-ts': { logger: { sinks: { console: { enabled: true } } } } });
    const system = ActorSystem.create('logging-replace', systemOptions);

    // One sink, ours — the console block did not join the set.
    system.log.info('hello');
    expect(sink.records).toHaveLength(1);
    await system.terminate();
  });

  it('applies actor-ts.logger.level as the floor over the sinks', async () => {
    const sink = new RecordingSink('recording', LogLevel.Debug);
    const systemOptions = ActorSystemOptions.create()
      .withLogSinks([sink])
      .withConfig({ 'actor-ts': { logger: { level: 'warn' } } });
    const system = ActorSystem.create('logging-floor', systemOptions);

    expect(system.log.level).toBe(LogLevel.Warn);
    system.log.info('suppressed');
    system.log.warn('kept');
    expect(sink.records.map((r) => r.message)).toEqual(['kept']);
    await system.terminate();
  });

  it('rejects a sink block with an unusable min-level instead of guessing', () => {
    const systemOptions = ActorSystemOptions.create()
      .withConfig({
        'actor-ts': { logger: { sinks: { console: { enabled: true, 'min-level': 'warning' } } } },
      });
    // The message names the accepted spellings, not the numeric enum
    // values — the reader of it wrote a word in a config file.
    expect(() => ActorSystem.create('logging-bad-level', systemOptions))
      .toThrow(/minLevel must be one of debug, info, warn, error, off/);
  });
});

describe('sink lifecycle', () => {
  it('attaches the scheduler and the system name', async () => {
    const sink = new RecordingSink();
    const system = ActorSystem.create('logging-attach', ActorSystemOptions.create().withLogSinks([sink]));

    expect(sink.contexts).toHaveLength(1);
    expect(sink.contexts[0]!.systemName).toBe('logging-attach');
    expect(sink.contexts[0]!.scheduler).toBe(system.scheduler);
    await system.terminate();
  });

  it('closes the logger on terminate', async () => {
    const sink = new RecordingSink();
    const system = ActorSystem.create('logging-close', ActorSystemOptions.create().withLogSinks([sink]));

    await system.terminate();

    expect(sink.closes).toBe(1);
  });

  it('closes the logger only after the actors have stopped logging', async () => {
    const sink = new RecordingSink();
    const system = ActorSystem.create('logging-order', ActorSystemOptions.create().withLogSinks([sink]));

    // A record emitted during shutdown must still reach the sink, not the
    // post-close console fallback.
    system.log.info('shutting down');
    await system.terminate();

    expect(sink.records.map((r) => r.message)).toContain('shutting down');
    expect(sink.closes).toBe(1);
  });

  it('does not let a hanging sink block termination past the budget', async () => {
    const hanging: LogSink = {
      name: 'hanging',
      minLevel: LogLevel.Debug,
      write() {},
      close() { return new Promise<void>(() => {}); },
    };
    const systemOptions = ActorSystemOptions.create()
      .withLogSinks([hanging])
      .withConfig({ 'actor-ts': { logger: { 'close-timeout': '30ms' } } });
    const system = ActorSystem.create('logging-hang', systemOptions);

    const startedAt = Date.now();
    await system.terminate();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(system.isTerminated).toBe(true);
    // The per-sink budget inherits the system's, so nothing is still
    // counting down after termination to report into a later program.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(consoleErrors.filter((call) => String(call[0]).includes('hanging'))).toHaveLength(1);
  });

  it('terminates cleanly when the logger has no close at all', async () => {
    const system = ActorSystem.create('logging-plain', ActorSystemOptions.create().withLogger(new NoopLogger()));
    await expect(system.terminate()).resolves.toBeUndefined();
  });

  it('survives a logger whose close rejects', async () => {
    const failing: LogSink = {
      name: 'failing',
      minLevel: LogLevel.Debug,
      write() {},
      async close() { throw new Error('drain failed'); },
    };
    const system = ActorSystem.create('logging-reject', ActorSystemOptions.create().withLogSinks([failing]));

    await expect(system.terminate()).resolves.toBeUndefined();
    expect(system.isTerminated).toBe(true);
  });
});

describe('actor logging through the pipeline', () => {
  it('stamps the actor path as the record source', async () => {
    const sink = new RecordingSink();
    const system = ActorSystem.create('logging-actors', ActorSystemOptions.create().withLogSinks([sink]));

    system.log.withSource('actor-ts://logging-actors/user/order').info('from an actor');
    await system.terminate();

    const record = sink.records.find((r) => r.message === 'from an actor');
    expect(record?.source).toBe('actor-ts://logging-actors/user/order');
  });
});

type OtlpAttribute = { readonly key: string; readonly value: { readonly stringValue: string } };
type OtlpLogRecord = { readonly body: { readonly stringValue: string } };

/** The part of an OTLP `ExportLogsServiceRequest` these tests read. */
type OtlpExportRequest = {
  readonly resourceLogs: ReadonlyArray<{
    readonly resource: { readonly attributes: readonly OtlpAttribute[] };
    readonly scopeLogs: ReadonlyArray<{ readonly logRecords: readonly OtlpLogRecord[] }>;
  }>;
};

type PostedExport = {
  readonly url: string;
  readonly contentEncoding: string | undefined;
  readonly body: OtlpExportRequest;
};

/**
 * What the OTLP sink sent, read off a stubbed global `fetch`.  A sink built
 * from HOCON has no `fetchFn` — config cannot carry a function — so it takes
 * the global one, and the request it makes is what a collector would see.
 */
let posted: PostedExport[] = [];
const realFetch = globalThis.fetch;

function recordPosts(): void {
  posted = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    const raw = init.body as string | Uint8Array;
    const text = headers['content-encoding'] === 'gzip'
      ? gunzipSync(raw as Uint8Array).toString('utf8')
      : typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    posted.push({
      url: String(url),
      contentEncoding: headers['content-encoding'],
      body: JSON.parse(text) as OtlpExportRequest,
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}

/** `service.name` of every resource in every request, deduplicated. */
function serviceNamesPosted(): string[] {
  const names = posted.flatMap((request) => request.body.resourceLogs.map((resourceLog) =>
    resourceLog.resource.attributes.find((attribute) => attribute.key === 'service.name')?.value.stringValue
      ?? '(no service.name)'));
  return [...new Set(names)];
}

function messagesPosted(): string[] {
  return posted.flatMap((request) => request.body.resourceLogs.flatMap((resourceLog) =>
    resourceLog.scopeLogs.flatMap((scopeLog) => scopeLog.logRecords.map((logRecord) => logRecord.body.stringValue))));
}

/** Log one line, deliver it, and stop the system whatever happens. */
async function logAndTerminate(system: ActorSystem, message: string): Promise<void> {
  try {
    expect(system.log).toBeInstanceOf(MultiSinkLogger);
    system.log.info(message);
    await (system.log as MultiSinkLogger).flush();
  } finally {
    await system.terminate();
  }
}

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** The first `hocon` fence under a page's `## OTLP` heading — the block a reader copies. */
function otlpHoconSampleOf(page: string): string {
  const text = readFileSync(join(DOCS_ROOT, page), 'utf8');
  const section = text.split(/\r?\n## /).find((part) => part.startsWith('OTLP'));
  const fence = section?.match(/```hocon\r?\n([\s\S]*?)\r?\n```/);
  if (fence === undefined || fence === null) throw new Error(`${page}: no hocon sample under the OTLP heading`);
  return fence[1]!;
}

describe('the OTLP sink enabled from HOCON alone', () => {
  beforeEach(recordPosts);
  afterEach(() => { globalThis.fetch = realFetch; });

  it('starts with nothing but enabled = true, and sends the system name as service.name', async () => {
    // The whole user config.  reference.conf ships `service-name = ""` as the
    // key's placeholder; read as a value, it made this one line throw at
    // ActorSystem.create, before any record could be sent.
    const systemOptions = ActorSystemOptions.create()
      .withConfig(Config.parseString('actor-ts.logger.sinks.otlp.enabled = true'));
    const system = ActorSystem.create('checkout', systemOptions);

    await logAndTerminate(system, 'placing order');

    expect(messagesPosted()).toContain('placing order');
    expect([...new Set(posted.map((request) => request.url))]).toEqual(['http://localhost:4318/v1/logs']);
    expect(serviceNamesPosted()).toEqual(['checkout']);
  });

  it('keeps a service-name set in HOCON', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withConfig(Config.parseString('actor-ts.logger.sinks.otlp { enabled = true, service-name = "checkout-api" }'));
    const system = ActorSystem.create('checkout', systemOptions);

    await logAndTerminate(system, 'placing order');

    expect(messagesPosted()).toContain('placing order');
    expect(serviceNamesPosted()).toEqual(['checkout-api']);
  });

  it('runs the sample on the integrations page as written', async () => {
    const sample = otlpHoconSampleOf('observability/logging/integrations.mdx');
    // The German page carries the same block, so this runs both.
    expect(otlpHoconSampleOf('de/observability/logging/integrations.mdx')).toBe(sample);
    const system = ActorSystem.create('orders', ActorSystemOptions.create().withConfig(Config.parseString(sample)));

    await logAndTerminate(system, 'placing order');

    // What the page promises: its url, gzip on, and service.name taken from
    // the system's name, as in the request it prints.
    expect(messagesPosted()).toContain('placing order');
    expect([...new Set(posted.map((request) => request.url))]).toEqual(['http://collector:4318/v1/logs']);
    expect([...new Set(posted.map((request) => request.contentEncoding))]).toEqual(['gzip']);
    expect(serviceNamesPosted()).toEqual(['orders']);
  });
});
