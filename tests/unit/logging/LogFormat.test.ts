import { describe, expect, it, afterEach } from 'bun:test';
import {
  ConsoleLogger,
  DISPLAY_NAME_FIELD,
  JsonLogger,
  LogLevel,
  type JsonLogSink,
} from '../../../src/Logger.js';
import { LogContext, type LogContextData } from '../../../src/LogContext.js';
import { formatJsonLine, formatTextLine } from '../../../src/logging/LogFormat.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';

/**
 * The point of these tests is parity: `formatTextLine` / `formatJsonLine`
 * must render what `ConsoleLogger` / `JsonLogger` render, because a
 * deployment switching to a multi-sink logger keeps whatever parses those
 * lines today.  Each parity case therefore builds the record the pipeline
 * *would* build and compares against the legacy logger's real output.
 */

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

/** Drop the `[timestamp]` head so a real-clock logger can be compared. */
function withoutTimestamp(line: string): string {
  return line.replace(/^\[[^\]]+\]/, '[ts]');
}

/** Capture what `ConsoleLogger` passes to `console.*` for one call. */
function consoleLoggerLine(
  level: LogLevel,
  source: string,
  staticFields: LogContextData,
  message: string,
): string {
  const captured: string[] = [];
  const methods = ['debug', 'log', 'warn', 'error'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = ((line: string) => { captured.push(line); }) as typeof console.log;
  }
  try {
    const logger = new ConsoleLogger(LogLevel.Debug, source, staticFields);
    if (level === LogLevel.Debug) logger.debug(message);
    else if (level === LogLevel.Info) logger.info(message);
    else if (level === LogLevel.Warn) logger.warn(message);
    else logger.error(message);
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]!; });
  }
  return captured[0]!;
}

/** Capture the NDJSON line `JsonLogger` writes for one call. */
function jsonLoggerLine(
  source: string,
  staticFields: LogContextData,
  message: string,
  args: unknown[],
): string {
  const lines: string[] = [];
  const sink: JsonLogSink = { write: (line) => { lines.push(line); } };
  const logger = new JsonLogger(LogLevel.Debug, source, staticFields, sink);
  logger.info(message, ...args);
  return lines[0]!.slice(0, -1); // strip the '\n' JsonLogger appends
}

describe('formatTextLine', () => {
  it('renders the bare line without a source or fields', () => {
    expect(formatTextLine(record())).toBe('[2026-08-12T09:41:02.113Z] INFO  placing order');
  });

  it('renders source, display name and the field suffix', () => {
    const line = formatTextLine(record({
      source: 'actor-ts://app/user/order',
      displayName: 'Order 42',
      fields: { [DISPLAY_NAME_FIELD]: 'Order 42', correlationId: 'abc' },
    }));
    expect(line).toBe(
      '[2026-08-12T09:41:02.113Z] INFO  actor-ts://app/user/order - Order 42 - placing order {correlationId=abc}',
    );
  });

  it('pads the level tag to a fixed width, like ConsoleLogger', () => {
    expect(formatTextLine(record({ level: LogLevel.Warn }))).toContain('] WARN  placing');
    expect(formatTextLine(record({ level: LogLevel.Error }))).toContain('] ERROR placing');
  });

  it('formats non-string field values', () => {
    const line = formatTextLine(record({ fields: { attempts: 3, retried: true } }));
    expect(line).toEndWith('{attempts=3, retried=true}');
  });

  it('keeps a dynamic display name in the suffix when it differs from the static one', () => {
    const line = formatTextLine(record({
      source: 'actor-ts://app/user/order',
      displayName: 'Order 42',
      fields: { [DISPLAY_NAME_FIELD]: 'spoofed' },
    }));
    expect(line).toContain('- Order 42 - placing order');
    expect(line).toEndWith('{displayName=spoofed}');
  });

  it('keeps a display name that was never lifted (dynamic only)', () => {
    const line = formatTextLine(record({ fields: { [DISPLAY_NAME_FIELD]: 'remote' } }));
    expect(line).toBe('[2026-08-12T09:41:02.113Z] INFO  placing order {displayName=remote}');
  });

  describe('parity with ConsoleLogger', () => {
    it('matches for a plain record', () => {
      expect(withoutTimestamp(formatTextLine(record()))).toBe(
        withoutTimestamp(consoleLoggerLine(LogLevel.Info, '', {}, 'placing order')),
      );
    });

    it('matches with a source', () => {
      const source = 'actor-ts://app/user/order';
      expect(withoutTimestamp(formatTextLine(record({ source })))).toBe(
        withoutTimestamp(consoleLoggerLine(LogLevel.Info, source, {}, 'placing order')),
      );
    });

    it('matches with a source, a display name and static fields', () => {
      const source = 'actor-ts://app/user/order';
      const staticFields = { [DISPLAY_NAME_FIELD]: 'Order 42', shardId: 7 };
      expect(withoutTimestamp(formatTextLine(record({
        source,
        displayName: 'Order 42',
        fields: staticFields,
      })))).toBe(
        withoutTimestamp(consoleLoggerLine(LogLevel.Info, source, staticFields, 'placing order')),
      );
    });

    it('matches for every level', () => {
      for (const level of [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error]) {
        expect(withoutTimestamp(formatTextLine(record({ level })))).toBe(
          withoutTimestamp(consoleLoggerLine(level, '', {}, 'placing order')),
        );
      }
    });

    it('matches when the MDC contributes fields', () => {
      const staticFields = { component: 'orders' };
      const dynamic = { correlationId: 'abc-123' };
      const line = LogContext.run(dynamic, () =>
        consoleLoggerLine(LogLevel.Info, 'src', staticFields, 'placing order'));
      expect(withoutTimestamp(formatTextLine(record({
        source: 'src',
        fields: { ...staticFields, ...dynamic },
      })))).toBe(withoutTimestamp(line));
    });
  });
});

describe('formatJsonLine', () => {
  it('emits ts, level, source, msg and the merged fields in order', () => {
    const line = formatJsonLine(record({
      source: 'actor-ts://app/user/order',
      fields: { correlationId: 'abc' },
    }));
    expect(line).toBe(
      '{"ts":"2026-08-12T09:41:02.113Z","level":"info","source":"actor-ts://app/user/order",'
      + '"msg":"placing order","correlationId":"abc"}',
    );
  });

  it('omits source when unbound and args when there are none', () => {
    const parsed = JSON.parse(formatJsonLine(record()));
    expect(parsed).toEqual({ ts: '2026-08-12T09:41:02.113Z', level: 'info', msg: 'placing order' });
  });

  it('appends no trailing newline — the sink owns the delimiter', () => {
    expect(formatJsonLine(record())).not.toEndWith('\n');
  });

  it('serialises an Error argument as name/message/stack', () => {
    const parsed = JSON.parse(formatJsonLine(record({ args: [new Error('boom')] })));
    expect(parsed.args[0].name).toBe('Error');
    expect(parsed.args[0].message).toBe('boom');
    expect(typeof parsed.args[0].stack).toBe('string');
  });

  it('survives BigInt, circular and function values', () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular['self'] = circular;
    const parsed = JSON.parse(formatJsonLine(record({
      args: [{ big: 10n, fn: () => {}, circular }],
    })));
    expect(parsed.args[0].big).toBe('10');
    expect(parsed.args[0]).not.toHaveProperty('fn');
    expect(parsed.args[0].circular.self).toBe('[Circular]');
  });

  describe('parity with JsonLogger', () => {
    it('matches key order and values for a full record', () => {
      const source = 'actor-ts://app/user/order';
      const staticFields = { component: 'orders', shardId: 7 };
      const dynamic = { correlationId: 'abc-123' };
      const legacy = LogContext.run(dynamic, () =>
        jsonLoggerLine(source, staticFields, 'placing order', [{ items: 42 }]));
      const mine = formatJsonLine(record({
        source,
        fields: { ...staticFields, ...dynamic },
        args: [{ items: 42 }],
      }));
      // Same keys, same order — a parser that reads positionally keeps working.
      expect(Object.keys(JSON.parse(mine))).toEqual(Object.keys(JSON.parse(legacy)));
      const stripTimestamp = (line: string) => line.replace(/"ts":"[^"]+"/, '"ts":"[ts]"');
      expect(stripTimestamp(mine)).toBe(stripTimestamp(legacy));
    });

    it('matches for a record without source or fields', () => {
      const legacy = jsonLoggerLine('', {}, 'placing order', []);
      const stripTimestamp = (line: string) => line.replace(/"ts":"[^"]+"/, '"ts":"[ts]"');
      expect(stripTimestamp(formatJsonLine(record()))).toBe(stripTimestamp(legacy));
    });
  });
});

afterEach(() => {
  // The console-capture helper restores in a finally, but a failed
  // expectation inside it would otherwise leave a patched console behind.
  expect(typeof console.log).toBe('function');
});
