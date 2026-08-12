import { INITIAL_FRAME_BUFFER_BYTES, RETAINED_FRAME_BUFFER_BYTES } from './Constants.js';
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
export const MEMBER_STATUSES = [
  'joining',
  'weakly-up',
  'up',
  'unreachable',
  'leaving',
  'down',
  'removed',
] as const;

/**
 * The type is *derived* from {@link MEMBER_STATUSES} rather than declared
 * alongside it.  A status arrives off the wire as an arbitrary string, so the
 * runtime needs a list to check it against — and a hand-maintained second copy
 * of the same seven names is exactly the kind of thing that drifts.  Here a new
 * status cannot be added to one without the other.
 *
 * Why it needs checking at all: `Cluster.emitStatusTransition` dispatches on
 * this value with `match(...).exhaustive()`, which throws for anything outside
 * the union — and it runs *after* the member has been written to the map, so an
 * unchecked status both crashed the node and was re-gossiped to its peers
 * (#563).
 */
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Whether an arbitrary value is one of the seven legal member statuses. */
export function isMemberStatus(value: unknown): value is MemberStatus {
  return typeof value === 'string'
    && (MEMBER_STATUSES as readonly string[]).includes(value);
}

export type MemberData = {
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
};

/**
 * Every wire message carries a discriminator `kind`.  Payload types that contain
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

export type HelloMessage = {
  kind: 'hello';
  self: NodeAddressData;
};

export type HelloAcknowledgmentMessage = {
  kind: 'hello-ack';
  self: NodeAddressData;
};

export type HeartbeatMessage = {
  kind: 'heartbeat';
  from: NodeAddressData;
  seq: number;
  ts: number;
};

export type HeartbeatAcknowledgmentMessage = {
  kind: 'heartbeat-ack';
  from: NodeAddressData;
  seq: number;
};

export type GossipMessage = {
  kind: 'gossip';
  from: NodeAddressData;
  /**
   * Strictly-increasing counter stamped by the node that composed the frame,
   * seeded from its wall-clock at startup and bumped by one per frame (#112).
   *
   * It exists so a receiver can tell a *new* frame from a **recording of an
   * old one**.  Nothing else on a gossip frame can: `members` is a snapshot
   * whose versions are per-member and only move when a status changes, so a
   * captured frame stays byte-for-byte valid indefinitely — and is accepted
   * again the moment the receiver has dropped one of the entries it names,
   * because the merge path's no-existing-entry branch has no lower bound to
   * hold it to.
   *
   * Required, not optional: an optional field whose absence skips the check is
   * bypassed by stripping it.
   */
  sequence: number;
  members: MemberData[];
};

export type EnvelopeMessage = {
  kind: 'envelope';
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
};

export type ShardMapMessage = {
  kind: 'shard-map';
  type: string;
  shards: Record<number, NodeAddressData>;
  version: number;
};

export type LeaveMessage = {
  kind: 'leave';
  node: NodeAddressData;
};

/* -------------------------------- Framing -------------------------------- */

const HEADER_SIZE = 4;

/** Encode a WireMessage as a length-prefixed JSON frame. */
export function encodeFrame(message: WireMessage): Uint8Array {
  const json = JSON.stringify(message);
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
 *
 * **Decode cost (security, #588):** the accumulator is a slab plus a read
 * cursor, not a `Uint8Array` rebuilt per chunk.  It used to be the latter —
 * `buffer = concat(buffer, chunk)` — which copies everything received so far
 * on *every* arriving chunk, so the work to assemble one frame was quadratic
 * in the number of chunks it was split into.  The peer chooses that split:
 * feeding a 16 MiB frame in ~1400-byte TCP-sized writes is ~12 000 chunks and
 * ≈ 100 GB of memcpy, an amplification of roughly 6000× on bytes the attacker
 * never had to send — and reachable before the `hello` gate, so no membership
 * was required.  Appending into a slab copies each byte once on arrival, which
 * makes the cost linear and the amplification 1×.
 */
export class FrameDecoder {
  /**
   * Bytes received and not yet decoded live in `slab[readOffset, writeOffset)`.
   * The two cursors are what remove the copy: a decoded frame advances
   * `readOffset` instead of reallocating, and the space it leaves is reclaimed
   * by the next compaction rather than by a fresh allocation.
   */
  private slab: Uint8Array = new Uint8Array(0);
  private readOffset = 0;
  private writeOffset = 0;
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isFinite(maxFrameBytes) || maxFrameBytes < 1) {
      throw new Error(`FrameDecoder: maxFrameBytes must be a positive integer, got ${maxFrameBytes}`);
    }
    this.maxFrameBytes = Math.trunc(maxFrameBytes);
  }

  /**
   * Bytes of a frame this decoder is still holding — zero when the buffer has
   * drained exactly on a frame boundary.
   *
   * Exposed for the transport's stall deadline: "is a frame half-received?" is
   * the question that decides whether a silent socket is a peer between frames
   * (fine, that is most of them) or one holding memory it never intends to
   * complete (#588).
   */
  pendingBytes(): number {
    return this.writeOffset - this.readOffset;
  }

  push(chunk: Uint8Array): WireMessage[] {
    this.append(chunk);
    const out: WireMessage[] = [];
    const decoder = new TextDecoder();
    while (this.pendingBytes() >= HEADER_SIZE) {
      const length = new DataView(
        this.slab.buffer, this.slab.byteOffset + this.readOffset, HEADER_SIZE,
      ).getUint32(0, false);
      if (length > this.maxFrameBytes) {
        // Reject BEFORE buffering — the attacker can't force an OOM
        // by claiming a 4 GiB frame.  Throwing here triggers
        // connection-shutdown in the transport layer.
        throw new Error(
          `wire frame claims length ${length} > maxFrameBytes ${this.maxFrameBytes} — `
          + `connection terminated to prevent OOM/DoS`,
        );
      }
      if (this.pendingBytes() < HEADER_SIZE + length) break;
      const payloadStart = this.readOffset + HEADER_SIZE;
      const json = decoder.decode(this.slab.subarray(payloadStart, payloadStart + length));
      this.readOffset = payloadStart + length;
      try {
        out.push(JSON.parse(json) as WireMessage);
      } catch (e) {
        throw new Error(`Invalid wire frame JSON: ${(e as Error).message}`);
      }
    }
    this.reclaim();
    return out;
  }

  /* --------------------------- buffer management --------------------------- */

  private append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.makeRoomFor(chunk.byteLength);
    this.slab.set(chunk, this.writeOffset);
    this.writeOffset += chunk.byteLength;
  }

  /**
   * Make `extra` bytes fit after {@link writeOffset}, compacting in place when
   * the slab is merely fragmented and growing only when it is genuinely too
   * small.
   *
   * **Sized from what arrived, never from what was claimed.**  Allocating
   * `HEADER_SIZE + length` the moment a header is read would be the obvious
   * pre-sizing, and it re-opens the vector the frame cap closed: a peer claims
   * just under the cap, sends no payload at all, and holds 16 MiB per
   * connection for free.  Doubling off received bytes gives the same amortised
   * cost with the resident size still bounded by what the peer actually paid
   * to send.
   */
  private makeRoomFor(extra: number): void {
    if (this.writeOffset + extra <= this.slab.byteLength) return;
    const pending = this.pendingBytes();
    const needed = pending + extra;
    if (needed <= this.slab.byteLength) {
      // The slab is big enough — the free space is just at the wrong end.
      this.slab.copyWithin(0, this.readOffset, this.writeOffset);
    } else {
      let capacity = Math.max(this.slab.byteLength, INITIAL_FRAME_BUFFER_BYTES);
      while (capacity < needed) capacity *= 2;
      // Doubling amortises many small growths, but rounding a slab that is
      // already frame-sized up to the next power of two would double the
      // per-connection ceiling this decoder exists to bound — so above one
      // whole frame the slab is sized to fit, not to the next step.
      const ceiling = Math.max(needed, HEADER_SIZE + this.maxFrameBytes);
      this.slab = replaceSlab(this.slab, this.readOffset, this.writeOffset, Math.min(capacity, ceiling));
    }
    this.readOffset = 0;
    this.writeOffset = pending;
  }

  /**
   * Hand a large slab back once the buffer has drained.
   *
   * A slab is as large as the biggest frame it ever had to hold, so without
   * this one oversized envelope pins that much memory per connection until the
   * peer disconnects.  Ordinary traffic never trips it: the buffer settles at
   * {@link INITIAL_FRAME_BUFFER_BYTES}, well under the retention bound, and is
   * reused for the life of the connection.
   */
  private reclaim(): void {
    if (this.readOffset !== this.writeOffset) return;
    this.readOffset = 0;
    this.writeOffset = 0;
    if (this.slab.byteLength > RETAINED_FRAME_BUFFER_BYTES) this.slab = new Uint8Array(0);
  }
}

/** Move `[start, end)` of `slab` into a fresh buffer of `capacity` bytes. */
function replaceSlab(slab: Uint8Array, start: number, end: number, capacity: number): Uint8Array {
  const grown = new Uint8Array(capacity);
  grown.set(slab.subarray(start, end), 0);
  return grown;
}

export const Protocol = {
  encodeFrame,
  NodeAddress: {
    toData: (a: NodeAddress): NodeAddressData => a.toJSON(),
    fromData: (d: NodeAddressData): NodeAddress => NodeAddress.fromJSON(d),
  },
};
