import { describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import {
  DEFAULT_SYSLOG_FACILITY,
  frameForStream,
  syslogMessageFor,
} from '../../../src/logging/SyslogFrame.js';
import { SyslogSink } from '../../../src/logging/SyslogSink.js';
import { SyslogSinkOptions } from '../../../src/logging/SyslogSinkOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
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

const parts = { facility: 16, hostName: 'web-01', appName: 'orders', processId: '1234' };

describe('RFC 5424 frame', () => {
  it('lays out the header exactly as the RFC specifies', () => {
    expect(syslogMessageFor(record(), parts)).toBe(
      '<134>1 2026-08-12T09:41:02.113Z web-01 orders 1234 - - placing order',
    );
  });

  it('computes the priority as facility · 8 + severity', () => {
    const priorityOf = (level: LogLevel, facility: number): number =>
      Number(/^<(\d+)>/.exec(syslogMessageFor(record({ level }), { ...parts, facility }))![1]);

    // local0 (16): 16·8 = 128, plus the severity.
    expect(priorityOf(LogLevel.Debug, 16)).toBe(135);
    expect(priorityOf(LogLevel.Info, 16)).toBe(134);
    expect(priorityOf(LogLevel.Warn, 16)).toBe(132);
    expect(priorityOf(LogLevel.Error, 16)).toBe(131);
    // user-level (1): 8 + severity.
    expect(priorityOf(LogLevel.Error, 1)).toBe(11);
    // kernel (0): the severity alone.
    expect(priorityOf(LogLevel.Error, 0)).toBe(3);
  });

  it('appends the record fields to MSG', () => {
    const message = syslogMessageFor(record({
      source: 'actor-ts://orders/user/order',
      fields: { tenant: 'acme' },
    }), parts);

    expect(message).toEndWith('actor-ts://orders/user/order - placing order {tenant=acme}');
  });

  it('uses the nil value for an empty hostname or process id', () => {
    const message = syslogMessageFor(record(), { ...parts, hostName: '', processId: '' });
    expect(message).toBe('<134>1 2026-08-12T09:41:02.113Z - orders - - - placing order');
  });

  it('strips characters that would shift the following fields', () => {
    const message = syslogMessageFor(record(), { ...parts, hostName: 'web 01', appName: 'my app' });
    // A space inside HOSTNAME would move APP-NAME into its place.
    expect(message).toContain(' web01 myapp ');
  });

  it('leaves the structured-data element nil', () => {
    // A well-formed SD-ID needs an IANA enterprise number this project
    // does not have; fields ride in MSG instead.
    expect(syslogMessageFor(record(), parts)).toContain(' 1234 - - placing order');
  });

  it('defaults the facility to local0', () => {
    expect(DEFAULT_SYSLOG_FACILITY).toBe(16);
  });
});

describe('stream framing', () => {
  it('prefixes the byte length for octet-counting', () => {
    const message = syslogMessageFor(record(), parts);
    const framed = frameForStream(message, 'octet-counting');

    const [length, rest] = [framed.slice(0, framed.indexOf(' ')), framed.slice(framed.indexOf(' ') + 1)];
    expect(Number(length)).toBe(new TextEncoder().encode(message).length);
    expect(rest).toBe(message);
  });

  it('counts bytes, not characters', () => {
    const message = syslogMessageFor(record({ message: 'grüße' }), parts);
    const framed = frameForStream(message, 'octet-counting');

    const declared = Number(framed.slice(0, framed.indexOf(' ')));
    expect(declared).toBe(new TextEncoder().encode(message).length);
    // A character count would cut the frame short of the real bytes.
    expect(declared).toBeGreaterThan(message.length);
  });

  it('keeps a multi-line message intact under octet-counting', () => {
    const message = syslogMessageFor(record({ message: 'boom\n  at somewhere' }), parts);
    const framed = frameForStream(message, 'octet-counting');

    expect(framed).toContain('\n');
    const declared = Number(framed.slice(0, framed.indexOf(' ')));
    expect(declared).toBe(new TextEncoder().encode(message).length);
  });

  it('collapses newlines under lf framing, because it cannot represent them', () => {
    const message = syslogMessageFor(record({ message: 'boom\n  at somewhere' }), parts);
    const framed = frameForStream(message, 'lf');

    expect(framed.endsWith('\n')).toBe(true);
    expect(framed.slice(0, -1)).not.toContain('\n');
  });
});

/** A sink whose wire records instead of sending. */
class RecordingSyslogSink extends SyslogSink {
  readonly sent: string[] = [];
  closes = 0;

  protected override createWire() {
    return {
      send: async (message: string) => { this.sent.push(message); },
      close: async () => { this.closes += 1; },
    };
  }
}

describe('SyslogSink delivery', () => {
  it('sends one message per record', async () => {
    const sink = new RecordingSyslogSink({ hostName: 'web-01', appName: 'orders' });
    sink.write(record({ message: 'a' }));
    sink.write(record({ message: 'b' }));
    await sink.flush();

    expect(sink.sent).toHaveLength(2);
    expect(sink.sent[0]).toEndWith('a');
    expect(sink.sent[1]).toEndWith('b');
  });

  it('closes its wire on close', async () => {
    const sink = new RecordingSyslogSink({ hostName: 'web-01' });
    sink.write(record());
    await sink.close();

    expect(sink.closes).toBe(1);
  });

  it('takes APP-NAME from the actor system when unset', async () => {
    const sink = new RecordingSyslogSink({ hostName: 'web-01' });
    sink.attach({ systemName: 'orders' });
    sink.write(record());
    await sink.flush();

    expect(sink.sent[0]).toContain(' web-01 orders ');
  });

  it('keeps an explicitly configured APP-NAME', async () => {
    const sink = new RecordingSyslogSink({ hostName: 'web-01', appName: 'explicit' });
    sink.attach({ systemName: 'orders' });
    sink.write(record());
    await sink.flush();

    expect(sink.sent[0]).toContain(' web-01 explicit ');
  });
});

describe('SyslogSinkOptions', () => {
  it('accepts the fluent builder', () => {
    const options = SyslogSinkOptions.create()
      .withHost('logs.internal')
      .withTransport('tcp')
      .withFacility(20);

    expect(new SyslogSink(options).name).toBe('syslog');
  });

  it('rejects a facility outside the RFC range', () => {
    expect(() => new SyslogSink({ facility: 24 })).toThrow(OptionsError);
    expect(() => new SyslogSink({ facility: -1 })).toThrow(OptionsError);
  });

  it('rejects an unknown transport or framing', () => {
    expect(() => new SyslogSink({ transport: 'sctp' as 'tcp' })).toThrow(OptionsError);
    expect(() => new SyslogSink({ framing: 'crlf' as 'lf' })).toThrow(OptionsError);
  });

  it('rejects TLS material on a transport that cannot use it', () => {
    expect(() => new SyslogSink({ transport: 'udp', tls: { ca: 'x' } }))
      .toThrow(/tls is only supported when transport is tls/);
  });

  it('rejects an invalid port', () => {
    expect(() => new SyslogSink({ port: 70_000 })).toThrow(OptionsError);
  });

  it('validates the nested delivery block', () => {
    expect(() => new SyslogSink({ delivery: { queueCapacity: -5 } }))
      .toThrow(/delivery\.queueCapacity/);
  });
});
