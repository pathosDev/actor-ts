import {
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE_LENGTH,
  MAX_LOGGED_WIRE_KIND_LENGTH,
} from './Constants.js';
import { isMemberStatus, type MemberData, type WireMessage } from './Protocol.js';
import { NodeAddress, type NodeAddressData } from './NodeAddress.js';

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

/**
 * A `NodeAddressData` whose fields are actually the declared types.
 *
 * The single gate for every address-bearing wire field — `hello.self`,
 * `hello-ack.self`, `heartbeat.from`, `heartbeat-ack.from`, `gossip.from`,
 * every `gossip.members[].address` and `leave.node` — which is why an
 * *optional* `incarnation` is checked here rather than required: making it
 * required would refuse all seven at once from any peer that predates the field
 * (#940).  The length bound it is held to is the point of checking it at all;
 * `NodeAddress.isIncarnation` states it, so this guard and
 * `NodeAddress.fromJSON` cannot disagree.
 */
export function isNodeAddressData(value: unknown): value is NodeAddressData {
  if (typeof value !== 'object' || value === null) return false;
  const { systemName, host, port, incarnation } = value as Partial<NodeAddressData>;
  return typeof systemName === 'string' && systemName.length > 0
    && typeof host === 'string' && host.length > 0
    && isPort(port)
    && (incarnation === undefined || NodeAddress.isIncarnation(incarnation));
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
      const { from, sequence, members } = frame as {
        from?: unknown; sequence?: unknown; members?: unknown;
      };
      if (!isNodeAddressData(from)) return '`from` is not a valid node address';
      // Shape only — `Cluster.onGossip` decides whether a well-formed sequence
      // is also *fresh*, and how far ahead of this node's clock it may be.
      if (typeof sequence !== 'number' || !Number.isFinite(sequence)) {
        return '`sequence` is not a finite number';
      }
      if (!Array.isArray(members)) return '`members` is not an array';
      const bad = members.findIndex((m) => !isMemberData(m));
      return bad < 0 ? null : `member[${bad}] is malformed (address, status or version)`;
    }

    case 'envelope': {
      const { to, from } = frame as { to?: unknown; from?: unknown };
      if (typeof to !== 'string' || to.length === 0) return '`to` is not a non-empty path string';
      return from === null || typeof from === 'string' ? null : '`from` is neither a path string nor null';
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

/**
 * Fields `JsonLogger` writes itself.  Its record spreads the MDC **last**, so
 * before this guard a peer that put `msg` or `level` in an envelope's context
 * did not add a field — it replaced the real one, and the forged record was
 * indistinguishable from a genuine one downstream (#573).
 */
const RESERVED_LOG_FIELDS = new Set(['ts', 'level', 'source', 'msg', 'args']);

/**
 * Make a wire-supplied MDC safe to install.
 *
 * `Cluster.onEnvelope` hands `message.context` straight to `LogContext.run`,
 * from where both shipped loggers read it. Two things had to be taken away
 * from the sender: the ability to overwrite a log record's own fields, and the
 * ability to put a line break in a value — `ConsoleLogger` writes one line per
 * record, so a `\n` in a value forges as many additional log lines as the
 * attacker likes, each looking exactly like the real thing. U+2028/U+2029 are
 * included because plenty of log processors split on them too.
 *
 * Offending entries are dropped rather than escaped: an MDC value is
 * diagnostic context, and a sender that puts a newline in one is not doing
 * diagnostics.
 */
export function sanitizeWireLogContext(
  context: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const safe: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(context)) {
    if (kept >= MAX_CONTEXT_KEYS) break;
    if (RESERVED_LOG_FIELDS.has(key) || hasControlCharacters(key)) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
    } else if (typeof value === 'string') {
      if (value.length > MAX_CONTEXT_VALUE_LENGTH || hasControlCharacters(value)) continue;
    } else if (typeof value !== 'boolean') {
      continue;  // objects, arrays, null — not a `LogContextData` value
    }
    safe[key] = value;
    kept += 1;
  }
  return safe;
}

/**
 * Make a wire-supplied frame `kind` safe to put in a log line (#1178).
 *
 * {@link isWireFrame} enforces only "a string", because unknown kinds pass
 * deliberately — see the module note.  So a `kind` reaching a log line is
 * arbitrary text from a peer, and the two things wrong with printing it are
 * the two {@link sanitizeWireLogContext} already names one field to the left:
 * a CR or LF forges as many additional records as the sender likes, and an
 * unbounded length lets one frame write an unbounded line.
 *
 * Escaped rather than dropped, because unlike an MDC value the kind *is* the
 * diagnostic — "which frame did this node not understand" is the whole of the
 * report — and a sender that puts a newline in one has told you something
 * worth seeing in escaped form.
 */
export function sanitizeWireKindForLog(kind: string): string {
  const clipped = kind.length > MAX_LOGGED_WIRE_KIND_LENGTH
    ? `${kind.slice(0, MAX_LOGGED_WIRE_KIND_LENGTH)}…`
    : kind;
  let safe = '';
  for (const character of clipped) {
    const code = character.codePointAt(0)!;
    safe += code <= LAST_C0_CONTROL || code === DELETE || code === NEXT_LINE
      || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : character;
  }
  return safe;
}

/* ------------------------------- internals ------------------------------- */

/**
 * Any C0/C1 control character, plus the Unicode line and paragraph separators.
 *
 * CR and LF are the ones that matter: ConsoleLogger writes one line per record,
 * so a value containing either forges additional log lines that read exactly
 * like genuine ones.  The rest of the control range is in because none of it
 * belongs in a diagnostic value, and U+2028/U+2029 because enough log
 * processors treat them as line breaks too.
 */
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const NEXT_LINE = 0x85;
const DELETE = 0x7f;
const LAST_C0_CONTROL = 0x1f;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= LAST_C0_CONTROL || code === DELETE || code === NEXT_LINE
      || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) return true;
  }
  return false;
}

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
