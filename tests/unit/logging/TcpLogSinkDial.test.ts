/**
 * #1475 — how the GELF and syslog sinks reach a collector over TCP: what
 * arrives on a fresh connection, and how long a collector that does not
 * answer can hold a batch.
 *
 * Both sinks write as soon as `TcpBackend.connect` resolves, so they are only
 * as good as that promise.  Over TLS on Bun it used to resolve at the TCP
 * connect, before the handshake, and Bun drops what is written in that
 * window: the first batch on every fresh connection never reached the
 * collector.  Real loopback sockets here, because the loss lived in the
 * runtime's socket; the collectors present a certificate minted per run.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { GelfSink } from '../../../src/logging/GelfSink.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import { SyslogSink } from '../../../src/logging/SyslogSink.js';
import { BunTcpBackend } from '../../../src/runtime/tcp/BunTcpBackend.js';
import type { TcpListener, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { mintTlsMaterial } from '../cluster/TcpTransportTlsIpLiteralPeer.fixture.js';

const material = mintTlsMaterial();

function record(message: string): LogRecord {
  return { timestampMs: Date.UTC(2026, 9, 29, 9, 41, 2), level: LogLevel.Info, message, fields: {} };
}

/** Everything a test opened, released whether it passed or not. */
const sinks: Array<GelfSink | SyslogSink> = [];
const listeners: TcpListener[] = [];
const accepted: TcpSocketLike[] = [];

afterEach(async () => {
  for (const sink of sinks.splice(0)) await sink.close();
  for (const socket of accepted.splice(0)) {
    try { socket.destroy?.(); } catch { /* already gone */ }
  }
  for (const listener of listeners.splice(0)) await listener.close();
});

/** A TLS collector that keeps every byte it is sent, as text. */
async function tlsCollector(): Promise<{ readonly port: number; received(): string }> {
  const decoder = new TextDecoder();
  let received = '';
  const listener = await new BunTcpBackend().listen({
    host: '127.0.0.1',
    port: 0,
    tls: material.withIpSan,
    handlers: {
      onOpen: (socket) => { accepted.push(socket); },
      onData: (_socket, chunk) => { received += decoder.decode(chunk, { stream: true }); },
      onClose: () => {},
      onError: () => {},
    },
  });
  listeners.push(listener);
  return { port: listener.port, received: () => received };
}

describe('the first batch over TLS reaches the collector (#1475)', () => {
  test('GELF over TCP and TLS', async () => {
    const collector = await tlsCollector();
    const sink = new GelfSink({ protocol: 'tcp', host: '127.0.0.1', port: collector.port, tls: { ca: material.ca }, hostName: 'web-01' });
    sinks.push(sink);

    for (const message of ['first', 'second', 'third']) sink.write(record(message));
    await sink.flush();

    await awaitCondition(
      () => collector.received().split('\0').filter((document) => document !== '').length === 3,
      { label: 'the collector received all three GELF documents of the first batch' },
    );
    const documents = collector.received().split('\0').filter((document) => document !== '');
    expect(documents.map((document) => JSON.parse(document)['short_message'])).toEqual(['first', 'second', 'third']);
    expect(sink.droppedCount).toBe(0);
  });

  test('syslog over TLS', async () => {
    const collector = await tlsCollector();
    const sink = new SyslogSink({
      transport: 'tls', host: '127.0.0.1', port: collector.port, tls: { ca: material.ca }, hostName: 'web-01', appName: 'orders',
    });
    sinks.push(sink);

    for (const message of ['first', 'second', 'third']) sink.write(record(message));
    await sink.flush();

    const messages = (): string[] => octetCountedFrames(collector.received());
    await awaitCondition(() => messages().length === 3, { label: 'the collector received all three syslog messages of the first batch' });
    expect(messages().map((message) => message.split(' - - ')[1])).toEqual(['first', 'second', 'third']);
    expect(sink.droppedCount).toBe(0);
  });
});

/** RFC 6587 octet counting — `<length> <frame>`, back to back — read as far as the text is complete. */
function octetCountedFrames(text: string): string[] {
  const frames: string[] = [];
  let rest = text;
  for (let header = /^(\d+) /.exec(rest); header !== null; header = /^(\d+) /.exec(rest)) {
    const end = header[0].length + Number(header[1]);
    if (rest.length < end) break;
    frames.push(rest.slice(header[0].length, end));
    rest = rest.slice(end);
  }
  return frames;
}
