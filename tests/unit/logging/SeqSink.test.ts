import { beforeEach, describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { clefDocumentFor, SeqSink } from '../../../src/logging/SeqSink.js';
import { SEQ_CLEF_CONTENT_TYPE, SeqSinkOptions } from '../../../src/logging/SeqSinkOptions.js';
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
  return { status: 201, ok: true, headers: { get: () => null }, text: async () => '' };
};

beforeEach(() => { captured = []; });

const baseOptions = { url: 'http://seq:5341', fetchFn };

describe('CLEF documents', () => {
  it('uses the reserved keys for timestamp, message and level', () => {
    expect(JSON.parse(clefDocumentFor(record()))).toEqual({
      '@t': '2026-08-12T09:41:02.113Z',
      '@m': 'placing order',
      '@l': 'Information',
    });
  });

  it('uses Serilog level names, not the framework spelling', () => {
    const levelOf = (level: LogLevel): string => JSON.parse(clefDocumentFor(record({ level })))['@l'];
    expect(levelOf(LogLevel.Debug)).toBe('Debug');
    // 'Information', not 'Info' — Seq rejects an unknown level name.
    expect(levelOf(LogLevel.Info)).toBe('Information');
    expect(levelOf(LogLevel.Warn)).toBe('Warning');
    expect(levelOf(LogLevel.Error)).toBe('Error');
  });

  it('puts an Error stack in @x', () => {
    const document = JSON.parse(clefDocumentFor(record({ args: [new Error('boom')] })));
    expect(document['@x']).toContain('Error: boom');
  });

  it('sends source, display name and fields as top-level properties', () => {
    const document = JSON.parse(clefDocumentFor(record({
      source: 'actor-ts://app/user/order',
      displayName: 'Order 42',
      fields: { tenant: 'acme', attempts: 3 },
    })));

    expect(document['source']).toBe('actor-ts://app/user/order');
    expect(document['displayName']).toBe('Order 42');
    expect(document['tenant']).toBe('acme');
    expect(document['attempts']).toBe(3);
  });

  it('cannot let a field forge a reserved key', () => {
    // A `@t` arriving over the cluster wire must not become the timestamp.
    const document = JSON.parse(clefDocumentFor(record({
      fields: { '@t': 'spoofed', '@l': 'Fatal' },
    })));

    expect(document['@t']).toBe('2026-08-12T09:41:02.113Z');
    expect(document['@l']).toBe('Information');
    // CLEF's own escape: the sigil is doubled.
    expect(document['@@t']).toBe('spoofed');
    expect(document['@@l']).toBe('Fatal');
  });

  it('survives a value JSON cannot take', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const document = JSON.parse(clefDocumentFor(record({ args: [circular] })));
    expect(document['@m']).toBe('placing order');
  });
});

describe('SeqSink request', () => {
  it('posts newline-delimited CLEF to the ingest endpoint', async () => {
    const sink = new SeqSink(baseOptions);
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    expect(captured[0]!.url).toBe('http://seq:5341/ingest/clef');
    expect(captured[0]!.headers['content-type']).toBe(SEQ_CLEF_CONTENT_TYPE);

    const lines = captured[0]!.body.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line)['@m'])).toEqual(['a', 'b']);
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const sink = new SeqSink({ ...baseOptions, url: 'http://seq:5341/' });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.url).toBe('http://seq:5341/ingest/clef');
  });

  it('sends the API key header when configured', async () => {
    const sink = new SeqSink({ ...baseOptions, apiKey: 'secret' });
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['x-seq-apikey']).toBe('secret');
  });

  it('omits the API key header when not configured', async () => {
    const sink = new SeqSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.headers['x-seq-apikey']).toBeUndefined();
  });
});

describe('SeqSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = SeqSinkOptions.create()
      .withUrl('http://seq:5341')
      .withApiKey('secret');

    expect(new SeqSink(options).name).toBe('seq');
  });

  it('requires a URL', () => {
    expect(() => new SeqSink({})).toThrow(/url is required/);
  });

  it('rejects a non-HTTP URL', () => {
    expect(() => new SeqSink({ url: 'seq://host' })).toThrow(OptionsError);
  });

  it('validates the nested delivery block', () => {
    expect(() => new SeqSink({ ...baseOptions, delivery: { maxRetries: -1 } }))
      .toThrow(/delivery\.maxRetries/);
  });
});
