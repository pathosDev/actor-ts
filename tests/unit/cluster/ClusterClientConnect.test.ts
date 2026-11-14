/**
 * How a `ClusterClient` connect attempt ends — every way it can (#938, #1751)
 * — and what the client refuses before it dials at all (#1763).
 *
 * Driven through a fake `TcpBackend` whose dials open, answer, fail and close
 * when the test says so, installed through the client's private `backend`
 * seam, and through a virtual set of host timers in its `hostTimers` seam, so
 * a connect deadline elapses when the test advances it rather than after a
 * wait.  The sequences are the ones a runtime emits: `onOpen` before the dial
 * resolves, then `onData`, and on a reset `onError` followed by `onClose`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import type { HostTimers } from '../../../src/Scheduler.js';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { ClusterClientOptions } from '../../../src/cluster/ClusterClientOptions.js';
import type {
  ClusterClientEnvelopeMessage,
  ClusterClientReplyMessage,
} from '../../../src/cluster/ClusterClientReceptionist.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import { Config } from '../../../src/config/Config.js';
import type {
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportOptionsType,
} from '../../../src/runtime/tcp/TcpBackend.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const CONNECT_TIMEOUT_MS = 150;

/** A socket that records what was written to it and how it was closed. */
class RecordingSocket implements TcpSocketLike {
  readonly writes: Uint8Array[] = [];
  ended = false;
  destroyed = false;
  write(data: Uint8Array): void { this.writes.push(data); }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }

  /** Every frame written so far, decoded. */
  frames(): readonly { readonly kind: string }[] {
    const decoder = new FrameDecoder();
    return this.writes.flatMap((chunk) => decoder.push(chunk)) as unknown as { kind: string }[];
  }

  envelopes(): readonly ClusterClientEnvelopeMessage[] {
    return this.frames().filter((frame) => frame.kind === 'cluster-client-envelope') as unknown as ClusterClientEnvelopeMessage[];
  }

  /** Whether the client has let go of this socket, one way or the other. */
  get closedByClient(): boolean { return this.ended || this.destroyed; }
}

/** One `backend.connect` call, settled by the test. */
class FakeDial {
  readonly socket = new RecordingSocket();
  opened = false;
  private settled = false;
  private resolveDial!: (socket: TcpSocketLike) => void;
  private rejectDial!: (error: Error) => void;
  readonly promise: Promise<TcpSocketLike>;

  constructor(
    readonly port: number,
    readonly tls: TlsTransportOptionsType | undefined,
    private readonly handlers: TcpSocketHandlers,
    readonly signal: AbortSignal | undefined,
    /** A backend that cannot honour an abort (Deno over TLS, a caller's own). */
    private readonly ignoresAbort: boolean,
  ) {
    this.promise = new Promise<TcpSocketLike>((resolve, reject) => {
      this.resolveDial = resolve;
      this.rejectDial = reject;
    });
    signal?.addEventListener('abort', () => {
      if (this.settled || this.ignoresAbort) return;
      this.settled = true;
      if (this.opened) this.socket.destroy();
      this.rejectDial(signal.reason as Error);
    });
  }

  /** The socket opens: `onOpen`, then the dial resolves. */
  open(): void {
    this.opened = true;
    this.handlers.onOpen(this.socket);
    if (this.settled) return;
    this.settled = true;
    this.resolveDial(this.socket);
  }

  refuse(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectDial(error);
  }

  receive(bytes: Uint8Array): void { this.handlers.onData(this.socket, bytes); }

  acknowledgeHello(): void { this.receive(helloAcknowledgment(this.port)); }

  reply(askId: string, body: unknown): void {
    const reply: ClusterClientReplyMessage = { kind: 'cluster-client-reply', askId, ok: true, body };
    this.receive(encodeFrame(reply as unknown as WireMessage));
  }

  error(error: Error): void { this.handlers.onError(this.socket, error); }

  close(): void { this.handlers.onClose(this.socket); }
}

class FakeBackend {
  readonly dials: FakeDial[] = [];
  ignoresAbort = false;

  connect(options: {
    host: string;
    port: number;
    tls?: TlsTransportOptionsType;
    handlers: TcpSocketHandlers;
    signal?: AbortSignal;
  }): Promise<TcpSocketLike> {
    const dial = new FakeDial(options.port, options.tls, options.handlers, options.signal, this.ignoresAbort);
    this.dials.push(dial);
    return dial.promise;
  }

  listen(): never { throw new Error('a ClusterClient never listens'); }

  /** The dial to `port`, waiting for the client to make it. */
  async dialTo(port: number, nth = 1): Promise<FakeDial> {
    for (let turn = 0; turn < 100; turn++) {
      const matching = this.dials.filter((dial) => dial.port === port);
      if (matching.length >= nth) return matching[nth - 1]!;
      await drain();
    }
    throw new Error(`the client never dialled port ${port} (${nth}. time)`);
  }
}

/** Host timers that advance only when the test says so. */
class VirtualHostTimers implements HostTimers {
  private now = 0;
  private nextHandle = 0;
  private readonly pending = new Map<number, { readonly at: number; readonly callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.nextHandle++;
    this.pending.set(this.nextHandle, { at: this.now + delayMs, callback });
    return this.nextHandle;
  }

  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }

  setInterval(): unknown { throw new Error('a ClusterClient arms no interval'); }

  clearInterval(): void { /* nothing armed */ }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, timer] of [...this.pending]) {
      if (timer.at > this.now) continue;
      this.pending.delete(handle);
      timer.callback();
    }
  }
}

/** The private seams the fakes go in through, and the state the cases read. */
type ClientInternals = {
  backend: unknown;
  hostTimers: HostTimers | undefined;
  readonly connectingPromise: Promise<void> | null;
};

function internals(client: ClusterClient): ClientInternals {
  return client as unknown as ClientInternals;
}

function helloAcknowledgment(port: number): Uint8Array {
  return encodeFrame({
    kind: 'hello-ack',
    wireVersion: 2,
    self: new NodeAddress('contact-point', '127.0.0.1', port, 'test-run').toJSON(),
  });
}

/** Run everything already queued — microtasks and the I/O turn — and nothing timed. */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Whether `promise` has settled yet, observed without waiting on it. */
function track(promise: Promise<unknown>): { readonly settled: boolean; readonly outcome: Promise<string> } {
  const state = { settled: false };
  const outcome = promise.then(
    () => { state.settled = true; return 'resolved'; },
    (error: unknown) => { state.settled = true; return error instanceof Error ? error.message : String(error); },
  );
  return { get settled() { return state.settled; }, outcome };
}

const clients: ClusterClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

function clientOf(ports: readonly number[]): { client: ClusterClient; backend: FakeBackend; timers: VirtualHostTimers } {
  const options = ClusterClientOptions.create()
    .withContactPoints(ports.map((port) => `contact-point@127.0.0.1:${port}`))
    .withConnectTimeoutMs(CONNECT_TIMEOUT_MS)
    .withLogger(new NoopLogger());
  const client = new ClusterClient(options, Config.empty());
  const backend = new FakeBackend();
  const timers = new VirtualHostTimers();
  internals(client).backend = backend;
  internals(client).hostTimers = timers;
  clients.push(client);
  return { client, backend, timers };
}

describe('every way out of a connect attempt settles it (#938)', () => {
  test('a reset after the socket opened rejects the ask instead of hanging', async () => {
    const { client, backend } = clientOf([2551]);
    const asked = track(client.ask('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    dial.open();
    // What a runtime emits for a peer that resets before its hello-ack.
    dial.error(new Error('read ECONNRESET'));
    dial.close();
    // No virtual time has passed: the reset settles the attempt, not the deadline.
    expect(await asked.outcome).toContain('read ECONNRESET');
    expect(internals(client).connectingPromise).toBeNull();
  });

  test('a close before the hello-ack rejects at once, not at the deadline', async () => {
    const { client, backend } = clientOf([2551]);
    const asked = track(client.ask('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    dial.open();
    dial.close();
    expect(await asked.outcome).toContain('closed the connection before its hello-ack');
    expect(internals(client).connectingPromise).toBeNull();
  });

  test('after a failed attempt the next send dials again instead of reusing the dead promise', async () => {
    const { client, backend } = clientOf([2551]);
    const first = track(client.send('/user/service', { kind: 'one' }));
    const firstDial = await backend.dialTo(2551);
    firstDial.open();
    firstDial.error(new Error('read ECONNRESET'));
    firstDial.close();
    expect(await first.outcome).toContain('read ECONNRESET');

    const second = track(client.send('/user/service', { kind: 'two' }));
    const secondDial = await backend.dialTo(2551, 2);
    secondDial.open();
    secondDial.acknowledgeHello();
    expect(await second.outcome).toBe('resolved');
    expect(secondDial.socket.envelopes().map((envelope) => envelope.body)).toEqual([{ kind: 'two' }]);
  });

  test('a failure after the handshake is a dropped connection, and the next call dials again', async () => {
    const { client, backend } = clientOf([2551]);
    const asked = track(client.ask('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    dial.open();
    dial.acknowledgeHello();
    await drain();
    expect(dial.socket.envelopes()).toHaveLength(1);
    dial.error(new Error('read ECONNRESET'));
    dial.close();
    expect(await asked.outcome).toBe('ClusterClient: connection closed before reply arrived');

    const sent = track(client.send('/user/service', { kind: 'again' }));
    const redial = await backend.dialTo(2551, 2);
    redial.open();
    redial.acknowledgeHello();
    expect(await sent.outcome).toBe('resolved');
  });

  test('close() rejects a connect attempt in flight, gives up its socket and dials nothing else', async () => {
    const { client, backend } = clientOf([2551, 2552]);
    const asked = track(client.ask('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    dial.open();
    await client.close();
    expect(await asked.outcome).toBe('ClusterClient closed');
    expect(dial.socket.closedByClient).toBe(true);
    await drain();
    expect(backend.dials).toHaveLength(1);
    expect(internals(client).connectingPromise).toBeNull();
  });
});

describe('an attempt that has ended changes nothing (#1751)', () => {
  test('a contact point that answers after connect-timeout does not take the connection over', async () => {
    const { client, backend, timers } = clientOf([2551, 2552]);
    const asked = track(client.ask<string>('/user/service', { kind: 'ping' }, 5_000));

    // A accepts the connection and holds its hello-ack past the deadline.
    const late = await backend.dialTo(2551);
    late.open();
    timers.advance(CONNECT_TIMEOUT_MS);
    expect(late.signal?.aborted).toBe(true);
    expect(late.socket.destroyed).toBe(true);

    // B answers at once, and the ask goes out on B.
    const prompt = await backend.dialTo(2552);
    prompt.open();
    prompt.acknowledgeHello();
    await drain();
    expect(prompt.socket.envelopes()).toHaveLength(1);

    // A's hello-ack arrives on the connection the client gave up on.
    late.acknowledgeHello();
    await client.send('/user/service', { kind: 'after-the-late-ack' });
    expect(prompt.socket.envelopes().map((envelope) => envelope.body))
      .toEqual([{ kind: 'ping' }, { kind: 'after-the-late-ack' }]);
    expect(late.socket.envelopes()).toEqual([]);

    // A closing its connection fails nothing in flight on B.
    late.close();
    await drain();
    expect(asked.settled).toBe(false);
    prompt.reply(prompt.socket.envelopes()[0]!.askId!, 'pong');
    expect(await asked.outcome).toBe('resolved');
  });

  test('a dial that has not opened by the deadline is given up', async () => {
    const { client, backend, timers } = clientOf([2551]);
    const asked = track(client.ask('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    timers.advance(CONNECT_TIMEOUT_MS);
    expect(dial.signal?.aborted).toBe(true);
    expect(await asked.outcome).toContain(`timed out after ${CONNECT_TIMEOUT_MS}ms`);
  });

  test('a dial that opens after it was given up is destroyed and says nothing', async () => {
    const { client, backend, timers } = clientOf([2551]);
    backend.ignoresAbort = true;
    const asked = track(client.ask('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    timers.advance(CONNECT_TIMEOUT_MS);
    expect(await asked.outcome).toContain('timed out');

    dial.open();
    await drain();
    expect(dial.socket.destroyed).toBe(true);
    expect(dial.socket.frames()).toEqual([]);
  });

  test('each socket decodes its own frames: half a frame from an abandoned peer does not corrupt the next', async () => {
    const { client, backend, timers } = clientOf([2551, 2552]);
    const sent = track(client.send('/user/service', { kind: 'ping' }));
    const late = await backend.dialTo(2551);
    late.open();
    // A has sent the first bytes of a frame when the deadline gives up on it.
    late.receive(helloAcknowledgment(2551).subarray(0, 3));
    timers.advance(CONNECT_TIMEOUT_MS);

    const prompt = await backend.dialTo(2552);
    prompt.open();
    prompt.acknowledgeHello();
    expect(await sent.outcome).toBe('resolved');
    expect(prompt.socket.envelopes()).toHaveLength(1);
  });

  test('after close(), no connection the client opened is left open', async () => {
    const { client, backend } = clientOf([2551]);
    const sent = track(client.send('/user/service', { kind: 'ping' }));
    const dial = await backend.dialTo(2551);
    dial.open();
    dial.acknowledgeHello();
    expect(await sent.outcome).toBe('resolved');
    await client.close();
    expect(dial.socket.closedByClient).toBe(true);
  });
});

describe('ClusterClient.ask refuses a per-call timeoutMs outside its domain (#1763)', () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`${timeoutMs} is refused before anything is dialled`, async () => {
      const { client, backend } = clientOf([2551]);
      let refusal: unknown;
      try {
        await client.ask('/user/service', { kind: 'ping' }, timeoutMs);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(OptionsError);
      expect((refusal as OptionsError).field).toBe('timeoutMs');
      expect((refusal as Error).message)
        .toContain('ClusterClient.ask: timeoutMs must be a positive finite number');
      await drain();
      expect(backend.dials).toHaveLength(0);
    });
  }
});
