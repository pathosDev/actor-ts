/**
 * When `TcpBackend.connect` tells its caller things — the half of the contract
 * no type can state, and the half every consumer builds on (#1475).
 *
 * `TcpTransport` writes its `hello` from `onOpen`, `ClusterClient` does the
 * same, and both treat a rejected `connect` as "this dial failed".  So
 * `onOpen` firing twice is two handshakes on one socket, and a failure that
 * arrives as an `onError` on one runtime and a rejection on another is two
 * different log lines for the same refused peer.
 *
 * Real sockets over loopback, because the defect is in which native events the
 * adapter listens to; a fake socket would only repeat the adapter's own idea of
 * them.  TLS runs on the throwaway material in `tests/fixtures/tls/` and
 * verifies against its CA.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BunTcpBackend } from '../../../../src/runtime/tcp/BunTcpBackend.js';
import { NodeTcpBackend } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type {
  TcpListener,
  TcpSocketLike,
  TlsTransportOptionsType,
} from '../../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const FIXTURES = new URL('../../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** Everything a test opened, released whether it passed or not. */
const listeners: TcpListener[] = [];
const sockets: TcpSocketLike[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { socket.destroy?.(); } catch { /* already gone */ }
  }
  for (const listener of listeners.splice(0)) await listener.close();
});

/**
 * A listener that answers the first byte it receives with one byte of its own.
 *
 * The answer is what makes "opened once" decidable without waiting on a clock:
 * application data reaches the client only after its handshake has finished,
 * so every open event the client's runtime is going to emit has been emitted
 * by the time the answer arrives.
 */
async function answeringListener(tls?: TlsTransportOptionsType): Promise<TcpListener> {
  const listener = await new BunTcpBackend().listen({
    host: '127.0.0.1',
    port: 0,
    ...(tls === undefined ? {} : { tls }),
    handlers: {
      onOpen: (socket) => { sockets.push(socket); },
      onData: (socket) => { socket.write(Uint8Array.of(0x79)); },
      onClose: () => {},
      onError: () => {},
    },
  });
  listeners.push(listener);
  return listener;
}

describe('a dial opens exactly once (#1475)', () => {
  test('a TLS dial over node:tls opens once, not once per handshake event', async () => {
    // `tls.connect` emits `connect` when the TCP connect lands and
    // `secureConnect` when the TLS handshake does — both, on Node and on Bun's
    // `node:tls` alike.  Mapping both to `onOpen` wrote two `hello` frames per
    // TLS dial from `TcpTransport` and from `ClusterClient`.
    const listener = await answeringListener({ cert: CERT, key: KEY });
    let opened = 0;
    let answered = false;
    const client = await new NodeTcpBackend().connect({
      host: '127.0.0.1',
      port: listener.port,
      tls: { ca: CA, serverName: 'localhost' },
      handlers: {
        onOpen: (socket) => { opened += 1; socket.write(Uint8Array.of(0x78)); },
        onData: () => { answered = true; },
        onClose: () => {},
        onError: () => {},
      },
    });
    sockets.push(client);

    await awaitCondition(() => answered, { label: 'the TLS listener answered' });
    expect(opened).toBe(1);
  });

  test('a plaintext dial over node:net opens once too', async () => {
    // The control for the case above: a fix that listened for `secureConnect`
    // alone would pass it and never open a plaintext socket at all.
    const listener = await answeringListener();
    let opened = 0;
    let answered = false;
    const client = await new NodeTcpBackend().connect({
      host: '127.0.0.1',
      port: listener.port,
      handlers: {
        onOpen: (socket) => { opened += 1; socket.write(Uint8Array.of(0x78)); },
        onData: () => { answered = true; },
        onClose: () => {},
        onError: () => {},
      },
    });
    sockets.push(client);

    await awaitCondition(() => answered, { label: 'the plaintext listener answered' });
    expect(opened).toBe(1);
  });
});

/** A loopback port nothing listens on: bound once to find it, then let go. */
async function refusingPort(): Promise<number> {
  const listener = await new BunTcpBackend().listen({
    host: '127.0.0.1',
    port: 0,
    handlers: { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} },
  });
  const port = listener.port;
  await listener.close();
  return port;
}

/** Counts every handler call, so "no handler fired" is an assertion and not a hope. */
function countingHandlers(): {
  readonly calls: string[];
  readonly handlers: {
    onOpen(): void; onData(): void; onClose(): void; onError(): void;
  };
} {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      onOpen: () => { calls.push('open'); },
      onData: () => { calls.push('data'); },
      onClose: () => { calls.push('close'); },
      onError: () => { calls.push('error'); },
    },
  };
}

describe('a dial settles when it is decided (#1475)', () => {
  test('connect resolves only once the socket is open', async () => {
    // A caller that has the socket in hand has a connection: everything it
    // does next — install the socket, count it as connected — assumes that.
    // Node's adapter resolved before the TCP connect even started.
    const listener = await answeringListener();
    const { calls, handlers } = countingHandlers();

    const client = await new NodeTcpBackend().connect({ host: '127.0.0.1', port: listener.port, handlers });
    sockets.push(client);

    expect(calls).toEqual(['open']);
  });

  test('a refused dial rejects, and no handler fires', async () => {
    // The rejection is the report.  Node's adapter resolved first and then
    // reported the refusal through `onError` and `onClose`, so a caller saw
    // the same refused peer as a connect failure on Bun and Deno and as a
    // dead established socket on Node — and logged two different lines.
    const port = await refusingPort();
    const { calls, handlers } = countingHandlers();

    const outcome = await new NodeTcpBackend()
      .connect({ host: '127.0.0.1', port, handlers })
      .then((socket) => { sockets.push(socket); return 'resolved'; }, () => 'rejected');

    // A second refused dial is the clock: the first socket's own `close`
    // follows its `error` in the same turn, long before another dial fails.
    await new NodeTcpBackend()
      .connect({ host: '127.0.0.1', port, handlers: countingHandlers().handlers })
      .then((socket) => { sockets.push(socket); }, () => {});

    expect(outcome).toBe('rejected');
    expect(calls).toEqual([]);
  });
});
