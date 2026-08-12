import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DISPLAY_NAME_FIELD, LogLevel } from '../../../src/Logger.js';
import { LogContext } from '../../../src/LogContext.js';
import { MultiSinkLogger } from '../../../src/logging/MultiSinkLogger.js';
import { MultiSinkLoggerOptions } from '../../../src/logging/MultiSinkLoggerOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import type { LogSink, LogSinkContext } from '../../../src/logging/LogSink.js';

/** A sink that just remembers what it was given. */
class RecordingSink implements LogSink {
  readonly records: LogRecord[] = [];
  readonly contexts: LogSinkContext[] = [];
  flushes = 0;
  closes = 0;

  constructor(readonly name = 'recording', readonly minLevel: LogLevel = LogLevel.Debug) {}

  write(record: LogRecord): void { this.records.push(record); }
  attach(context: LogSinkContext): void { this.contexts.push(context); }
  async flush(): Promise<void> { this.flushes += 1; }
  async close(): Promise<void> { this.closes += 1; }
}

let consoleErrors: unknown[][] = [];
let consoleLines: unknown[][] = [];
const originals = {
  error: console.error,
  warn: console.warn,
  log: console.log,
  debug: console.debug,
};

beforeEach(() => {
  consoleErrors = [];
  consoleLines = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
  console.warn = ((...args: unknown[]) => { consoleLines.push(args); }) as typeof console.warn;
  console.log = ((...args: unknown[]) => { consoleLines.push(args); }) as typeof console.log;
  console.debug = ((...args: unknown[]) => { consoleLines.push(args); }) as typeof console.debug;
});

afterEach(() => {
  console.error = originals.error;
  console.warn = originals.warn;
  console.log = originals.log;
  console.debug = originals.debug;
});

describe('MultiSinkLogger fan-out', () => {
  it('delivers one record to every sink', () => {
    const first = new RecordingSink('first');
    const second = new RecordingSink('second');
    const logger = new MultiSinkLogger({ sinks: [first, second] });

    logger.info('placing order');

    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    // The same object: sinks share it, which is why records are immutable.
    expect(first.records[0]).toBe(second.records[0]!);
    expect(first.records[0]!.message).toBe('placing order');
    expect(first.records[0]!.level).toBe(LogLevel.Info);
  });

  it('applies each sink’s own minimum level', () => {
    const verbose = new RecordingSink('verbose', LogLevel.Debug);
    const quiet = new RecordingSink('quiet', LogLevel.Error);
    const logger = new MultiSinkLogger({ sinks: [verbose, quiet] });

    logger.debug('noisy');
    logger.error('broken');

    expect(verbose.records.map((r) => r.message)).toEqual(['noisy', 'broken']);
    expect(quiet.records.map((r) => r.message)).toEqual(['broken']);
  });

  it('gates at the lowest sink level when no floor is configured', () => {
    const logger = new MultiSinkLogger({
      sinks: [new RecordingSink('a', LogLevel.Warn), new RecordingSink('b', LogLevel.Debug)],
    });
    expect(logger.level).toBe(LogLevel.Debug);
  });

  it('lets an explicit floor override a more permissive sink', () => {
    const sink = new RecordingSink('a', LogLevel.Debug);
    const logger = new MultiSinkLogger({ sinks: [sink], level: LogLevel.Warn });

    expect(logger.level).toBe(LogLevel.Warn);
    logger.info('suppressed');
    logger.warn('kept');
    expect(sink.records.map((r) => r.message)).toEqual(['kept']);
  });

  it('never lowers the gate below what the sinks accept', () => {
    // level=Debug with an Info-only sink would build records nobody wants.
    const logger = new MultiSinkLogger({
      sinks: [new RecordingSink('a', LogLevel.Info)],
      level: LogLevel.Debug,
    });
    expect(logger.level).toBe(LogLevel.Info);
  });

  it('reports Off for an empty sink list', () => {
    expect(new MultiSinkLogger({ sinks: [] }).level).toBe(LogLevel.Off);
  });
});

describe('MultiSinkLogger record building', () => {
  it('captures the MDC synchronously, so a deferred sink still sees it', async () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({ sinks: [sink] });

    LogContext.run({ correlationId: 'abc-123' }, () => { logger.info('inside'); });
    // By now the async context is gone — the record must still carry it.
    await Promise.resolve();

    expect(sink.records[0]!.fields).toEqual({ correlationId: 'abc-123' });
    expect(LogContext.get()).toEqual({});
  });

  it('merges static fields under the MDC, dynamic winning', () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({ sinks: [sink] }).withFields({ tenant: 'static', shardId: 7 });

    LogContext.run({ tenant: 'dynamic' }, () => { logger.info('m'); });

    expect(sink.records[0]!.fields).toEqual({ tenant: 'dynamic', shardId: 7 });
  });

  it('lifts the display name from static fields only', () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({ sinks: [sink] }).withFields({ [DISPLAY_NAME_FIELD]: 'Order 42' });

    logger.info('a');
    LogContext.run({ [DISPLAY_NAME_FIELD]: 'spoofed' }, () => {
      new MultiSinkLogger({ sinks: [sink] }).info('b');
    });

    expect(sink.records[0]!.displayName).toBe('Order 42');
    // A name that only ever arrived over the wire never names a local actor.
    expect(sink.records[1]!.displayName).toBeUndefined();
    expect(sink.records[1]!.fields[DISPLAY_NAME_FIELD]).toBe('spoofed');
  });

  it('keeps positional arguments raw', () => {
    const sink = new RecordingSink();
    const error = new Error('boom');
    new MultiSinkLogger({ sinks: [sink] }).error('failed', error, { attempt: 2 });

    expect(sink.records[0]!.args?.[0]).toBe(error);
    expect(sink.records[0]!.args?.[1]).toEqual({ attempt: 2 });
  });

  it('omits source and args when there are none', () => {
    const sink = new RecordingSink();
    new MultiSinkLogger({ sinks: [sink] }).info('bare');

    expect(sink.records[0]).not.toHaveProperty('source');
    expect(sink.records[0]).not.toHaveProperty('args');
  });

  it('binds the source through withSource', () => {
    const sink = new RecordingSink();
    new MultiSinkLogger({ sinks: [sink] }).withSource('actor-ts://app/user/order').info('m');

    expect(sink.records[0]!.source).toBe('actor-ts://app/user/order');
  });
});

describe('MultiSinkLogger views', () => {
  it('shares one pipeline, so attach and close happen once', async () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({ sinks: [sink] });
    const derived = logger.withSource('a').withFields({ x: 1 }).withSource('b');

    logger.attach({ systemName: 'app' });
    derived.info('m');
    await logger.close();

    expect(sink.contexts).toHaveLength(1);
    expect(sink.closes).toBe(1);
    expect(sink.records[0]!.source).toBe('b');
  });

  it('does not leak attach/close onto derived views', () => {
    const logger = new MultiSinkLogger({ sinks: [new RecordingSink()] });
    const derived = logger.withSource('a') as unknown as Record<string, unknown>;

    expect(derived['attach']).toBeUndefined();
    expect(derived['close']).toBeUndefined();
  });

  it('reports the pipeline level from a view', () => {
    const logger = new MultiSinkLogger({ sinks: [new RecordingSink('a', LogLevel.Warn)] });
    expect(logger.withSource('x').level).toBe(LogLevel.Warn);
  });
});

describe('MultiSinkLogger failure isolation', () => {
  it('keeps delivering to the other sinks when one throws', () => {
    const broken: LogSink = {
      name: 'broken',
      minLevel: LogLevel.Debug,
      write() { throw new Error('sink down'); },
    };
    const healthy = new RecordingSink('healthy');
    const logger = new MultiSinkLogger({ sinks: [broken, healthy] });

    expect(() => logger.info('m')).not.toThrow();
    expect(healthy.records).toHaveLength(1);
    expect(logger.droppedCount).toBe(1);
    expect(String(consoleErrors[0]?.[0])).toContain('log sink "broken"');
    expect(String(consoleErrors[0]?.[0])).toContain('sink down');
  });

  it('rate-limits the report so a broken sink cannot flood the console', () => {
    const broken: LogSink = {
      name: 'broken',
      minLevel: LogLevel.Debug,
      write() { throw new Error('sink down'); },
    };
    const logger = new MultiSinkLogger({ sinks: [broken] });

    for (let i = 0; i < 50; i += 1) logger.info('m');

    expect(consoleErrors).toHaveLength(1);
    expect(logger.droppedCount).toBe(50);
  });

  it('survives a sink that throws from attach', () => {
    const broken: LogSink = {
      name: 'broken',
      minLevel: LogLevel.Debug,
      write() {},
      attach() { throw new Error('no scheduler for you'); },
    };
    const logger = new MultiSinkLogger({ sinks: [broken] });

    expect(() => logger.attach({ systemName: 'app' })).not.toThrow();
    expect(String(consoleErrors[0]?.[0])).toContain('attach threw');
  });

  it('bounds a sink that hangs on close', async () => {
    const hanging: LogSink = {
      name: 'hanging',
      minLevel: LogLevel.Debug,
      write() {},
      close() { return new Promise<void>(() => {}); },
    };
    const healthy = new RecordingSink('healthy');
    const logger = new MultiSinkLogger({ sinks: [hanging, healthy], closeTimeoutMs: 20 });

    await logger.close();

    expect(healthy.closes).toBe(1);
    expect(String(consoleErrors[0]?.[0])).toContain('close timed out');
  });

  it('reports a close that rejects without failing the shutdown', async () => {
    const failing: LogSink = {
      name: 'failing',
      minLevel: LogLevel.Debug,
      write() {},
      async close() { throw new Error('flush failed'); },
    };
    const logger = new MultiSinkLogger({ sinks: [failing] });

    await expect(logger.close()).resolves.toBeUndefined();
    expect(String(consoleErrors[0]?.[0])).toContain('close failed');
  });
});

describe('MultiSinkLogger close', () => {
  it('is idempotent', async () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({ sinks: [sink] });

    await Promise.all([logger.close(), logger.close()]);
    await logger.close();

    expect(sink.closes).toBe(1);
  });

  it('routes records logged after close to the console instead of dropping them', async () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({ sinks: [sink] });

    await logger.close();
    logger.info('after close');
    logger.error('bad news');

    expect(sink.records).toHaveLength(0);
    expect(String(consoleLines[0]?.[0])).toContain('after close');
    expect(String(consoleErrors[0]?.[0])).toContain('bad news');
  });

  it('flushes every sink', async () => {
    const first = new RecordingSink('first');
    const second = new RecordingSink('second');
    const logger = new MultiSinkLogger({ sinks: [first, second] });

    await logger.flush();

    expect(first.flushes).toBe(1);
    expect(second.flushes).toBe(1);
  });
});

describe('MultiSinkLogger transform', () => {
  it('rewrites records before fan-out', () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({
      sinks: [sink],
      transform: (record) => ({ ...record, message: record.message.replace(/secret-\w+/, '[redacted]') }),
    });

    logger.info('token secret-abc123 leaked');

    expect(sink.records[0]!.message).toBe('token [redacted] leaked');
  });

  it('drops a record when the transform returns null', () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({
      sinks: [sink],
      transform: (record) => (record.fields['internal'] === true ? null : record),
    });

    logger.withFields({ internal: true }).info('hidden');
    logger.info('kept');

    expect(sink.records.map((r) => r.message)).toEqual(['kept']);
  });

  it('keeps the record and reports when the transform throws', () => {
    const sink = new RecordingSink();
    const logger = new MultiSinkLogger({
      sinks: [sink],
      transform: () => { throw new Error('bad hook'); },
    });

    expect(() => logger.info('m')).not.toThrow();
    expect(sink.records).toHaveLength(1);
    expect(String(consoleErrors[0]?.[0])).toContain('transform threw');
  });
});

describe('MultiSinkLoggerOptions', () => {
  it('accepts the fluent builder', () => {
    const sink = new RecordingSink();
    const options = MultiSinkLoggerOptions.create()
      .withSinks([sink])
      .withLevel(LogLevel.Warn)
      .withCloseTimeoutMs(500);

    expect(new MultiSinkLogger(options).level).toBe(LogLevel.Warn);
  });

  it('rejects an object that is not a sink', () => {
    expect(() => new MultiSinkLogger({ sinks: [{ name: 'x' } as unknown as LogSink] }))
      .toThrow(OptionsError);
  });

  it('rejects a non-positive close timeout', () => {
    expect(() => new MultiSinkLogger({ sinks: [], closeTimeoutMs: 0 })).toThrow(OptionsError);
  });
});
