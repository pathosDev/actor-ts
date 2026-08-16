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
 * Missing or malformed markers fall back to `Nobody`.
 */
export function decodeRefs(value: unknown, cluster: Cluster): unknown {
  return walkDecode(value, cluster, new WeakSet());
}

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

function decodeSingleRef(wire: WireActorRef, cluster: Cluster): ActorRef {
  if (wire.path === 'nobody' || !wire.host || !wire.port || !wire.system) {
    return Nobody;
  }
  const self = cluster.selfAddress;
  // Same node: hand back the local ref.  Actors that no longer exist fall
  // through to Nobody rather than constructing a dangling RemoteActorRef
  // back to ourselves.
  if (wire.host === self.host && wire.port === self.port && wire.system === self.systemName) {
    const segs = parsePathSegments(wire.path);
    return cluster.system._resolvePath(segs).getOrElse(Nobody);
  }
  const targetNode = new NodeAddress(wire.system, wire.host, wire.port);
  return new RemoteActorRef(targetNode, wire.path, cluster);
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

function walk(value: unknown, encodeRef: RefEncoder, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof ActorRef) return encodeRef(value);
  if (carriesNoRef(value)) return value;

  if (seen.has(value as object)) return null;  // break cycles
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, encodeRef, seen));
  }

  if (value instanceof BidirectionalMap) {
    return new BidirectionalMap(
      Array.from(value.entries(), ([k, v]) => [k, walk(v, encodeRef, seen)] as [unknown, unknown]),
    );
  }
  if (value instanceof BidirectionalMultiMap) {
    const out = new BidirectionalMultiMap<unknown, unknown>();
    for (const left of value.lefts()) {
      for (const right of value.get(left)) out.add(left, walk(right, encodeRef, seen));
    }
    return out;
  }
  if (value instanceof Map) {
    // Values only: a ref used as a Map *key* would have to be rewritten
    // without changing the key's identity, which no rebuild can promise.
    const out = new Map();
    for (const [k, v] of value.entries()) out.set(k, walk(v, encodeRef, seen));
    return out;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value).map((v) => walk(v, encodeRef, seen)));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = walk(v, encodeRef, seen);
  }
  return out;
}

function walkDecode(value: unknown, cluster: Cluster, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (isWireActorRef(value)) return decodeSingleRef(value, cluster);
  if (carriesNoRef(value)) return value;

  if (seen.has(value as object)) return null;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walkDecode(v, cluster, seen));
  }

  // The container branches mirror `walk` exactly.  They were missing here,
  // which made the decode direction the lossier of the two: a `Map` that
  // survived encode, the transport and the frame codec fell through to the
  // `Object.entries` tail on arrival and was delivered as `{}`.
  if (value instanceof BidirectionalMap) {
    return new BidirectionalMap(
      Array.from(value.entries(), ([k, v]) => [k, walkDecode(v, cluster, seen)] as [unknown, unknown]),
    );
  }
  if (value instanceof BidirectionalMultiMap) {
    const out = new BidirectionalMultiMap<unknown, unknown>();
    for (const left of value.lefts()) {
      for (const right of value.get(left)) out.add(left, walkDecode(right, cluster, seen));
    }
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value.entries()) out.set(k, walkDecode(v, cluster, seen));
    return out;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value).map((v) => walkDecode(v, cluster, seen)));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Guard the prototype setter — a hostile envelope carrying a
    // `"__proto__"` key must round-trip as plain data, not mutate the
    // decoded object's prototype (security audit #9).
    if (k === '__proto__') {
      Object.defineProperty(out, k, {
        value: walkDecode(v, cluster, seen), enumerable: true, writable: true, configurable: true,
      });
    } else {
      out[k] = walkDecode(v, cluster, seen);
    }
  }
  return out;
}
