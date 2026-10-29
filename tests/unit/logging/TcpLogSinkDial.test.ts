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
 *
 * The dial itself had no bound but the operating system's, so a collector
 * that drops SYNs held `emitBatch` for 21 s on Windows and about two minutes
 * on Linux, per attempt.  That case runs on a socket whose connect never
 * lands, under fake timers, because no test can have a network blackhole a
 * SYN on cue and the sinks' bound is longer than bun's per-test cap.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { SinkDeliveryError } from '../../../src/logging/BatchingSink.js';
import { GelfSink } from '../../../src/logging/GelfSink.js';
import type { GelfSinkOptionsType } from '../../../src/logging/GelfSinkOptions.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import { SyslogSink } from '../../../src/logging/SyslogSink.js';
import type { SyslogSinkOptionsType } from '../../../src/logging/SyslogSinkOptions.js';
import { BunTcpBackend } from '../../../src/runtime/tcp/BunTcpBackend.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';
import { NodeTcpBackend } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type { NodeSocketModules } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpBackend, TcpListener, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { mintTlsMaterial } from '../cluster/TcpTransportTlsIpLiteralPeer.fixture.js';

const material = mintTlsMaterial();

/**
 * TEST-NET-1: assigned to nobody, so a dial a seam failed to intercept goes
 * nowhere rather than to a real host.
 */
const NOWHERE = '192.0.2.1';

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

/* ------------------------------------------------------------------------ */
/* A collector that never answers, and one that refuses                     */
/* ------------------------------------------------------------------------ */

/** A `node:net` socket whose connect never lands — a collector dropping SYNs — and that records how it was let go. */
class UnansweredSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  destroyed = false;
  ended = false;
  readonly remoteAddress = undefined;

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  write(): boolean { return true; }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }
}

/** Socket modules that hand every dial `socket`, and remember each dial. */
function unansweredModules(socket: UnansweredSocket): { readonly modules: NodeSocketModules; readonly dialled: unknown[] } {
  const dialled: unknown[] = [];
  const module = {
    createServer: (): never => { throw new Error('no listener in this test'); },
    connect: (options: unknown): UnansweredSocket => { dialled.push(options); return socket; },
  };
  return {
    dialled,
    modules: { net: async () => module as never, tls: async () => module as never },
  };
}

/** A GELF sink that dials through `backend`, and lets the test call `emitBatch` itself. */
class DialingGelfSink extends GelfSink {
  constructor(options: GelfSinkOptionsType, private readonly backend: TcpBackend) {
    super(options);
  }

  protected override tcpBackend(): Promise<TcpBackend> { return Promise.resolve(this.backend); }

  emitNow(records: readonly LogRecord[]): Promise<void> { return this.emitBatch(records); }
}

/** The same for syslog. */
class DialingSyslogSink extends SyslogSink {
  constructor(options: SyslogSinkOptionsType, private readonly backend: TcpBackend) {
    super(options);
  }

  protected override tcpBackend(): Promise<TcpBackend> { return Promise.resolve(this.backend); }

  emitNow(records: readonly LogRecord[]): Promise<void> { return this.emitBatch(records); }
}

/** A batch being delivered; `settled` and `error` say how far it got. */
type Delivery = { readonly settled: boolean; readonly error: unknown };

function watch(delivery: Promise<void>): Delivery {
  const seen = { settled: false, error: undefined as unknown };
  delivery.then(
    () => { seen.settled = true; },
    (error: unknown) => { seen.settled = true; seen.error = error; },
  );
  return seen;
}

/**
 * Let every pending continuation run.  The fake timers that hold the sink's
 * deadline also hold `awaitCondition`'s poll, so this is the one way left to
 * wait — and the dial is all promise hops once its module seam has answered.
 */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

describe('a collector that never answers holds a batch for the sink\'s bound and no longer (#1475)', () => {
  const cases = [
    {
      sink: 'GELF over TCP',
      create: (backend: TcpBackend) => new DialingGelfSink({ protocol: 'tcp', host: NOWHERE, port: 12_201 }, backend),
      failure: `GELF TCP connect to ${NOWHERE}:12201 failed: no connection within 10000 ms`,
    },
    {
      sink: 'syslog over TCP',
      create: (backend: TcpBackend) => new DialingSyslogSink({ transport: 'tcp', host: NOWHERE, port: 514 }, backend),
      failure: `syslog connect to ${NOWHERE}:514 failed: no connection within 10000 ms`,
    },
  ] as const;

  for (const { sink: name, create, failure } of cases) {
    test(`${name}: the dial is given up after 10 s, the batch fails retryably, and the socket is destroyed`, async () => {
      const socket = new UnansweredSocket();
      const { modules, dialled } = unansweredModules(socket);
      const sink = create(new NodeTcpBackend(modules));
      sinks.push(sink);
      jest.useFakeTimers();
      try {
        const delivery = watch(sink.emitNow([record('held')]));
        await drainMicrotasks();
        expect(dialled).toHaveLength(1);

        jest.advanceTimersByTime(9_999);
        await drainMicrotasks();
        expect(delivery.settled).toBe(false);
        expect(socket.destroyed).toBe(false);

        jest.advanceTimersByTime(1);
        await drainMicrotasks();
        expect(delivery.settled).toBe(true);
        expect(delivery.error).toBeInstanceOf(SinkDeliveryError);
        expect((delivery.error as SinkDeliveryError).retryable).toBe(true);
        expect((delivery.error as Error).message).toBe(failure);
        // Given up, not abandoned: the pending connect is torn down, never half-closed.
        expect({ destroyed: socket.destroyed, ended: socket.ended }).toEqual({ destroyed: true, ended: false });
      } finally {
        jest.useRealTimers();
      }
    });
  }

  test('the next attempt dials again rather than waiting on the one given up', async () => {
    const socket = new UnansweredSocket();
    const { modules, dialled } = unansweredModules(socket);
    const sink = new DialingGelfSink({ protocol: 'tcp', host: NOWHERE, port: 12_201 }, new NodeTcpBackend(modules));
    sinks.push(sink);
    jest.useFakeTimers();
    try {
      const first = watch(sink.emitNow([record('first attempt')]));
      await drainMicrotasks();
      jest.advanceTimersByTime(10_000);
      await drainMicrotasks();
      expect(first.settled).toBe(true);

      const second = watch(sink.emitNow([record('second attempt')]));
      await drainMicrotasks();
      expect(dialled).toHaveLength(2);
      expect(second.settled).toBe(false);
      jest.advanceTimersByTime(10_000);
      await drainMicrotasks();
      expect(second.error).toBeInstanceOf(SinkDeliveryError);
    } finally {
      jest.useRealTimers();
    }
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

describe('a collector that refuses the connection fails the batch retryably (#1475)', () => {
  // Through the runtime's own backend, the one `tcpBackend()` hands out by
  // default.  This is the behaviour the docs state and the retry policy builds
  // on: before #1475 Node's adapter resolved a refused dial, and the batch was
  // written into a dead socket and counted as delivered.
  test('GELF over TCP', async () => {
    const port = await refusingPort();
    const sink = new DialingGelfSink({ protocol: 'tcp', host: '127.0.0.1', port, hostName: 'web-01' }, await getTcpBackend());
    sinks.push(sink);
    const delivery = watch(sink.emitNow([record('refused')]));
    await awaitCondition(() => delivery.settled, { label: 'the refused GELF batch settled' });
    expect(delivery.error).toBeInstanceOf(SinkDeliveryError);
    expect((delivery.error as SinkDeliveryError).retryable).toBe(true);
    expect((delivery.error as Error).message).toStartWith(`GELF TCP connect to 127.0.0.1:${port} failed: `);
  });

  test('syslog over TCP', async () => {
    const port = await refusingPort();
    const sink = new DialingSyslogSink({ transport: 'tcp', host: '127.0.0.1', port, hostName: 'web-01' }, await getTcpBackend());
    sinks.push(sink);
    const delivery = watch(sink.emitNow([record('refused')]));
    await awaitCondition(() => delivery.settled, { label: 'the refused syslog batch settled' });
    expect(delivery.error).toBeInstanceOf(SinkDeliveryError);
    expect((delivery.error as SinkDeliveryError).retryable).toBe(true);
    expect((delivery.error as Error).message).toStartWith(`syslog connect to 127.0.0.1:${port} failed: `);
  });
});
