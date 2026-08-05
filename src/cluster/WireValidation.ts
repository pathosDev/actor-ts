import { isMemberStatus, type MemberData, type WireMessage } from './Protocol.js';
import type { NodeAddressData } from './NodeAddress.js';

/**
 * Runtime shape checks for frames arriving off the cluster wire.
 *
 * `FrameDecoder.push` ends in `JSON.parse(json) as WireMessage` — a cast, not a
 * check.  Everything downstream then reads the frame as if the type were true:
 * `TcpTransport.onMessage` dereferences `message.kind`, `Cluster.handleWire`
 * matches on it, and the per-kind handlers pull `from` / `node` / `members`
 * straight out.  A peer that sends `null`, a bare string, or an object missing
 * the field a handler reads produces a `TypeError` deep inside a socket
 * callback (#705, #711) — and for one particular field, an unvalidated
 * `MemberStatus`, a poisoned member was stored *before* the throw and then
 * re-gossiped to the rest of the cluster (#563).
 *
 * These guards run once, at the decode boundary, so no handler has to repeat
 * them and none of them can be forgotten.
 *
 * **Unknown kinds pass deliberately.** Extensions register their own frame
 * kinds through `Cluster._onWire` (sharding, pub-sub, receptionist,
 * DistributedData, DevTools) and their payloads are not part of
 * {@link WireMessage}.  Rejecting what this module does not recognise would
 * break every one of them, so an unknown `kind` is forwarded and the extension
 * validates its own payload.  What is enforced for *every* frame is the floor
 * the dispatch machinery itself relies on: a non-null object carrying a string
 * `kind`.
 */

/** The floor every frame must clear before anything may read it. */
export function isWireFrame(value: unknown): value is { kind: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { kind?: unknown }).kind === 'string';
}

/** A `NodeAddressData` whose fields are actually the declared types. */
export function isNodeAddressData(value: unknown): value is NodeAddressData {
  if (typeof value !== 'object' || value === null) return false;
  const { systemName, host, port } = value as Partial<NodeAddressData>;
  return typeof systemName === 'string' && systemName.length > 0
    && typeof host === 'string' && host.length > 0
    && isPort(port);
}

/**
 * A gossiped member entry.  `status` is checked against the runtime allow-list
 * rather than trusted (#563); `version` and `removedAt` only need to be finite
 * here — `Cluster.mergeMember` applies the plausibility bounds that decide
 * whether a *well-formed* value is also believable.
 */
export function isMemberData(value: unknown): value is MemberData {
  if (typeof value !== 'object' || value === null) return false;
  const { address, status, version, roles, removedAt } = value as Partial<MemberData>;
  return isNodeAddressData(address)
    && isMemberStatus(status)
    && typeof version === 'number' && Number.isFinite(version)
    && (roles === undefined || isStringArray(roles))
    && (removedAt === undefined || (typeof removedAt === 'number' && Number.isFinite(removedAt)));
}

/**
 * Validate a frame against the variant its `kind` claims.
 *
 * Returns `null` when the frame is well-formed — either a known kind that
 * checks out, or an unknown kind bound for an extension handler.  Otherwise
 * returns the reason, for the caller to log.  A reason rather than a bare
 * `false` because the alternative is an operator staring at "dropped a frame"
 * with no way to tell a hostile peer from a version mismatch.
 */
export function wireFrameProblem(frame: { kind: string }): string | null {
  switch (frame.kind) {
    case 'hello':
    case 'hello-ack':
      return isNodeAddressData((frame as { self?: unknown }).self)
        ? null : '`self` is not a valid node address';

    case 'heartbeat':
    case 'heartbeat-ack': {
      const { from, seq } = frame as { from?: unknown; seq?: unknown };
      if (!isNodeAddressData(from)) return '`from` is not a valid node address';
      return typeof seq === 'number' && Number.isFinite(seq) ? null : '`seq` is not a finite number';
    }

    case 'gossip': {
      const { from, members } = frame as { from?: unknown; members?: unknown };
      if (!isNodeAddressData(from)) return '`from` is not a valid node address';
      if (!Array.isArray(members)) return '`members` is not an array';
      const bad = members.findIndex((m) => !isMemberData(m));
      return bad < 0 ? null : `member[${bad}] is malformed (address, status or version)`;
    }

    case 'envelope': {
      const { to, from } = frame as { to?: unknown; from?: unknown };
      if (typeof to !== 'string' || to.length === 0) return '`to` is not a non-empty path string';
      return from === null || typeof from === 'string' ? null : '`from` is neither a path string nor null';
    }

    case 'shard-map': {
      const { type, shards, version } = frame as { type?: unknown; shards?: unknown; version?: unknown };
      if (typeof type !== 'string' || type.length === 0) return '`type` is not a non-empty string';
      if (typeof version !== 'number' || !Number.isFinite(version)) return '`version` is not a finite number';
      if (typeof shards !== 'object' || shards === null) return '`shards` is not an object';
      const badShard = Object.entries(shards as Record<string, unknown>)
        .find(([, address]) => !isNodeAddressData(address));
      return badShard === undefined ? null : `shard ${badShard[0]} maps to an invalid node address`;
    }

    case 'leave':
      return isNodeAddressData((frame as { node?: unknown }).node)
        ? null : '`node` is not a valid node address';

    // An extension's frame kind — see the module note.
    default:
      return null;
  }
}

/**
 * The two checks together, for callers that only need a yes/no plus a reason.
 * `frame` is narrowed to {@link WireMessage} on success, which is the cast that
 * `FrameDecoder` used to make unconditionally.
 */
export function validateWireFrame(value: unknown): { message: WireMessage } | { problem: string } {
  if (!isWireFrame(value)) return { problem: 'frame is not an object with a string `kind`' };
  const problem = wireFrameProblem(value);
  return problem === null ? { message: value as unknown as WireMessage } : { problem };
}

/* ------------------------------- internals ------------------------------- */

/**
 * A positive integer, deliberately *not* the TCP range — see
 * `NodeAddress.fromJSON` and `ClusterOptionsValidator`, which state the same
 * rule: under `InMemoryTransport` the port is a synthetic node discriminator,
 * so capping at 65535 here would reject addresses the framework itself mints.
 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
