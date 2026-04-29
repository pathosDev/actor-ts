import { NodeAddress, type NodeAddressData } from './NodeAddress.js';

/**
 * Lifecycle state of a cluster member.
 *   - `joining`    — announced itself, not yet part of the active set.
 *   - `weakly-up`  — reachable and has been waiting for leader convergence
 *     for a while; allowed to route traffic but isn't yet part of the
 *     leader-elected active set.  Transitioned to `up` on convergence.
 *   - `up`         — active member, receives and routes work.
 *   - `unreachable`— heartbeats missing; may recover.
 *   - `leaving`    — graceful shutdown in progress.
 *   - `down`       — declared dead, pending removal.
 *   - `removed`    — completely gone from the cluster view.
 */
export type MemberStatus =
  | 'joining'
  | 'weakly-up'
  | 'up'
  | 'unreachable'
  | 'leaving'
  | 'down'
  | 'removed';

export interface MemberData {
  readonly address: NodeAddressData;
  readonly status: MemberStatus;
  /** Monotonic version clock; higher value wins during gossip merges. */
  readonly version: number;
  /** Arbitrary role tags used to filter placement (e.g. "backend"). */
  readonly roles?: string[];
}

/**
 * Every wire message carries a discriminator `t`.  Payload types that contain
 * user messages use `body` which is assumed to be JSON-safe.
 */
export type WireMessage =
  | HelloMsg
  | HelloAckMsg
  | HeartbeatMsg
  | HeartbeatAckMsg
  | GossipMsg
  | EnvelopeMsg
  | ShardMapMsg
  | LeaveMsg;

export interface HelloMsg {
  t: 'hello';
  self: NodeAddressData;
}

export interface HelloAckMsg {
  t: 'hello-ack';
  self: NodeAddressData;
}

export interface HeartbeatMsg {
  t: 'heartbeat';
  from: NodeAddressData;
  seq: number;
  ts: number;
}

export interface HeartbeatAckMsg {
  t: 'heartbeat-ack';
  from: NodeAddressData;
  seq: number;
}

export interface GossipMsg {
  t: 'gossip';
  from: NodeAddressData;
  members: MemberData[];
}

export interface EnvelopeMsg {
  t: 'envelope';
  /** Full actor path string of the recipient on the target node. */
  to: string;
  /** Full actor path string of the sender, or null. */
  from: string | null;
  /** JSON-safe payload. */
  body: unknown;
  /** Optional: name of a class/type for richer routing. */
  tag?: string;
  /**
   * Optional MDC snapshot captured at tell-time on the originating
   * node.  Re-installed by `Cluster.handleEnvelope` so the receiving
   * actor's log lines carry the same context as the sender's
   * (#53 — cross-node MDC).
   */
  context?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Optional W3C trace context — the `traceparent` value carrying
   * the originating node's active span.  The receiving cluster
   * decodes it and links the new actor.receive span to that parent
   * (#10 — cross-node distributed tracing).
   */
  trace?: { readonly traceparent: string; readonly tracestate?: string };
}

export interface ShardMapMsg {
  t: 'shard-map';
  type: string;
  shards: Record<number, NodeAddressData>;
  version: number;
}

export interface LeaveMsg {
  t: 'leave';
  node: NodeAddressData;
}

/* -------------------------------- Framing -------------------------------- */

const HEADER_SIZE = 4;

/** Encode a WireMessage as a length-prefixed JSON frame. */
export function encodeFrame(msg: WireMessage): Uint8Array {
  const json = JSON.stringify(msg);
  const payload = new TextEncoder().encode(json);
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.byteLength, false); // big-endian
  frame.set(payload, HEADER_SIZE);
  return frame;
}

/**
 * Incremental decoder that buffers bytes across multiple chunks and yields
 * whole frames.  TCP gives no message boundaries — the caller feeds bytes as
 * they arrive and collects whatever frames completed.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): WireMessage[] {
    this.buffer = concat(this.buffer, chunk);
    const out: WireMessage[] = [];
    const decoder = new TextDecoder();
    while (this.buffer.byteLength >= HEADER_SIZE) {
      const len = new DataView(
        this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength,
      ).getUint32(0, false);
      if (this.buffer.byteLength < HEADER_SIZE + len) break;
      const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + len);
      const json = decoder.decode(payload);
      this.buffer = this.buffer.subarray(HEADER_SIZE + len);
      try {
        out.push(JSON.parse(json) as WireMessage);
      } catch (e) {
        throw new Error(`Invalid wire frame JSON: ${(e as Error).message}`);
      }
    }
    return out;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export const Protocol = {
  encodeFrame,
  NodeAddress: {
    toData: (a: NodeAddress): NodeAddressData => a.toJSON(),
    fromData: (d: NodeAddressData): NodeAddress => NodeAddress.fromJSON(d),
  },
};
