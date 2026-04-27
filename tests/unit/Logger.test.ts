import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ConsoleLogger, LogLevel, NoopLogger } from '../../src/Logger.js';

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
});
