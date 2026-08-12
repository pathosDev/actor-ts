import { describe, expect, it, beforeEach } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { LokiSink } from '../../../src/logging/LokiSink.js';
import { LokiSinkOptions } from '../../../src/logging/LokiSinkOptions.js';
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

let captured: { url: string; headers: Record<string, string>; body: string }[] = [];
const fetchFn: FetchLike = async (url, init) => {
  captured.push({ url, headers: init.headers, body: String(init.body) });
  return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' };
};

beforeEach(() => { captured = []; });

const baseOptions = { url: 'http://loki:3100', fetchFn };

function sentStream(index = 0): any {
  return JSON.parse(captured[index]!.body).streams[0];
}

describe('LokiSink push request', () => {
  it('posts to the push endpoint', async () => {
    const sink = new LokiSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.url).toBe('http://loki:3100/loki/api/v1/push');
    expect(captured[0]!.headers['content-type']).toBe('application/json');
  });

  it('sends one stream carrying the whole batch', async () => {
    const sink = new LokiSink({ ...baseOptions, labels: { service: 'orders' } });
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    const stream = sentStream();
    expect(stream.stream).toEqual({ service: 'orders' });
    expect(stream.values).toHaveLength(2);
  });

  it('sends the timestamp as a nanosecond string, which Loki requires', async () => {
    const sink = new LokiSink(baseOptions);
    sink.write(record());
    await sink.flush();

    const [timestamp, line] = sentStream().values[0];
    expect(timestamp).toBe((BigInt(TIMESTAMP_MS) * 1_000_000n).toString());
    // A JSON number here earns a 400 from Loki.
    expect(typeof timestamp).toBe('string');
    expect(line).toContain('placing order');
  });

  it('renders the line as text by default and NDJSON on request', async () => {
    const text = new LokiSink(baseOptions);
    text.write(record());
    await text.flush();
    expect(sentStream().values[0][1]).toContain('] INFO  placing order');

    captured = [];
    const json = new LokiSink({ ...baseOptions, format: 'json' });
    json.write(record());
    await json.flush();
    expect(JSON.parse(sentStream().values[0][1]).msg).toBe('placing order');
  });

  it('sets the tenant header when configured', async () => {
    const sink = new LokiSink({ ...baseOptions, tenantId: 'team-a' });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['x-scope-orgid']).toBe('team-a');
  });

  it('omits the tenant header when not configured', async () => {
    const sink = new LokiSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['x-scope-orgid']).toBeUndefined();
  });
});

describe('LokiSink labels and metadata', () => {
  it('defaults the service label to the actor system name', async () => {
    const sink = new LokiSink(baseOptions);
    sink.attach({ systemName: 'orders' });
    sink.write(record());
    await sink.flush();

    expect(sentStream().stream).toEqual({ service: 'orders' });
  });

  it('keeps an explicitly configured service label', async () => {
    const sink = new LokiSink({ ...baseOptions, labels: { service: 'explicit' } });
    sink.attach({ systemName: 'orders' });
    sink.write(record());
    await sink.flush();

    expect(sentStream().stream.service).toBe('explicit');
  });

  it('puts variable data in structured metadata, never in labels', async () => {
    const sink = new LokiSink({ ...baseOptions, labels: { service: 'orders' } });
    sink.write(record({
      source: 'actor-ts://orders/user/order-42',
      displayName: 'Order 42',
      fields: { tenant: 'acme', attempts: 3 },
    }));
    await sink.flush();

    const stream = sentStream();
    // The actor path is per-record: as a label it would create one stream
    // per entity, which is how a Loki cluster falls over.
    expect(stream.stream).toEqual({ service: 'orders' });
    expect(stream.values[0][2]).toEqual({
      level: 'info',
      actor_path: 'actor-ts://orders/user/order-42',
      actor_name: 'Order 42',
      tenant: 'acme',
      attempts: '3',
    });
  });

  it('flattens metadata keys Loki would rewrite anyway', async () => {
    const sink = new LokiSink(baseOptions);
    sink.write(record({ fields: { 'service.version': '1.2.3' } }));
    await sink.flush();

    expect(sentStream().values[0][2]['service_version']).toBe('1.2.3');
  });

  it('can be told to send no metadata at all', async () => {
    const sink = new LokiSink({ ...baseOptions, structuredMetadata: false });
    sink.write(record({ fields: { tenant: 'acme' } }));
    await sink.flush();

    expect(sentStream().values[0]).toHaveLength(2);
  });
});

describe('LokiSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = LokiSinkOptions.create()
      .withUrl('http://loki:3100')
      .withLabels({ service: 'orders' })
      .withTenantId('team-a');

    expect(new LokiSink(options).name).toBe('loki');
  });

  it('requires a URL', () => {
    expect(() => new LokiSink({})).toThrow(/url is required/);
  });

  it('rejects a label name Loki cannot index', () => {
    expect(() => new LokiSink({ ...baseOptions, labels: { 'service.name': 'orders' } }))
      .toThrow(/labels\.service\.name/);
  });

  it('rejects an empty label value', () => {
    expect(() => new LokiSink({ ...baseOptions, labels: { service: '' } })).toThrow(OptionsError);
  });

  it('validates the nested delivery block', () => {
    expect(() => new LokiSink({ ...baseOptions, delivery: { overflow: 'reject' as 'drop-new' } }))
      .toThrow(/delivery\.overflow/);
  });
});
