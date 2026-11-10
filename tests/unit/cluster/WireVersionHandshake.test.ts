/**
 * #823 — the cluster wire's version, negotiated in the handshake.
 *
 * Version 2 requires every node address past the handshake to name its run.
 * Nodes on either side of that cut cannot form one cluster, so they refuse
 * each other at the `hello` — with a `hello-refused` that says why and a line
 * in this node's log — rather than half-working.  Driven over a real socket
 * against a real node, as a peer of another release would arrive.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { connect as connectSocket } from 'node:net';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { encodeFrame, FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import { CLUSTER_WIRE_VERSION, MIN_CLUSTER_WIRE_VERSION, wireVersionRefusal } from '../../../src/cluster/WireVersion.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const started: ActorSystem[] = [];

afterEach(async () => {
  for (const system of started.splice(0)) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

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

async function startNode(log: RecordingLogger): Promise<Cluster> {
  const system = ActorSystem.create('wire-version', ActorSystemOptions.create().withLogger(log));
  started.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('127.0.0.1')
    .withPort(await freePort())
    .withSeeds([]);
  const cluster = await Cluster.join(system, clusterOptions);
  await awaitCondition(() => cluster.selfMember()?.status === 'up', { label: 'the node elected itself up' });
  return cluster;
}

/** Send one `hello` over a fresh socket and collect what comes back until the node closes it. */
async function handshake(port: number, hello: object): Promise<{ replies: WireMessage[]; closed: boolean }> {
  const replies: WireMessage[] = [];
  const decoder = new FrameDecoder();
  let closed = false;
  const socket = connectSocket(port, '127.0.0.1');
  socket.on('data', (chunk: Buffer) => { for (const frame of decoder.push(new Uint8Array(chunk))) replies.push(frame as WireMessage); });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(encodeFrame(hello as WireMessage));
  await awaitCondition(() => closed || replies.length > 0, { timeoutMs: 3_000, label: 'the node answered' });
  // A refusal is followed by the close; an acknowledgment is not.
  if (replies.some((reply) => reply.kind === 'hello-refused')) {
    await awaitCondition(() => closed, { timeoutMs: 3_000, label: 'the node closed the refused connection' });
  }
  socket.destroy();
  return { replies, closed };
}

const peerAddress = (port: number, incarnation?: string): object => ({
  systemName: 'wire-version', host: '127.0.0.1', port, ...(incarnation === undefined ? {} : { incarnation }),
});

describe('the cluster wire version is negotiated in the handshake (#823)', () => {
  test('a version-1 hello — no version, no incarnation — is refused with the reason, on both ends', async () => {
    const log = new RecordingLogger();
    const cluster = await startNode(log);

    const { replies, closed } = await handshake(cluster.selfAddress.port, {
      kind: 'hello', self: peerAddress(40_001),
    });

    expect(closed).toBe(true);
    const refusal = replies.find((reply) => reply.kind === 'hello-refused') as
      | { wireVersion: number; minWireVersion: number; reason: string } | undefined;
    expect(refusal?.wireVersion).toBe(CLUSTER_WIRE_VERSION);
    expect(refusal?.minWireVersion).toBe(MIN_CLUSTER_WIRE_VERSION);
    expect(refusal?.reason).toContain('v1..v1');
    expect(log.records.some((record) => record.level === 'warn' && record.message.includes('cluster handshake'))).toBe(true);
    expect(cluster.getMembers()).toHaveLength(1);
  });

  test('a version-2 hello without an incarnation is refused, naming the missing incarnation', async () => {
    const cluster = await startNode(new RecordingLogger());

    const { replies } = await handshake(cluster.selfAddress.port, {
      kind: 'hello', wireVersion: 2, minWireVersion: 2, self: peerAddress(40_002),
    });

    const refusal = replies.find((reply) => reply.kind === 'hello-refused') as { reason: string } | undefined;
    expect(refusal?.reason).toContain('incarnation');
  });

  test('a version-2 hello with its incarnation is acknowledged with the version', async () => {
    const cluster = await startNode(new RecordingLogger());

    const { replies } = await handshake(cluster.selfAddress.port, {
      kind: 'hello', wireVersion: 2, minWireVersion: 2, self: peerAddress(40_003, 'peer-run'),
    });

    const ack = replies.find((reply) => reply.kind === 'hello-ack') as { wireVersion?: number } | undefined;
    expect(ack?.wireVersion).toBe(CLUSTER_WIRE_VERSION);
    expect(replies.some((reply) => reply.kind === 'hello-refused')).toBe(false);
  });
});

describe('wireVersionRefusal — the overlap rule (#823)', () => {
  const withRun = { systemName: 's', host: 'h', port: 1, incarnation: 'r' };

  test('a peer that speaks a range reaching v2 is taken', () => {
    expect(wireVersionRefusal({ wireVersion: 2, minWireVersion: 2 }, withRun)).toBeNull();
    expect(wireVersionRefusal({ wireVersion: 3, minWireVersion: 1 }, withRun)).toBeNull();
  });

  test('a peer that only speaks versions this node does not is refused', () => {
    expect(wireVersionRefusal({}, withRun)).not.toBeNull();
    expect(wireVersionRefusal({ wireVersion: 1 }, withRun)).not.toBeNull();
    expect(wireVersionRefusal({ wireVersion: 9, minWireVersion: 3 }, withRun)).not.toBeNull();
  });
});
