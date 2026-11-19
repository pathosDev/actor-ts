import { parsePathSegments } from '../ActorPath.js';
import { ActorRef, AskResponseRef, Nobody, NobodyRef } from '../ActorRef.js';
import { BidirectionalMap } from '../util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../util/BidirectionalMultiMap.js';
import { NodeAddress } from './NodeAddress.js';
import { RemoteActorRef } from './RemoteActorRef.js';
import type { Cluster } from './Cluster.js';

/**
 * Wire representation of an `ActorRef` — a plain JSON-safe object that
 * round-trips through `JSON.stringify` / `JSON.parse` and can be rebuilt
 * into a real ref on the receiving node.
 *
 * Refs for `Nobody` (the no-op ref) are encoded with `path: 'nobody'` and
 * no address fields.  All other refs carry the full owning-node address so
 * the receiver knows where to dial back.
 */
export type WireActorRef = {
  readonly $ref: 'actor';
  readonly path: string;
  readonly host?: string;
  readonly port?: number;
  readonly system?: string;
};

const WIRE_REF_TAG = 'actor' as const;

export function isWireActorRef(v: unknown): v is WireActorRef {
  return typeof v === 'object' && v !== null
    && (v as { $ref?: unknown }).$ref === WIRE_REF_TAG
    && typeof (v as { path?: unknown }).path === 'string';
}

/**
 * Recursively walk a user message value and replace every `ActorRef`
 * instance with a `WireActorRef` marker.  Local refs (including the
 * short-lived ask-response ref and `DeadLetterRef`) are stamped with
 * `cluster.selfAddress` so the receiver can reconstruct a `RemoteActorRef`
 * pointing back here.  Remote refs carry their existing target node.
 * `Nobody` becomes a sentinel marker.
 *
 * Takes the whole `Cluster` rather than just the address — symmetric with
 * {@link decodeRefs}, and because encoding an ask-response ref is also the
 * moment it has to become addressable from the other side (see
 * {@link registerAskResponseRef}).
 *
 * Non-ref values pass through untouched — this walker only rewrites refs.
 */
export function encodeRefs(value: unknown, cluster: Cluster): unknown {
  return walk(value, (ref) => encodeSingleRef(ref, cluster), new WeakSet());
}

/**
 * Recursively walk a parsed wire value and replace every `WireActorRef`
 * marker with a live `ActorRef` — a local resolution if the marker points
 * at this cluster's own `selfAddress`, a `RemoteActorRef` otherwise.
 * Missing or malformed markers fall back to `Nobody`, and so does a marker
 * naming a path on this node that no peer may address by name (#1572).
 *
 * `from` is the connection's peer — the party that wrote the body.  A refused
 * marker is reported against it through `EnvelopeTrust`, under
 * `frame="ref"`.  An in-process caller with no peer to blame may leave it out:
 * the marker still decodes to `Nobody`, it is only not counted.
 */
export function decodeRefs(value: unknown, cluster: Cluster, from?: NodeAddress): unknown {
  return walkDecode(value, { cluster, from: from ?? null }, new WeakSet());
}

/** What the decode walk carries down to every marker it meets. */
type DecodeContext = {
  readonly cluster: Cluster;
  /** The peer the body came from, or `null` for an in-process caller. */
  readonly from: NodeAddress | null;
};

/* ------------------------------ internals -------------------------------- */

function encodeSingleRef(ref: ActorRef, cluster: Cluster): WireActorRef {
  if (ref instanceof NobodyRef) {
    return { $ref: WIRE_REF_TAG, path: 'nobody' };
  }
  if (ref instanceof RemoteActorRef) {
    return {
      $ref: WIRE_REF_TAG,
      path: ref.targetPath,
      host: ref.targetNode.host,
      port: ref.targetNode.port,
      system: ref.targetNode.systemName,
    };
  }
  if (ref instanceof AskResponseRef) {
    registerAskResponseRef(ref, cluster);
  }
  // Local refs (LocalActorRef / ask-response ref / DeadLetterRef) — tag
  // with our own address so the other side can send back to us.
  const fromAddress = cluster.selfAddress;
  return {
    $ref: WIRE_REF_TAG,
    path: ref.path.toString(),
    host: fromAddress.host,
    port: fromAddress.port,
    system: fromAddress.systemName,
  };
}

/**
 * Make a one-shot ask-response ref reachable from another node, for as long as
 * the ask is outstanding.
 *
 * An ask ref is not an actor: nothing spawned it, so `_resolvePath` cannot find
 * it and an inbound reply would fall through to the catch-all and be dropped
 * (#517).  Registering it as a per-path envelope handler puts it in the one
 * lookup `dispatchEnvelope` consults *before* it tries the actor tree.
 *
 * Done here, at encode time, rather than in `ask` itself: this is the point at
 * which the ref is known to be leaving the node, so a purely local ask — the
 * overwhelmingly common case — pays nothing and stays off the map entirely.
 *
 * Registration is keyed by path, so encoding the same ref onto envelopes for
 * several nodes is idempotent; the teardown on settle likewise runs at most
 * once per key.
 */
function registerAskResponseRef(ref: AskResponseRef, cluster: Cluster): void {
  const unregister = cluster._registerEnvelopeHandler(
    ref.path.toString(),
    (envelope) => ref.tell(envelope.body),
  );
  ref._onSettled(unregister);
}

/**
 * Rebuild the ref a marker describes, or `Nobody` for one that names no
 * valid node.
 *
 * The address is a claim of the sender's, so it goes through
 * {@link NodeAddress.fromJSON} — the validation every other wire address gets —
 * rather than the raw constructor (#936).  A marker that does not validate is
 * not an error worth failing the whole envelope over: the rest of the body may
 * be fine, and `Nobody` is what an unusable ref already decodes to.
 *
 * Validating the shape does not make the address safe to *dial*.  The ref is
 * built lazily and the decision is taken where it is used, in
 * `Cluster._sendEnvelope` / `_sendWire`: a ref to a member this node learns of
 * a moment later stays usable, and one to a node that never becomes a member
 * is never dialled.
 */
function decodeSingleRef(wire: WireActorRef, context: DecodeContext): ActorRef {
  if (wire.path === 'nobody') return Nobody;
  const targetNode = addressOf(wire);
  if (targetNode === null) return Nobody;
  const { cluster } = context;
  const self = cluster.selfAddress;
  if (wire.host === self.host && wire.port === self.port && wire.system === self.systemName) {
    return resolveSameNodeMarker(wire.path, context);
  }
  return new RemoteActorRef(targetNode, wire.path, cluster);
}

/**
 * The local ref a same-node marker names — or `Nobody`, when the path names
 * nothing a peer may address by name.
 *
 * A marker in a body is a path a remote party chose, exactly like an
 * envelope's `to`, and it gets the same two guards `dispatchEnvelope` and
 * `RemoteWatcher` apply to theirs (#1572).  Without them the decoder was the
 * one reader of a wire path with no trust decision in it:
 *
 * - **An empty segment list is `Nobody`.**  `parsePathSegments` answers `[]`
 *   for anything that is not a full `actor-ts://…` URI — a bare `/user/x`,
 *   garbage, an empty string — and `_resolvePath([])` answers the root
 *   guardian, which is right for its in-process callers and never a wire
 *   endpoint.
 * - **`EnvelopeTrust.refusalFor` is asked before the tree walk**, so `/system`
 *   is refused in every configuration and an `untrusted-mode` allow-list
 *   narrows `/user` here as it does for an envelope — and, as there, the
 *   answer does not depend on whether the actor exists.  A refusal is reported
 *   against the connection's peer, folded with the envelope-level ones and
 *   never carrying the body.
 *
 * Neither guard throws: a throw inside the wire handler drops the peer's
 * connection (#563), and one bad field should cost that field, not the rest
 * of the body.  Actors that no longer exist likewise fall through to `Nobody`
 * rather than to a dangling `RemoteActorRef` back to this node.
 */
function resolveSameNodeMarker(path: string, context: DecodeContext): ActorRef {
  const segments = parsePathSegments(path);
  if (segments.length === 0) return Nobody;
  const trust = context.cluster._envelopeTrust;
  const refusal = trust.refusalFor(segments);
  if (refusal !== null) {
    if (context.from !== null) trust.report(context.from, 'ref', refusal);
    return Nobody;
  }
  return context.cluster.system._resolvePath(segments).getOrElse(Nobody);
}

/** The marker's node, validated, or `null` when it names none. */
function addressOf(wire: WireActorRef): NodeAddress | null {
  const { system, host, port } = wire;
  if (system === undefined || host === undefined || port === undefined) return null;
  try {
    return NodeAddress.fromJSON({ systemName: system, host, port });
  } catch {
    return null;
  }
}

type RefEncoder = (ref: ActorRef) => WireActorRef;

/**
 * Values both walkers must hand back **by reference** instead of rebuilding.
 *
 * Neither walker exists to transform data — they exist to swap `ActorRef`s for
 * markers and back — but both rebuild every container they pass through, and
 * the generic `Object.entries` tail at the bottom of each is destructive for
 * anything whose data is not own-enumerable.  A `RegExp`, a `URL` and an
 * `Error` all come out of it as `{}`; an `Int32Array` comes out as an
 * index-keyed plain object.  That happened *before* the frame codec ever saw
 * the value, so tagging these types on the wire would have faithfully carried
 * an empty object.
 *
 * None of them can hold an `ActorRef` in a position a walker could reach, so
 * skipping them costs nothing.  The list is deliberately the tagged-as-a-unit
 * half of `JsonTree`'s vocabulary; its container half (`Map`, `Set`,
 * `BidirectionalMap`, `BidirectionalMultiMap`) is walked below instead,
 * because a ref inside one of those is entirely ordinary.
 */
function carriesNoRef(value: object): boolean {
  return value instanceof Date
    || value instanceof RegExp
    || value instanceof URL
    || value instanceof Error
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value);
}

/**
 * Walk one container with `value` on the ancestor path for as long as its own
 * subtree is being walked — and no longer.
 *
 * Both walkers used to add every container to `ancestors` and never take it
 * out again, which is visited-detection rather than cycle-detection: it cannot
 * tell "this object contains itself" from "this object appears twice in the
 * body", so the second occurrence of every shared sub-object crossed the wire
 * as `null` (#946).  Removing it once its subtree is done keeps the set to the
 * current path, so a shared value arrives in every position it held — as two
 * equal copies, which is what a JSON wire can carry — while a genuine cycle is
 * still cut where it closes, at the back-edge, exactly as before.
 *
 * Without a `try`/`finally` on purpose: a throw abandons the whole walk, and
 * the set is the walk's own, built fresh by {@link encodeRefs} or
 * {@link decodeRefs} for every call.
 */
function withAncestor<TValue extends object>(
  value: TValue,
  ancestors: WeakSet<object>,
  walkContainer: (container: TValue) => unknown,
): unknown {
  if (ancestors.has(value)) return null;  // a genuine cycle: cut the back-edge
  ancestors.add(value);
  const out = walkContainer(value);
  ancestors.delete(value);
  return out;
}

function walk(value: unknown, encodeRef: RefEncoder, ancestors: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof ActorRef) return encodeRef(value);
  if (carriesNoRef(value)) return value;
  return withAncestor(value, ancestors, (container) => walkContainer(container, encodeRef, ancestors));
}

function walkContainer(value: object, encodeRef: RefEncoder, ancestors: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, encodeRef, ancestors));
  }

  if (value instanceof BidirectionalMap) {
    return new BidirectionalMap(
      Array.from(value.entries(), ([k, v]) => [k, walk(v, encodeRef, ancestors)] as [unknown, unknown]),
    );
  }
  if (value instanceof BidirectionalMultiMap) {
    const out = new BidirectionalMultiMap<unknown, unknown>();
    for (const left of value.lefts()) {
      for (const right of value.get(left)) out.add(left, walk(right, encodeRef, ancestors));
    }
    return out;
  }
  if (value instanceof Map) {
    // Values only: a ref used as a Map *key* would have to be rewritten
    // without changing the key's identity, which no rebuild can promise.
    const out = new Map();
    for (const [k, v] of value.entries()) out.set(k, walk(v, encodeRef, ancestors));
    return out;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value).map((v) => walk(v, encodeRef, ancestors)));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // The mirror of `walkDecode`'s guard.  Any body built by `JSON.parse` can
    // carry an own `"__proto__"` key, and assigned here it ran the prototype
    // setter: the field never reached the frame, and the copy inherited the
    // field's members instead.  Defined, it is a field like any other.
    if (k === '__proto__') {
      Object.defineProperty(out, k, {
        value: walk(v, encodeRef, ancestors), enumerable: true, writable: true, configurable: true,
      });
    } else {
      out[k] = walk(v, encodeRef, ancestors);
    }
  }
  return out;
}

function walkDecode(value: unknown, context: DecodeContext, ancestors: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (isWireActorRef(value)) return decodeSingleRef(value, context);
  if (carriesNoRef(value)) return value;
  return withAncestor(value, ancestors, (container) => walkDecodeContainer(container, context, ancestors));
}

function walkDecodeContainer(value: object, context: DecodeContext, ancestors: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walkDecode(v, context, ancestors));
  }

  // The container branches mirror `walk` exactly.  They were missing here,
  // which made the decode direction the lossier of the two: a `Map` that
  // survived encode, the transport and the frame codec fell through to the
  // `Object.entries` tail on arrival and was delivered as `{}`.
  if (value instanceof BidirectionalMap) {
    return new BidirectionalMap(
      Array.from(value.entries(), ([k, v]) => [k, walkDecode(v, context, ancestors)] as [unknown, unknown]),
    );
  }
  if (value instanceof BidirectionalMultiMap) {
    const out = new BidirectionalMultiMap<unknown, unknown>();
    for (const left of value.lefts()) {
      for (const right of value.get(left)) out.add(left, walkDecode(right, context, ancestors));
    }
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value.entries()) out.set(k, walkDecode(v, context, ancestors));
    return out;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value).map((v) => walkDecode(v, context, ancestors)));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Guard the prototype setter — a hostile envelope carrying a
    // `"__proto__"` key must round-trip as plain data, not mutate the
    // decoded object's prototype (security audit #9).
    if (k === '__proto__') {
      Object.defineProperty(out, k, {
        value: walkDecode(v, context, ancestors), enumerable: true, writable: true, configurable: true,
      });
    } else {
      out[k] = walkDecode(v, context, ancestors);
    }
  }
  return out;
}
