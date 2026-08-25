import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, Socket, type Server } from 'node:net';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Actor } from '../../../../../src/Actor.js';
import { TcpSocketActor } from '../../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../../src/io/broker/TcpSocketOptions.js';
import { BrokerConnected, BrokerDisconnected } from '../../../../../src/io/broker/BrokerEvents.js';
import { DEFAULT_TCP_KEEP_ALIVE_MS } from '../../../../../src/io/broker/TcpSocketOptions.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * Settle window for the assertions that also carry an *upper* bound
 * ("exactly three frames").  Polling alone cannot see an overshoot — it
 * returns on the delivery that reaches the count — so those wait for
 * `>=` and then give a short beat in which a surplus frame would show
 * up (#418).
 */
const SETTLE_MS = 20;

class CollectActor extends Actor<unknown> {
  received: unknown[] = [];
  override onReceive(m: unknown): void { this.received.push(m); }
}

/**
 * A real TCP connect crosses the kernel and the event loop, so the 30 ms
 * these tests used to allow for it is a bet on an idle machine, and
 * every one of them sends into the socket immediately afterwards.
 * `BrokerConnected` is the actual signal; watch it instead.
 */
function connectionWatcher(sys: ActorSystem): { connected: boolean } {
  const link = { connected: false };
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(_: unknown): void { link.connected = true; }
    })()),
    BrokerConnected,
  );
  return link;
}

function awaitConnected(link: { connected: boolean }, what: string): Promise<void> {
  return awaitCondition(() => link.connected, {
    timeoutMs: 4_000, label: `${what}: the socket reported BrokerConnected`,
  });
}

function awaitFrames(collector: CollectActor, count: number, what: string): Promise<void> {
  return awaitCondition(() => collector.received.length >= count, {
    timeoutMs: 4_000, label: `${what}: ${count} frame(s) delivered to the target`,
  });
}

interface EchoServer {
  port: number;
  close(): Promise<void>;
}

/** Spin up a tiny TCP echo server on a random port. */
async function startEchoServer(transform?: (chunk: Buffer) => Buffer): Promise<EchoServer> {
  const server: Server = createServer((sock) => {
    sock.on('data', (chunk: Buffer) => {
      sock.write(transform ? transform(chunk) : chunk);
    });
    sock.on('error', () => { /* ignore client disconnects */ });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('no port assigned');
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let server: EchoServer;
beforeEach(async () => { server = await startEchoServer(); });
afterEach(async () => { await server.close(); });

describe('TcpSocketActor — bytes framing (default)', () => {
  test('connects, sends bytes, receives echo', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-1', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);

    const link = connectionWatcher(sys);

    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'bytes framing');
    expect(link.connected).toBe(true);

    ref.tell({ kind: 'send', payload: 'hello' });
    await awaitFrames(collector, 1, 'bytes framing');
    // Echo server returns the bytes; bytes-framing delivers as Uint8Array.
    expect(collector.received.length).toBeGreaterThanOrEqual(1);
    const first = collector.received[0] as Uint8Array;
    expect(new TextDecoder().decode(first)).toBe('hello');
    await sys.terminate();
  });
});

describe('TcpSocketActor — line framing', () => {
  test('extracts newline-delimited frames', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-2', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);

    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target)
      .withFraming({ kind: 'lines' });
    const link = connectionWatcher(sys);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'line framing');

    // Send three lines in one chunk; echo returns them.  The framing
    // strategy MUST split them into three deliveries.
    ref.tell({ kind: 'send', payload: 'one\ntwo\nthree\n' });
    await awaitFrames(collector, 3, 'line framing');
    // "exactly three" is half the claim — give a fourth a chance to appear.
    await sleep(SETTLE_MS);
    expect(collector.received).toEqual(['one', 'two', 'three']);
    await sys.terminate();
  });

  test('handles partial frames across multiple chunks', async () => {
    // Custom server: echoes byte by byte with a small delay so the
    // line crosses chunk boundaries.
    await server.close();
    server = await startEchoServer((chunk) => chunk);  // identity echo
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-3', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target)
      .withFraming({ kind: 'lines' });
    const link = connectionWatcher(sys);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'partial frames');
    ref.tell({ kind: 'send', payload: 'partial-' });
    // Fixture, not a wait: the gap is what splits the line across chunks.
    await sleep(20);
    ref.tell({ kind: 'send', payload: 'frame\n' });
    await awaitFrames(collector, 1, 'partial frames');
    expect(collector.received).toContain('partial-frame');
    await sys.terminate();
  });
});

describe('TcpSocketActor — length-prefixed framing', () => {
  test('extracts u32-prefixed frames', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-4', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target)
      .withFraming({ kind: 'length-prefixed' });
    const link = connectionWatcher(sys);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'length-prefixed framing');

    // Build a 5-byte frame with a 4-byte length prefix.
    const payload = new TextEncoder().encode('hello');
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length, false);  // big-endian
    out.set(payload, 4);
    ref.tell({ kind: 'send', payload: out });
    await awaitFrames(collector, 1, 'length-prefixed framing');
    // "exactly one" is half the claim — give a second frame a chance.
    await sleep(SETTLE_MS);
    expect(collector.received.length).toBe(1);
    const decoded = new TextDecoder().decode(collector.received[0] as Uint8Array);
    expect(decoded).toBe('hello');
    await sys.terminate();
  });
});

describe('TcpSocketActor — a breached framing cap (#578)', () => {
  test('closes the socket even when the reconnect policy is off', async () => {
    // The BRK-1 guard fired before this fix too — and did nothing that
    // mattered.  `handleConnectionLost` never touches the transport, and with
    // `reconnect: false` the policy never gets as far as reconnecting, so the
    // socket stayed attached with its 'data' listener live and the same peer
    // went on growing the buffer the cap had just refused to clear.  A real
    // socket is the only thing that can witness the difference; the unit
    // harness has none.
    let peerSawClose = false;
    const flooder: Server = createServer((sock) => {
      const flood = (): boolean => sock.write('x'.repeat(4096));  // never a '\n'
      const timer = setInterval(flood, 5);
      sock.on('close', () => { peerSawClose = true; clearInterval(timer); });
      sock.on('error', () => { clearInterval(timer); });  // the client aborting us
      flood();
    });
    await new Promise<void>((resolve) => flooder.listen(0, '127.0.0.1', () => resolve()));
    const address = flooder.address();
    if (typeof address === 'string' || !address) throw new Error('no port assigned');

    try {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off);
      const sys = ActorSystem.create('tcp-6', sysOptions);
      const collector = new CollectActor();
      const target = sys.spawnAnonymous(() => collector);
      const tcpOptions = TcpSocketOptions.create()
        .withHost('127.0.0.1')
        .withPort(address.port)
        .withTarget(target)
        .withFraming({ kind: 'lines', maxLineLen: 64 })
        .withReconnect(false);
      const link = connectionWatcher(sys);
      sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
      await awaitConnected(link, 'cap breach');

      await awaitCondition(() => peerSawClose, {
        timeoutMs: 4_000, label: 'the client dropped the socket after the cap breach',
      });
      // Nothing over the cap reaches the target — the frames are the other
      // half of the claim, and a settle window is what can see a surplus.
      await sleep(SETTLE_MS);
      expect(collector.received).toEqual([]);
      await sys.terminate();
    } finally {
      await new Promise<void>((resolve) => flooder.close(() => resolve()));
    }
  });
});

describe('TcpSocketActor — options validation', () => {
  test('missing host/port throws BrokerOptionsError', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-5', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    let captured: Error | null = null;
    const tcpOptions = TcpSocketOptions.create()
      .withTarget(target);  // host, port missing
    sys.spawnAnonymous(() => {
      const actor = new TcpSocketActor(tcpOptions);
      const orig = actor.preStart.bind(actor);
      actor.preStart = async () => { try { await orig(); } catch (e) { captured = e as Error; } };
      return actor as unknown as Actor<unknown>;
    });
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'preStart rejected the incomplete options',
    });
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toContain('host');
    expect((captured as unknown as Error).message).toContain('port');
    await sys.terminate();
  });
});

/* --------------------- liveness: read-idle + keepalive (#753) ------------ */

/**
 * A server that accepts the connection and then says nothing — the observable
 * half of a peer that has vanished without FIN/RST.  It never writes and never
 * closes, so `data`, `close` and `error` all stay silent and the actor has
 * nothing but a clock to go on.
 */
async function startSilentServer(): Promise<EchoServer> {
  const silent: Server = createServer((sock) => {
    sock.on('error', () => { /* ignore client disconnects */ });
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
  const addr = silent.address();
  if (typeof addr === 'string' || !addr) throw new Error('no port assigned');
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => silent.close(() => resolve())),
  };
}

/** Records the cause of every `BrokerDisconnected` the system publishes. */
function disconnectCauses(sys: ActorSystem): string[] {
  const causes: string[] = [];
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(m: unknown): void {
        causes.push((m as BrokerDisconnected).cause?.message ?? '<no cause>');
      }
    })()),
    BrokerDisconnected,
  );
  return causes;
}

describe('TcpSocketActor — read-idle timeout (#753)', () => {
  test('a peer that accepts and then goes silent is reported as lost', async () => {
    const silent = await startSilentServer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-idle-1', sysOptions);
    try {
      const target = sys.spawnAnonymous(() => new CollectActor());
      const causes = disconnectCauses(sys);
      const tcpOptions = TcpSocketOptions.create()
        .withHost('127.0.0.1')
        .withPort(silent.port)
        .withTarget(target)
        .withIdleTimeoutMs(60)
        .withReconnect(false);
      sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));

      await awaitCondition(() => causes.length > 0, {
        timeoutMs: 4_000, label: 'the idle deadline reported the silent peer as lost',
      });
      expect(causes[0]).toContain('idle timeout');
    } finally {
      await sys.terminate();
      await silent.close();
    }
  });

  test('idleTimeoutMs 0 leaves a quiet connection alone', async () => {
    const silent = await startSilentServer();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-idle-2', sysOptions);
    try {
      const target = sys.spawnAnonymous(() => new CollectActor());
      const causes = disconnectCauses(sys);
      const link = connectionWatcher(sys);
      const tcpOptions = TcpSocketOptions.create()
        .withHost('127.0.0.1')
        .withPort(silent.port)
        .withTarget(target)
        .withIdleTimeoutMs(0)
        .withReconnect(false);
      sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
      await awaitConnected(link, 'idle timeout disabled');

      // `0` is the documented way to turn the deadline off, and the only thing
      // that can prove it is a stretch of silence in which nothing happens.
      await sleep(200);
      expect(causes).toEqual([]);
    } finally {
      await sys.terminate();
      await silent.close();
    }
  });

  test('inbound bytes keep the deadline from firing', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-idle-3', sysOptions);
    try {
      const collector = new CollectActor();
      const target = sys.spawnAnonymous(() => collector);
      const causes = disconnectCauses(sys);
      const link = connectionWatcher(sys);
      const tcpOptions = TcpSocketOptions.create()
        .withHost('127.0.0.1')
        .withPort(server.port)  // the module-level echo server
        .withTarget(target)
        .withIdleTimeoutMs(500)
        .withReconnect(false);
      const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
      await awaitConnected(link, 'idle timeout with traffic');

      // Traffic every 50 ms against a 500 ms deadline — a tenfold margin, so a
      // failure here is the deadline ignoring inbound bytes rather than a slow
      // machine.  The window spans two deadlines, which is what makes the
      // absence of a disconnect mean something.
      for (let round = 1; round <= 24; round++) {
        ref.tell({ kind: 'send', payload: `tick-${round}` });
        await sleep(50);  // the elapsed time IS the assertion: two deadline windows of traffic
      }
      expect(collector.received.length).toBeGreaterThan(0);
      expect(causes).toEqual([]);
    } finally {
      await sys.terminate();
    }
  }, 10_000);
});

/**
 * Observes `setKeepAlive` on the socket the actor actually opened.
 *
 * Patching the prototype is the only seam: `connectImplementation` creates the
 * socket itself and never hands it out, and the effect of keepalive — an OS
 * probe minutes later — is not observable from a test at all.  The original is
 * restored in a `finally`, and the patch delegates, so the socket behaves
 * exactly as it would have.
 */
async function recordKeepAliveCalls(body: () => Promise<void>): Promise<Array<[boolean, number]>> {
  const calls: Array<[boolean, number]> = [];
  const original = Socket.prototype.setKeepAlive;
  Socket.prototype.setKeepAlive = function patched(
    this: Socket, enable?: boolean, initialDelay?: number,
  ): Socket {
    calls.push([enable ?? false, initialDelay ?? 0]);
    return original.call(this, enable, initialDelay);
  };
  try { await body(); } finally { Socket.prototype.setKeepAlive = original; }
  return calls;
}

describe('TcpSocketActor — TCP keepalive (#753)', () => {
  test('enables OS keepalive on the connected socket by default', async () => {
    const calls = await recordKeepAliveCalls(async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off);
      const sys = ActorSystem.create('tcp-keepalive-1', sysOptions);
      const target = sys.spawnAnonymous(() => new CollectActor());
      const link = connectionWatcher(sys);
      const tcpOptions = TcpSocketOptions.create()
        .withHost('127.0.0.1')
        .withPort(server.port)
        .withTarget(target);
      sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
      await awaitConnected(link, 'keepalive default');
      await sys.terminate();
    });
    // On by default: it is the one liveness knob that cannot be wrong about a
    // healthy peer, because a probe is answered by the peer's kernel whether
    // or not its application has anything to say.
    expect(calls).toEqual([[true, DEFAULT_TCP_KEEP_ALIVE_MS]]);
  });

  test('keepAliveMs 0 leaves keepalive off', async () => {
    const calls = await recordKeepAliveCalls(async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off);
      const sys = ActorSystem.create('tcp-keepalive-2', sysOptions);
      const target = sys.spawnAnonymous(() => new CollectActor());
      const link = connectionWatcher(sys);
      const tcpOptions = TcpSocketOptions.create()
        .withHost('127.0.0.1')
        .withPort(server.port)
        .withTarget(target)
        .withKeepAliveMs(0);
      sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
      await awaitConnected(link, 'keepalive disabled');
      await sys.terminate();
    });
    expect(calls).toEqual([]);
  });
});
