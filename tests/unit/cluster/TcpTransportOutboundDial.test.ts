/**
 * #1475 — the dialling side of `TcpTransport`, between `send` and the peer's
 * `hello-ack`: what it writes, and what it says when that never arrives.
 *
 * Until this file nothing in `tests/` pinned any outbound-dial message at all,
 * which is how a blackholed connect and a peer that accepts and never speaks
 * came to log the same line.  Most cases drive the transport through a fake
 * backend whose dials settle when the test says so — the same shape the
 * #1476 cases in `tests/multi-node/ClusterSecurity.test.ts` use — and the ones
 * whose defect lives in a runtime's socket events run over real loopback
 * sockets instead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { Logger } from '../../../src/Logger.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder } from '../../../src/cluster/Protocol.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { BunTcpBackend } from '../../../src/runtime/tcp/BunTcpBackend.js';
import { NodeTcpBackend } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type {
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
} from '../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** One WARN as the transport emitted it, with whatever it attached. */
type Warning = { readonly message: string; readonly args: readonly unknown[] };

/** Collects the transport's WARNs together with the error each one carried. */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: Warning[] = [];
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(message: string, ...args: unknown[]): void { this.warnings.push({ message, args }); }
  error(_message: string, ..._args: unknown[]): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: Record<string, unknown>): Logger { return this; }
}

/** The private seam the fake backends are installed through. */
type TransportInternals = { backend: unknown };

function internals(transport: TcpTransport): TransportInternals {
  return transport as unknown as TransportInternals;
}

const self = new NodeAddress('dialler', '127.0.0.1', 2_552);

function heartbeat(seq: number): WireMessage {
  return { kind: 'heartbeat', from: self.toJSON(), seq, ts: seq };
}

/** Everything a test opened, released whether it passed or not. */
const transports: TcpTransport[] = [];
const listeners: TcpListener[] = [];
const sockets: TcpSocketLike[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
  for (const socket of sockets.splice(0)) {
    try { socket.destroy?.(); } catch { /* already gone */ }
  }
  for (const listener of listeners.splice(0)) await listener.close();
});

/** A socket that records what was written to it and how it was closed. */
type RecordingSocket = TcpSocketLike & {
  readonly writes: Uint8Array[];
  ended: boolean;
  destroyed: boolean;
};

function recordingSocket(): RecordingSocket {
  return {
    writes: [],
    ended: false,
    destroyed: false,
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void { this.ended = true; },
    destroy(): void { this.destroyed = true; },
  };
}

describe('the dial writes one hello (#1475)', () => {
  test('a TLS dial over node:tls writes one hello, not two', async () => {
    // Node's `tls.connect` — and Bun's — emit `connect` and then
    // `secureConnect`, and the adapter mapped both to `onOpen`, so every TLS
    // dial from Node announced itself twice.  Read on the far side, from the
    // bytes that actually crossed the wire.
    const received: WireMessage[] = [];
    const decoder = new FrameDecoder();
    let peer = self;
    const listener = await new BunTcpBackend().listen({
      host: '127.0.0.1',
      port: 0,
      tls: { cert: CERT, key: KEY },
      handlers: {
        onOpen: (socket) => { sockets.push(socket); },
        onData: (socket, chunk) => {
          for (const message of decoder.push(chunk)) {
            received.push(message);
            // Ack the first hello only, as a peer would: the second one is the
            // defect, and answering it would hide nothing either way.
            if (message.kind === 'hello' && received.filter((m) => m.kind === 'hello').length === 1) {
              socket.write(encodeFrame({ kind: 'hello-ack', self: peer.toJSON() }));
            }
          }
        },
        onClose: () => {},
        onError: () => {},
      },
    });
    listeners.push(listener);
    peer = new NodeAddress('listener', '127.0.0.1', listener.port);

    const transport = new TcpTransport(self, new NoopLogger(), { tls: { ca: CA, serverName: 'localhost' } });
    transports.push(transport);
    internals(transport).backend = new NodeTcpBackend();
    transport.send(peer, heartbeat(1));

    // The heartbeat is flushed by the hello-ack, so by the time it arrives
    // every hello this dial was ever going to write is already in front of it.
    await awaitCondition(() => received.some((m) => m.kind === 'heartbeat'), {
      label: 'the buffered heartbeat crossed the TLS connection',
    });
    expect(received.filter((m) => m.kind === 'hello')).toHaveLength(1);
  });

  test('a runtime that reports the open twice still gets one hello', async () => {
    // The transport's own half: whatever an adapter does, opening is a state
    // the dial enters once, not an event it reacts to every time.
    const socket = recordingSocket();
    const transport = new TcpTransport(self, new NoopLogger());
    transports.push(transport);
    internals(transport).backend = {
      listen: () => Promise.resolve({ port: 0, close: () => {} }),
      connect: (options: { handlers: TcpSocketHandlers }) => {
        options.handlers.onOpen(socket);
        options.handlers.onOpen(socket);
        return Promise.resolve(socket);
      },
    };

    transport.send(new NodeAddress('peer', '127.0.0.1', 2_553), heartbeat(1));
    await Promise.resolve();

    expect(socket.writes).toHaveLength(1);
  });
});
