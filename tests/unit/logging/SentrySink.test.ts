import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import {
  DEFAULT_SENTRY_MIN_LEVEL,
  SentrySinkOptions,
  sentrySink,
  type SentrySdkLike,
} from '../../../src/logging/SentrySink.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';

const TIMESTAMP_MS = Date.UTC(2026, 7, 12, 9, 41, 2, 113);

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs: TIMESTAMP_MS,
    level: LogLevel.Error,
    message: 'order failed',
    fields: {},
    ...overrides,
  };
}

type Captured = {
  exceptions: { error: unknown; extra: Record<string, unknown> | undefined }[];
  messages: { message: string; level: string | undefined }[];
  logs: { method: string; message: string; attributes: Record<string, unknown> | undefined }[];
};

/** A recording stand-in for the user's `@sentry/node` import. */
function fakeSdk(withLogger = true): { sdk: SentrySdkLike; captured: Captured } {
  const captured: Captured = { exceptions: [], messages: [], logs: [] };
  const logger = {
    debug: (message: string, attributes?: Record<string, unknown>) => { captured.logs.push({ method: 'debug', message, attributes }); },
    info: (message: string, attributes?: Record<string, unknown>) => { captured.logs.push({ method: 'info', message, attributes }); },
    warn: (message: string, attributes?: Record<string, unknown>) => { captured.logs.push({ method: 'warn', message, attributes }); },
    error: (message: string, attributes?: Record<string, unknown>) => { captured.logs.push({ method: 'error', message, attributes }); },
  };
  const sdk: SentrySdkLike = {
    captureException: (error, hint) => { captured.exceptions.push({ error, extra: hint?.extra }); return 'id'; },
    captureMessage: (message, level) => { captured.messages.push({ message, level }); return 'id'; },
    ...(withLogger ? { logger } : {}),
  };
  return { sdk, captured };
}

let consoleErrors: unknown[][] = [];
const originalError = console.error;
beforeEach(() => {
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});
afterEach(() => { console.error = originalError; });

describe('sentrySink routing', () => {
  it('captures an Error argument as an exception', () => {
    const { sdk, captured } = fakeSdk();
    const error = new Error('boom');
    sentrySink({ sdk }).write(record({ args: [error] }));

    expect(captured.exceptions).toHaveLength(1);
    expect(captured.exceptions[0]!.error).toBe(error);
    expect(captured.messages).toHaveLength(0);
  });

  it('captures a message when there is no Error to group on', () => {
    const { sdk, captured } = fakeSdk();
    sentrySink({ sdk }).write(record());

    expect(captured.messages).toEqual([{ message: 'order failed', level: 'error' }]);
    expect(captured.exceptions).toHaveLength(0);
  });

  it('does not turn a warning into an issue', () => {
    const { sdk, captured } = fakeSdk();
    sentrySink({ sdk }).write(record({ level: LogLevel.Warn, message: 'slow response' }));

    expect(captured.exceptions).toHaveLength(0);
    expect(captured.messages).toHaveLength(0);
    // It still reaches the logs product.
    expect(captured.logs).toEqual([{ method: 'warn', message: 'slow response', attributes: {} }]);
  });

  it('forwards every passing record to the logs product', () => {
    const { sdk, captured } = fakeSdk();
    const sink = sentrySink({ sdk, minLevel: LogLevel.Debug });
    sink.write(record({ level: LogLevel.Debug, message: 'a' }));
    sink.write(record({ level: LogLevel.Info, message: 'b' }));

    expect(captured.logs.map((entry) => entry.method)).toEqual(['debug', 'info']);
  });

  it('can be told not to use the logs product', () => {
    const { sdk, captured } = fakeSdk();
    sentrySink({ sdk, sendLogs: false }).write(record({ args: [new Error('boom')] }));

    expect(captured.logs).toHaveLength(0);
    expect(captured.exceptions).toHaveLength(1);
  });

  it('works with an SDK that has no logs product', () => {
    const { sdk, captured } = fakeSdk(false);
    expect(() => sentrySink({ sdk }).write(record({ args: [new Error('boom')] }))).not.toThrow();
    expect(captured.exceptions).toHaveLength(1);
  });
});

describe('sentrySink context', () => {
  it('sends the actor path and fields as extra', () => {
    const { sdk, captured } = fakeSdk();
    sentrySink({ sdk }).write(record({
      source: 'actor-ts://app/user/order',
      displayName: 'Order 42',
      fields: { tenant: 'acme' },
      args: [new Error('boom')],
    }));

    expect(captured.exceptions[0]!.extra).toEqual({
      tenant: 'acme',
      'actor.path': 'actor-ts://app/user/order',
      'actor.name': 'Order 42',
    });
  });

  it('carries non-Error arguments alongside the exception', () => {
    const { sdk, captured } = fakeSdk();
    sentrySink({ sdk }).write(record({ args: [new Error('boom'), { attempt: 2 }] }));

    expect(JSON.parse(String(captured.exceptions[0]!.extra!['args']))).toEqual([{ attempt: 2 }]);
  });
});

describe('sentrySink resilience', () => {
  it('never throws when the SDK does', () => {
    const sdk: SentrySdkLike = {
      captureException: () => { throw new Error('sdk broken'); },
      captureMessage: () => { throw new Error('sdk broken'); },
      logger: {
        debug: () => { throw new Error('sdk broken'); },
        info: () => { throw new Error('sdk broken'); },
        warn: () => { throw new Error('sdk broken'); },
        error: () => { throw new Error('sdk broken'); },
      },
    };
    const sink = sentrySink({ sdk });

    expect(() => sink.write(record({ args: [new Error('boom')] }))).not.toThrow();
    expect(String(consoleErrors[0]?.[0])).toContain('log sink "sentry"');
  });

  it('still reaches the logs product when captureException throws', () => {
    const { captured } = fakeSdk();
    const sdk: SentrySdkLike = {
      captureException: () => { throw new Error('sdk broken'); },
      captureMessage: () => { throw new Error('sdk broken'); },
      logger: {
        debug: () => {}, info: () => {}, warn: () => {},
        error: (message, attributes) => { captured.logs.push({ method: 'error', message, attributes }); },
      },
    };
    sentrySink({ sdk }).write(record());

    expect(captured.logs).toHaveLength(1);
  });
});

describe('sentrySink options', () => {
  it('defaults to warn — an error tracker is not a log firehose', () => {
    const { sdk } = fakeSdk();
    expect(sentrySink({ sdk }).minLevel).toBe(LogLevel.Warn);
    expect(DEFAULT_SENTRY_MIN_LEVEL).toBe(LogLevel.Warn);
  });

  it('accepts the fluent builder', () => {
    const { sdk } = fakeSdk();
    const options = SentrySinkOptions.create().withSdk(sdk).withMinLevel(LogLevel.Error);

    expect(sentrySink(options).minLevel).toBe(LogLevel.Error);
  });

  it('rejects something that is not a Sentry SDK', () => {
    expect(() => sentrySink({ sdk: {} as SentrySdkLike })).toThrow(OptionsError);
    expect(() => sentrySink({ sdk: { captureException: () => {} } as unknown as SentrySdkLike }))
      .toThrow(/captureException and captureMessage/);
  });

  it('is named sentry', () => {
    const { sdk } = fakeSdk();
    expect(sentrySink({ sdk }).name).toBe('sentry');
  });
});
