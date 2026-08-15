import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { ParseableSink, requestBodiesFor } from '../../../src/logging/ParseableSink.js';
import {
  PARSEABLE_MAX_REQUEST_BYTES,
  ParseableSinkOptions,
} from '../../../src/logging/ParseableSinkOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import type { FetchLike } from '../../../src/logging/HttpDelivery.js';
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

type Captured = { url: string; headers: Record<string, string>; body: string };

let captured: Captured[] = [];
let consoleErrors: unknown[][] = [];
const originalError = console.error;

const fetchFn: FetchLike = async (url, init) => {
  captured.push({ url, headers: init.headers, body: String(init.body) });
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
};

beforeEach(() => {
  captured = [];
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});
afterEach(() => { console.error = originalError; });

const baseOptions = { url: 'https://parseable.internal', stream: 'app-logs', fetchFn };

describe('ParseableSink request', () => {
  it('posts a JSON array to the ingest endpoint', async () => {
    const sink = new ParseableSink(baseOptions);
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://parseable.internal/api/v1/ingest');
    expect(captured[0]!.headers['content-type']).toBe('application/json');
    expect(captured[0]!.headers['x-p-stream']).toBe('app-logs');

    const body = JSON.parse(captured[0]!.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((entry: { message: string }) => entry.message)).toEqual(['a', 'b']);
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const sink = new ParseableSink({ ...baseOptions, url: 'https://parseable.internal/' });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.url).toBe('https://parseable.internal/api/v1/ingest');
  });

  it('sends flat records with an RFC 3339 timestamp', async () => {
    const sink = new ParseableSink(baseOptions);
    sink.write(record({
      source: 'actor-ts://app/user/order',
      fields: { tenant: 'acme', attempts: 3 },
    }));
    await sink.flush();

    expect(JSON.parse(captured[0]!.body)[0]).toEqual({
      timestamp: '2026-08-12T09:41:02.113Z',
      level: 'info',
      source: 'actor-ts://app/user/order',
      message: 'placing order',
      tenant: 'acme',
      attempts: 3,
    });
  });

  it('normalises an Error argument', async () => {
    const sink = new ParseableSink(baseOptions);
    sink.write(record({ args: [new Error('boom')] }));
    await sink.flush();

    expect(JSON.parse(captured[0]!.body)[0].args[0].message).toBe('boom');
  });
});

describe('ParseableSink authentication', () => {
  it('sends an API key header', async () => {
    const sink = new ParseableSink({ ...baseOptions, apiKey: 'secret-key' });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['x-api-key']).toBe('secret-key');
    expect(captured[0]!.headers['authorization']).toBeUndefined();
  });

  it('sends basic auth when credentials are given', async () => {
    const sink = new ParseableSink({ ...baseOptions, username: 'admin', password: 'pässwörd' });
    sink.write(record());
    await sink.flush();

    const header = captured[0]!.headers['authorization']!;
    expect(header).toStartWith('Basic ');
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe('admin:pässwörd');
  });

  it('sends no credentials when none are configured', async () => {
    const sink = new ParseableSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['authorization']).toBeUndefined();
    expect(captured[0]!.headers['x-api-key']).toBeUndefined();
  });
});

describe('ParseableSink request splitting', () => {
  it('keeps a normal batch in one request', () => {
    const bodies = requestBodiesFor([record({ message: 'a' }), record({ message: 'b' })]);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toHaveLength(2);
  });

  it('splits a batch that would exceed the server cap', () => {
    // Each record is ~1 MiB, so twelve of them cannot ride in one 10 MiB request.
    const big = record({ message: 'x'.repeat(1024 * 1024) });
    const bodies = requestBodiesFor(Array.from({ length: 12 }, () => big));

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(PARSEABLE_MAX_REQUEST_BYTES);
      expect(() => JSON.parse(body)).not.toThrow();
    }
    const total = bodies.reduce((count, body) => count + JSON.parse(body).length, 0);
    expect(total).toBe(12);
  });

  it('still sends a single record that cannot fit, rather than losing it', () => {
    const enormous = record({ message: 'x'.repeat(PARSEABLE_MAX_REQUEST_BYTES + 1_000) });
    const bodies = requestBodiesFor([enormous]);

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toHaveLength(1);
  });

  it('sends each split body as its own request', async () => {
    const sink = new ParseableSink({ ...baseOptions, delivery: { maxBatchSize: 12, queueCapacity: 100 } });
    for (let i = 0; i < 12; i += 1) sink.write(record({ message: 'x'.repeat(1024 * 1024) }));
    await sink.flush();

    expect(captured.length).toBeGreaterThan(1);
  });
});

describe('ParseableSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = ParseableSinkOptions.create()
      .withUrl('https://parseable.internal')
      .withStream('app-logs')
      .withApiKey('secret');

    expect(new ParseableSink(options).name).toBe('parseable');
  });

  it('requires a URL', () => {
    expect(() => new ParseableSink({ stream: 'app-logs' })).toThrow(/url is required/);
  });

  it('rejects an API key combined with basic auth', () => {
    expect(() => new ParseableSink({
      ...baseOptions, username: 'admin', password: 'secret', apiKey: 'key',
    })).toThrow(/cannot be combined with basic-auth/);
  });

  it('rejects half a credential pair', () => {
    expect(() => new ParseableSink({ ...baseOptions, username: 'admin' }))
      .toThrow(/must be set together/);
    expect(() => new ParseableSink({ ...baseOptions, password: 'secret' }))
      .toThrow(/must be set together/);
  });

  it('rejects a non-HTTP URL', () => {
    expect(() => new ParseableSink({ url: 'ftp://parseable.internal' })).toThrow(OptionsError);
  });
});
