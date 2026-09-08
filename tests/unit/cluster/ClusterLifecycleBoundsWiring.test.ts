/**
 * #846 — the hop from `actor-ts.remote.*` to the transport `Cluster` builds.
 *
 * The two halves of that hop were each well bound and the join between them was
 * bound by nothing: `ClusterConfigDefaults` proves the reader turns the HOCON
 * block into `ClusterOptionsType` fields, and `TcpTransportInboundGuards` proves
 * a `TcpTransport` enforces the bounds it was handed — but nothing observed a
 * configured number arriving at a guard.  Deleting the four option lines from
 * the `new TcpTransport(...)` literal in `Cluster`'s constructor, which makes
 * all four keys inert, left `tests/unit/cluster/`, `tests/unit/config/`,
 * `tests/unit/options/` and `tests/unit/docs/` green.
 *
 * So this file is deliberately end-to-end for four keys and nothing else: HOCON
 * text in, a real `Cluster.join`, and the guard on the transport that join built
 * observed firing at the configured number rather than the shipped constant.
 * The control case at the end is what keeps it honest — an unconfigured join
 * has to land on the constants, or "configurable" would have quietly become
 * "the option's own default".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  INCOMPLETE_FRAME_IDLE_MS,
  MAX_INBOUND_CONNECTIONS,
  MAX_PENDING_FRAMES,
} from '../../../src/cluster/Constants.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel } from '../../../src/Logger.js';
import type { Logger } from '../../../src/Logger.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';

/** Collects the transport's WARNs — the only place a guard names its bound. */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: string[] = [];
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(message: string, ..._args: unknown[]): void { this.warnings.push(message); }
  error(_message: string, ..._args: unknown[]): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: Record<string, unknown>): Logger { return this; }
}

/** Just enough of a socket for the two guards these tests provoke. */
interface MockSocket {
  ended: boolean;
  write(data: Uint8Array): void;
  end(): void;
}

function mockSocket(): MockSocket {
  return {
    ended: false,
    write(_data: Uint8Array): void {},
    end(): void { this.ended = true; },
  };
}

/** The private socket callbacks and bookkeeping these tests reach through. */
interface TransportInternals {
  attachInbound(socket: unknown): void;
  onHandshakeTimeout(connection: object): void;
  readonly inboundConnections: number;
  readonly bySocket: WeakMap<object, { handshakeTimer: ReturnType<typeof setTimeout> | null }>;
  readonly byPeer: Map<string, { readonly pending: readonly unknown[] }>;
}

function internals(cluster: Cluster): TransportInternals {
  return cluster.transport as unknown as TransportInternals;
}

/** The four bounds as the transport resolved them, whatever their source. */
type ResolvedBounds = {
  readonly handshakeTimeoutMs: number;
  readonly outboundQueueSize: number;
  readonly maxInboundConnections: number;
  readonly incompleteFrameIdleMs: number;
};

function resolvedBounds(cluster: Cluster): ResolvedBounds {
  return cluster.transport as unknown as ResolvedBounds;
}

/**
 * A port the operating system just handed out and is therefore willing to
 * assign — which a hard-coded number is not, on a Windows host with a `netsh`
 * excluded port range over the one that was picked.  The listener is closed
 * before the number is handed back, so this races anything else asking for an
 * ephemeral port in the same instant; that is a far smaller risk than a
 * constant that is unbindable on one developer's machine forever.
 */
async function freePort(): Promise<number> {
  const backend = await getTcpBackend();
  const listener = await backend.listen({
    host: '127.0.0.1',
    port: 0,
    handlers: { onOpen: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} },
  });
  const { port } = listener;
  await listener.close();
  return port;
}

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * Join a single-node cluster over a real `TcpTransport` — no `withTransport`,
 * because an injected transport is exactly the path that does *not* cross the
 * wiring under test.
 */
async function joinConfigured(
  name: string,
  hocon: string,
): Promise<{ readonly cluster: Cluster; readonly log: CapturingLogger }> {
  const log = new CapturingLogger();
  const system = ActorSystem.create(
    name,
    ActorSystemOptions.create().withLogger(log).withConfig(Config.parseString(hocon)),
  );
  started.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(await freePort())
    .withSeeds([]);
  const cluster = await Cluster.join(system, clusterOptions);
  return { cluster, log };
}

describe('the association-lifecycle bounds reach the transport Cluster builds (#846)', () => {
  test('a configured inbound cap is the one that refuses a socket', async () => {
    const { cluster } = await joinConfigured(
      'lifecycle-bounds-inbound-cap',
      'actor-ts.remote.max-inbound-connections = 2',
    );

    const accepted = [mockSocket(), mockSocket()];
    for (const socket of accepted) internals(cluster).attachInbound(socket);
    expect(internals(cluster).inboundConnections).toBe(2);
    expect(accepted.every((socket) => !socket.ended)).toBe(true);

    const refused = mockSocket();
    internals(cluster).attachInbound(refused);
    expect(refused.ended).toBe(true);
    expect(internals(cluster).inboundConnections).toBe(2);
  });

  test('a configured handshake deadline is the one the WARN names', async () => {
    const { cluster, log } = await joinConfigured(
      'lifecycle-bounds-handshake',
      `actor-ts.remote {
         handshake-timeout     = 250ms
         incomplete-frame-idle = 900ms
       }`,
    );

    const socket = mockSocket();
    internals(cluster).attachInbound(socket);
    const connection = internals(cluster).bySocket.get(socket)!;
    clearTimeout(connection.handshakeTimer as ReturnType<typeof setTimeout>);
    internals(cluster).onHandshakeTimeout(connection);

    expect(socket.ended).toBe(true);
    // The number in the message is the whole assertion: a wiring that took the
    // option and went on reading the constant tears the socket down just the
    // same, and says 5000.
    expect(log.warnings.join('\n')).toContain('sent no hello within 250 ms');
    expect(log.warnings.join('\n')).not.toContain(`${HANDSHAKE_TIMEOUT_MS} ms`);
  });

  test('a configured outbound queue is the depth at which frames start dropping', async () => {
    const { cluster, log } = await joinConfigured(
      'lifecycle-bounds-outbound-queue',
      'actor-ts.remote.outbound-queue-size = 2',
    );
    // Never listened on, so the dial fails on a later tick — well after the
    // three synchronous buffer writes below.
    const peer = new NodeAddress('unreachable-peer', '127.0.0.1', await freePort());

    cluster.transport.send(peer, { kind: 'hello', self: peer.toJSON() });
    cluster.transport.send(peer, { kind: 'hello-ack', self: peer.toJSON() });
    cluster.transport.send(peer, { kind: 'heartbeat', from: peer.toJSON(), seq: 1, ts: 1 });

    expect(internals(cluster).byPeer.get(peer.toString())?.pending).toHaveLength(2);
    expect(log.warnings.join('\n')).toContain('hit 2 frames; dropping oldest');
    expect(log.warnings.join('\n')).not.toContain(`${MAX_PENDING_FRAMES} frames`);
  });

  test('a configured stall deadline reaches the transport as the number it will enforce', async () => {
    const { cluster } = await joinConfigured(
      'lifecycle-bounds-stall',
      `actor-ts.remote {
         handshake-timeout     = 400ms
         incomplete-frame-idle = 1200ms
       }`,
    );

    // Read off the transport rather than provoked: the stall timer needs a
    // half-received frame, and building one here would re-test the guard
    // instead of the hop that hands it its number.
    expect(resolvedBounds(cluster).incompleteFrameIdleMs).toBe(1_200);
    expect(resolvedBounds(cluster).handshakeTimeoutMs).toBe(400);
  });

  test('an unconfigured join lands on the shipped constants', async () => {
    // The control case.  Without it the four above would pass just as happily
    // if every constant had been dropped and the option had become its own
    // default — which is the shape in which "configurable" moves a bound.
    const { cluster } = await joinConfigured('lifecycle-bounds-default', 'actor-ts.cluster.roles = []');

    expect(resolvedBounds(cluster)).toMatchObject({
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      outboundQueueSize: MAX_PENDING_FRAMES,
      maxInboundConnections: MAX_INBOUND_CONNECTIONS,
      incompleteFrameIdleMs: INCOMPLETE_FRAME_IDLE_MS,
    });
  });

  test('the transport a caller hands in keeps its own bounds', async () => {
    // The other side of the same seam, and the reason the four lines are in
    // `Cluster`'s constructor rather than inside `TcpTransport`: re-capping
    // someone else's transport from this node's config would be a surprise.
    const injected = new TcpTransport(
      new NodeAddress('lifecycle-bounds-injected', '127.0.0.1', await freePort()),
      new CapturingLogger(),
      { maxInboundConnections: 7, bindHost: '127.0.0.1', bindPort: 0 },
    );
    const system = ActorSystem.create(
      'lifecycle-bounds-injected',
      ActorSystemOptions.create()
        .withLogger(new CapturingLogger())
        .withConfig(Config.parseString('actor-ts.remote.max-inbound-connections = 2')),
    );
    started.push(system);
    const clusterOptions = ClusterOptions.create()
      .withHost('127.0.0.1')
      .withPort(await freePort())
      .withSeeds([])
      .withTransport(injected);

    const cluster = await Cluster.join(system, clusterOptions);

    expect(resolvedBounds(cluster).maxInboundConnections).toBe(7);
  });
});
