/**
 * Tests for the OTel-Logs bridge (#311).
 *
 * Hand-rolled fake `@opentelemetry/api-logs` surface — same self-
 * contained pattern as `OtelAdapter.test.ts`.  Lets us assert
 * severity-number mapping, MDC propagation, attribute shape, and
 * level-filtering without pulling in a real OTel SDK.
 */

import { describe, expect, test } from 'bun:test';
import {
  otelLogger,
  type OtelLoggerLike,
  type OtelLoggerProviderLike,
  type OtelLogRecord,
  type OtelLogsApiLike,
  type OtelSeverityNumber,
} from '../../../src/tracing/OtelLogsAdapter.js';
import { LogContext } from '../../../src/LogContext.js';
import { LogLevel } from '../../../src/Logger.js';

const FAKE_SEVERITY: OtelSeverityNumber = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

function makeFakeLogsApi(): { api: OtelLogsApiLike; emitted: OtelLogRecord[]; loggerName: string | null } {
  const emitted: OtelLogRecord[] = [];
  let loggerName: string | null = null;
  const fakeLogger: OtelLoggerLike = {
    emit(record) { emitted.push(record); },
  };
  const provider: OtelLoggerProviderLike = {
    getLogger(name) {
      loggerName = name;
      return fakeLogger;
    },
  };
  const api: OtelLogsApiLike = {
    SeverityNumber: FAKE_SEVERITY,
    logs: { getLoggerProvider: () => provider },
  };
  return { api, emitted, get loggerName() { return loggerName; } } as never;
}

describe('otelLogger', () => {
  test('emits one LogRecord per call, with body=msg and ISO timestamp', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api, level: LogLevel.Debug });
    log.info('hello world');
    expect(emitted).toHaveLength(1);
    const rec = emitted[0]!;
    expect(rec.body).toBe('hello world');
    expect(typeof rec.timestamp).toBe('number');
  });

  test('maps every level to the corresponding OTel SeverityNumber', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api, level: LogLevel.Debug });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(emitted.map((r) => r.severityNumber)).toEqual([
      FAKE_SEVERITY.DEBUG,
      FAKE_SEVERITY.INFO,
      FAKE_SEVERITY.WARN,
      FAKE_SEVERITY.ERROR,
    ]);
    expect(emitted.map((r) => r.severityText)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  test('attaches source from withSource as an attribute', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api }).withSource('actor://app/user/order');
    log.info('placed');
    expect(emitted[0]!.attributes?.['source']).toBe('actor://app/user/order');
  });

  test('merges static fields (withFields) and dynamic MDC (LogContext) — dynamic wins', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api }).withFields({ component: 'api', requestId: 'static' });
    LogContext.run({ requestId: 'dynamic', userId: 'u-42' }, () => {
      log.info('processed');
    });
    const attrs = emitted[0]!.attributes!;
    expect(attrs['component']).toBe('api');
    expect(attrs['requestId']).toBe('dynamic');
    expect(attrs['userId']).toBe('u-42');
  });

  test('positional args flatten to "args.N" keys', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api });
    log.info('done', { count: 7 }, 'extra');
    const attrs = emitted[0]!.attributes!;
    expect(attrs['args.0']).toEqual({ count: 7 });
    expect(attrs['args.1']).toBe('extra');
  });

  test('Error args explode to args.N.name / .message / .stack', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api });
    const err = new Error('kaboom');
    log.error('failed', err);
    const attrs = emitted[0]!.attributes!;
    expect(attrs['args.0.name']).toBe('Error');
    expect(attrs['args.0.message']).toBe('kaboom');
    expect(typeof attrs['args.0.stack']).toBe('string');
  });

  test('respects level — below-level calls do not call emit', () => {
    const { api, emitted } = makeFakeLogsApi();
    const log = otelLogger({ api, level: LogLevel.Warn });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(emitted.map((r) => r.severityText)).toEqual(['WARN', 'ERROR']);
  });

  test('passes loggerName + loggerVersion through to getLogger', () => {
    const fakeBoth = makeFakeLogsApi() as { api: OtelLogsApiLike; readonly loggerName: string | null };
    otelLogger({
      api: fakeBoth.api,
      loggerName: 'my-svc',
      loggerVersion: '1.2.3',
    }).info('init');
    expect(fakeBoth.loggerName).toBe('my-svc');
  });

  test('defaults loggerName to "actor-ts" when not passed', () => {
    const fakeBoth = makeFakeLogsApi() as { api: OtelLogsApiLike; readonly loggerName: string | null };
    otelLogger({ api: fakeBoth.api }).info('init');
    expect(fakeBoth.loggerName).toBe('actor-ts');
  });

  test('preserves immutability through withSource / withFields', () => {
    const { api, emitted } = makeFakeLogsApi();
    const base = otelLogger({ api }).withFields({ app: 'demo' });
    const bound = base.withSource('actor://x').withFields({ component: 'shard' });
    bound.info('hi');
    base.info('bye');
    expect(emitted).toHaveLength(2);
    const a1 = emitted[0]!.attributes!;
    const a2 = emitted[1]!.attributes!;
    expect(a1['source']).toBe('actor://x');
    expect(a1['component']).toBe('shard');
    expect(a1['app']).toBe('demo');
    expect(a2['source']).toBeUndefined();
    expect(a2['component']).toBeUndefined();
    expect(a2['app']).toBe('demo');
  });

  test('user can supply a pre-built logger to bypass getLogger', () => {
    let emittedHere = 0;
    const externalLogger: OtelLoggerLike = { emit: () => { emittedHere++; } };
    const { api } = makeFakeLogsApi();
    otelLogger({ api, logger: externalLogger }).info('routed');
    expect(emittedHere).toBe(1);
  });
});
