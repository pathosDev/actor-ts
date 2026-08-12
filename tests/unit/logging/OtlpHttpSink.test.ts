import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { LogLevel } from '../../../src/Logger.js';
import { nanosecondsOf, OtlpHttpSink } from '../../../src/logging/OtlpHttpSink.js';
import { OtlpHttpSinkOptions } from '../../../src/logging/OtlpHttpSinkOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { FetchLike } from '../../../src/logging/HttpDelivery.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';

/**
 * The wire format is the product here, so these assert the exact request a
 * collector would receive — through an injected `fetch`, with no socket.
 */

type Captured = {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | string;
};

type Response = { status: number; headers?: Record<string, string> };

let captured: Captured[] = [];
/**
 * Responses handed out in order; the last one repeats.  Scripting the
 * sequence keeps the retry tests deterministic — flipping a shared
 * variable from the test body races the retry it is meant to answer.
 */
let responses: Response[] = [{ status: 200 }];
let consoleErrors: unknown[][] = [];
const originalError = console.error;

const fetchFn: FetchLike = async (url, init) => {
  captured.push({ url, headers: init.headers, body: init.body });
  const response = responses[Math.min(captured.length - 1, responses.length - 1)]!;
  const headers = response.headers ?? {};
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => 'response body',
  };
};

beforeEach(() => {
  captured = [];
  responses = [{ status: 200 }];
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});
afterEach(() => { console.error = originalError; });

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

function sentBody(index = 0): any {
  const body = captured[index]!.body;
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
}

function firstLogRecord(index = 0): any {
  return sentBody(index).resourceLogs[0].scopeLogs[0].logRecords[0];
}

describe('OtlpHttpSink request', () => {
  it('posts JSON to the configured endpoint', async () => {
    const sink = new OtlpHttpSink({ url: 'http://collector:4318/v1/logs', fetchFn });
    sink.write(record());
    await sink.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('http://collector:4318/v1/logs');
    expect(captured[0]!.headers['content-type']).toBe('application/json');
  });

  it('defaults to the standard collector endpoint', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.url).toBe('http://localhost:4318/v1/logs');
  });

  it('builds the ExportLogsServiceRequest shape', async () => {
    const sink = new OtlpHttpSink({ fetchFn, serviceName: 'orders' });
    sink.write(record({ source: 'actor-ts://app/user/order' }));
    await sink.flush();

    const body = sentBody();
    expect(body.resourceLogs).toHaveLength(1);
    expect(body.resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'orders' } },
    ]);
    expect(body.resourceLogs[0].scopeLogs[0].scope).toEqual({ name: 'actor-ts' });
    expect(firstLogRecord().body).toEqual({ stringValue: 'placing order' });
  });

  it('sends every record of a batch in one request', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    expect(captured).toHaveLength(1);
    const records = sentBody().resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.map((r: any) => r.body.stringValue)).toEqual(['a', 'b']);
  });

  it('takes service.name from the actor system when none is configured', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.attach({ systemName: 'my-app' });
    sink.write(record());
    await sink.flush();

    expect(sentBody().resourceLogs[0].resource.attributes[0].value.stringValue).toBe('my-app');
  });

  it('keeps an explicitly configured service name', async () => {
    const sink = new OtlpHttpSink({ fetchFn, serviceName: 'explicit' });
    sink.attach({ systemName: 'my-app' });
    sink.write(record());
    await sink.flush();

    expect(sentBody().resourceLogs[0].resource.attributes[0].value.stringValue).toBe('explicit');
  });
});

describe('OtlpHttpSink record mapping', () => {
  it('encodes the timestamp as a nanosecond string', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.write(record());
    await sink.flush();

    const sent = firstLogRecord();
    expect(sent.timeUnixNano).toBe((BigInt(TIMESTAMP_MS) * 1_000_000n).toString());
    // int64 travels as a string in proto3 JSON — a number would lose precision
    // in any consumer that parses it as a double.
    expect(typeof sent.timeUnixNano).toBe('string');
    expect(sent.observedTimeUnixNano).toBe(sent.timeUnixNano);
  });

  it('computes nanoseconds exactly, which float multiplication does not', () => {
    const ms = 1_786_527_662_113;
    expect(BigInt(nanosecondsOf(ms))).toBe(BigInt(ms) * 1_000_000n);

    // Why it has to go through BigInt: the double is 64 ns short of the
    // real value.  It is `String()` that hides this — JavaScript prints the
    // shortest decimal that round-trips, so the wrong number can still
    // *look* like the right timestamp.
    expect(Number.isSafeInteger(ms * 1e6)).toBe(false);
    expect(BigInt(ms * 1e6)).not.toBe(BigInt(ms) * 1_000_000n);
    expect(BigInt(ms) * 1_000_000n - BigInt(ms * 1e6)).toBe(64n);
  });

  it('maps the severity number and text', async () => {
    const sink = new OtlpHttpSink({ fetchFn, minLevel: LogLevel.Debug });
    for (const level of [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error]) {
      sink.write(record({ level }));
    }
    await sink.flush();

    const records = sentBody().resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.map((r: any) => r.severityNumber)).toEqual([5, 9, 13, 17]);
    expect(records.map((r: any) => r.severityText)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('sends severity as an integer, never a name string', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.write(record());
    await sink.flush();

    // The spec forbids enum name strings in OTLP JSON.
    expect(typeof firstLogRecord().severityNumber).toBe('number');
  });

  it('maps fields onto typed attribute values', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.write(record({
      source: 'actor-ts://app/user/order',
      displayName: 'Order 42',
      fields: { tenant: 'acme', attempts: 3, ratio: 0.5, retried: true },
    }));
    await sink.flush();

    expect(firstLogRecord().attributes).toEqual([
      { key: 'actor.path', value: { stringValue: 'actor-ts://app/user/order' } },
      { key: 'actor.name', value: { stringValue: 'Order 42' } },
      { key: 'tenant', value: { stringValue: 'acme' } },
      // int64 goes as a string in proto3 JSON.
      { key: 'attempts', value: { intValue: '3' } },
      { key: 'ratio', value: { doubleValue: 0.5 } },
      { key: 'retried', value: { boolValue: true } },
    ]);
  });

  it('carries positional arguments as a JSON attribute', async () => {
    const sink = new OtlpHttpSink({ fetchFn });
    sink.write(record({ args: [new Error('boom'), { items: 2 }] }));
    await sink.flush();

    const args = firstLogRecord().attributes.find((a: any) => a.key === 'args');
    const parsed = JSON.parse(args.value.stringValue);
    expect(parsed[0].message).toBe('boom');
    expect(parsed[1]).toEqual({ items: 2 });
  });
});

describe('OtlpHttpSink compression', () => {
  it('gzips the body and says so', async () => {
    const sink = new OtlpHttpSink({ fetchFn, gzip: true });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['content-encoding']).toBe('gzip');
    const unpacked = gunzipSync(captured[0]!.body as Uint8Array).toString('utf8');
    expect(JSON.parse(unpacked).resourceLogs).toHaveLength(1);
  });
});

describe('OtlpHttpSink retry classification', () => {
  const fastRetry = { minBackoffMs: 1, maxBackoffMs: 2, randomFactor: 0, maxRetries: 1 };

  it('retries a 503 and succeeds on the second attempt', async () => {
    const sink = new OtlpHttpSink({ fetchFn, delivery: fastRetry });
    responses = [{ status: 503 }, { status: 200 }];
    sink.write(record());
    await sink.flush();

    expect(captured).toHaveLength(2);
    expect(sink.droppedCount).toBe(0);
  });

  it('gives up after the configured retries and counts the loss', async () => {
    const sink = new OtlpHttpSink({ fetchFn, delivery: fastRetry });
    responses = [{ status: 503 }];
    sink.write(record());
    await sink.flush();

    // One attempt plus one retry.
    expect(captured).toHaveLength(2);
    expect(sink.droppedCount).toBe(1);
  });

  it('does not retry a 401', async () => {
    const sink = new OtlpHttpSink({ fetchFn, delivery: fastRetry });
    responses = [{ status: 401 }];
    sink.write(record());
    await sink.flush();

    expect(captured).toHaveLength(1);
    expect(sink.droppedCount).toBe(1);
    expect(String(consoleErrors[0]?.[0])).toContain('HTTP 401');
  });

  it('does not retry a 400', async () => {
    const sink = new OtlpHttpSink({ fetchFn, delivery: fastRetry });
    responses = [{ status: 400 }];
    sink.write(record());
    await sink.flush();

    expect(captured).toHaveLength(1);
    expect(sink.droppedCount).toBe(1);
  });

  it('honours Retry-After over its own backoff', async () => {
    const sink = new OtlpHttpSink({
      fetchFn,
      // A 10 s backoff the header has to beat for this test to finish.
      delivery: { minBackoffMs: 10_000, maxBackoffMs: 10_000, randomFactor: 0, maxRetries: 1 },
    });
    responses = [{ status: 429, headers: { 'retry-after': '0.005' } }, { status: 200 }];
    sink.write(record());

    const startedAt = Date.now();
    await sink.flush();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(captured).toHaveLength(2);
    expect(sink.droppedCount).toBe(0);
  });

  it('reports the response body so a rejection can be diagnosed', async () => {
    const sink = new OtlpHttpSink({ fetchFn, delivery: fastRetry });
    responses = [{ status: 422 }];
    sink.write(record());
    await sink.flush();

    expect(String(consoleErrors[0]?.[0])).toContain('response body');
  });
});

describe('OtlpHttpSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = OtlpHttpSinkOptions.create()
      .withUrl('https://otel.example.com/v1/logs')
      .withGzip(true);

    expect(new OtlpHttpSink(options).name).toBe('otlp');
  });

  it('rejects a non-HTTP URL', () => {
    expect(() => new OtlpHttpSink({ url: 'grpc://collector:4317' })).toThrow(OptionsError);
  });

  it('rejects a malformed URL', () => {
    expect(() => new OtlpHttpSink({ url: 'not a url' })).toThrow(OptionsError);
  });

  it('validates the nested delivery block', () => {
    expect(() => new OtlpHttpSink({ delivery: { queueCapacity: 0 } }))
      .toThrow(/delivery\.queueCapacity/);
  });
});
