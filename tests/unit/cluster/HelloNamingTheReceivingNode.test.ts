/**
 * A `hello` that names the receiving node itself, sent over a real socket to a
 * real cluster node — the public route, where the transport-level cases in
 * `TransportFrameGuardContract.test.ts` reach the same handshake through its
 * private socket callbacks.
 *
 * A peer is never the node it is talking to, so the node refuses the claim:
 * the connection gets no identity, the node answers nothing on it — no
 * `hello-ack`, and no reply to the frame that follows — and closes it.  The
 * node's membership and its own status are what they were before.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { connect as connectSocket } from 'node:net';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import { getTcpBackend } from '../../../src/runtime/tcp/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const started: ActorSystem[] = [];

afterEach(async () => {
  for (const system of started.splice(0)) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * A port the operating system just handed out — `port: 0`, read back, released
 * — so no fixed number can land in a Windows excluded range.  The cluster
 * binds it a moment later; the window in between is far smaller than the risk
 * of a constant.
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

describe('a hello naming the receiving node itself, over a real socket', () => {
  test('is refused: no reply, the socket closed, and membership and status unchanged', async () => {
    const log = new RecordingLogger();
    const system = ActorSystem.create('hello-naming-receiver', ActorSystemOptions.create().withLogger(log));
    started.push(system);
    const clusterOptions = ClusterOptions.create()
      .withHost('127.0.0.1')
      .withPort(await freePort())
      .withSeeds([]);
    const cluster = await Cluster.join(system, clusterOptions);
    await awaitCondition(() => cluster.selfMember()?.status === 'up', { label: 'the node elected itself up' });

    const self = cluster.selfAddress;
    const membership = (): string[] => cluster.getMembers().map((member) => `${member.address} ${member.status}`);
    const warningsNamingSelf = (): number => log.records
      .filter((record) => record.level === 'warn' && record.message.includes(self.toString()))
      .length;
    const membershipBefore = membership();
    const warningsBefore = warningsNamingSelf();

    const replies: WireMessage[] = [];
    const decoder = new FrameDecoder();
    let closed = false;
    let closedByTheNode = false;
    const socket = connectSocket(self.port, '127.0.0.1');
    socket.on('data', (chunk: Uint8Array) => { replies.push(...decoder.push(new Uint8Array(chunk))); });
    socket.on('close', () => { closed = true; });
    // The node aborts the socket; how that surfaces here varies by runtime.
    socket.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      // The address alone, without the incarnation the node knows itself by:
      // identity is the address, here as in every map a peer is keyed in.
      const claim = new NodeAddress(self.systemName, self.host, self.port);
      socket.write(encodeFrame({ kind: 'hello', self: claim.toJSON() }));
      // A frame the node would answer, had the connection been given an identity.
      socket.write(encodeFrame({ kind: 'heartbeat', from: claim.toJSON(), seq: 1, ts: 0 }));
      // Whichever comes first: the node closing the socket, or the node answering on it.
      await awaitCondition(() => closed || replies.length > 0, {
        label: 'the node either closed the socket or answered on it',
      });
      // Read before this side closes it too.
      closedByTheNode = closed;
    } finally {
      socket.destroy();
    }

    expect(replies).toEqual([]);
    expect(closedByTheNode).toBe(true);
    expect(cluster.transport.peers()).toEqual([]);
    expect(membership()).toEqual(membershipBefore);
    expect(cluster.selfMember()?.status).toBe('up');
    expect(warningsNamingSelf() - warningsBefore).toBe(1);
  });
});
