import { beforeEach, describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { SplunkSink } from '../../../src/logging/SplunkSink.js';
import { SplunkSinkOptions } from '../../../src/logging/SplunkSinkOptions.js';
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
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
};

beforeEach(() => { captured = []; });

const baseOptions = { url: 'https://splunk:8088', token: 'hec-token', fetchFn };

/** HEC batches are concatenated objects, so parse them by scanning. */
function sentEvents(index = 0): any[] {
  const body = captured[index]!.body;
  const events: any[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i]!;
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === '{') { if (depth === 0) start = i; depth += 1; }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) events.push(JSON.parse(body.slice(start, i + 1)));
    }
  }
  return events;
}

describe('SplunkSink request', () => {
  it('posts to the event endpoint with the Splunk authorization scheme', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(captured[0]!.url).toBe('https://splunk:8088/services/collector/event');
    expect(captured[0]!.headers['authorization']).toBe('Splunk hec-token');
  });

  it('batches events as concatenated objects, not a JSON array', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    const body = captured[0]!.body;
    // The classic batch protocol every Splunk version accepts.
    expect(body).not.toStartWith('[');
    expect(body).toContain('}{');
    expect(sentEvents().map((event) => event.event.message)).toEqual(['a', 'b']);
  });

  it('sends the time as epoch seconds with millisecond precision', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(sentEvents()[0].time).toBe(TIMESTAMP_MS / 1000);
  });

  it('carries the standard metadata keys', async () => {
    const sink = new SplunkSink({ ...baseOptions, index: 'main', hostName: 'web-01' });
    sink.write(record({ source: 'actor-ts://app/user/order', displayName: 'Order 42' }));
    await sink.flush();

    const event = sentEvents()[0];
    expect(event.host).toBe('web-01');
    expect(event.source).toBe('actor-ts');
    expect(event.sourcetype).toBe('_json');
    expect(event.index).toBe('main');
    expect(event.event).toEqual({
      level: 'info',
      message: 'placing order',
      actorPath: 'actor-ts://app/user/order',
      actorName: 'Order 42',
    });
  });

  it('omits the index when none is configured', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(sentEvents()[0]).not.toHaveProperty('index');
  });

  it('takes the host from the actor system when unset', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.attach({ systemName: 'orders' });
    sink.write(record());
    await sink.flush();

    expect(sentEvents()[0].host).toBe('orders');
  });
});

describe('SplunkSink indexed fields', () => {
  it('sends fields as a flat object', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record({ fields: { tenant: 'acme', attempts: 3, retried: true } }));
    await sink.flush();

    // HEC rejects a nested value under `fields`.
    expect(sentEvents()[0].fields).toEqual({ tenant: 'acme', attempts: '3', retried: 'true' });
  });

  it('omits fields entirely when there are none', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record());
    await sink.flush();

    expect(sentEvents()[0]).not.toHaveProperty('fields');
  });

  it('keeps arguments in the event rather than in the indexed fields', async () => {
    const sink = new SplunkSink(baseOptions);
    sink.write(record({ args: [new Error('boom')] }));
    await sink.flush();

    expect(sentEvents()[0].event.args[0].message).toBe('boom');
    expect(sentEvents()[0]).not.toHaveProperty('fields');
  });
});

describe('SplunkSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = SplunkSinkOptions.create()
      .withUrl('https://splunk:8088')
      .withToken('hec-token')
      .withSourcetype('actor_ts:log');

    expect(new SplunkSink(options).name).toBe('splunk');
  });

  it('requires a URL and a token', () => {
    expect(() => new SplunkSink({ token: 'hec-token' })).toThrow(/url is required/);
    expect(() => new SplunkSink({ url: 'https://splunk:8088' })).toThrow(/token is required/);
  });

  it('rejects a non-HTTP URL', () => {
    expect(() => new SplunkSink({ url: 'tcp://splunk:9997', token: 'x' })).toThrow(OptionsError);
  });

  it('validates the nested delivery block', () => {
    expect(() => new SplunkSink({ ...baseOptions, delivery: { flushIntervalMs: 0 } }))
      .toThrow(/delivery\.flushIntervalMs/);
  });
});
