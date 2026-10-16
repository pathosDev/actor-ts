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
import {
  DEFAULT_OTEL_LOGGER_NAME,
  OtelLogsAdapterOptions,
  OtelLogsAdapterOptionsBuilder,
  type OtelLogsAdapterOptionsType,
} from '../../../src/tracing/OtelLogsAdapterOptions.js';
import { LogContext } from '../../../src/LogContext.js';
import { LogLevel } from '../../../src/Logger.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

const FAKE_SEVERITY: OtelSeverityNumber = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

/** One `getLogger(name, version)` call, as the provider received it. */
type GetLoggerCall = readonly [name: string, version: string | undefined];

type FakeLogsApi = {
  readonly api: OtelLogsApiLike;
  readonly emitted: OtelLogRecord[];
  /** Every `getLogger` call, both arguments — the version is half of what the adapter forwards. */
  readonly getLoggerCalls: GetLoggerCall[];
};

function makeFakeLogsApi(): FakeLogsApi {
  const emitted: OtelLogRecord[] = [];
  const getLoggerCalls: GetLoggerCall[] = [];
  const fakeLogger: OtelLoggerLike = {
    emit(record) { emitted.push(record); },
  };
  const provider: OtelLoggerProviderLike = {
    getLogger(name, version) {
      getLoggerCalls.push([name, version]);
      return fakeLogger;
    },
  };
  const api: OtelLogsApiLike = {
    SeverityNumber: FAKE_SEVERITY,
    logs: { getLoggerProvider: () => provider },
  };
  return { api, emitted, getLoggerCalls };
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
    // Both arguments: a fake that kept only the name passed an adapter that
    // dropped the version on the floor.
    const fake = makeFakeLogsApi();
    otelLogger({
      api: fake.api,
      loggerName: 'my-svc',
      loggerVersion: '1.2.3',
    }).info('init');
    expect(fake.getLoggerCalls).toEqual([['my-svc', '1.2.3']]);
  });

  test('defaults loggerName to DEFAULT_OTEL_LOGGER_NAME and passes no version when neither is set', () => {
    const fake = makeFakeLogsApi();
    otelLogger({ api: fake.api }).info('init');
    expect(DEFAULT_OTEL_LOGGER_NAME).toBe('actor-ts');
    expect(fake.getLoggerCalls).toEqual([[DEFAULT_OTEL_LOGGER_NAME, undefined]]);
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
    const { api, getLoggerCalls } = makeFakeLogsApi();
    otelLogger({ api, logger: externalLogger }).info('routed');
    expect(emittedHere).toBe(1);
    expect(getLoggerCalls).toEqual([]);
  });

  test('takes one options argument and nothing that could carry a config', () => {
    // The pure path: what the options say is all it knows.  The system builds
    // its logger through it, but layers the config file over the options
    // first, outside this function.
    expect(otelLogger.length).toBe(1);
  });

  test('a plain object still has to name the api namespace', () => {
    const plain: OtelLogsAdapterOptionsType = { api: makeFakeLogsApi().api };
    expect(otelLogger(plain).level).toBe(LogLevel.Info);
    // The accepted union is the builder or the whole options shape, not a
    // `Partial` of it, so leaving the namespace out of a literal is a compile
    // error rather than a TypeError at the first call.
    // @ts-expect-error -- `api` is required on the plain-object form
    expect(() => otelLogger({ loggerName: 'no-api' })).toThrow();
  });
});

describe('OtelLogsAdapterOptions — the builder reaches the same logger as the plain object', () => {
  test('the value alias is the builder', () => {
    expect(OtelLogsAdapterOptions).toBe(OtelLogsAdapterOptionsBuilder);
    expect(OtelLogsAdapterOptions.create()).toBeInstanceOf(OtelLogsAdapterOptionsBuilder);
  });

  test('a builder is the bag of the fields it was given, and nothing else', () => {
    const { api } = makeFakeLogsApi();
    const otelLogsOptions = OtelLogsAdapterOptions.create()
      .withApi(api)
      .withLoggerName('billing')
      .withLoggerVersion('2.4.0')
      .withLevel(LogLevel.Warn);
    expectExactOptions({ ...otelLogsOptions }, {
      api,
      loggerName: 'billing',
      loggerVersion: '2.4.0',
      level: LogLevel.Warn,
    });
  });

  test('withApi alone: the default name, no version, info level', () => {
    const fake = makeFakeLogsApi();
    const otelLogsOptions = OtelLogsAdapterOptions.create().withApi(fake.api);
    const log = otelLogger(otelLogsOptions);
    log.debug('dropped');
    log.info('kept');
    expect(fake.getLoggerCalls).toEqual([[DEFAULT_OTEL_LOGGER_NAME, undefined]]);
    expect(log.level).toBe(LogLevel.Info);
    expect(fake.emitted.map((r) => r.body)).toEqual(['kept']);
  });

  test('withLoggerName and withLoggerVersion reach getLogger exactly as the plain fields do', () => {
    const viaPlain = makeFakeLogsApi();
    otelLogger({ api: viaPlain.api, loggerName: 'billing', loggerVersion: '2.4.0' });
    const viaBuilder = makeFakeLogsApi();
    const otelLogsOptions = OtelLogsAdapterOptions.create()
      .withApi(viaBuilder.api)
      .withLoggerName('billing')
      .withLoggerVersion('2.4.0');
    otelLogger(otelLogsOptions);
    expect(viaBuilder.getLoggerCalls).toEqual([['billing', '2.4.0']]);
    expect(viaBuilder.getLoggerCalls).toEqual(viaPlain.getLoggerCalls);
  });

  test('a version alone keeps the default name', () => {
    const fake = makeFakeLogsApi();
    const otelLogsOptions = OtelLogsAdapterOptions.create()
      .withApi(fake.api)
      .withLoggerVersion('2.4.0');
    otelLogger(otelLogsOptions);
    expect(fake.getLoggerCalls).toEqual([[DEFAULT_OTEL_LOGGER_NAME, '2.4.0']]);
  });

  test('withLevel filters exactly as the plain level does', () => {
    const fake = makeFakeLogsApi();
    const otelLogsOptions = OtelLogsAdapterOptions.create()
      .withApi(fake.api)
      .withLevel(LogLevel.Warn);
    const log = otelLogger(otelLogsOptions);
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(log.level).toBe(LogLevel.Warn);
    expect(fake.emitted.map((r) => r.severityText)).toEqual(['WARN', 'ERROR']);
  });

  test('withLogger bypasses getLogger, so neither the name nor the version reaches it', () => {
    const fake = makeFakeLogsApi();
    const routed: OtelLogRecord[] = [];
    const externalLogger: OtelLoggerLike = { emit: (record) => { routed.push(record); } };
    const otelLogsOptions = OtelLogsAdapterOptions.create()
      .withApi(fake.api)
      .withLogger(externalLogger)
      .withLoggerName('ignored');
    otelLogger(otelLogsOptions).info('routed');
    expect(fake.getLoggerCalls).toEqual([]);
    expect(routed.map((r) => r.body)).toEqual(['routed']);
    expect(fake.emitted).toEqual([]);
  });
});
