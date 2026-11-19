/**
 * #1827 — the GELF and syslog sinks honour a stream socket's back-pressure.
 *
 * #931 gave `TcpSocketLike.write` a `boolean` answer and `onDrain`, and both
 * sinks threw the answer away: every record of a batch went into the socket
 * whatever it said, so a collector that stopped reading grew this process's
 * heap by one socket backlog per batch, without bound.  A sink now waits for
 * `onDrain` after a write that answers `false` before it writes the next
 * record, which leaves `BatchingSink`'s bounded queue — with its reported
 * drop — as the one place records pile up.  A drain that never comes is a
 * stalled collector: the batch fails retryably after the stall bound and the
 * connection is torn down, so the retry dials afresh.
 *
 * Covered three ways, per runtime.  Node through its socket-module seam and
 * Deno through a stubbed `Deno` global — the stand-ins the adapters' own
 * back-pressure suites use — with a socket whose answers the test decides.
 * Bun on its real runtime, over loopback, with the collector on the same
 * thread: a batch of large records written without yielding to the event loop
 * fills the socket, and the socket's own answers decide when the sink may go on.
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
import { DenoTcpBackend } from '../../../src/runtime/tcp/DenoTcpBackend.js';
import { NodeTcpBackend } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type { NodeSocketModules } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpBackend, TcpListener, TcpSocketHandlers, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

function record(message: string): LogRecord {
  return { timestampMs: Date.UTC(2026, 10, 17, 9, 41, 2), level: LogLevel.Info, message, fields: {} };
}

const sinks: Array<GelfSink | SyslogSink> = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  jest.useRealTimers();
  for (const sink of sinks.splice(0)) await sink.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A GELF sink that dials through `backend` and lets the test call `emitBatch` itself. */
class DialingGelfSink extends GelfSink {
  constructor(options: GelfSinkOptionsType, private readonly backend: TcpBackend) { super(options); }
  protected override tcpBackend(): Promise<TcpBackend> { return Promise.resolve(this.backend); }
  emitNow(records: readonly LogRecord[]): Promise<void> { return this.emitBatch(records); }
}

/** The same for syslog. */
class DialingSyslogSink extends SyslogSink {
  constructor(options: SyslogSinkOptionsType, private readonly backend: TcpBackend) { super(options); }
  protected override tcpBackend(): Promise<TcpBackend> { return Promise.resolve(this.backend); }
  emitNow(records: readonly LogRecord[]): Promise<void> { return this.emitBatch(records); }
}

type DialingSink = DialingGelfSink | DialingSyslogSink;

const SINKS = [
  {
    name: 'GELF over TCP',
    create: (backend: TcpBackend, port = 12_201): DialingSink =>
      new DialingGelfSink({ protocol: 'tcp', host: '127.0.0.1', port, hostName: 'web-01' }, backend),
    stall: 'GELF TCP',
  },
  {
    name: 'syslog over TCP',
    create: (backend: TcpBackend, port = 514): DialingSink =>
      new DialingSyslogSink({ transport: 'tcp', host: '127.0.0.1', port, hostName: 'web-01' }, backend),
    stall: 'syslog',
  },
] as const;

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

/** Let every pending continuation run — the only wait left under fake timers. */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

/* ------------------------------------------------------------------------ */
/* Node, through the socket-module seam                                      */
/* ------------------------------------------------------------------------ */

/** A `node:net` socket that connects at once and answers each write as the test scripts it. */
class ScriptedNodeSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly writes: Uint8Array[] = [];
  /** What the next writes answer, in order; once used up, every write answers `true`. */
  readonly answers: boolean[] = [];
  destroyed = false;
  readonly remoteAddress = '127.0.0.1';

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    if (event === 'connect') queueMicrotask(() => listener());
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  write(data: Uint8Array): boolean {
    this.writes.push(data);
    return this.answers.shift() ?? true;
  }

  end(): void { this.emit('close'); }
  // No `close` from here: Node emits it on a later tick, so a sink that waits
  // for it to forget a destroyed socket can hand that socket the next batch.
  destroy(): void { this.destroyed = true; }
}

function scriptedNodeBackend(): { readonly backend: TcpBackend; readonly sockets: ScriptedNodeSocket[] } {
  const sockets: ScriptedNodeSocket[] = [];
  const module = {
    createServer: (): never => { throw new Error('no listener in this test'); },
    connect: (): ScriptedNodeSocket => {
      const socket = new ScriptedNodeSocket();
      // Every dial in a test pushes back on its first write.
      socket.answers.push(false);
      sockets.push(socket);
      return socket;
    },
    isIP: (): number => 4,
  };
  const modules: NodeSocketModules = { net: async () => module as never, tls: async () => module as never };
  return { backend: new NodeTcpBackend(modules), sockets };
}

describe('a sink waits for the drain after a write that answers false (#1827, Node adapter)', () => {
  for (const { name, create } of SINKS) {
    test(`${name}: no record is written between the false and the drain`, async () => {
      const { backend, sockets } = scriptedNodeBackend();
      const sink = create(backend);
      sinks.push(sink);

      const delivery = watch(sink.emitNow([record('first'), record('second'), record('third')]));
      await drainMicrotasks();
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.writes).toHaveLength(1);
      expect(delivery.settled).toBe(false);

      sockets[0]!.emit('drain');
      await drainMicrotasks();
      expect(sockets[0]!.writes).toHaveLength(3);
      expect(delivery).toEqual({ settled: true, error: undefined });
    });

    test(`${name}: a drain that never comes fails the batch retryably after 10 s and the next batch dials afresh`, async () => {
      const { backend, sockets } = scriptedNodeBackend();
      const sink = create(backend);
      sinks.push(sink);
      jest.useFakeTimers();

      const delivery = watch(sink.emitNow([record('first'), record('second')]));
      await drainMicrotasks();
      jest.advanceTimersByTime(9_999);
      await drainMicrotasks();
      expect(delivery.settled).toBe(false);

      jest.advanceTimersByTime(1);
      await drainMicrotasks();
      expect(delivery.settled).toBe(true);
      expect(delivery.error).toBeInstanceOf(SinkDeliveryError);
      expect((delivery.error as SinkDeliveryError).retryable).toBe(true);
      expect(sockets[0]!.writes).toHaveLength(1);
      // Torn down, not left holding a backlog nobody reads.
      expect(sockets[0]!.destroyed).toBe(true);

      const next = watch(sink.emitNow([record('again')]));
      await drainMicrotasks();
      expect(sockets).toHaveLength(2);
      expect(sockets[1]!.writes).toHaveLength(1);
      sockets[1]!.emit('drain');
      await drainMicrotasks();
      expect(next).toEqual({ settled: true, error: undefined });
    });

    test(`${name}: a connection that closes while the sink waits fails the batch retryably`, async () => {
      const { backend, sockets } = scriptedNodeBackend();
      const sink = create(backend);
      sinks.push(sink);

      const delivery = watch(sink.emitNow([record('first'), record('second')]));
      await drainMicrotasks();
      sockets[0]!.emit('close');
      await drainMicrotasks();
      expect(delivery.settled).toBe(true);
      expect(delivery.error).toBeInstanceOf(SinkDeliveryError);
      expect((delivery.error as SinkDeliveryError).retryable).toBe(true);
      expect(sockets[0]!.writes).toHaveLength(1);
    });

    test(`${name}: a drain from a connection the sink has replaced resumes nothing`, async () => {
      const { backend, sockets } = scriptedNodeBackend();
      const sink = create(backend);
      sinks.push(sink);
      jest.useFakeTimers();

      // The first connection stalls and is given up …
      const first = watch(sink.emitNow([record('first')]));
      await drainMicrotasks();
      jest.advanceTimersByTime(10_000);
      await drainMicrotasks();
      expect(first.settled).toBe(true);

      // … the second pushes back, and a late drain from the first must not count for it.
      const second = watch(sink.emitNow([record('second'), record('third')]));
      await drainMicrotasks();
      expect(sockets).toHaveLength(2);
      sockets[0]!.emit('drain');
      await drainMicrotasks();
      expect(sockets[1]!.writes).toHaveLength(1);
      expect(second.settled).toBe(false);

      sockets[1]!.emit('drain');
      await drainMicrotasks();
      expect(sockets[1]!.writes).toHaveLength(2);
      expect(second).toEqual({ settled: true, error: undefined });
    });
  }
});

/* ------------------------------------------------------------------------ */
/* Deno, through a stubbed global                                            */
/* ------------------------------------------------------------------------ */

/** `DENO_WRITE_HIGH_WATER_MARK_BYTES`, module-private in the adapter. */
const DENO_MARK_BYTES = 64 * 1024;

/** A `Deno.Conn` whose writer completes each write on demand. */
class HeldWriteConnection {
  readonly writes: Array<{ readonly bytes: number; release(): Promise<void> }> = [];
  private finish: () => void = () => {};
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => { this.finish = () => controller.close(); },
  });
  readonly writable = {
    getWriter: () => ({
      write: (data: Uint8Array): Promise<void> => {
        let resolve: () => void = () => {};
        const written = new Promise<void>((settle) => { resolve = settle; });
        this.writes.push({ bytes: data.byteLength, release: async () => { resolve(); await written; } });
        return written;
      },
      close: (): Promise<void> => Promise.resolve(),
    }),
  };
  readonly remoteAddr = { hostname: '127.0.0.1', port: 514 };

  close(): void { this.finish(); }
}

describe('a sink waits for the drain after a write that answers false (#1827, Deno adapter)', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  for (const { name, create } of SINKS) {
    test(`${name}: a record past the 64 KiB mark holds the next one until the writer catches up`, async () => {
      const connection = new HeldWriteConnection();
      setDeno({ connect: async () => connection });
      const sink = create(new DenoTcpBackend());
      sinks.push(sink);

      const big = 'x'.repeat(DENO_MARK_BYTES);
      const delivery = watch(sink.emitNow([record(big), record('after the big one')]));
      await drainMicrotasks();
      expect(connection.writes).toHaveLength(1);
      expect(delivery.settled).toBe(false);

      await connection.writes[0]!.release();
      await drainMicrotasks();
      expect(connection.writes).toHaveLength(2);
      await connection.writes[1]!.release();
      await drainMicrotasks();
      expect(delivery).toEqual({ settled: true, error: undefined });
    });
  }
});

/* ------------------------------------------------------------------------ */
/* Bun, on the real runtime                                                  */
/* ------------------------------------------------------------------------ */

/** A collector on this thread that keeps every byte, and one write log per dialled socket. */
async function bunCollector(): Promise<{ readonly port: number; receivedBytes(): number; text(): string }> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const listener: TcpListener = await new BunTcpBackend().listen({
    host: '127.0.0.1',
    port: 0,
    handlers: {
      onOpen: (socket) => { cleanups.push(() => { try { socket.destroy?.(); } catch { /* gone */ } }); },
      onData: (_socket, chunk) => { chunks.push(chunk.slice()); receivedBytes += chunk.byteLength; },
      onClose: () => {},
      onError: () => {},
    },
  });
  cleanups.push(() => listener.close());
  return {
    port: listener.port,
    receivedBytes: () => receivedBytes,
    text: () => new TextDecoder().decode(Buffer.concat(chunks)),
  };
}

/** What the sink did with its socket: each write's answer, and each drain, in order. */
type SocketEvent = 'true' | 'false' | 'drain';

/** The runtime's own backend, with every socket it dials wrapped to log writes and drains. */
function recordingBackend(inner: TcpBackend, events: SocketEvent[]): TcpBackend {
  return {
    listen: (options) => inner.listen(options),
    connect: async (options) => {
      const handlers: TcpSocketHandlers = {
        ...options.handlers,
        onDrain: (socket) => { events.push('drain'); options.handlers.onDrain?.(socket); },
      };
      const socket = await inner.connect({ ...options, handlers });
      const wrapped: TcpSocketLike = {
        write: (data) => { const answer = socket.write(data); events.push(answer ? 'true' : 'false'); return answer; },
        end: () => socket.end(),
        destroy: () => socket.destroy?.(),
      };
      return wrapped;
    },
  };
}

describe('a sink honours a real Bun socket\'s back-pressure (#1827)', () => {
  // Large records written without yielding to the event loop: the collector on
  // this thread cannot read until the sink awaits something that is not a
  // microtask, so the kernel's loopback buffer fills and the socket says so.
  const RECORD_BYTES = 256 * 1024;
  const RECORDS = 40;

  for (const { name, create } of SINKS) {
    test(`${name}: after a false the sink writes nothing until the drain, and every record arrives whole`, async () => {
      const collector = await bunCollector();
      const events: SocketEvent[] = [];
      const sink = create(recordingBackend(new BunTcpBackend(), events), collector.port);
      sinks.push(sink);

      const records = Array.from({ length: RECORDS }, (_, index) => record(`${index}:${'y'.repeat(RECORD_BYTES)}`));
      await sink.emitNow(records);

      expect(events).toContain('false');
      // The property: a write that answered false is followed by a drain, never by another write.
      for (let index = 0; index < events.length - 1; index += 1) {
        if (events[index] === 'false') expect(events[index + 1]).toBe('drain');
      }
      expect(events.filter((event) => event !== 'drain')).toHaveLength(RECORDS);

      await awaitCondition(
        () => [...collector.text().matchAll(/(\d+):y{262144}/g)].length === RECORDS,
        { timeoutMs: 20_000, intervalMs: 10, label: 'every record arrived whole' },
      );
      const order = [...collector.text().matchAll(/(\d+):y{262144}/g)].map((match) => Number(match[1]));
      expect(order).toEqual(Array.from({ length: RECORDS }, (_, index) => index));
    }, 60_000);
  }
});
