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
 *   - `removed`    — terminal state.  On the **definitive-removal**
 *     paths (`handleLeave`, downing-provider force-down) the entry
 *     is kept in the local members map as a **tombstone** with a
 *     `removedAt` timestamp so stale gossip can't resurrect the
 *     address; the tombstone is reclaimed once `tombstoneTtlMs`
 *     (default 24 h) elapses.  On the **FD-driven** path the entry
 *     is deleted outright so a healed partition can re-discover
 *     the peer.  Public APIs (`getMembers`, `upMembers`,
 *     `reachableMembers`) and `Member.isReachable()` all filter
 *     `removed` out — only direct iteration of the raw map needs
 *     to check the status explicitly.  See #75 + the
 *     {@link MemberRemoved} JSDoc.
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
  /**
   * Wall-clock instant at which the tombstone was created, set only
   * when `status === 'removed'` (#75).  Travels in gossip so every
   * peer prunes the tombstone at roughly the same wall-clock time;
   * absent on non-tombstone members and on tombstones created by
   * older nodes that pre-date this field — see `mergeMember` for
   * the back-compat handling.
   */
  readonly removedAt?: number;
}

/**
 * Every wire message carries a discriminator `t`.  Payload types that contain
 * user messages use `body` which is assumed to be JSON-safe.
 */
export type WireMessage =
  | HelloMessage
  | HelloAcknowledgmentMessage
  | HeartbeatMessage
  | HeartbeatAcknowledgmentMessage
  | GossipMessage
  | EnvelopeMessage
  | ShardMapMessage
  | LeaveMessage;

export interface HelloMessage {
  t: 'hello';
  self: NodeAddressData;
}

export interface HelloAcknowledgmentMessage {
  t: 'hello-ack';
  self: NodeAddressData;
}

export interface HeartbeatMessage {
  t: 'heartbeat';
  from: NodeAddressData;
  seq: number;
  ts: number;
}

export interface HeartbeatAcknowledgmentMessage {
  t: 'heartbeat-ack';
  from: NodeAddressData;
  seq: number;
}

export interface GossipMessage {
  t: 'gossip';
  from: NodeAddressData;
  members: MemberData[];
}

export interface EnvelopeMessage {
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

export interface ShardMapMessage {
  t: 'shard-map';
  type: string;
  shards: Record<number, NodeAddressData>;
  version: number;
}

export interface LeaveMessage {
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
 * Default cap on a single frame's payload size — 16 MiB.  Anything
 * larger is rejected by {@link FrameDecoder} before the buffer grows.
 *
 * **Why this exists (security):** the wire format prefixes each
 * payload with a 4-byte big-endian uint32, so a malicious or
 * malformed peer can claim a 4 GiB length and force the decoder to
 * either buffer up to that size (OOM) or wait indefinitely for the
 * rest of the bytes (DoS).  Capping at a sensible default closes
 * that vector; callers that genuinely send larger frames can raise
 * the cap via the `FrameDecoder` constructor or
 * `TcpTransport`'s options.
 */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Incremental decoder that buffers bytes across multiple chunks and yields
 * whole frames.  TCP gives no message boundaries — the caller feeds bytes as
 * they arrive and collects whatever frames completed.
 *
 * **Frame-size cap (security):** the optional `maxFrameBytes`
 * constructor arg (default {@link DEFAULT_MAX_FRAME_BYTES}) rejects
 * frames whose claimed length-prefix exceeds the cap — before any
 * payload bytes are buffered.  An attacker claiming a 4 GiB frame
 * hits the cap immediately and the decoder throws, so neither OOM
 * nor an indefinite stall is possible.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isFinite(maxFrameBytes) || maxFrameBytes < 1) {
      throw new Error(`FrameDecoder: maxFrameBytes must be a positive integer, got ${maxFrameBytes}`);
    }
    this.maxFrameBytes = Math.trunc(maxFrameBytes);
  }

  push(chunk: Uint8Array): WireMessage[] {
    this.buffer = concat(this.buffer, chunk);
    const out: WireMessage[] = [];
    const decoder = new TextDecoder();
    while (this.buffer.byteLength >= HEADER_SIZE) {
      const len = new DataView(
        this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength,
      ).getUint32(0, false);
      if (len > this.maxFrameBytes) {
        // Reject BEFORE buffering — the attacker can't force an OOM
        // by claiming a 4 GiB frame.  Throwing here triggers
        // connection-shutdown in the transport layer.
        throw new Error(
          `wire frame claims length ${len} > maxFrameBytes ${this.maxFrameBytes} — `
          + `connection terminated to prevent OOM/DoS`,
        );
      }
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
