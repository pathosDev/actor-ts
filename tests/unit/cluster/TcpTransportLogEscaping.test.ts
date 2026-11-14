/**
 * #1629 — what a peer writes into its handshake never reaches a log line raw.
 *
 * `connection.peer` is built from the peer's own `hello`, and the wire check
 * asks only that `systemName` and `host` are non-empty strings.  So a host
 * holding a line break, rendered as it came, splits one record into two in
 * `ConsoleLogger`, which writes one line per record: the peer forges whole log
 * records that read exactly like genuine ones.  A plaintext cluster has nothing
 * that narrows the claim — the peer need only complete a handshake.
 *
 * Every case drives a line that names a peer-supplied value and asserts that
 * no record carries a raw line break, and that the value is still there in its
 * escaped form — dropping it would hide which peer misbehaved.
 */
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import type { TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const self = new NodeAddress('sim', '10.0.0.100', 5_000, 'test-run');
/** A host that, rendered raw, ends the record and starts a forged one. */
const FORGING_HOST = '10.0.0.1\n2026-11-14T00:00:00Z WARN forged record\u2028more\r';
const forger = new NodeAddress('sim', FORGING_HOST, 5_000, 'test-run');

type RecordingSocket = TcpSocketLike & { destroyed: boolean };

function recordingSocket(): RecordingSocket {
  return {
    destroyed: false,
    write(): boolean { return true; },
    end(): void { /* not asserted on */ },
    destroy(): void { this.destroyed = true; },
  };
}

interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
}

const internals = (transport: TcpTransport): TransportInternals => transport as unknown as TransportInternals;

function handshake(kind: 'hello' | 'hello-ack', address: NodeAddress): Uint8Array {
  return encodeFrame({ kind, wireVersion: 2, minWireVersion: 2, self: address.toJSON() });
}

/** An accepted socket that has announced `identity`, on a fresh transport. */
function acceptedFrom(identity: NodeAddress): { transport: TcpTransport; log: RecordingLogger; socket: RecordingSocket } {
  const log = new RecordingLogger();
  const transport = new TcpTransport(self, log);
  const socket = recordingSocket();
  internals(transport).attachInbound(socket);
  internals(transport).onData(socket, handshake('hello', identity));
  return { transport, log, socket };
}

const RAW_LINE_BREAK = /[\r\n\u2028\u2029]/;

/** The warnings logged, after asserting that none of them holds a raw line break. */
function warnings(log: RecordingLogger): string[] {
  for (const record of log.records) expect(RAW_LINE_BREAK.test(record.message)).toBe(false);
  return log.records.filter((record) => record.level === 'warn').map((record) => record.message);
}

describe('TcpTransport escapes a peer-supplied address in its log lines (#1629)', () => {
  test('the malformed-frame WARN names the peer escaped', async () => {
    const { transport, log, socket } = acceptedFrom(forger);
    internals(transport).onData(socket, encodeFrame({ kind: 'gossip' } as never));

    const lines = warnings(log).filter((line) => line.startsWith('rejecting malformed frame'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('10.0.0.1\\u000a2026-11-14T00:00:00Z WARN forged record\\u2028more\\u000d');
    await transport.shutdown();
  });

  test('the handler-threw WARN names the peer escaped', async () => {
    const { transport, log, socket } = acceptedFrom(forger);
    transport.setHandler(() => { throw new Error('boom'); });
    internals(transport).onData(socket, encodeFrame({ kind: 'extension-frame' } as never));

    const lines = warnings(log).filter((line) => line.startsWith('wire handler threw'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\\u000a');
    await transport.shutdown();
  });

  test('the frame-decoder WARN names the peer escaped', async () => {
    const { transport, log, socket } = acceptedFrom(forger);
    // A length prefix far above the frame cap: the decoder throws on it.
    internals(transport).onData(socket, new Uint8Array([0x7f, 0xff, 0xff, 0xff]));

    const lines = warnings(log).filter((line) => line.startsWith('frame-decoder error'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\\u000a');
    await transport.shutdown();
  });

  test('the hello-hijack WARN names the claimed address escaped', async () => {
    const { transport, log } = acceptedFrom(forger);
    const second = recordingSocket();
    internals(transport).attachInbound(second);
    internals(transport).onData(second, handshake('hello', forger));

    expect(second.destroyed).toBe(true);
    const lines = warnings(log).filter((line) => line.startsWith('hello hijack rejected'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\\u000a');
    await transport.shutdown();
  });

  test('the version refusal WARN names the peer escaped', async () => {
    const log = new RecordingLogger();
    const transport = new TcpTransport(self, log);
    const socket = recordingSocket();
    internals(transport).attachInbound(socket);
    // Wire v1 only: refused over the version, and the line names the peer.
    internals(transport).onData(socket, encodeFrame({ kind: 'hello', wireVersion: 1, self: forger.toJSON() }));

    const lines = warnings(log).filter((line) => line.startsWith('cluster handshake from'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\\u000a');
    await transport.shutdown();
  });

  test('a peer\'s hello-refused reason is escaped as well', async () => {
    const log = new RecordingLogger();
    const transport = new TcpTransport(self, log);
    const socket = recordingSocket();
    internals(transport).attachInbound(socket);
    internals(transport).onData(socket, encodeFrame({
      kind: 'hello-refused',
      self: forger.toJSON(),
      wireVersion: 2,
      minWireVersion: 2,
      reason: 'too old\n2026-11-14T00:00:00Z ERROR forged',
    }));

    const lines = warnings(log).filter((line) => line.startsWith('cluster handshake with'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('too old\\u000a2026-11-14T00:00:00Z ERROR forged');
    await transport.shutdown();
  });
});
