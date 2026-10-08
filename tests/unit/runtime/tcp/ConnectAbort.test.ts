/**
 * #1475 — a dial that is given up stays given up: `TcpBackend.connect`'s
 * `signal`, adapter by adapter.
 *
 * An abort owes the caller three things: the promise rejects, no handler fires
 * afterwards, and the socket the dial opened — or opens later — is destroyed
 * rather than half-closed.  The last one is what was missing everywhere.  The
 * transport's deadline forgot a pending dial and the dial went on connecting:
 * about 21 s past the deadline on Bun and on Node, because `end()` on a Node
 * socket still in its TCP connect does not stop the connect, and `destroy()`
 * does, in 2 ms.
 *
 * Two kinds of evidence, because neither is enough alone.  Real loopback
 * sockets show that the runtime's socket really closes: a TLS dial into a
 * listener that never speaks TLS stays pending in its handshake for as long as
 * the test likes, and the listener sees the close.  They cannot show *how* it
 * closed — from the far side an abort and a half-close look alike — and no
 * loopback connect stays pending in its TCP connect long enough to be aborted.
 * So the Node adapter is also driven through its module seam, with a socket
 * that records which of the two it got and lets the test emit what a runtime
 * would.  The Deno adapter is driven through a stubbed `Deno` global, the same
 * way `TlsClientAuth.test.ts` drives it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BunTcpBackend } from '../../../../src/runtime/tcp/BunTcpBackend.js';
import { NodeTcpBackend } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type { NodeSocketModules } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpBackend, TcpListener, TcpSocketLike } from '../../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const FIXTURES = new URL('../../../fixtures/tls/', import.meta.url);
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/**
 * TEST-NET-1: reserved for documentation and assigned to nobody, so a dial a
 * seam fails to intercept goes nowhere rather than to a real host.
 */
const NOWHERE = '192.0.2.1';

/** Everything a test opened, released whether it passed or not. */
const listeners: TcpListener[] = [];
const sockets: TcpSocketLike[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { socket.destroy?.(); } catch { /* already gone */ }
  }
  for (const listener of listeners.splice(0)) await listener.close();
});

/** A listener that records what it accepted and what closed, and says nothing. */
type RecordingListener = {
  readonly port: number;
  readonly accepted: TcpSocketLike[];
  readonly closed: TcpSocketLike[];
  readonly spoke: TcpSocketLike[];
};

/**
 * A plaintext listener that never answers.  A TLS dial into it completes its
 * TCP connect and then waits for a `ServerHello` that never comes — a dial that
 * is pending for exactly as long as the test wants it to be.  It answers a
 * byte only when asked to, so it can also serve as an ordinary peer.
 */
async function recordingListener(answer = false): Promise<RecordingListener> {
  const accepted: TcpSocketLike[] = [];
  const closed: TcpSocketLike[] = [];
  const spoke: TcpSocketLike[] = [];
  const listener = await new BunTcpBackend().listen({
    host: '127.0.0.1',
    port: 0,
    handlers: {
      onOpen: (socket) => { accepted.push(socket); sockets.push(socket); },
      onData: (socket) => {
        spoke.push(socket);
        if (answer) socket.write(Uint8Array.of(0x79));
      },
      onClose: (socket) => { closed.push(socket); },
      onError: () => {},
    },
  });
  listeners.push(listener);
  return { port: listener.port, accepted, closed, spoke };
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

/** A dial being watched; `wait()` yields what it settled with. */
type Settlement = { wait(): Promise<unknown> };

/**
 * Watch a dial from the moment it starts, so a rejection is never unhandled,
 * and let the test ask later what it settled with: the rejection's reason, or
 * `null` once a socket was handed back.
 *
 * The wait is bounded inside the fixture.  A dial that never settles is
 * exactly the failure an abort that does not take hangs on, and bun's
 * per-test cap is no place to report it from.
 */
function settlement(dial: Promise<TcpSocketLike>): Settlement {
  const seen: { outcome: { readonly value: unknown } | null } = { outcome: null };
  dial.then(
    (socket) => { sockets.push(socket); seen.outcome = { value: null }; },
    (reason: unknown) => { seen.outcome = { value: reason }; },
  );
  return {
    async wait(): Promise<unknown> {
      await awaitCondition(() => seen.outcome !== null, { label: 'the dial settled' });
      return seen.outcome?.value;
    },
  };
}

describe('NodeTcpBackend honours the signal, on real sockets', () => {
  test('a signal already aborted rejects before anything is dialled', async () => {
    const listener = await recordingListener();
    const controller = new AbortController();
    controller.abort();
    const { calls, handlers } = countingHandlers();

    const outcome = await settlement(new NodeTcpBackend().connect({
      host: '127.0.0.1', port: listener.port, handlers, signal: controller.signal,
    })).wait();

    // A control dial is the clock.  The aborted one was started first, and a
    // loopback connect lands in a millisecond, so had it dialled at all it
    // would have been accepted before the control's byte arrived.
    const control = await new NodeTcpBackend().connect({
      host: '127.0.0.1', port: listener.port, handlers: countingHandlers().handlers,
    });
    sockets.push(control);
    control.write(Uint8Array.of(0x78));
    await awaitCondition(() => listener.spoke.length === 1, { label: 'the control dial spoke' });

    expect(outcome).toBe(controller.signal.reason);
    expect(listener.accepted).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  test('aborting a dial pending in its TLS handshake rejects it, fires no handler, and closes its socket', async () => {
    const listener = await recordingListener();
    const controller = new AbortController();
    const { calls, handlers } = countingHandlers();

    const outcome = settlement(new NodeTcpBackend().connect({
      host: '127.0.0.1',
      port: listener.port,
      tls: { ca: CA, serverName: 'localhost' },
      handlers,
      signal: controller.signal,
    }));
    await awaitCondition(() => listener.accepted.length === 1, { label: 'the TCP connect landed' });
    controller.abort();

    expect(await outcome.wait()).toBe(controller.signal.reason);
    await awaitCondition(() => listener.closed.length === 1, { label: 'the listener saw the dial close' });
    expect(calls).toEqual([]);
  });

  test('aborting after the dial opened changes nothing', async () => {
    // The guard against the opposite mistake: the signal gives up a *dial*.
    // Once the socket is the caller's, the caller closes it — the transport
    // half-closes an established connection on purpose, so its leave frames
    // still reach the peer, and an abort that reached past the open would
    // throw them away.
    const listener = await recordingListener(true);
    const controller = new AbortController();
    const { calls, handlers } = countingHandlers();
    const client = await new NodeTcpBackend().connect({
      host: '127.0.0.1', port: listener.port, handlers, signal: controller.signal,
    });
    sockets.push(client);

    controller.abort();
    client.write(Uint8Array.of(0x78));

    await awaitCondition(() => calls.includes('data'), { label: 'the socket still carried an answer' });
    expect(calls).toEqual(['open', 'data']);
  });
});

/**
 * A stand-in for a `node:net` / `node:tls` socket: it records how it was
 * closed, and lets the test emit the events a runtime would.
 */
class FakeNodeSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  destroyed = false;
  ended = false;
  readonly remoteAddress = undefined;

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  write(): boolean { return true; }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }
}

/**
 * Socket modules that hand out `socket` and record what was dialled, behind an
 * optional gate standing in for the first-use `import()` of the real ones.
 */
function fakeModules(socket: FakeNodeSocket, gate: Promise<void> = Promise.resolve()): {
  readonly modules: NodeSocketModules;
  readonly dialled: unknown[];
} {
  const dialled: unknown[] = [];
  const module = {
    createServer: (): never => { throw new Error('no listener in this test'); },
    connect: (options: unknown): FakeNodeSocket => { dialled.push(options); return socket; },
  };
  return {
    dialled,
    modules: {
      net: async () => { await gate; return module as never; },
      tls: async () => { await gate; return module as never; },
    },
  };
}

describe('NodeTcpBackend honours the signal, through its module seam', () => {
  test('an abort destroys the pending socket, never half-closes it, and silences it', async () => {
    const socket = new FakeNodeSocket();
    const { modules, dialled } = fakeModules(socket);
    const controller = new AbortController();
    const { calls, handlers } = countingHandlers();

    const outcome = settlement(new NodeTcpBackend(modules).connect({
      host: NOWHERE, port: 2_552, handlers, signal: controller.signal,
    }));
    await awaitCondition(() => dialled.length === 1, { label: 'the adapter dialled' });
    controller.abort();

    expect(await outcome.wait()).toBe(controller.signal.reason);
    expect({ destroyed: socket.destroyed, ended: socket.ended }).toEqual({ destroyed: true, ended: false });
    // Whatever the runtime still emits on a socket it was told to destroy goes nowhere.
    socket.emit('connect');
    socket.emit('data', Uint8Array.of(1));
    socket.emit('error', new Error('late'));
    socket.emit('close');
    expect(calls).toEqual([]);
  });

  test('an abort while the runtime module is still loading dials nothing at all', async () => {
    // The first dial on Node `import()`s `node:net`, so there is a window in
    // which the abort lands and no socket exists yet.  Dialling and then
    // destroying would still send a SYN to a peer that was given up on.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { modules, dialled } = fakeModules(new FakeNodeSocket(), gate);
    const controller = new AbortController();

    const outcome = settlement(new NodeTcpBackend(modules).connect({
      host: NOWHERE, port: 2_552, handlers: countingHandlers().handlers, signal: controller.signal,
    }));
    controller.abort();
    release();

    expect(await outcome.wait()).toBe(controller.signal.reason);
    expect(dialled).toEqual([]);
  });

  test('a dial that fails before it opens rejects with the runtime\'s error, and nothing else fires', async () => {
    const socket = new FakeNodeSocket();
    const { modules, dialled } = fakeModules(socket);
    const { calls, handlers } = countingHandlers();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    const outcome = settlement(new NodeTcpBackend(modules).connect({ host: NOWHERE, port: 2_552, handlers }));
    await awaitCondition(() => dialled.length === 1, { label: 'the adapter dialled' });
    socket.emit('error', refused);
    socket.emit('close');

    expect(await outcome.wait()).toBe(refused);
    expect(calls).toEqual([]);
  });

  test('once the socket is open the signal lets go of it', async () => {
    const socket = new FakeNodeSocket();
    const { modules, dialled } = fakeModules(socket);
    const controller = new AbortController();
    const { calls, handlers } = countingHandlers();

    const outcome = settlement(new NodeTcpBackend(modules).connect({
      host: NOWHERE, port: 2_552, handlers, signal: controller.signal,
    }));
    await awaitCondition(() => dialled.length === 1, { label: 'the adapter dialled' });
    socket.emit('connect');
    expect(await outcome.wait()).toBeNull();

    controller.abort();
    expect({ destroyed: socket.destroyed, ended: socket.ended }).toEqual({ destroyed: false, ended: false });
    socket.emit('close');
    expect(calls).toEqual(['open', 'close']);
  });
});

/**
 * Native `Bun.connect` takes no signal, and a dial abandoned on it ran on for
 * about 21 s past the deadline that gave it up.  Bun's own `node:net` and
 * `node:tls` cancel within milliseconds, so a dial that may have to be given
 * up goes through them instead.
 */
describe('BunTcpBackend honours the signal', () => {
  test('a signalled dial pending in its TLS handshake is aborted, and its socket closed', async () => {
    // Natively this dial would not even be pending: Bun runs `open` when the
    // TCP connect lands, before the handshake, so `connect` resolved here with
    // a socket nobody could cancel.
    const listener = await recordingListener();
    const controller = new AbortController();
    const { calls, handlers } = countingHandlers();

    const outcome = settlement(new BunTcpBackend().connect({
      host: '127.0.0.1',
      port: listener.port,
      tls: { ca: CA, serverName: 'localhost' },
      handlers,
      signal: controller.signal,
    }));
    await awaitCondition(() => listener.accepted.length === 1, { label: 'the TCP connect landed' });
    controller.abort();

    expect(await outcome.wait()).toBe(controller.signal.reason);
    await awaitCondition(() => listener.closed.length === 1, { label: 'the listener saw the dial close' });
    expect(calls).toEqual([]);
  });

  test('a signal already aborted rejects before anything is dialled', async () => {
    const listener = await recordingListener();
    const controller = new AbortController();
    controller.abort();
    const { calls, handlers } = countingHandlers();

    const outcome = await settlement(new BunTcpBackend().connect({
      host: '127.0.0.1', port: listener.port, handlers, signal: controller.signal,
    })).wait();

    const control = await new BunTcpBackend().connect({
      host: '127.0.0.1', port: listener.port, handlers: countingHandlers().handlers,
    });
    sockets.push(control);
    control.write(Uint8Array.of(0x78));
    await awaitCondition(() => listener.spoke.length === 1, { label: 'the control dial spoke' });

    expect(outcome).toBe(controller.signal.reason);
    expect(listener.accepted).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  test('only a dial that carries a signal leaves Bun.connect', async () => {
    // Native stays the path for a caller that never gives a dial up, which is
    // every caller but the cluster transport today.
    const routed: unknown[] = [];
    const cancellable: Pick<TcpBackend, 'connect'> = {
      connect: (options) => {
        routed.push(options);
        return Promise.reject(new Error('stand-in for the cancellable dialer'));
      },
    };
    const backend = new BunTcpBackend(cancellable);
    const controller = new AbortController();

    const signalled = settlement(backend.connect({
      host: NOWHERE, port: 2_552, handlers: countingHandlers().handlers, signal: controller.signal,
    }));
    await awaitCondition(() => routed.length === 1, { label: 'the signalled dial reached the cancellable dialer' });
    expect(await signalled.wait()).toBeInstanceOf(Error);

    const listener = await recordingListener();
    const native = await backend.connect({
      host: '127.0.0.1', port: listener.port, handlers: countingHandlers().handlers,
    });
    sockets.push(native);
    expect(routed).toHaveLength(1);
  });
});
