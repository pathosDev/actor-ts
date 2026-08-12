import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { DISPLAY_NAME_FIELD, LogLevel } from '../../../src/Logger.js';
import {
  chunkGelfDatagram,
  GELF_CHUNK_HEADER_BYTES,
  GELF_MAX_CHUNKS,
  GelfMessageTooLargeError,
  newGelfMessageId,
} from '../../../src/logging/GelfChunking.js';
import { additionalFieldName, encodeGelf, gelfPayloadFor } from '../../../src/logging/GelfPayload.js';
import { GelfSink, UdpGelfTransport, type DgramSocketLike } from '../../../src/logging/GelfSink.js';
import { GelfSinkOptions } from '../../../src/logging/GelfSinkOptions.js';
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

let consoleErrors: unknown[][] = [];
const originalError = console.error;
beforeEach(() => {
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});
afterEach(() => { console.error = originalError; });

describe('GELF payload', () => {
  it('carries the three required fields', () => {
    const payload = gelfPayloadFor(record(), 'web-01');
    expect(payload['version']).toBe('1.1');
    expect(payload['host']).toBe('web-01');
    expect(payload['short_message']).toBe('placing order');
  });

  it('sends the timestamp as epoch seconds with a fraction', () => {
    expect(gelfPayloadFor(record(), 'web-01')['timestamp']).toBe(TIMESTAMP_MS / 1000);
  });

  it('maps levels onto syslog severities', () => {
    const severityOf = (level: LogLevel): unknown => gelfPayloadFor(record({ level }), 'h')['level'];
    expect(severityOf(LogLevel.Debug)).toBe(7);
    expect(severityOf(LogLevel.Info)).toBe(6);
    expect(severityOf(LogLevel.Warn)).toBe(4);
    expect(severityOf(LogLevel.Error)).toBe(3);
  });

  it('splits a multi-line message into short and full', () => {
    const payload = gelfPayloadFor(record({ message: 'headline\ndetail line' }), 'h');
    expect(payload['short_message']).toBe('headline');
    expect(payload['full_message']).toBe('detail line');
  });

  it('puts an Error stack into full_message', () => {
    const payload = gelfPayloadFor(record({ args: [new Error('boom')] }), 'h');
    expect(String(payload['full_message'])).toContain('Error: boom');
  });

  it('prefixes custom fields with an underscore', () => {
    const payload = gelfPayloadFor(record({
      source: 'actor-ts://app/user/order',
      displayName: 'Order 42',
      fields: { [DISPLAY_NAME_FIELD]: 'Order 42', tenant: 'acme' },
    }), 'h');

    expect(payload['_source']).toBe('actor-ts://app/user/order');
    expect(payload['_display_name']).toBe('Order 42');
    expect(payload['_tenant']).toBe('acme');
  });

  it('never emits a bare short_message for an empty record', () => {
    expect(gelfPayloadFor(record({ message: '' }), 'h')['short_message']).toBe('(empty)');
  });
});

describe('GELF field-name hardening (#573)', () => {
  it('replaces characters the spec forbids', () => {
    expect(additionalFieldName('user id')).toBe('_user_id');
    expect(additionalFieldName('a/b')).toBe('_a_b');
    expect(additionalFieldName('ok.name-1')).toBe('_ok.name-1');
  });

  it('drops the forbidden _id field', () => {
    expect(additionalFieldName('id')).toBeUndefined();
  });

  it('drops a field that would overwrite a GELF top-level key', () => {
    for (const reserved of ['version', 'host', 'short_message', 'full_message', 'timestamp', 'level']) {
      expect(additionalFieldName(reserved)).toBeUndefined();
    }
  });

  it('cannot be used by a remote MDC to rewrite the message', () => {
    const payload = gelfPayloadFor(record({
      fields: { host: 'spoofed', level: 0, short_message: 'spoofed', id: 'spoofed' },
    }), 'web-01');

    expect(payload['host']).toBe('web-01');
    expect(payload['level']).toBe(6);
    expect(payload['short_message']).toBe('placing order');
    expect(Object.keys(payload)).not.toContain('_id');
  });

  it('encodes without throwing on a hostile value', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const encoded = encodeGelf(gelfPayloadFor(record({ args: [circular, 10n] }), 'h'));
    expect(JSON.parse(encoded)['version']).toBe('1.1');
  });
});

describe('GELF chunking', () => {
  it('leaves a small message unchunked', () => {
    const payload = new Uint8Array(100);
    expect(chunkGelfDatagram(payload, newGelfMessageId(), 1420)).toEqual([payload]);
  });

  it('lays the header out exactly as the spec says', () => {
    const payload = new Uint8Array(1000).fill(0x41);
    const messageId = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const chunks = chunkGelfDatagram(payload, messageId, 512);

    expect(chunks).toHaveLength(Math.ceil(1000 / (512 - GELF_CHUNK_HEADER_BYTES)));
    chunks.forEach((chunk, index) => {
      expect(chunk[0]).toBe(0x1e);
      expect(chunk[1]).toBe(0x0f);
      expect([...chunk.subarray(2, 10)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(chunk[10]).toBe(index);
      expect(chunk[11]).toBe(chunks.length);
    });
  });

  it('reassembles to the original payload', () => {
    const payload = Uint8Array.from({ length: 5_000 }, (_unused, index) => index % 251);
    const chunks = chunkGelfDatagram(payload, newGelfMessageId(), 600);
    const reassembled = new Uint8Array(payload.length);
    let offset = 0;
    for (const chunk of chunks) {
      const body = chunk.subarray(GELF_CHUNK_HEADER_BYTES);
      reassembled.set(body, offset);
      offset += body.length;
    }
    expect(reassembled).toEqual(payload);
  });

  it('refuses a message needing more than the protocol allows', () => {
    const payload = new Uint8Array(600 * GELF_MAX_CHUNKS);
    expect(() => chunkGelfDatagram(payload, newGelfMessageId(), 512))
      .toThrow(GelfMessageTooLargeError);
  });

  it('draws a fresh message id each time', () => {
    const first = newGelfMessageId();
    const second = newGelfMessageId();
    expect(first).toHaveLength(8);
    expect([...first]).not.toEqual([...second]);
  });
});

/* --------------------------- transport tests ---------------------------- */

type SentMessage = string;

/** A `GelfSink` whose transport records instead of sending. */
class RecordingGelfSink extends GelfSink {
  readonly sent: SentMessage[] = [];
  closes = 0;

  protected override createTransport() {
    return {
      send: async (message: string) => { this.sent.push(message); },
      close: async () => { this.closes += 1; },
    };
  }
}

describe('GelfSink delivery', () => {
  it('sends one GELF document per record', async () => {
    const sink = new RecordingGelfSink({ hostName: 'web-01' });
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    expect(sink.sent).toHaveLength(2);
    expect(JSON.parse(sink.sent[0]!)['short_message']).toBe('a');
    expect(JSON.parse(sink.sent[1]!)['short_message']).toBe('b');
  });

  it('closes its transport on close', async () => {
    const sink = new RecordingGelfSink({ hostName: 'web-01' });
    sink.write(record());
    await sink.close();

    expect(sink.closes).toBe(1);
  });

  it('falls back to the system name when there is no OS hostname', async () => {
    const previousHostname = process.env['HOSTNAME'];
    const previousComputername = process.env['COMPUTERNAME'];
    delete process.env['HOSTNAME'];
    delete process.env['COMPUTERNAME'];
    try {
      const sink = new RecordingGelfSink({});
      sink.attach({ systemName: 'orders' });
      sink.write(record());
      await sink.flush();

      expect(JSON.parse(sink.sent[0]!)['host']).toBe('orders');
    } finally {
      if (previousHostname !== undefined) process.env['HOSTNAME'] = previousHostname;
      if (previousComputername !== undefined) process.env['COMPUTERNAME'] = previousComputername;
    }
  });
});

describe('GelfSink over HTTP', () => {
  it('posts the document to the configured input URL', async () => {
    const captured: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      captured.push({ url, body: init.body, headers: init.headers });
      return { status: 202, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    const sink = new GelfSink({ protocol: 'http', url: 'http://graylog:12201/gelf', hostName: 'web-01', fetchFn });
    sink.write(record());
    await sink.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('http://graylog:12201/gelf');
    expect(captured[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(captured[0]!.body))['short_message']).toBe('placing order');
  });
});

describe('GelfSink UDP framing', () => {
  /** A UDP transport whose socket collects datagrams instead of sending them. */
  function transportWith(compression: 'none' | 'gzip', maxChunkBytes = 1420) {
    const sent: Uint8Array[] = [];
    const socket: DgramSocketLike = {
      send: (datagram, _port, _host, callback) => { sent.push(datagram); callback(); },
      close: (callback) => callback?.(),
      on: () => {},
    };
    const reporter = { report: (reason: string) => { consoleErrors.push([reason]); } };
    const transport = new UdpGelfTransport('127.0.0.1', 12201, compression, maxChunkBytes, reporter, async () => socket);
    return { transport, sent };
  }

  const document = (): string => encodeGelf(gelfPayloadFor(record(), 'web-01'));

  it('gzips the datagram so the server can auto-detect it', async () => {
    const { transport, sent } = transportWith('gzip');
    await transport.send(document());

    expect(sent).toHaveLength(1);
    // gzip magic bytes — the server needs no header to know.
    expect(sent[0]![0]).toBe(0x1f);
    expect(sent[0]![1]).toBe(0x8b);
    expect(JSON.parse(gunzipSync(sent[0]!).toString('utf8'))['short_message']).toBe('placing order');
  });

  it('sends plain JSON when compression is off', async () => {
    const { transport, sent } = transportWith('none');
    await transport.send(document());

    expect(sent).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(sent[0]!))['host']).toBe('web-01');
  });

  it('chunks a document that does not fit one datagram', async () => {
    const { transport, sent } = transportWith('none', 512);
    const big = encodeGelf(gelfPayloadFor(record({ message: 'x'.repeat(3_000) }), 'web-01'));
    await transport.send(big);

    expect(sent.length).toBeGreaterThan(1);
    for (const datagram of sent) {
      expect(datagram[0]).toBe(0x1e);
      expect(datagram[1]).toBe(0x0f);
      expect(datagram[11]).toBe(sent.length);
    }
  });

  it('drops a record too large to chunk, without retrying it', async () => {
    const { transport, sent } = transportWith('none', 512);
    const enormous = encodeGelf(gelfPayloadFor(record({ message: 'x'.repeat(200_000) }), 'web-01'));

    await expect(transport.send(enormous)).rejects.toThrow(/more than the 128/);
    expect(sent).toHaveLength(0);
  });
});

describe('GelfSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = GelfSinkOptions.create()
      .withHost('graylog.internal')
      .withProtocol('tcp');

    expect(new GelfSink(options).name).toBe('gelf');
  });

  it('requires a URL for the http protocol', () => {
    expect(() => new GelfSink({ protocol: 'http' })).toThrow(/url is required/);
  });

  it('rejects TLS on a protocol that cannot use it', () => {
    expect(() => new GelfSink({ protocol: 'udp', tls: { cert: 'x', key: 'y' } }))
      .toThrow(/tls is only supported when protocol is tcp/);
  });

  it('rejects an out-of-range chunk size', () => {
    expect(() => new GelfSink({ maxChunkBytes: 100 })).toThrow(OptionsError);
    expect(() => new GelfSink({ maxChunkBytes: 70_000 })).toThrow(OptionsError);
  });

  it('rejects an invalid port', () => {
    expect(() => new GelfSink({ port: 0 })).toThrow(OptionsError);
  });
});
