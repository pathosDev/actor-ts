import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
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
