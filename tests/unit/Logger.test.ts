import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ConsoleLogger, JsonLogger, LogLevel, NoopLogger, type JsonLogSink } from '../../src/Logger.js';
import { LogContext } from '../../src/LogContext.js';

describe('LogLevel', () => {
  test('orders numerically Debug < Info < Warn < Error < Off', () => {
    expect(LogLevel.Debug).toBeLessThan(LogLevel.Info);
    expect(LogLevel.Info).toBeLessThan(LogLevel.Warn);
    expect(LogLevel.Warn).toBeLessThan(LogLevel.Error);
    expect(LogLevel.Error).toBeLessThan(LogLevel.Off);
  });
});

describe('ConsoleLogger', () => {
  const originals = {
    debug: console.debug,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  let debugCalls: unknown[][];
  let infoCalls: unknown[][];
  let warnCalls: unknown[][];
  let errorCalls: unknown[][];

  beforeEach(() => {
    debugCalls = []; infoCalls = []; warnCalls = []; errorCalls = [];
    console.debug = (...args: unknown[]) => { debugCalls.push(args); };
    console.log = (...args: unknown[]) => { infoCalls.push(args); };
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
  });

  afterEach(() => {
    console.debug = originals.debug;
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  });

  test('default level is Info — debug is filtered, info/warn/error pass', () => {
    const log = new ConsoleLogger();
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(debugCalls.length).toBe(0);
    expect(infoCalls.length).toBe(1);
    expect(warnCalls.length).toBe(1);
    expect(errorCalls.length).toBe(1);
  });

  test('Debug level passes every severity', () => {
    const log = new ConsoleLogger(LogLevel.Debug);
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(debugCalls.length).toBe(1);
    expect(infoCalls.length).toBe(1);
    expect(warnCalls.length).toBe(1);
    expect(errorCalls.length).toBe(1);
  });

  test('Off level swallows everything', () => {
    const log = new ConsoleLogger(LogLevel.Off);
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(debugCalls.length).toBe(0);
    expect(infoCalls.length).toBe(0);
    expect(warnCalls.length).toBe(0);
    expect(errorCalls.length).toBe(0);
  });

  test('Error level passes only error', () => {
    const log = new ConsoleLogger(LogLevel.Error);
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(debugCalls.length).toBe(0);
    expect(infoCalls.length).toBe(0);
    expect(warnCalls.length).toBe(0);
    expect(errorCalls.length).toBe(1);
  });

  test('withSource prefixes rendered messages with the source tag', () => {
    const base = new ConsoleLogger(LogLevel.Debug);
    const scoped = base.withSource('actor://foo/bar');
    scoped.info('hello');
    expect(infoCalls.length).toBe(1);
    const rendered = String(infoCalls[0]![0]);
    expect(rendered).toContain('actor://foo/bar');
    expect(rendered).toContain('hello');
  });

  test('withSource returns a fresh ConsoleLogger — does not mutate the original', () => {
    const base = new ConsoleLogger();
    const scoped = base.withSource('x');
    expect(scoped).not.toBe(base);
    expect(scoped.level).toBe(base.level);
  });

  test('variadic args are forwarded untouched', () => {
    const log = new ConsoleLogger(LogLevel.Debug);
    const err = new Error('boom');
    log.error('failed', err, { retries: 3 });
    expect(errorCalls.length).toBe(1);
    const [, e, meta] = errorCalls[0] as [string, unknown, unknown];
    expect(e).toBe(err);
    expect(meta).toEqual({ retries: 3 });
  });
});

describe('ConsoleLogger — MDC integration (#53)', () => {
  const originals = { log: console.log };
  let infoCalls: unknown[][];
  beforeEach(() => {
    infoCalls = [];
    console.log = (...args: unknown[]) => { infoCalls.push(args); };
  });
  afterEach(() => { console.log = originals.log; });

  test('outside any LogContext.run, no fields suffix is appended', () => {
    new ConsoleLogger().info('plain');
    expect(String(infoCalls[0]![0])).not.toContain('{');
  });

  test('inside LogContext.run, every field is rendered as a {k=v, ...} suffix', () => {
    LogContext.run({ correlationId: 'abc-123', userId: 'u-42' }, () => {
      new ConsoleLogger().info('processing');
    });
    const rendered = String(infoCalls[0]![0]);
    expect(rendered).toContain('correlationId=abc-123');
    expect(rendered).toContain('userId=u-42');
    expect(rendered).toContain('processing');
  });

  test('withFields stamps static fields on every record', () => {
    const log = new ConsoleLogger().withFields({ component: 'shard-coordinator' });
    log.info('hello');
    log.info('world');
    expect(String(infoCalls[0]![0])).toContain('component=shard-coordinator');
    expect(String(infoCalls[1]![0])).toContain('component=shard-coordinator');
  });

  test('dynamic LogContext fields override static withFields fields on key collision', () => {
    const log = new ConsoleLogger().withFields({ scope: 'static' });
    LogContext.run({ scope: 'dynamic' }, () => log.info('hello'));
    const rendered = String(infoCalls[0]![0]);
    expect(rendered).toContain('scope=dynamic');
    expect(rendered).not.toContain('scope=static');
  });

  test('numeric and boolean values render as bare strings (not JSON)', () => {
    LogContext.run({ count: 42, enabled: true }, () => new ConsoleLogger().info('x'));
    const rendered = String(infoCalls[0]![0]);
    expect(rendered).toContain('count=42');
    expect(rendered).toContain('enabled=true');
  });

  test('chained withSource + withFields composes correctly', () => {
    const log = new ConsoleLogger()
      .withSource('actor://foo')
      .withFields({ region: 'eu' });
    log.info('hello');
    const rendered = String(infoCalls[0]![0]);
    expect(rendered).toContain('actor://foo');
    expect(rendered).toContain('region=eu');
    expect(rendered).toContain('hello');
  });
});

describe('NoopLogger', () => {
  test('all methods are no-ops', () => {
    const log = new NoopLogger();
    expect(() => {
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    }).not.toThrow();
  });

  test('level is Off', () => {
    expect(new NoopLogger().level).toBe(LogLevel.Off);
  });

  test('withSource returns the same instance (cheap, immutable)', () => {
    const log = new NoopLogger();
    expect(log.withSource('anything')).toBe(log);
  });

  test('withFields returns the same instance — Noop is opaque', () => {
    const log = new NoopLogger();
    expect(log.withFields({ x: 1 })).toBe(log);
  });
});

describe('JsonLogger — #311 structured logging', () => {
  /** Capture-array sink so tests don't have to touch stdout. */
  function capturingSink(): { sink: JsonLogSink; lines: string[] } {
    const lines: string[] = [];
    return {
      sink: { write: (line) => { lines.push(line); } },
      lines,
    };
  }

  test('emits one JSON object per record, \\n-delimited', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink);
    log.info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const rec = JSON.parse(lines[0]!);
    expect(rec.msg).toBe('hello');
    expect(rec.level).toBe('info');
    expect(typeof rec.ts).toBe('string');
    // ISO-8601 timestamp (cheap shape check).
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('includes source field when bound via withSource', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink).withSource('actor://x/user/y');
    log.info('done');
    const rec = JSON.parse(lines[0]!);
    expect(rec.source).toBe('actor://x/user/y');
  });

  test('omits source when unset (no stray "" key)', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink);
    log.info('done');
    const rec = JSON.parse(lines[0]!);
    expect(Object.hasOwn(rec, 'source')).toBe(false);
  });

  test('merges static fields and dynamic MDC; dynamic wins on collision', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', { component: 'api', requestId: 'static' }, sink);
    LogContext.run({ requestId: 'dynamic', userId: 'u-42' }, () => {
      log.info('processed');
    });
    const rec = JSON.parse(lines[0]!);
    expect(rec.component).toBe('api');
    expect(rec.requestId).toBe('dynamic');   // dynamic wins
    expect(rec.userId).toBe('u-42');
  });

  test('extra positional args land under "args"', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink);
    log.info('processed', { items: 42 }, 'extra');
    const rec = JSON.parse(lines[0]!);
    expect(rec.args).toEqual([{ items: 42 }, 'extra']);
  });

  test('Error args serialise name + message + stack instead of "{}"', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink);
    const err = new Error('boom');
    log.error('failed', err);
    const rec = JSON.parse(lines[0]!);
    expect(rec.args[0].name).toBe('Error');
    expect(rec.args[0].message).toBe('boom');
    expect(typeof rec.args[0].stack).toBe('string');
  });

  test('respects level filter — below-level calls do not write', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Warn, '', {}, sink);
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).level).toBe('warn');
    expect(JSON.parse(lines[1]!).level).toBe('error');
  });

  test('handles circular references without throwing', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink);
    const circ: Record<string, unknown> = { name: 'root' };
    circ['self'] = circ;
    expect(() => log.info('circ', circ)).not.toThrow();
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.args[0].self).toBe('[Circular]');
  });

  test('handles BigInt without throwing', () => {
    const { sink, lines } = capturingSink();
    const log = new JsonLogger(LogLevel.Debug, '', {}, sink);
    expect(() => log.info('big', { n: BigInt('9999999999999999') })).not.toThrow();
    const rec = JSON.parse(lines[0]!);
    // BigInt → string in the replacer; survives roundtrip.
    expect(rec.args[0].n).toBe('9999999999999999');
  });

  test('withSource and withFields return independent instances', () => {
    const { sink, lines } = capturingSink();
    const base = new JsonLogger(LogLevel.Debug, '', { app: 'demo' }, sink);
    const bound = base.withSource('actor://x').withFields({ component: 'shard' });
    bound.info('hi');
    base.info('bye');
    expect(lines).toHaveLength(2);
    const r1 = JSON.parse(lines[0]!);
    const r2 = JSON.parse(lines[1]!);
    expect(r1.source).toBe('actor://x');
    expect(r1.component).toBe('shard');
    expect(r1.app).toBe('demo');
    expect(r2.source).toBeUndefined();
    expect(r2.component).toBeUndefined();
    expect(r2.app).toBe('demo');
  });
});
