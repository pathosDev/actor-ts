import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { ConsoleLogger, LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { ConsoleSink } from '../../../src/logging/ConsoleSink.js';
import { FileSink } from '../../../src/logging/FileSink.js';
import { GelfSink } from '../../../src/logging/GelfSink.js';
import { LokiSink } from '../../../src/logging/LokiSink.js';
import { MultiSinkLogger } from '../../../src/logging/MultiSinkLogger.js';
import { OtlpHttpSink } from '../../../src/logging/OtlpHttpSink.js';
import { ParseableSink } from '../../../src/logging/ParseableSink.js';
import { SeqSink } from '../../../src/logging/SeqSink.js';
import { SplunkSink } from '../../../src/logging/SplunkSink.js';
import { SyslogSink } from '../../../src/logging/SyslogSink.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import type { LogSink, LogSinkContext } from '../../../src/logging/LogSink.js';

/**
 * How the sinks reach — and leave — a running system: construction
 * precedence, the `attach` that hands them the scheduler, the flush
 * `terminate()` owes them, and the sink each `actor-ts.logger.sinks.*`
 * block builds.
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

/**
 * The sinks a {@link MultiSinkLogger} fans out to.  The logger keeps them
 * private — a view must not hand them out — so this reads the runtime field,
 * and throws rather than answering `[]` when that field moves: an empty list
 * would let a test about a missing sink pass for the wrong reason.
 */
function sinksOf(log: Logger): readonly LogSink[] {
  expect(log).toBeInstanceOf(MultiSinkLogger);
  const targets = (log as unknown as { pipeline?: { targets?: unknown } }).pipeline?.targets;
  if (!Array.isArray(targets)) {
    throw new Error('MultiSinkLogger no longer keeps its sinks at pipeline.targets; update sinksOf()');
  }
  return targets.map((target: { sink: LogSink }) => target.sink);
}

/** One `actor-ts.logger.sinks.*` block and the sink class it has to build. */
type SinkBlockCase = {
  readonly block: string;
  readonly sinkClass: abstract new (...args: never[]) => LogSink;
  /** Leaves the sink cannot start without, beyond `enabled`. */
  readonly requiredLeaves: (directory: string) => string;
};

const NOTHING_REQUIRED = (): string => '';

/**
 * Every block the reference ships.  The four remote sinks without a default
 * endpoint refuse to start without a url (and Splunk without its token), and
 * the file sink is pointed at a temporary directory so nothing lands in the
 * working tree.
 */
const SINK_BLOCK_CASES: readonly SinkBlockCase[] = [
  { block: 'console', sinkClass: ConsoleSink, requiredLeaves: NOTHING_REQUIRED },
  { block: 'file', sinkClass: FileSink, requiredLeaves: (directory) => `directory = ${JSON.stringify(directory)}` },
  { block: 'gelf', sinkClass: GelfSink, requiredLeaves: NOTHING_REQUIRED },
  { block: 'loki', sinkClass: LokiSink, requiredLeaves: () => 'url = "http://127.0.0.1:3100"' },
  { block: 'otlp', sinkClass: OtlpHttpSink, requiredLeaves: NOTHING_REQUIRED },
  { block: 'parseable', sinkClass: ParseableSink, requiredLeaves: () => 'url = "http://127.0.0.1:8000"' },
  { block: 'seq', sinkClass: SeqSink, requiredLeaves: () => 'url = "http://127.0.0.1:5341"' },
  {
    block: 'splunk',
    sinkClass: SplunkSink,
    requiredLeaves: () => 'url = "https://127.0.0.1:8088", token = "example-hec-token"',
  },
  { block: 'syslog', sinkClass: SyslogSink, requiredLeaves: NOTHING_REQUIRED },
];

describe('every sink block builds its sink from HOCON alone', () => {
  let directory = '';

  beforeEach(() => {
    // No sink here should send anything — min-level is `error` and nothing
    // logs at error — but an HTTP sink that did would reach this stub, not
    // the network.
    recordPosts();
    directory = mkdtempSync(join(tmpdir(), 'logger-wiring-'));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(directory, { recursive: true, force: true });
  });

  it('covers every block the reference ships', () => {
    const shipped = Object.keys(Config.parseString(REFERENCE_CONF).getObject('actor-ts.logger.sinks'));
    expect(SINK_BLOCK_CASES.map((sinkCase) => sinkCase.block).sort()).toEqual(shipped.sort());
  });

  for (const sinkCase of SINK_BLOCK_CASES) {
    it(`actor-ts.logger.sinks.${sinkCase.block} builds its ${sinkCase.sinkClass.name}`, async () => {
      // `min-level = "error"` is not what the reference ships, so only this
      // block's own reader can have handed it to the sink — a branch reading
      // a neighbour's block, or none, would build it at `info`.
      const leaves = ['enabled = true', 'min-level = "error"', sinkCase.requiredLeaves(directory)]
        .filter((leaf) => leaf !== '')
        .join(', ');
      const systemOptions = ActorSystemOptions.create()
        .withConfig(Config.parseString(`actor-ts.logger.sinks.${sinkCase.block} { ${leaves} }`));
      const system = ActorSystem.create(`wiring-${sinkCase.block}`, systemOptions);
      try {
        const sinks = sinksOf(system.log);
        expect(sinks.map((sink) => sink.name)).toEqual([sinkCase.block]);
        expect(sinks[0]).toBeInstanceOf(sinkCase.sinkClass);
        expect(sinks[0]!.minLevel).toBe(LogLevel.Error);
      } finally {
        await system.terminate();
      }
    });
  }
});
