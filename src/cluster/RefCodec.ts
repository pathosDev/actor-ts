import { ActorRef, Nobody, NobodyRef } from '../ActorRef.js';
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
export interface WireActorRef {
  readonly $ref: 'actor';
  readonly path: string;
  readonly host?: string;
  readonly port?: number;
  readonly system?: string;
}

const WIRE_REF_TAG = 'actor' as const;

export function isWireActorRef(v: unknown): v is WireActorRef {
  return typeof v === 'object' && v !== null
    && (v as { $ref?: unknown }).$ref === WIRE_REF_TAG
    && typeof (v as { path?: unknown }).path === 'string';
}

/**
 * Recursively walk a user message value and replace every `ActorRef`
 * instance with a `WireActorRef` marker.  Local refs (including
 * `PromiseActorRef` and `DeadLetterRef`) are stamped with `fromAddress`
 * so the receiver can reconstruct a `RemoteActorRef` pointing back here.
 * Remote refs carry their existing target node.  `Nobody` becomes a
 * sentinel marker.
 *
 * Non-ref values pass through untouched — this walker only rewrites refs.
 */
export function encodeRefs(value: unknown, fromAddress: NodeAddress): unknown {
  return walk(value, (ref) => encodeSingleRef(ref, fromAddress), new WeakSet());
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

function encodeSingleRef(ref: ActorRef, fromAddress: NodeAddress): WireActorRef {
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
  // Local refs (LocalActorRef / PromiseActorRef / DeadLetterRef) — tag
  // with our own address so the other side can send back to us.
  return {
    $ref: WIRE_REF_TAG,
    path: ref.path.toString(),
    host: fromAddress.host,
    port: fromAddress.port,
    system: fromAddress.systemName,
  };
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

/** Extract the "user/foo/bar" segments from "actor-ts://system/user/foo/bar". */
export function parsePathSegments(path: string): string[] {
  const match = /^actor-ts:\/\/[^/]+\/?(.*)$/.exec(path);
  if (!match) return [];
  const rest = match[1] ?? '';
  return rest.split('/').filter((s) => s.length > 0);
}

type RefEncoder = (ref: ActorRef) => WireActorRef;

function walk(value: unknown, encodeRef: RefEncoder, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof ActorRef) return encodeRef(value);
  // Types JSON already handles (or silently lossy): leave alone.
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array) return value;

  if (seen.has(value as object)) return null;  // break cycles
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, encodeRef, seen));
  }

  if (value instanceof Map) {
    // Best-effort: walk values (JSON.stringify flattens Maps to {} anyway).
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
  if (value instanceof Date || value instanceof Uint8Array) return value;

  if (seen.has(value as object)) return null;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walkDecode(v, cluster, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = walkDecode(v, cluster, seen);
  }
  return out;
}
