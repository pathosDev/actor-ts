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
import { HANDSHAKE_TIMEOUT_MS } from '../../../src/cluster/Constants.js';
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

/** The slice of a `Connection` these tests reach for. */
type TrackedConnection = { handshakeTimer: ReturnType<typeof setTimeout> | null };

/** The private seam the fake backends are installed through, and the deadline they fire by hand. */
type TransportInternals = {
  backend: unknown;
  readonly byPeer: Map<string, TrackedConnection>;
  onHandshakeTimeout(connection: TrackedConnection): void;
  onData(socket: unknown, chunk: Uint8Array): void;
};

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

/** One dial the fake backend received, settled when the test says so. */
type HeldDial = {
  readonly socket: RecordingSocket;
  readonly signal: AbortSignal | undefined;
  /** The runtime reports the socket open, then `connect` resolves — the order the contract fixes. */
  open(): Promise<void>;
  /** The dial fails the way every adapter reports it: a rejection, and no handler. */
  fail(error: unknown): Promise<void>;
  /** Resolves once the transport's own continuation for this dial has run. */
  handled(): Promise<void>;
};

/**
 * Install a backend whose dials hang until the test settles them.  Like every
 * adapter, an abort before the dial is decided rejects it with the signal's
 * reason — so a transport that hands no signal over has nothing to abort.
 *
 * `handled()` polls rather than awaiting the promise: a dial that never
 * settles is exactly what a missing abort looks like, and it has to fail
 * inside the fixture, not on bun's per-test cap.  Polling also orders it after
 * the transport's own reaction, which runs in the same turn the dial settles.
 */
function heldDialer(transport: TcpTransport): HeldDial[] {
  const dials: HeldDial[] = [];
  internals(transport).backend = {
    listen: () => Promise.resolve({ port: 0, close: () => {} }),
    connect: (options: { handlers: TcpSocketHandlers; signal?: AbortSignal }) => {
      const socket = recordingSocket();
      let resolve: (socket: TcpSocketLike) => void = () => {};
      let reject: (reason: unknown) => void = () => {};
      const connected = new Promise<TcpSocketLike>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      const settled = { done: false };
      connected.then(() => { settled.done = true; }, () => { settled.done = true; });
      const { signal } = options;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      const handled = (): Promise<void> =>
        awaitCondition(() => settled.done, { label: 'the dial settled' });
      dials.push({
        socket,
        signal,
        open: async () => {
          options.handlers.onOpen(socket);
          resolve(socket);
          await handled();
        },
        fail: async (error) => {
          reject(error);
          await handled();
        },
        handled,
      });
      return connected;
    },
  };
  return dials;
}

/** Fire a dial's handshake deadline the way the runtime would, with the real timer cancelled. */
function fireHandshakeDeadline(transport: TcpTransport, to: NodeAddress): void {
  const connection = internals(transport).byPeer.get(to.toString());
  expect(connection?.handshakeTimer ?? null).not.toBeNull();
  clearTimeout(connection!.handshakeTimer as ReturnType<typeof setTimeout>);
  internals(transport).onHandshakeTimeout(connection!);
}

describe('a dial that misses its deadline is given up, and says how far it got (#1475)', () => {
  const target = new NodeAddress('peer', '10.0.0.9', 2_552);
  const bounds = { handshakeTimeoutMs: 250, incompleteFrameIdleMs: 900 };

  function dialling(log: Logger = new NoopLogger()): { transport: TcpTransport; dials: HeldDial[] } {
    const transport = new TcpTransport(self, log, bounds);
    transports.push(transport);
    return { transport, dials: heldDialer(transport) };
  }

  test('a dial that never connects is aborted at the deadline, and says it could not connect', async () => {
    // Forgotten was not enough: the dial went on connecting for about 21 s
    // past the deadline on Bun and on Node.  Aborted, the adapter destroys it.
    const log = new CapturingLogger();
    const { transport, dials } = dialling(log);
    transport.send(target, heartbeat(1));

    fireHandshakeDeadline(transport, target);
    await dials[0]!.handled();

    expect(dials[0]!.signal?.aborted).toBe(true);
    expect(log.warnings.map((warning) => warning.message)).toEqual([
      `could not connect to ${target} within 250 ms; dropping the connection and 1 buffered frame(s)`,
    ]);
  });

  test('a dial that connected but got no hello-ack says so instead', async () => {
    // The other half of the old line: a peer that accepts and never speaks
    // used to log exactly what a blackholed connect did.
    const log = new CapturingLogger();
    const { transport, dials } = dialling(log);
    transport.send(target, heartbeat(1));
    await dials[0]!.open();

    fireHandshakeDeadline(transport, target);

    expect(log.warnings.map((warning) => warning.message)).toEqual([
      `connected to ${target}, but no hello-ack came within 250 ms; dropping the connection and 1 buffered frame(s)`,
    ]);
    expect({ destroyed: dials[0]!.socket.destroyed, ended: dials[0]!.socket.ended })
      .toEqual({ destroyed: true, ended: false });
  });

  test('a refused dial is one WARN, worded from the deadline, with the runtime\'s error attached', async () => {
    // One line on every runtime, and never the runtime's verdict: Bun on
    // Windows reports an unanswered SYN as ECONNREFUSED, so a line that
    // quoted the code would call a blackholed peer a refusal.  The error rides
    // along as the cause; the wording is the transport's own.
    const log = new CapturingLogger();
    const { transport, dials } = dialling(log);
    transport.send(target, heartbeat(1));
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:2552'), { code: 'ECONNREFUSED' });

    await dials[0]!.fail(refused);

    expect(log.warnings).toEqual([{
      message: `could not connect to ${target} within 250 ms; dropping the connection and 1 buffered frame(s)`,
      args: [refused],
    }]);
  });

  test('a dial given up at its deadline is reported once, not again when its connect gives up', async () => {
    // The abort rejects the pending connect, and the dial's catch used to log
    // that rejection as a second failure of a connection already dropped.
    const log = new CapturingLogger();
    const { transport, dials } = dialling(log);
    transport.send(target, heartbeat(1));

    fireHandshakeDeadline(transport, target);
    await dials[0]!.handled();

    expect(log.warnings).toHaveLength(1);
  });

  test('disconnect() and shutdown() give up a dial still connecting', async () => {
    const disconnected = dialling();
    disconnected.transport.send(target, heartbeat(1));
    disconnected.transport.disconnect(target);
    expect(disconnected.dials[0]!.signal?.aborted).toBe(true);

    const stopped = dialling();
    stopped.transport.send(target, heartbeat(1));
    await stopped.transport.shutdown();
    expect(stopped.dials[0]!.signal?.aborted).toBe(true);
  });

  test('shutdown() destroys a dial that connected but was never acked', async () => {
    // Nothing but its own hello was ever written to it — buffered frames wait
    // for the hello-ack — so there is nothing to flush, and a half-close would
    // leave the socket open for as long as a silent peer keeps its half.
    const { transport, dials } = dialling();
    transport.send(target, heartbeat(1));
    await dials[0]!.open();

    await transport.shutdown();

    expect({ destroyed: dials[0]!.socket.destroyed, ended: dials[0]!.socket.ended })
      .toEqual({ destroyed: true, ended: false });
  });

  test('shutdown() still closes an acked dial in order, so what was written reaches the peer', async () => {
    // The control: `Cluster.leave` writes its leave frames just before
    // `shutdown()`, and an abort would discard whatever is still buffered.
    const { transport, dials } = dialling();
    transport.send(target, heartbeat(1));
    await dials[0]!.open();
    internals(transport).onData(dials[0]!.socket, encodeFrame({ kind: 'hello-ack', self: target.toJSON() }));

    await transport.shutdown();

    expect({ destroyed: dials[0]!.socket.destroyed, ended: dials[0]!.socket.ended })
      .toEqual({ destroyed: false, ended: true });
  });
});

describe('the deadline gives up a real dial, not just its bookkeeping (#1475)', () => {
  test('a dial still in its TLS handshake at the deadline is destroyed', async () => {
    // A plaintext listener that never speaks TLS keeps a TLS dial pending for
    // as long as the test likes.  Pre-fix the deadline dropped the Connection
    // and the dial went on, its socket open on the listener's side.
    const accepted: TcpSocketLike[] = [];
    const closed: TcpSocketLike[] = [];
    const listener = await new BunTcpBackend().listen({
      host: '127.0.0.1',
      port: 0,
      handlers: {
        onOpen: (socket) => { accepted.push(socket); sockets.push(socket); },
        onData: () => {},
        onClose: (socket) => { closed.push(socket); },
        onError: () => {},
      },
    });
    listeners.push(listener);
    const log = new CapturingLogger();
    const transport = new TcpTransport(self, log, {
      tls: { ca: CA, serverName: 'localhost' },
      handshakeTimeoutMs: 200,
      incompleteFrameIdleMs: 900,
    });
    transports.push(transport);
    internals(transport).backend = new NodeTcpBackend();
    const peer = new NodeAddress('silent', '127.0.0.1', listener.port);

    transport.send(peer, heartbeat(1));

    await awaitCondition(() => accepted.length === 1, { label: 'the TCP connect landed' });
    await awaitCondition(() => closed.length === 1, { label: 'the deadline destroyed the dial' });
    expect(log.warnings.map((warning) => warning.message)).toEqual([
      `could not connect to ${peer} within 200 ms; dropping the connection and 1 buffered frame(s)`,
    ]);
  });

  test('a refused dial on the default backend is the same one WARN', async () => {
    const vacated = await new BunTcpBackend().listen({
      host: '127.0.0.1',
      port: 0,
      handlers: { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} },
    });
    const port = vacated.port;
    await vacated.close();
    const log = new CapturingLogger();
    const transport = new TcpTransport(self, log);
    transports.push(transport);
    const peer = new NodeAddress('gone', '127.0.0.1', port);

    transport.send(peer, heartbeat(1));

    await awaitCondition(() => log.warnings.length > 0, { label: 'the refused dial was reported' });
    expect(log.warnings.map((warning) => warning.message)).toEqual([
      `could not connect to ${peer} within ${HANDSHAKE_TIMEOUT_MS} ms; dropping the connection and 1 buffered frame(s)`,
    ]);
    expect(log.warnings[0]!.args[0]).toBeInstanceOf(Error);
  });
});
