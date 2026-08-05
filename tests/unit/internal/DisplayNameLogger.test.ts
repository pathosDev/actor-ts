import { describe, expect, test } from 'bun:test';
import { DisplayNameLogger } from '../../../src/internal/DisplayNameLogger.js';
import { ConsoleLogger, LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';

/**
 * Records what it was asked to do, and how often it was derived from —
 * the memoisation claim is only checkable by counting `withFields`.
 */
class RecordingLogger implements Logger {
  readonly records: Array<{ level: string; message: string }> = [];
  readonly derivations: LogContextData[] = [];

  constructor(
    public level: LogLevel = LogLevel.Debug,
    readonly fields: LogContextData = {},
    private readonly root: RecordingLogger | null = null,
  ) {}

  /** Every derived logger reports back to the one the test holds. */
  private get sink(): RecordingLogger { return this.root ?? this; }

  debug(message: string): void { this.sink.records.push({ level: 'debug', message }); }
  info(message: string): void { this.sink.records.push({ level: 'info', message }); }
  warn(message: string): void { this.sink.records.push({ level: 'warn', message }); }
  error(message: string): void { this.sink.records.push({ level: 'error', message }); }

  withSource(source: string): Logger {
    return new RecordingLogger(this.level, { ...this.fields, source }, this.sink);
  }

  withFields(fields: LogContextData): Logger {
    this.sink.derivations.push(fields);
    return new RecordingLogger(this.level, { ...this.fields, ...fields }, this.sink);
  }
}

/** Counts how often the name was asked for, so "never" is provable. */
function countingResolver(name: string | (() => string)): { resolve: () => string; calls: () => number } {
  let calls = 0;
  return {
    resolve: () => { calls++; return typeof name === 'function' ? name() : name; },
    calls: () => calls,
  };
}

describe('DisplayNameLogger', () => {
  test('stamps the resolved name on every record', () => {
    const base = new RecordingLogger();
    new DisplayNameLogger(base, () => 'Order(42)').info('persisted');
    expect(base.derivations).toEqual([{ displayName: 'Order(42)' }]);
    expect(base.records).toEqual([{ level: 'info', message: 'persisted' }]);
  });

  test('an empty name emits through the base untouched', () => {
    const base = new RecordingLogger();
    new DisplayNameLogger(base, () => '').info('persisted');
    expect(base.derivations).toHaveLength(0);
    expect(base.records).toHaveLength(1);
  });

  test('resolves per record, so a name that changes is followed', () => {
    const base = new RecordingLogger();
    let name = 'first';
    const log = new DisplayNameLogger(base, () => name);
    log.info('a');
    name = 'second';
    log.info('b');
    expect(base.derivations).toEqual([{ displayName: 'first' }, { displayName: 'second' }]);
  });

  test('memoises on the last name — a stable name derives once', () => {
    const base = new RecordingLogger();
    const log = new DisplayNameLogger(base, () => 'Order(42)');
    log.info('a'); log.info('b'); log.warn('c');
    expect(base.derivations).toHaveLength(1);
    expect(base.records).toHaveLength(3);
  });

  test('a filtered-out call never reaches the resolver', () => {
    const base = new RecordingLogger(LogLevel.Info);
    const resolver = countingResolver('Order(42)');
    const log = new DisplayNameLogger(base, resolver.resolve);
    log.debug('below the level');
    expect(resolver.calls()).toBe(0);
    expect(base.records).toHaveLength(0);
    log.info('at the level');
    expect(resolver.calls()).toBe(1);
  });

  test('a NoopLogger base never reaches the resolver at any level', () => {
    // The whole point: tests and benchmarks run on NoopLogger, and must
    // not pay for a feature they never observe.
    const resolver = countingResolver('Order(42)');
    const log = new DisplayNameLogger(new NoopLogger(), resolver.resolve);
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(resolver.calls()).toBe(0);
  });

  test('level reads through, so raising it later takes effect', () => {
    const base = new ConsoleLogger(LogLevel.Info);
    const log = new DisplayNameLogger(base, () => '');
    expect(log.level).toBe(LogLevel.Info);
    base.level = LogLevel.Error;
    expect(log.level).toBe(LogLevel.Error);
  });

  test('a throwing resolver degrades to the plain base, silently', () => {
    // Silently, because `ActorCell` owns the warning — warning here too
    // would turn one broken override into one warning per record.
    const base = new RecordingLogger();
    const log = new DisplayNameLogger(base, () => { throw new Error('boom'); });
    expect(() => log.info('persisted')).not.toThrow();
    expect(base.derivations).toHaveLength(0);
    expect(base.records).toHaveLength(1);
  });

  test('a non-string name is no name', () => {
    const base = new RecordingLogger();
    const log = new DisplayNameLogger(base, (() => 42) as unknown as () => string);
    log.info('persisted');
    expect(base.derivations).toHaveLength(0);
    expect(base.records).toHaveLength(1);
  });

  test('withFields keeps the name — adding a field must not cost you one', () => {
    const base = new RecordingLogger();
    const log = new DisplayNameLogger(base, () => 'Order(42)').withFields({ region: 'eu' });
    log.info('persisted');
    expect(base.derivations).toEqual([{ region: 'eu' }, { displayName: 'Order(42)' }]);
  });

  test('withSource re-roots but stays dynamic', () => {
    const base = new RecordingLogger();
    let name = 'first';
    const log = new DisplayNameLogger(base, () => name).withSource('actor-ts://app/user/x');
    log.info('a');
    name = 'second';
    log.info('b');
    expect(base.derivations).toEqual([{ displayName: 'first' }, { displayName: 'second' }]);
  });
});
