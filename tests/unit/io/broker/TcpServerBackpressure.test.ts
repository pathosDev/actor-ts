/**
 * #1827 — `TcpServerActor` honours each accepted connection's back-pressure,
 * bounded per connection.
 *
 * `onSend` handed every payload to the socket whatever `write()` answered.
 * Since #931 every adapter keeps what it is handed, so one client that stopped
 * reading grew the listener's heap by everything the `target` sent it, without
 * bound.  Now, after a write that answers `false`, nothing more is written to
 * that connection until its `onDrain`; payloads are held whole, in order, up to
 * `max-buffered-bytes`.  Past that the connection fails: it is aborted and the
 * `target` gets `connectionClosed`, as for a breached frame cap — a byte
 * stream with a payload missing from its middle would be worse than no stream.
 *
 * Covered per runtime: Node through its socket-module seam and Deno through a
 * stubbed global, the stand-ins the adapters' own back-pressure suites use;
 * Bun on the real runtime, with the reading client on the same thread.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Config } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  readTcpServerOptionsFromConfig,
  TcpServerActor,
  type TcpServerCommand,
  type TcpServerMessage,
} from '../../../../src/io/broker/TcpServerActor.js';
import {
  DEFAULT_TCP_SERVER_MAX_BUFFERED_BYTES,
  TcpServerOptions,
  TcpServerOptionsValidator,
  type TcpServerOptionsBuilder,
} from '../../../../src/io/broker/TcpServerOptions.js';
import { BunTcpBackend } from '../../../../src/runtime/tcp/BunTcpBackend.js';
import { DenoTcpBackend } from '../../../../src/runtime/tcp/DenoTcpBackend.js';
import { NodeTcpBackend } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type { NodeSocketModules } from '../../../../src/runtime/tcp/NodeTcpBackend.js';
import type { TcpBackend, TcpSocketHandlers, TcpSocketLike } from '../../../../src/runtime/tcp/TcpBackend.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

class CollectingTarget extends Actor<TcpServerMessage> {
  readonly received: TcpServerMessage[] = [];
  override onReceive(message: TcpServerMessage): void { this.received.push(message); }
  openedIds(): string[] {
    return this.received.filter((m) => m.kind === 'connectionOpened').map((m) => m.connectionId);
  }
  closedIds(): string[] {
    return this.received.filter((m) => m.kind === 'connectionClosed').map((m) => m.connectionId);
  }
}

/** A listener that binds through the backend the test hands it. */
class BackendTcpServerActor extends TcpServerActor {
  constructor(options: TcpServerOptionsBuilder, private readonly backend: TcpBackend) { super(options); }
  protected override tcpBackend(): Promise<TcpBackend> { return Promise.resolve(this.backend); }
}

type Harness = {
  readonly system: ActorSystem;
  readonly server: ActorRef<TcpServerCommand>;
  readonly target: CollectingTarget;
};

const systems: ActorSystem[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(
  name: string,
  backend: TcpBackend,
  customize: (o: TcpServerOptionsBuilder) => TcpServerOptionsBuilder = (o) => o,
): Promise<Harness & { readonly listener: () => BackendTcpServerActor }> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const target = new CollectingTarget();
  const targetRef = system.spawn(() => target, 'target') as ActorRef<TcpServerMessage>;
  const serverOptions = customize(
    TcpServerOptions.create()
      .withBindHost('127.0.0.1')
      .withBindPort(0)
      .withTarget(targetRef),
  );
  const held = { current: null as BackendTcpServerActor | null };
  const server = system.spawn(() => {
    held.current = new BackendTcpServerActor(serverOptions, backend);
    return held.current;
  }, 'tcp-server') as ActorRef<TcpServerCommand>;
  await awaitCondition(() => (held.current?.boundPort ?? 0) > 0, { label: 'the listener bound' });
  return { system, server, target, listener: () => held.current! };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (chunks: readonly Uint8Array[]): string => chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');

/**
 * Give the listener's mailbox time to act on what was told before an
 * assertion of *absence* — a payload not written, a connection not closed.
 * There is no state to poll for a thing that must not happen, so the elapsed
 * time is the assertion; every positive outcome below is awaited by state.
 */
function letTheMailboxRun(): Promise<void> {
  // Absence is the assertion here: nothing to poll for, so a fixed wait it is.
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/* ------------------------------------------------------------------------ */
/* Node, through the socket-module seam                                      */
/* ------------------------------------------------------------------------ */

/** An accepted `node:net` socket whose write answers the test decides. */
class ScriptedNodeSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly writes: Uint8Array[] = [];
  full = false;
  ended = false;
  destroyed = false;
  /** How many writes had landed when `end()` was called. */
  writesBeforeEnd = -1;
  readonly remoteAddress = '127.0.0.1';

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  write(data: Uint8Array): boolean { this.writes.push(data); return !this.full; }
  end(): void { this.ended = true; this.writesBeforeEnd = this.writes.length; this.emit('close'); }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

/** `node:net` whose server accepts whatever socket the test hands it. */
function scriptedNodeModules(): { readonly modules: NodeSocketModules; accept(socket: ScriptedNodeSocket): void } {
  let onConnection: ((socket: ScriptedNodeSocket) => void) | undefined;
  const module = {
    createServer: (handler: (socket: ScriptedNodeSocket) => void) => {
      onConnection = handler;
      return {
        listen: (_port: number, _host: string, callback: () => void) => callback(),
        close: (callback: () => void) => callback(),
        address: () => ({ port: 7_001, address: '127.0.0.1' }),
        once: () => {},
      };
    },
    connect: (): never => { throw new Error('a listener never dials'); },
  };
  return {
    modules: { net: async () => module as never, tls: async () => module as never },
    accept: (socket) => onConnection!(socket),
  };
}

async function acceptedOverNode(
  name: string,
  customize?: (o: TcpServerOptionsBuilder) => TcpServerOptionsBuilder,
): Promise<{ harness: Harness; socket: ScriptedNodeSocket; id: string }> {
  const { modules, accept } = scriptedNodeModules();
  const harness = await boot(name, new NodeTcpBackend(modules), customize);
  const socket = new ScriptedNodeSocket();
  accept(socket);
  await awaitCondition(() => harness.target.openedIds().length === 1, { label: 'the connection was announced' });
  return { harness, socket, id: harness.target.openedIds()[0]! };
}

describe('TcpServerActor holds payloads while a connection pushes back (#1827, Node adapter)', () => {
  test('after a false nothing is written until the drain, then the held payloads go in order', async () => {
    const { harness, socket, id } = await acceptedOverNode('tcp-server-bp-hold');
    socket.full = true;
    for (const payload of ['a', 'b', 'c']) harness.server.tell({ kind: 'send', connectionId: id, payload });
    await awaitCondition(() => socket.writes.length >= 1, { label: 'the first payload was written' });
    // Give the mailbox every chance to write the other two, which it must not.
    await letTheMailboxRun();
    expect(decode(socket.writes)).toBe('a');

    socket.full = false;
    socket.emit('drain');
    expect(decode(socket.writes)).toBe('abc');
  });

  test('a drain that meets back-pressure again stops writing there', async () => {
    const { harness, socket, id } = await acceptedOverNode('tcp-server-bp-rewrite');
    socket.full = true;
    for (const payload of ['a', 'b', 'c']) harness.server.tell({ kind: 'send', connectionId: id, payload });
    await letTheMailboxRun();

    socket.emit('drain');
    expect(decode(socket.writes)).toBe('ab');
    socket.full = false;
    socket.emit('drain');
    expect(decode(socket.writes)).toBe('abc');
  });

  test('past max-buffered-bytes the connection is aborted and announced closed', async () => {
    const { harness, socket, id } = await acceptedOverNode(
      'tcp-server-bp-overflow',
      (o) => o.withMaxBufferedBytes(8),
    );
    socket.full = true;
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('first') });
    // Held: 4 + 4 = 8 bytes, exactly the bound.
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('1234') });
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('5678') });
    await letTheMailboxRun();
    expect(harness.target.closedIds()).toEqual([]);

    harness.server.tell({ kind: 'send', connectionId: id, payload: text('9') });
    await awaitCondition(() => harness.target.closedIds().length === 1, { label: 'the connection was announced closed' });
    expect(harness.target.closedIds()).toEqual([id]);
    // Aborted, not ended: a client that is not reading would not read a FIN either.
    expect(socket.destroyed).toBe(true);
    expect(socket.ended).toBe(false);
    expect(decode(socket.writes)).toBe('first');
  });

  test('what a drain wrote no longer counts against the bound', async () => {
    const { harness, socket, id } = await acceptedOverNode(
      'tcp-server-bp-recount',
      (o) => o.withMaxBufferedBytes(8),
    );
    socket.full = true;
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('first') });
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('12345678') });
    await awaitCondition(() => socket.writes.length === 1, { label: 'the first payload was written' });
    await letTheMailboxRun();

    // The drain writes the eight held bytes, and the socket pushes back on them.
    socket.emit('drain');
    expect(decode(socket.writes)).toBe('first12345678');
    // A full bound's worth again: held, not failed — the first eight left with the drain.
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('abcdefgh') });
    await letTheMailboxRun();
    expect(harness.target.closedIds()).toEqual([]);
    socket.full = false;
    socket.emit('drain');
    expect(decode(socket.writes)).toBe('first12345678abcdefgh');
  });

  test('a connection that goes lets go of what it held', async () => {
    const { modules, accept } = scriptedNodeModules();
    const accepted: TcpSocketLike[] = [];
    const inner = new NodeTcpBackend(modules);
    const capturing: TcpBackend = {
      connect: (options) => inner.connect(options),
      listen: (options) => inner.listen({
        ...options,
        handlers: { ...options.handlers, onOpen: (socket) => { accepted.push(socket); options.handlers.onOpen(socket); } },
      }),
    };
    const harness = await boot('tcp-server-bp-release', capturing);
    const socket = new ScriptedNodeSocket();
    accept(socket);
    await awaitCondition(() => harness.target.openedIds().length === 1, { label: 'the connection was announced' });
    const id = harness.target.openedIds()[0]!;
    socket.full = true;
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('first') });
    harness.server.tell({ kind: 'send', connectionId: id, payload: text('held') });
    await letTheMailboxRun();

    // The peer hangs up with a payload still held for it.
    socket.emit('close');
    await awaitCondition(() => harness.target.closedIds().length === 1, { label: 'the connection was announced closed' });
    type Held = { readonly outbox: readonly Uint8Array[]; readonly outboxBytes: number };
    const bySocket = (harness.listener() as unknown as { connectionsBySocket: WeakMap<TcpSocketLike, Held> }).connectionsBySocket;
    const record = bySocket.get(accepted[0]!)!;
    expect({ held: record.outbox.length, bytes: record.outboxBytes }).toEqual({ held: 0, bytes: 0 });
  });

  test('a close command writes the held payloads ahead of the FIN', async () => {
    const { harness, socket, id } = await acceptedOverNode('tcp-server-bp-close');
    socket.full = true;
    for (const payload of ['a', 'b', 'c']) harness.server.tell({ kind: 'send', connectionId: id, payload });
    harness.server.tell({ kind: 'close', connectionId: id });
    await awaitCondition(() => socket.ended, { label: 'the connection was ended' });
    expect(decode(socket.writes.slice(0, socket.writesBeforeEnd))).toBe('abc');
    expect(socket.destroyed).toBe(false);
  });

  test('back-pressure on one connection holds nothing for another', async () => {
    const { modules, accept } = scriptedNodeModules();
    const harness = await boot('tcp-server-bp-isolated', new NodeTcpBackend(modules));
    const slow = new ScriptedNodeSocket();
    const fast = new ScriptedNodeSocket();
    accept(slow);
    accept(fast);
    await awaitCondition(() => harness.target.openedIds().length === 2, { label: 'both connections were announced' });
    const [slowId, fastId] = harness.target.openedIds() as [string, string];
    slow.full = true;
    harness.server.tell({ kind: 'send', connectionId: slowId, payload: 'a' });
    harness.server.tell({ kind: 'send', connectionId: slowId, payload: 'b' });
    harness.server.tell({ kind: 'send', connectionId: fastId, payload: 'x' });
    harness.server.tell({ kind: 'send', connectionId: fastId, payload: 'y' });
    await awaitCondition(() => decode(fast.writes) === 'xy', { label: 'the fast connection got both payloads' });
    expect(decode(slow.writes)).toBe('a');
  });
});

describe('max-buffered-bytes is an option (#1827)', () => {
  test('defaults to 4 MiB, the WebSocket routes\' outbound cap', () => {
    expect(DEFAULT_TCP_SERVER_MAX_BUFFERED_BYTES).toBe(4 * 1024 * 1024);
  });

  test('read from actor-ts.io.broker.tcp-server.max-buffered-bytes as a size', () => {
    const config = Config.parseString(`${ConfigKeys.io.broker.tcpServer.maxBufferedBytes} = 2M`);
    expect(readTcpServerOptionsFromConfig(config)).toEqual({ maxBufferedBytes: 2 * 1024 * 1024 });
  });

  test('refused when not a positive integer', () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => new TcpServerOptionsValidator().validate({ maxBufferedBytes: value })).toThrow(OptionsError);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Deno, through a stubbed global                                            */
/* ------------------------------------------------------------------------ */

/** `DENO_WRITE_HIGH_WATER_MARK_BYTES`, module-private in the adapter. */
const DENO_MARK_BYTES = 64 * 1024;

/** An accepted `Deno.Conn` whose writer completes each write on demand. */
class HeldWriteConnection {
  readonly writes: Array<{ readonly data: Uint8Array; release(): Promise<void> }> = [];
  private finish: () => void = () => {};
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => { this.finish = () => controller.close(); },
  });
  readonly writable = {
    getWriter: () => ({
      write: (data: Uint8Array): Promise<void> => {
        let resolve: () => void = () => {};
        const written = new Promise<void>((settle) => { resolve = settle; });
        this.writes.push({ data, release: async () => { resolve(); await written; } });
        return written;
      },
      close: (): Promise<void> => Promise.resolve(),
    }),
  };
  readonly remoteAddr = { hostname: '127.0.0.1', port: 50_000 };

  close(): void { this.finish(); }
}

describe('TcpServerActor on the Deno adapter (#1827)', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  test('a payload past the 64 KiB mark holds the next until the writer catches up', async () => {
    const connection = new HeldWriteConnection();
    let closeListener: () => void = () => {};
    const listenerClosed = new Promise<void>((resolve) => { closeListener = resolve; });
    setDeno({
      listen: () => ({
        addr: { port: 7_002 },
        close: () => closeListener(),
        async *[Symbol.asyncIterator]() {
          yield connection;
          await listenerClosed;
        },
      }),
    });
    const harness = await boot('tcp-server-bp-deno', new DenoTcpBackend());
    await awaitCondition(() => harness.target.openedIds().length === 1, { label: 'the connection was announced' });
    const id = harness.target.openedIds()[0]!;

    harness.server.tell({ kind: 'send', connectionId: id, payload: new Uint8Array(DENO_MARK_BYTES) });
    harness.server.tell({ kind: 'send', connectionId: id, payload: 'after the big one' });
    await awaitCondition(() => connection.writes.length >= 1, { label: 'the big payload was written' });
    await letTheMailboxRun();
    expect(connection.writes).toHaveLength(1);

    await connection.writes[0]!.release();
    expect(connection.writes).toHaveLength(2);
    expect(new TextDecoder().decode(connection.writes[1]!.data)).toBe('after the big one');
    await connection.writes[1]!.release();
  });
});

/* ------------------------------------------------------------------------ */
/* Bun, on the real runtime                                                  */
/* ------------------------------------------------------------------------ */

/** What the listener did with its accepted socket: each write's answer, and each drain. */
type SocketEvent = 'true' | 'false' | 'drain';

function recordingBackend(inner: TcpBackend, events: SocketEvent[]): TcpBackend {
  const wrappers = new Map<TcpSocketLike, TcpSocketLike>();
  const wrap = (socket: TcpSocketLike): TcpSocketLike => {
    let wrapped = wrappers.get(socket);
    if (wrapped === undefined) {
      wrapped = {
        write: (data) => { const answer = socket.write(data); events.push(answer ? 'true' : 'false'); return answer; },
        end: () => socket.end(),
        destroy: () => socket.destroy?.(),
        get remoteAddress() { return socket.remoteAddress; },
      };
      wrappers.set(socket, wrapped);
    }
    return wrapped;
  };
  return {
    connect: (options) => inner.connect(options),
    listen: (options) => {
      const handlers: TcpSocketHandlers = {
        onOpen: (socket) => options.handlers.onOpen(wrap(socket)),
        onData: (socket, chunk) => options.handlers.onData(wrap(socket), chunk),
        onClose: (socket) => options.handlers.onClose(wrap(socket)),
        onError: (socket, error) => options.handlers.onError(wrap(socket), error),
        onDrain: (socket) => { events.push('drain'); options.handlers.onDrain?.(wrap(socket)); },
      };
      return inner.listen({ ...options, handlers });
    },
  };
}

describe('TcpServerActor honours a real Bun socket\'s back-pressure (#1827)', () => {
  test('after a false nothing is written until the drain, and every payload arrives whole and in order', async () => {
    const events: SocketEvent[] = [];
    const harness = await boot(
      'tcp-server-bp-bun',
      recordingBackend(new BunTcpBackend(), events),
      (o) => o.withMaxBufferedBytes(64 * 1024 * 1024),
    );
    let received = 0;
    const chunks: Uint8Array[] = [];
    const client = await new BunTcpBackend().connect({
      host: '127.0.0.1',
      port: harness.listener().boundPort,
      handlers: {
        onOpen: () => {},
        onData: (_socket, chunk) => { chunks.push(chunk.slice()); received += chunk.byteLength; },
        onClose: () => {},
        onError: () => {},
      },
    });
    cleanups.push(() => client.destroy?.());
    await awaitCondition(() => harness.target.openedIds().length === 1, { label: 'the connection was announced' });
    const id = harness.target.openedIds()[0]!;

    const PAYLOAD_BYTES = 256 * 1024;
    const PAYLOADS = 40;
    for (let index = 0; index < PAYLOADS; index += 1) {
      harness.server.tell({ kind: 'send', connectionId: id, payload: new Uint8Array(PAYLOAD_BYTES).fill(index) });
    }
    await awaitCondition(() => received === PAYLOAD_BYTES * PAYLOADS, {
      timeoutMs: 20_000, intervalMs: 10, label: 'every payload arrived',
    });

    expect(events).toContain('false');
    for (let index = 0; index < events.length - 1; index += 1) {
      if (events[index] === 'false') expect(events[index + 1]).toBe('drain');
    }
    const all = Buffer.concat(chunks);
    for (let index = 0; index < PAYLOADS; index += 1) {
      expect(all[index * PAYLOAD_BYTES]).toBe(index);
      expect(all[(index + 1) * PAYLOAD_BYTES - 1]).toBe(index);
    }
    expect(harness.target.closedIds()).toEqual([]);
  }, 60_000);
});
