/**
 * #1827 — a `ClusterClient` honours its connection's back-pressure, bounded.
 *
 * `writeFrame` handed every envelope to the socket whatever `write()` answered,
 * so a contact point that stopped reading grew this process's heap by every
 * `send` and `ask` made against it.  Now, after a write that answers `false`,
 * the client writes nothing more until the socket's `onDrain`, and holds whole
 * frames in a per-connection outbox of at most `outbound-queue-size` — the
 * transport's shape from #931.  Over the bound it refuses: the `send` or `ask`
 * rejects with an error saying the contact point is not reading, rather than
 * dropping a frame its caller believes was sent.
 *
 * Covered per runtime: through a fake backend whose answers the test decides;
 * Node through its socket-module seam and Deno through a stubbed global — the
 * stand-ins the adapters' own back-pressure suites use; and Bun on the real
 * runtime, against a contact point on the same thread.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import {
  ClusterClientOptions,
  DEFAULT_CLUSTER_CLIENT_OUTBOUND_QUEUE_SIZE,
  readClusterClientOptionsFromConfig,
} from '../../../src/cluster/ClusterClientOptions.js';
import type { ClusterClientEnvelopeMessage } from '../../../src/cluster/ClusterClientReceptionist.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder } from '../../../src/cluster/Protocol.js';
import { CLUSTER_WIRE_VERSION } from '../../../src/cluster/WireVersion.js';
import { Config } from '../../../src/config/Config.js';
import { BunTcpBackend } from '../../../src/runtime/tcp/BunTcpBackend.js';
import { DenoTcpBackend } from '../../../src/runtime/tcp/DenoTcpBackend.js';
import { NodeTcpBackend } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type { NodeSocketModules } from '../../../src/runtime/tcp/NodeTcpBackend.js';
import type {
  TcpBackend,
  TcpListener,
  TcpSocketHandlers,
  TcpSocketLike,
  TlsTransportOptionsType,
} from '../../../src/runtime/tcp/TcpBackend.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const clients: ClusterClient[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function helloAcknowledgment(port: number): Uint8Array {
  return encodeFrame({
    kind: 'hello-ack',
    wireVersion: CLUSTER_WIRE_VERSION,
    self: new NodeAddress('contact-point', '127.0.0.1', port, 'test-run').toJSON(),
  });
}

/** The envelopes among `chunks`, decoded in order. */
function envelopesIn(chunks: readonly Uint8Array[]): ClusterClientEnvelopeMessage[] {
  const decoder = new FrameDecoder();
  return (chunks.flatMap((chunk) => decoder.push(chunk)) as unknown as Array<{ kind: string }>)
    .filter((frame) => frame.kind === 'cluster-client-envelope') as unknown as ClusterClientEnvelopeMessage[];
}

/** Run everything already queued — microtasks and the I/O turn. */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function clientWith(backend: TcpBackend, port: number, outboundQueueSize?: number): ClusterClient {
  const builder = ClusterClientOptions.create()
    .withContactPoints([`contact-point@127.0.0.1:${port}`])
    .withLogger(new NoopLogger());
  const options = outboundQueueSize === undefined ? builder : builder.withOutboundQueueSize(outboundQueueSize);
  const client = new ClusterClient(options, Config.empty());
  (client as unknown as { backend: unknown }).backend = backend;
  clients.push(client);
  return client;
}

/* ------------------------------------------------------------------------ */
/* A fake backend whose socket answers as the test says                     */
/* ------------------------------------------------------------------------ */

class ScriptedSocket implements TcpSocketLike {
  readonly writes: Uint8Array[] = [];
  /** Whether a write answers `false` — the socket holding more than its mark. */
  full = false;
  ended = false;
  /** How many writes had landed when `end()` was called. */
  writesBeforeEnd = -1;
  write(data: Uint8Array): boolean { this.writes.push(data); return !this.full; }
  end(): void { this.ended = true; this.writesBeforeEnd = this.writes.length; }
  destroy(): void { this.ended = true; }
}

class ScriptedBackend {
  readonly socket = new ScriptedSocket();
  handlers: TcpSocketHandlers | undefined;

  connect(options: { port: number; handlers: TcpSocketHandlers; tls?: TlsTransportOptionsType }): Promise<TcpSocketLike> {
    this.handlers = options.handlers;
    options.handlers.onOpen(this.socket);
    queueMicrotask(() => options.handlers.onData(this.socket, helloAcknowledgment(options.port)));
    return Promise.resolve(this.socket);
  }

  listen(): never { throw new Error('a ClusterClient never listens'); }

  /** The socket can take more again. */
  drained(): void {
    this.socket.full = false;
    this.handlers!.onDrain?.(this.socket);
  }
}

async function connected(outboundQueueSize?: number): Promise<{ client: ClusterClient; backend: ScriptedBackend }> {
  const backend = new ScriptedBackend();
  const client = clientWith(backend as unknown as TcpBackend, 2551, outboundQueueSize);
  await client.send('/user/warm-up', 0);
  return { client, backend };
}

describe('ClusterClient holds frames while its socket pushes back (#1827)', () => {
  test('after a false nothing is written until the drain, then the held frames go in order', async () => {
    const { client, backend } = await connected();
    const socket = backend.socket;
    socket.full = true;
    await client.send('/user/a', 1);
    const writesAtFalse = socket.writes.length;
    await client.send('/user/b', 2);
    await client.send('/user/c', 3);
    expect(socket.writes).toHaveLength(writesAtFalse);

    backend.drained();
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1, 2, 3]);
  });

  test('a hello that meets back-pressure holds the first envelope behind it', async () => {
    const backend = new ScriptedBackend();
    backend.socket.full = true;
    const client = clientWith(backend as unknown as TcpBackend, 2551);
    await client.send('/user/first', 1);
    // Only the hello has gone: the socket answered it with false.
    expect(backend.socket.writes).toHaveLength(1);
    expect(envelopesIn(backend.socket.writes)).toEqual([]);

    backend.drained();
    expect(envelopesIn(backend.socket.writes).map((envelope) => envelope.body)).toEqual([1]);
  });

  test('a drain that meets back-pressure again stops writing there', async () => {
    const { client, backend } = await connected();
    const socket = backend.socket;
    socket.full = true;
    await client.send('/user/a', 1);
    await client.send('/user/b', 2);
    await client.send('/user/c', 3);

    // The socket drains, takes one frame and pushes back again.
    socket.full = true;
    backend.handlers!.onDrain?.(socket);
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1, 2]);
    backend.drained();
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1, 2, 3]);
  });

  test('past outbound-queue-size a send is refused, and the frames already held still go', async () => {
    const { client, backend } = await connected(2);
    const socket = backend.socket;
    socket.full = true;
    await client.send('/user/a', 1);
    await client.send('/user/b', 2);
    await client.send('/user/c', 3);

    let refusal: unknown;
    try { await client.send('/user/d', 4); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('is not reading');
    expect((refusal as Error).message).toContain('2 frame(s)');

    backend.drained();
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1, 2, 3]);
    // Drained: a send is taken again.
    await client.send('/user/e', 5);
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1, 2, 3, 5]);
  });

  test('a refused ask rejects at once and leaves no ask waiting', async () => {
    const { client, backend } = await connected(1);
    backend.socket.full = true;
    await client.send('/user/a', 1);
    await client.send('/user/b', 2);

    let refusal: unknown;
    try { await client.ask('/user/c', 3, 60_000); } catch (error) { refusal = error; }
    expect((refusal as Error).message).toContain('is not reading');
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  test('close() writes the held frames ahead of its FIN', async () => {
    const { client, backend } = await connected();
    const socket = backend.socket;
    socket.full = true;
    await client.send('/user/a', 1);
    await client.send('/user/b', 2);
    await client.close();
    expect(socket.ended).toBe(true);
    expect(envelopesIn(socket.writes.slice(0, socket.writesBeforeEnd)).map((envelope) => envelope.body)).toEqual([0, 1, 2]);
  });
});

describe('outbound-queue-size is an option (#1827)', () => {
  test('defaults to the transport\'s bound, 1000', () => {
    expect(DEFAULT_CLUSTER_CLIENT_OUTBOUND_QUEUE_SIZE).toBe(1000);
  });

  test('read from actor-ts.cluster.client.outbound-queue-size', () => {
    const config = Config.parseString('actor-ts.cluster.client.outbound-queue-size = 7');
    expect(readClusterClientOptionsFromConfig(config)).toEqual({ outboundQueueSize: 7 });
  });

  test('refused when not a positive integer', () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => new ClusterClient({ contactPoints: ['127.0.0.1:2551'], outboundQueueSize: value }, Config.empty()))
        .toThrow(OptionsError);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Node, through the socket-module seam                                      */
/* ------------------------------------------------------------------------ */

/** A `node:net` socket that connects at once, answers the hello, and pushes back while `full`. */
class ScriptedNodeSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly writes: Uint8Array[] = [];
  full = false;
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
    // The hello is answered as soon as it is written.
    if (this.writes.length === 1) queueMicrotask(() => this.emit('data', helloAcknowledgment(2551)));
    return !this.full;
  }

  end(): void {}
  destroy(): void {}
}

describe('ClusterClient on the Node adapter (#1827)', () => {
  test('a false holds the next frame until the socket emits drain', async () => {
    const socket = new ScriptedNodeSocket();
    const module = {
      createServer: (): never => { throw new Error('no listener in this test'); },
      connect: (): ScriptedNodeSocket => socket,
    };
    const modules: NodeSocketModules = { net: async () => module as never, tls: async () => module as never };
    const client = clientWith(new NodeTcpBackend(modules), 2551);
    await client.send('/user/warm-up', 0);

    socket.full = true;
    await client.send('/user/a', 1);
    await client.send('/user/b', 2);
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1]);

    socket.full = false;
    socket.emit('drain');
    expect(envelopesIn(socket.writes).map((envelope) => envelope.body)).toEqual([0, 1, 2]);
  });
});

/* ------------------------------------------------------------------------ */
/* Deno, through a stubbed global                                            */
/* ------------------------------------------------------------------------ */

/** `DENO_WRITE_HIGH_WATER_MARK_BYTES`, module-private in the adapter. */
const DENO_MARK_BYTES = 64 * 1024;

/** A `Deno.Conn` that answers the hello and whose writer completes each write on demand. */
class HeldWriteConnection {
  readonly writes: Array<{ readonly data: Uint8Array; release(): Promise<void> }> = [];
  private push: (chunk: Uint8Array) => void = () => {};
  private finish: () => void = () => {};
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.push = (chunk) => controller.enqueue(chunk);
      this.finish = () => controller.close();
    },
  });
  readonly writable = {
    getWriter: () => ({
      write: (data: Uint8Array): Promise<void> => {
        let resolve: () => void = () => {};
        const written = new Promise<void>((settle) => { resolve = settle; });
        this.writes.push({ data, release: async () => { resolve(); await written; } });
        if (this.writes.length === 1) this.push(helloAcknowledgment(2551));
        return written;
      },
      close: (): Promise<void> => Promise.resolve(),
    }),
  };
  readonly remoteAddr = { hostname: '127.0.0.1', port: 2551 };

  close(): void { this.finish(); }
}

describe('ClusterClient on the Deno adapter (#1827)', () => {
  const realDeno = (globalThis as { Deno?: unknown }).Deno;
  const setDeno = (value: unknown): void => {
    Object.defineProperty(globalThis, 'Deno', { value, configurable: true, writable: true });
  };
  afterEach(() => { setDeno(realDeno); });

  test('a frame past the 64 KiB mark holds the next until the writer catches up', async () => {
    const connection = new HeldWriteConnection();
    setDeno({ connect: async () => connection });
    const client = clientWith(new DenoTcpBackend(), 2551);
    await client.send('/user/warm-up', 0);
    for (const write of [...connection.writes]) await write.release();

    await client.send('/user/big', 'x'.repeat(DENO_MARK_BYTES));
    await client.send('/user/after', 'after the big one');
    const written = (): unknown[] => envelopesIn(connection.writes.map((write) => write.data)).map((envelope) => envelope.to);
    expect(written()).toEqual(['/user/warm-up', '/user/big']);

    await connection.writes[connection.writes.length - 1]!.release();
    await drain();
    expect(written()).toEqual(['/user/warm-up', '/user/big', '/user/after']);
  });
});

/* ------------------------------------------------------------------------ */
/* Bun, on the real runtime                                                  */
/* ------------------------------------------------------------------------ */

/** What the client did with its socket: each write's answer, and each drain, in order. */
type SocketEvent = 'true' | 'false' | 'drain';

function recordingBackend(inner: TcpBackend, events: SocketEvent[]): TcpBackend {
  return {
    listen: (options) => inner.listen(options),
    connect: async (options) => {
      const wrappers = new Map<TcpSocketLike, TcpSocketLike>();
      const wrap = (socket: TcpSocketLike): TcpSocketLike => {
        let wrapped = wrappers.get(socket);
        if (wrapped === undefined) {
          wrapped = {
            write: (data) => { const answer = socket.write(data); events.push(answer ? 'true' : 'false'); return answer; },
            end: () => socket.end(),
            destroy: () => socket.destroy?.(),
          };
          wrappers.set(socket, wrapped);
        }
        return wrapped;
      };
      const handlers: TcpSocketHandlers = {
        onOpen: (socket) => options.handlers.onOpen(wrap(socket)),
        onData: (socket, chunk) => options.handlers.onData(wrap(socket), chunk),
        onClose: (socket) => options.handlers.onClose(wrap(socket)),
        onError: (socket, error) => options.handlers.onError(wrap(socket), error),
        onDrain: (socket) => { events.push('drain'); options.handlers.onDrain?.(wrap(socket)); },
      };
      return wrap(await inner.connect({ ...options, handlers }));
    },
  };
}

/** A contact point on this thread: answers the hello, then keeps every byte. */
async function bunContactPoint(): Promise<{ readonly port: number; received(): Uint8Array[] }> {
  const chunks: Uint8Array[] = [];
  let port = 0;
  const listener: TcpListener = await new BunTcpBackend().listen({
    host: '127.0.0.1',
    port: 0,
    handlers: {
      onOpen: (socket) => { cleanups.push(() => { try { socket.destroy?.(); } catch { /* gone */ } }); },
      onData: (socket, chunk) => {
        if (chunks.length === 0) socket.write(helloAcknowledgment(port));
        chunks.push(chunk.slice());
      },
      onClose: () => {},
      onError: () => {},
    },
  });
  port = listener.port;
  cleanups.push(() => listener.close());
  return { port, received: () => chunks };
}

describe('ClusterClient honours a real Bun socket\'s back-pressure (#1827)', () => {
  test('after a false nothing is written until the drain; past the bound sends are refused; the rest arrive whole', async () => {
    const contactPoint = await bunContactPoint();
    const events: SocketEvent[] = [];
    const client = clientWith(recordingBackend(new BunTcpBackend(), events), contactPoint.port, 8);
    await client.send('/user/warm-up', -1);

    // Fired without yielding to the event loop: the contact point on this
    // thread reads nothing until they have all been handed to the client.
    const body = 'z'.repeat(256 * 1024);
    const outcomes = Array.from({ length: 40 }, (_, index) =>
      client.send(`/user/${index}`, body).then(() => 'sent', (error: Error) => error.message));
    const settled = await Promise.all(outcomes);

    expect(events).toContain('false');
    const refused = settled.filter((outcome) => outcome !== 'sent');
    expect(refused.length).toBeGreaterThan(0);
    for (const message of refused) expect(message).toContain('is not reading');

    const accepted = settled.flatMap((outcome, index) => outcome === 'sent' ? [`/user/${index}`] : []);
    await awaitCondition(
      () => envelopesIn(contactPoint.received()).length === accepted.length + 1,
      { timeoutMs: 20_000, intervalMs: 10, label: 'every accepted envelope arrived' },
    );
    expect(envelopesIn(contactPoint.received()).map((envelope) => envelope.to)).toEqual(['/user/warm-up', ...accepted]);
    for (let index = 0; index < events.length - 1; index += 1) {
      if (events[index] === 'false') expect(events[index + 1]).toBe('drain');
    }
  }, 60_000);
});
