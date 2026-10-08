/**
 * A socket refused at the inbound cap stays refused.
 *
 * The refusal used to half-close the socket with `end()` and forget it.  A
 * half-close leaves the peer's half open, so a peer that never answers keeps
 * the socket for as long as it likes, and on Node a half-closed socket goes on
 * delivering what the peer sends.  Forgotten, every such chunk reached
 * `onData` as a stranger's first bytes and ran through `acceptInbound` again —
 * and the first chunk to arrive after a slot freed was *adopted*, its fresh
 * decoder starting in the middle of whatever frame the peer was sending.  The
 * same shape #1476 closed for a dropped dial, on the one path it left open.
 *
 * The private socket callbacks are driven with fake sockets, as the other
 * transport guard suites do: the defect lives in those callbacks, and a real
 * listener would only add a port to collide on.
 */
import { describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';

/** A socket that records what was written to it and how it was closed. */
type RecordingSocket = {
  readonly writes: Uint8Array[];
  ended: boolean;
  destroyed: boolean;
  write(data: Uint8Array): void;
  end(): void;
  destroy(): void;
};

function recordingSocket(): RecordingSocket {
  return {
    writes: [],
    ended: false,
    destroyed: false,
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void { this.ended = true; },
    destroy(): void { this.destroyed = true; },
  };
}

/** The private socket callbacks and the counter these tests reach through. */
type TransportInternals = {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
  onClose(socket: unknown): void;
  readonly inboundConnections: number;
  readonly byPeer: Map<string, unknown>;
};

function internals(transport: TcpTransport): TransportInternals {
  return transport as unknown as TransportInternals;
}

/** A transport with room for exactly one inbound connection, and that one taken. */
function saturated(): { transport: TcpTransport; admitted: RecordingSocket } {
  const transport = new TcpTransport(
    new NodeAddress('inbound-cap', '127.0.0.1', 19_601),
    new NoopLogger(),
    { maxInboundConnections: 1 },
  );
  const admitted = recordingSocket();
  internals(transport).attachInbound(admitted);
  expect(internals(transport).inboundConnections).toBe(1);
  return { transport, admitted };
}

const hello = encodeFrame({
  kind: 'hello',
  self: new NodeAddress('refused-peer', '10.0.0.21', 2_552).toJSON(),
});

describe('a socket refused at the inbound cap stays refused', () => {
  test('the refused socket is aborted, not half-closed', () => {
    const { transport } = saturated();
    const refused = recordingSocket();

    internals(transport).attachInbound(refused);

    expect({ destroyed: refused.destroyed, ended: refused.ended }).toEqual({ destroyed: true, ended: false });
    expect(internals(transport).inboundConnections).toBe(1);
  });

  test('exploit: a refused peer that keeps sending is not adopted once a slot frees', () => {
    // Whole frames, so the adoption is visible.  Split across the refusal, a
    // frame is worse but quieter: the adopted socket's fresh decoder reads the
    // middle of a frame as a length prefix, and usually throws the connection
    // away again on the spot — which hides that it was ever adopted.
    const { transport, admitted } = saturated();
    const refused = recordingSocket();
    internals(transport).attachInbound(refused);
    internals(transport).onData(refused, hello);       // sent while refused

    internals(transport).onClose(admitted);
    expect(internals(transport).inboundConnections).toBe(0);
    internals(transport).onData(refused, hello);       // sent after the slot freed

    expect(internals(transport).inboundConnections).toBe(0);
    expect(refused.writes).toEqual([]);     // no hello-ack: nothing was handshaken
    expect(internals(transport).byPeer.size).toBe(0);
  });

  test('a refused socket\'s close gives back nothing it never held', () => {
    // The refused socket never took a slot, so its close must not hand one
    // back — a counter that drifts below the truth quietly raises the cap.
    const { transport } = saturated();
    const refused = recordingSocket();
    internals(transport).attachInbound(refused);

    internals(transport).onClose(refused);

    expect(internals(transport).inboundConnections).toBe(1);
  });
});
