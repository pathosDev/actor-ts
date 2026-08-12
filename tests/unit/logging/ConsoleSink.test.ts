import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { ConsoleSink } from '../../../src/logging/ConsoleSink.js';
import { ConsoleSinkOptions } from '../../../src/logging/ConsoleSinkOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';

const TIMESTAMP_MS = Date.UTC(2026, 7, 12, 9, 41, 2, 113);

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs: TIMESTAMP_MS,
    level: LogLevel.Info,
    message: 'placing order',
    fields: {},
    ...overrides,
  };
}

type Call = { method: string; args: unknown[] };
let calls: Call[] = [];
let stdout: string[] = [];
let stderr: string[] = [];

const originalConsole = {
  debug: console.debug,
  log: console.log,
  warn: console.warn,
  error: console.error,
};
const originalWrite = { stdout: process.stdout.write, stderr: process.stderr.write };

beforeEach(() => {
  calls = [];
  stdout = [];
  stderr = [];
  for (const method of ['debug', 'log', 'warn', 'error'] as const) {
    console[method] = ((...args: unknown[]) => { calls.push({ method, args }); }) as typeof console.log;
  }
  process.stdout.write = ((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
});

afterEach(() => {
  Object.assign(console, originalConsole);
  process.stdout.write = originalWrite.stdout;
  process.stderr.write = originalWrite.stderr;
});

describe('ConsoleSink defaults', () => {
  it('is named console and starts at info', () => {
    const sink = new ConsoleSink();
    expect(sink.name).toBe('console');
    expect(sink.minLevel).toBe(LogLevel.Info);
  });
});

describe('ConsoleSink text format', () => {
  it('routes each level to the matching console method', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.Debug });
    sink.write(record({ level: LogLevel.Debug }));
    sink.write(record({ level: LogLevel.Info }));
    sink.write(record({ level: LogLevel.Warn }));
    sink.write(record({ level: LogLevel.Error }));

    expect(calls.map((call) => call.method)).toEqual(['debug', 'log', 'warn', 'error']);
  });

  it('writes the ConsoleLogger line layout', () => {
    new ConsoleSink().write(record({ source: 'actor-ts://app/user/order', fields: { correlationId: 'abc' } }));

    expect(calls[0]!.args[0]).toBe(
      '[2026-08-12T09:41:02.113Z] INFO  actor-ts://app/user/order - placing order {correlationId=abc}',
    );
  });

  it('passes arguments through untouched so the console can inspect them', () => {
    const error = new Error('boom');
    const payload = { attempt: 2 };
    new ConsoleSink().write(record({ args: [error, payload] }));

    // Identity matters: a normalised Error would lose its console rendering.
    expect(calls[0]!.args[1]).toBe(error);
    expect(calls[0]!.args[2]).toBe(payload);
  });

  it('renders arguments into the line when writing to an explicit stream', () => {
    new ConsoleSink({ stream: 'stderr' }).write(record({ args: [new Error('boom'), { attempt: 2 }] }));

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('placing order');
    expect(stderr[0]).toContain('"message":"boom"');
    expect(stderr[0]).toContain('{"attempt":2}');
    expect(stderr[0]).toEndWith('\n');
    expect(calls).toHaveLength(0);
  });
});

describe('ConsoleSink json format', () => {
  it('writes one NDJSON object to stdout', () => {
    new ConsoleSink({ format: 'json' }).write(record({ source: 'src', fields: { correlationId: 'abc' } }));

    expect(stdout).toEqual([
      '{"ts":"2026-08-12T09:41:02.113Z","level":"info","source":"src","msg":"placing order","correlationId":"abc"}\n',
    ]);
    expect(calls).toHaveLength(0);
  });

  it('keeps every level on one stream so the NDJSON stays parseable', () => {
    const sink = new ConsoleSink({ format: 'json', minLevel: LogLevel.Debug });
    sink.write(record({ level: LogLevel.Debug }));
    sink.write(record({ level: LogLevel.Error }));

    expect(stdout).toHaveLength(2);
    expect(stderr).toHaveLength(0);
  });

  it('honours an explicit stderr stream', () => {
    new ConsoleSink({ format: 'json', stream: 'stderr' }).write(record());

    expect(stderr).toHaveLength(1);
    expect(stdout).toHaveLength(0);
  });

  it('normalises an Error argument instead of emitting an empty object', () => {
    new ConsoleSink({ format: 'json' }).write(record({ args: [new Error('boom')] }));

    const parsed = JSON.parse(stdout[0]!);
    expect(parsed.args[0].message).toBe('boom');
  });
});

describe('ConsoleSink resilience', () => {
  it('never throws, even when the console does', () => {
    console.log = (() => { throw new Error('console gone'); }) as typeof console.log;
    expect(() => new ConsoleSink().write(record())).not.toThrow();
  });
});

describe('ConsoleSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = ConsoleSinkOptions.create()
      .withMinLevel(LogLevel.Warn)
      .withFormat('json');

    expect(new ConsoleSink(options).minLevel).toBe(LogLevel.Warn);
  });

  it('rejects an unknown format', () => {
    expect(() => new ConsoleSink({ format: 'yaml' as 'json' })).toThrow(OptionsError);
  });

  it('rejects an unknown stream', () => {
    expect(() => new ConsoleSink({ stream: 'file' as 'stdout' })).toThrow(OptionsError);
  });
});
