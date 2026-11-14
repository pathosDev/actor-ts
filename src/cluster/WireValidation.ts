import {
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE_LENGTH,
  MAX_LOGGED_ADDRESS_PART_LENGTH,
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
 * The shape every address-bearing wire field shares.  The handshake fields
 * (`hello.self`, `hello-ack.self`, `hello-refused.self`) are held to this
 * alone; every frame past the handshake is held to {@link isRunAddressData},
 * which additionally requires the incarnation cluster wire v2 carries (#823).
 * The field stays optional *here* so a version-1 `hello` is refused by the
 * transport with a reason instead of dropped as malformed, and so the address
 * shapes that legitimately name no run — a ref in a body, a persisted
 * snapshot — still validate.
 *
 * The two field rules with any substance to them — what a port is and what an
 * incarnation is — are `NodeAddress.isPort` and `NodeAddress.isIncarnation`,
 * spent from here rather than restated.  `NodeAddress.fromJSON` *throws* on
 * what this guard lets through, on the premise that the two agree, and the
 * premise is only worth having if there is one rule to agree on: the port half
 * was written out twice and drifted from what `toString` can actually carry
 * (#1515).
 */
export function isNodeAddressData(value: unknown): value is NodeAddressData {
  if (typeof value !== 'object' || value === null) return false;
  const { systemName, host, port, incarnation } = value as Partial<NodeAddressData>;
  return typeof systemName === 'string' && systemName.length > 0
    && typeof host === 'string' && host.length > 0
    && NodeAddress.isPort(port)
    && (incarnation === undefined || NodeAddress.isIncarnation(incarnation));
}

/**
 * A node address as cluster wire v2 carries it on every frame past the
 * handshake: valid, and naming its incarnation (#823, #940).
 *
 * Kept apart from {@link isNodeAddressData}, which stays lenient: a ref in a
 * message body (`RefCodec`), a persisted coordinator-state snapshot and a seed
 * parsed from configuration legitimately name an address without a run, and a
 * `hello` from a version-1 peer has to get far enough to be refused with a
 * reason rather than dropped as malformed.
 */
export function isRunAddressData(value: unknown): value is NodeAddressData {
  return isNodeAddressData(value) && (value as NodeAddressData).incarnation !== undefined;
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

/** A member entry as cluster wire v2 gossips it: its address names its run (#823). */
function isRunMemberData(value: unknown): value is MemberData {
  return isMemberData(value) && isRunAddressData(value.address);
}

/** An announced wire version: absent, or a safe integer of at least 1. */
function isAnnouncedWireVersion(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1);
}

/** How long a refusal's `reason` may be — a bound on what a peer can make this node log. */
const MAX_HELLO_REFUSAL_REASON_LENGTH = 512;

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
    // Lenient on purpose: a version-1 peer's `hello` names no incarnation and
    // no version, and the transport refuses it with the reason (#823).
    case 'hello':
    case 'hello-ack': {
      const { self, wireVersion, minWireVersion } = frame as {
        self?: unknown; wireVersion?: unknown; minWireVersion?: unknown;
      };
      if (!isNodeAddressData(self)) return '`self` is not a valid node address';
      if (!isAnnouncedWireVersion(wireVersion)) return '`wireVersion` is not a wire version';
      return isAnnouncedWireVersion(minWireVersion) ? null : '`minWireVersion` is not a wire version';
    }

    case 'hello-refused': {
      const { self, wireVersion, minWireVersion, reason } = frame as {
        self?: unknown; wireVersion?: unknown; minWireVersion?: unknown; reason?: unknown;
      };
      if (!isNodeAddressData(self)) return '`self` is not a valid node address';
      if (wireVersion === undefined || !isAnnouncedWireVersion(wireVersion)) return '`wireVersion` is not a wire version';
      if (minWireVersion === undefined || !isAnnouncedWireVersion(minWireVersion)) {
        return '`minWireVersion` is not a wire version';
      }
      return typeof reason === 'string' && reason.length <= MAX_HELLO_REFUSAL_REASON_LENGTH
        ? null : '`reason` is not a bounded string';
    }

    case 'heartbeat':
    case 'heartbeat-ack': {
      const { from, seq } = frame as { from?: unknown; seq?: unknown };
      if (!isRunAddressData(from)) return '`from` is not a node address with its incarnation';
      return typeof seq === 'number' && Number.isFinite(seq) ? null : '`seq` is not a finite number';
    }

    case 'membership-refused': {
      const { from, subject } = frame as { from?: unknown; subject?: unknown };
      if (!isRunAddressData(from)) return '`from` is not a node address with its incarnation';
      return isRunAddressData(subject) ? null : '`subject` is not a node address with its incarnation';
    }

    case 'gossip': {
      const { from, sequence, members, islandProbe } = frame as {
        from?: unknown; sequence?: unknown; members?: unknown; islandProbe?: unknown;
      };
      if (!isRunAddressData(from)) return '`from` is not a node address with its incarnation';
      if (islandProbe !== undefined && islandProbe !== true) return '`islandProbe` is neither absent nor true';
      // Shape only — `Cluster.onGossip` decides whether a well-formed sequence
      // is also *fresh*, and how far ahead of this node's clock it may be.
      if (typeof sequence !== 'number' || !Number.isFinite(sequence)) {
        return '`sequence` is not a finite number';
      }
      if (!Array.isArray(members)) return '`members` is not an array';
      const bad = members.findIndex((m) => !isRunMemberData(m));
      return bad < 0 ? null : `member[${bad}] is malformed (address with its incarnation, status or version)`;
    }

    case 'envelope': {
      const { to, from } = frame as { to?: unknown; from?: unknown };
      if (typeof to !== 'string' || to.length === 0) return '`to` is not a non-empty path string';
      return from === null || typeof from === 'string' ? null : '`from` is neither a path string nor null';
    }

    case 'leave':
      return isRunAddressData((frame as { node?: unknown }).node)
        ? null : '`node` is not a node address with its incarnation';

    case 'watch':
    case 'unwatch':
    case 'watch-terminated': {
      const { watcher, watchee, existenceConfirmed } = frame as {
        watcher?: unknown; watchee?: unknown; existenceConfirmed?: unknown;
      };
      if (typeof watcher !== 'string' || watcher.length === 0) return '`watcher` is not a non-empty path string';
      if (typeof watchee !== 'string' || watchee.length === 0) return '`watchee` is not a non-empty path string';
      if (frame.kind === 'watch-terminated' && typeof existenceConfirmed !== 'boolean') {
        return '`existenceConfirmed` is not a boolean';
      }
      return null;
    }

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
  return escapeForLog(kind, MAX_LOGGED_WIRE_KIND_LENGTH);
}

/**
 * Make free text a peer wrote safe to put in a log line (#1629) — the `reason`
 * of a `hello-refused`, or an address that only survives as its rendered key.
 *
 * The escaping of {@link sanitizeWireKindForLog}, clipped at the bound the
 * wire check already holds a refusal's reason to: a reason is the diagnostic
 * an operator reads, so clipping it to a frame kind's length would cut off
 * exactly the part that says why the handshake failed.
 */
export function sanitizePeerTextForLog(text: string): string {
  return escapeForLog(text, MAX_HELLO_REFUSAL_REASON_LENGTH);
}

/**
 * Make a node address that may be a peer's choice safe to put in a log line
 * (#936) — a ref marker in a message body names one, and so does gossip.
 *
 * The same escaping as {@link sanitizeWireKindForLog}, applied to the system
 * name, host and port one at a time, each clipped to
 * {@link MAX_LOGGED_ADDRESS_PART_LENGTH}.  Clipping the rendered address as one
 * string cut it from the end, so a long system name — the first part, and a
 * free choice of whoever wrote the marker — hid exactly the host and port an
 * operator needs to see.  `String(…)` on every part because an address built
 * with the raw constructor carries no runtime guarantee about its fields.
 *
 * An `@` inside the system name or host is escaped as well, so the first `@`
 * in the line is always the separator: `NodeAddress.fromJSON` checks only that
 * both are non-empty strings, and a system name of `x@10.0.0.1:22@` would
 * otherwise render as an address that names a different host.
 */
export function sanitizeNodeAddressForLog(address: NodeAddress): string {
  const system = escapeAtSign(escapeForLog(String(address.systemName), MAX_LOGGED_ADDRESS_PART_LENGTH));
  const host = escapeAtSign(escapeForLog(String(address.host), MAX_LOGGED_ADDRESS_PART_LENGTH));
  const port = escapeForLog(String(address.port), MAX_LOGGED_ADDRESS_PART_LENGTH);
  return `${system}@${host}:${port}`;
}

/* ------------------------------- internals ------------------------------- */

/** `@` in the `\u0040` form {@link escapeForLog} writes, so it cannot read as the address separator. */
function escapeAtSign(value: string): string {
  return value.replaceAll('@', '\\u0040');
}

/** Clip `value` to `maxLength` characters and escape every line-breaking or control character. */
function escapeForLog(value: string, maxLength: number): string {
  const clipped = value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
