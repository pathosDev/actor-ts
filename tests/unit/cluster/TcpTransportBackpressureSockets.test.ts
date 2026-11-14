/**
 * #931 over real sockets: a burst a stalled reader cannot keep up with
 * arrives intact.
 *
 * Both nodes run on this one thread over loopback, so while the sending loop
 * runs the receiver cannot read at all — the stalled reader the issue
 * describes, for free.  The burst goes out over the *accepted* side of the
 * connection, because on Bun that is the native `Bun.listen` socket, the one
 * whose `write` dropped what the kernel would not take: there the stream was
 * cut at about 195 KB, the receiver read the next frame's bytes as a length
 * prefix, and the connection was dropped.  (The dialling side writes through
 * Bun's `node:net`, which always queued.)
 *
 * Every frame carries its sequence number and a filler derived from it, so a
 * cut, a reordering or a corrupted byte all show as a failed comparison.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const HOST = '127.0.0.1';
const FILLER_LENGTH = 2_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type Received = { readonly seq: number; readonly intact: boolean };

const transports: TcpTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
});

/** The filler for `seq`: varies per frame, so a byte from the wrong frame shows. */
function filler(seq: number): string {
  return String.fromCharCode(97 + (seq % 26)).repeat(FILLER_LENGTH);
}

function envelope(seq: number): WireMessage {
  return { kind: 'envelope', to: '/user/sink', from: null, payload: { seq, filler: filler(seq) } } as unknown as WireMessage;
}

/**
 * A dialler and an acceptor, connected, with the acceptor's connection to the
 * dialler established — the side whose writes are under test.
 */
async function connectedPair(outboundQueueSize: number): Promise<{
  dialler: TcpTransport;
  acceptor: TcpTransport;
  diallerAddress: NodeAddress;
  received: Received[];
  acceptorLog: RecordingLogger;
  diallerLog: RecordingLogger;
}> {
  const diallerAddress = new NodeAddress('bp', HOST, await freePort(), 'run-a');
  const acceptorAddress = new NodeAddress('bp', HOST, await freePort(), 'run-b');
  const diallerLog = new RecordingLogger();
  const acceptorLog = new RecordingLogger();
  const dialler = new TcpTransport(diallerAddress, diallerLog, { outboundQueueSize });
  const acceptor = new TcpTransport(acceptorAddress, acceptorLog, { outboundQueueSize });
  transports.push(dialler, acceptor);
  const received: Received[] = [];
  dialler.setHandler((_from, message) => {
    const payload = (message as { payload?: { seq?: number; filler?: string } }).payload;
    if (typeof payload?.seq !== 'number') return;
    received.push({ seq: payload.seq, intact: payload.filler === filler(payload.seq) });
  });
  await dialler.start();
  await acceptor.start();
  dialler.send(acceptorAddress, envelope(-1));
  await awaitCondition(() => acceptor.peers().some((peer) => peer.equals(diallerAddress)), {
    timeoutMs: 5_000, intervalMs: 10, label: 'the acceptor holds the dialler as a peer',
  });
  return { dialler, acceptor, diallerAddress, received, acceptorLog, diallerLog };
}

describe('TcpTransport under back-pressure on real sockets (#931)', () => {
  test('a burst far past the socket buffers arrives whole and in order', async () => {
    const count = 5_000;
    const { acceptor, diallerAddress, received, diallerLog } = await connectedPair(count);

    for (let seq = 0; seq < count; seq++) acceptor.send(diallerAddress, envelope(seq));

    await awaitCondition(() => received.length === count, {
      timeoutMs: 20_000, intervalMs: 20, label: `all ${count} frames arrived`,
    });
    expect(received.map((frame) => frame.seq)).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(received.every((frame) => frame.intact)).toBe(true);
    expect(diallerLog.records.filter((record) => record.message.startsWith('frame-decoder error'))).toEqual([]);
  }, 30_000);

  test('past the bound frames are dropped whole, and the connection survives', async () => {
    const count = 20_000;
    const { acceptor, diallerAddress, received, acceptorLog, diallerLog } = await connectedPair(100);

    for (let seq = 0; seq < count; seq++) acceptor.send(diallerAddress, envelope(seq));

    // Wait for the drain to report the episode, then prove the link still works.
    await awaitCondition(
      () => acceptorLog.records.some((record) => record.message.includes('drained;')),
      { timeoutMs: 20_000, intervalMs: 20, label: 'the send buffer drained' },
    );
    acceptor.send(diallerAddress, envelope(count));
    await awaitCondition(() => received.at(-1)?.seq === count, {
      timeoutMs: 10_000, intervalMs: 20, label: 'a frame sent after the drain arrived',
    });

    const sequences = received.map((frame) => frame.seq);
    expect(sequences.length).toBeLessThan(count);
    expect(sequences.every((seq, i) => i === 0 || seq > sequences[i - 1]!)).toBe(true);
    expect(received.every((frame) => frame.intact)).toBe(true);
    expect(diallerLog.records.filter((record) => record.message.startsWith('frame-decoder error'))).toEqual([]);
    expect(acceptorLog.records.filter((record) => record.message.startsWith('send buffer for'))).toHaveLength(2);
  }, 40_000);
});
