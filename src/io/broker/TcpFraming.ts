/**
 * Inbound frame extraction for the TCP actors — the strategy union, the two
 * stateless extractors that implement it, the HOCON reader, and the shared
 * validation rule for the two size caps.
 *
 * Lifted verbatim out of {@link TcpSocketActor} when the server side (#158)
 * arrived and needed the same three strategies **per accepted connection**.
 * Sharing rather than copying is the point: four open security issues hang
 * off this parsing (#578, #610, #752, #789), and a second copy would have to
 * be fixed twice, by someone who knows the copy exists.
 *
 * The extractors are pure functions over `(buffer, caps)` rather than methods
 * on a framer object because the two callers own their buffer differently —
 * the client actor keeps one field, the server keeps one per connection — and
 * a function that returns the leftover lets each caller store it where it
 * already stores it.
 */
import type { Config } from '../../config/Config.js';

/** Raw byte chunks, no framing — the subscriber handles stream semantics. */
type BytesFraming = { readonly kind: 'bytes' };
/** Split on `delimiter`; each frame arrives as a decoded `string`. */
type LinesFraming = {
  readonly kind: 'lines';
  readonly delimiter?: string;
  readonly maxLineLen?: number;
};
/** First 4 bytes (big-endian uint32) carry the payload size. */
type LengthPrefixedFraming = { readonly kind: 'length-prefixed'; readonly maxFrameLen?: number };

/**
 * Frame extraction strategy on the inbound stream.
 *
 *   - `bytes`     — every chunk delivered raw, no framing.  Subscriber
 *                   has to handle byte-stream semantics itself.
 *   - `lines`     — split on `delimiter` (default `'\n'`).  Most useful
 *                   for line-oriented protocols (HTTP/Telnet/Redis).
 *   - `length-prefixed` — first 4 bytes (big-endian uint32) carry the
 *                         payload size; what follows is the payload.
 */
export type TcpFraming = BytesFraming | LinesFraming | LengthPrefixedFraming;

/** One extracted frame — `string` under `lines`, bytes otherwise. */
export type TcpFrame = Uint8Array | string;

/** Framing applied when nothing configured one. */
export const DEFAULT_FRAMING: TcpFraming = { kind: 'bytes' };
/** Line terminator when `lines` framing leaves `delimiter` unset. */
export const DEFAULT_LINE_DELIMITER = '\n';
/** Cap on one `lines` frame, in bytes, when `maxLineLen` is unset. */
export const DEFAULT_MAX_LINE_LENGTH = 1_048_576;
/** Cap on one `length-prefixed` frame when `maxFrameLen` is unset. */
export const DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * What one extraction pass produced.
 *
 * `remainder` is only meaningful when `overflow` is unset: a breached cap
 * leaves the caller's buffer untouched, because the connection is about to go
 * away and re-slicing a buffer nobody will read again would only obscure that.
 *
 * "About to go away" is the caller's half of the contract, and both callers
 * owe it: the listener closes the offending connection, the client discards
 * the bytes and destroys its socket (#578).  A caller that only reported the
 * overflow would keep the oversized buffer *and* the peer that sent it.
 */
export type FrameExtraction = {
  /** Frames completed in this pass, in arrival order. */
  readonly frames: readonly TcpFrame[];
  /** Bytes left over for the next chunk — assign back to the caller's buffer. */
  readonly remainder: Uint8Array;
  /**
   * How far into `remainder` the delimiter search already reached: those bytes
   * are known to hold no delimiter, so the next pass may start there instead
   * of at 0.  Hand it back as the `scanFrom` argument and a delimiter-free
   * peer costs O(chunk) per chunk rather than O(buffered) (#610).
   *
   * Unset on a breached cap, and unset for the strategies that keep no scan
   * state — `0` is always the safe reading.
   */
  readonly scanFrom?: number;
  /** Set when a frame breached its size cap; the reason, for the error. */
  readonly overflow?: string;
};

/**
 * Shared instances, because neither carries state across calls here: the
 * decoder is only ever handed a *complete* line and never opts into
 * `{ stream: true }`, so one instance per module saves an allocation per
 * frame without coupling two extraction passes.
 */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Append `chunk` to `buffer`, avoiding the copy when there is nothing to
 * append to — which is the common case for a stream whose frames arrive
 * whole.
 */
export function appendChunk(buffer: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (buffer.length === 0) return chunk;
  const merged = new Uint8Array(buffer.length + chunk.length);
  merged.set(buffer, 0);
  merged.set(chunk, buffer.length);
  return merged;
}

/**
 * Run `framing`'s extractor over `buffer`, filling in the unset caps.
 *
 * `scanFrom` is the previous pass' {@link FrameExtraction.scanFrom} for this
 * buffer; only `lines` keeps scan state, the other two ignore it.
 */
export function extractFrames(
  buffer: Uint8Array,
  framing: TcpFraming,
  scanFrom = 0,
): FrameExtraction {
  if (framing.kind === 'bytes') return { frames: [buffer], remainder: new Uint8Array(0) };
  if (framing.kind === 'lines') {
    return extractLineFrames(
      buffer,
      framing.delimiter ?? DEFAULT_LINE_DELIMITER,
      framing.maxLineLen ?? DEFAULT_MAX_LINE_LENGTH,
      scanFrom,
    );
  }
  return extractLengthPrefixedFrames(buffer, framing.maxFrameLen ?? DEFAULT_MAX_FRAME_LENGTH);
}

/**
 * Split `buffer` on `delimiter`, rejecting any line longer than `maxLineLen`
 * **bytes**.
 *
 * The scan runs over the raw bytes against the UTF-8-encoded delimiter, and
 * only completed lines are decoded.  Three properties follow from that, none
 * of which held while the whole pending buffer was decoded per chunk (#610):
 *
 *   - **Cost.**  Decoding N buffered bytes to look for a delimiter that has
 *     not arrived yet is O(N) per chunk and O(N²) over a delimiter-free
 *     stream — under a cap sized in mebibytes, an event-loop stall a peer can
 *     simply ask for.  `scanFrom` carries the already-searched prefix across
 *     calls, so each byte is looked at once.
 *   - **Correctness.**  A chunk boundary splitting a multi-byte character
 *     used to decode the partial sequence to U+FFFD and re-encode *that* into
 *     the leftover, so the continuation byte arriving next could never repair
 *     it.  Raw bytes go back untouched, so it repairs itself.
 *   - **The cap counts bytes** (#752) — the unit the options validator has
 *     always claimed.  Measured on the decoded string it counted UTF-16 code
 *     units, which let a 1 MiB `maxLineLen` buffer 3 MiB of ordinary CJK.
 *
 * The un-terminated remainder is checked against the cap too: bytes after the
 * last delimiter can never become a valid line once they are already over it,
 * so a hostile / MITM'd peer streaming delimiter-free bytes cannot grow the
 * caller's buffer without bound (security audit BRK-1).
 */
export function extractLineFrames(
  buffer: Uint8Array,
  delimiter: string,
  maxLineLen: number,
  scanFrom = 0,
): FrameExtraction {
  const delimiterBytes = textEncoder.encode(delimiter);
  // An empty delimiter matches at every offset while consuming nothing, so
  // the loop below would never advance — a synchronous spin no timeout can
  // interrupt, growing `frames` with empty strings until the process dies
  // (#789).  Unreachable through either actor: {@link findFramingViolation}
  // rejects it in `preStart`, before a socket exists.  Which is why this
  // throws rather than reporting an `overflow`: an overflow tells the caller
  // to drop the connection and reconnect, and it would then reconnect into
  // the same misconfiguration forever, with nothing pointing at the config.
  if (delimiterBytes.length === 0) {
    throw new Error('extractLineFrames: framing.delimiter must not be empty');
  }
  const frames: TcpFrame[] = [];
  let lineStart = 0;
  // Clamped rather than trusted: a caller that lost track of its buffer would
  // otherwise skip bytes it never searched.
  let searchFrom = Math.min(Math.max(scanFrom, 0), buffer.length);
  for (;;) {
    const index = indexOfBytes(buffer, delimiterBytes, searchFrom);
    if (index < 0) break;
    if (index - lineStart > maxLineLen) {
      return { frames, remainder: buffer, overflow: `line exceeds maxLineLen=${maxLineLen}` };
    }
    frames.push(textDecoder.decode(buffer.subarray(lineStart, index)));
    lineStart = index + delimiterBytes.length;
    searchFrom = lineStart;
  }
  if (buffer.length - lineStart > maxLineLen) {
    return {
      frames,
      remainder: buffer,
      overflow: `unterminated line exceeds maxLineLen=${maxLineLen}`,
    };
  }
  // Resume one short of a full delimiter, not at the very end: a multi-byte
  // delimiter straddling the boundary would otherwise be stepped over, and
  // that line would never complete.
  const searched = Math.max(buffer.length - delimiterBytes.length + 1, lineStart);
  // Nothing consumed → hand the buffer straight back rather than pay for a
  // view onto a chunk that is still one partial line.
  if (lineStart === 0) return { frames, remainder: buffer, scanFrom: searched };
  return { frames, remainder: buffer.subarray(lineStart), scanFrom: searched - lineStart };
}

/**
 * Offset of `needle` in `haystack` at or after `from`, or `-1`.
 *
 * Searching bytes is sound even for a non-ASCII delimiter: UTF-8 is
 * self-synchronizing — a lead byte never appears as a continuation byte — so
 * an encoded delimiter can only match on a character boundary.  The outer
 * scan is `TypedArray.indexOf`, i.e. the runtime's own byte search, which is
 * most of why this is cheaper than decoding first.
 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  for (
    let index = haystack.indexOf(first, from);
    index >= 0 && index <= last;
    index = haystack.indexOf(first, index + 1)
  ) {
    let matched = 1;
    while (matched < needle.length && haystack[index + matched] === needle[matched]) matched++;
    if (matched === needle.length) return index;
  }
  return -1;
}

/**
 * Peel `[uint32 length][payload]` frames off `buffer`, rejecting any frame
 * whose declared length exceeds `maxFrameLen`.
 *
 * The cap is checked against the **declared** length, before waiting for the
 * payload: a 4-byte header is all an attacker needs to send to make the
 * buffer grow to whatever it claims, so trusting it far enough to wait for
 * the rest is the vulnerability.
 */
export function extractLengthPrefixedFrames(
  buffer: Uint8Array,
  maxFrameLen: number,
): FrameExtraction {
  const frames: TcpFrame[] = [];
  let cursor = 0;
  while (buffer.length - cursor >= 4) {
    const length = (buffer[cursor]! << 24 | buffer[cursor + 1]! << 16
                  | buffer[cursor + 2]! << 8 | buffer[cursor + 3]!) >>> 0;
    if (length > maxFrameLen) {
      return { frames, remainder: buffer, overflow: `frame exceeds maxFrameLen=${maxFrameLen}` };
    }
    if (buffer.length - cursor - 4 < length) break;
    frames.push(buffer.slice(cursor + 4, cursor + 4 + length));
    cursor += 4 + length;
  }
  return { frames, remainder: cursor === 0 ? buffer : buffer.slice(cursor) };
}

/** Read a `framing { … }` block off a broker actor's HOCON config. */
export function readFramingFromConfig(framingConfig: Config): TcpFraming {
  const kind = framingConfig.getString('kind') as TcpFraming['kind'];
  if (kind === 'lines') {
    return {
      kind,
      delimiter: framingConfig.hasPath('delimiter') ? framingConfig.getString('delimiter') : undefined,
      maxLineLen: framingConfig.hasPath('maxLineLen') ? framingConfig.getInt('maxLineLen') : undefined,
    };
  }
  if (kind === 'length-prefixed') {
    return {
      kind,
      maxFrameLen: framingConfig.hasPath('maxFrameLen') ? framingConfig.getInt('maxFrameLen') : undefined,
    };
  }
  return { kind: 'bytes' };
}

/** A framing setting that is present but outside its domain. */
export type FramingViolation = {
  readonly field: string;
  readonly reason: string;
  readonly value: number | string;
};

/**
 * The offending `framing` setting, or `undefined` when all of them are fine —
 * the rule shared by every TCP options validator.
 *
 * `framing`'s leaves sit one level down, so the validators' check helpers —
 * typed against the top-level fields of an options type — cannot reach them,
 * which is why this is spelled out as a free function instead.  Both TCP
 * actors delegate to it, so one rule covers the client and the listener, and
 * covers the builder, the plain object and HOCON alike.
 *
 * Every rule here guards a failure mode worse than a merely wrong value.
 *
 * The two size caps are DoS limits: a frame past the cap drops the connection
 * instead of buffering without bound.  Both are applied as `length > cap`,
 * and any comparison against `NaN` is `false` — so a non-numeric value read
 * from HOCON does not clamp anything, it **removes the cap entirely** and
 * restores the unbounded buffering the limit exists to prevent.  A zero or
 * negative cap fails the other way, dropping every connection immediately.
 *
 * An empty `delimiter` is worse still: it matches at every offset without
 * consuming anything, so the extractor's scan cannot advance.  That is a
 * synchronous spin — not a slow actor but a wedged process, since no timeout
 * can interrupt it (#789).  `''` survives every layer on its own (`??`
 * treats it as set, HOCON reads it verbatim), so nothing else would catch it.
 */
export function findFramingViolation(
  framing: TcpFraming | undefined,
): FramingViolation | undefined {
  if (framing === undefined) return undefined;
  if (framing.kind === 'lines' && framing.delimiter === '') {
    return { field: 'framing.delimiter', reason: 'must not be empty', value: framing.delimiter };
  }
  const reason = 'must be a positive integer number of bytes';
  if (framing.kind === 'lines' && framing.maxLineLen !== undefined
      && !isByteCap(framing.maxLineLen)) {
    return { field: 'framing.maxLineLen', reason, value: framing.maxLineLen };
  }
  if (framing.kind === 'length-prefixed' && framing.maxFrameLen !== undefined
      && !isByteCap(framing.maxFrameLen)) {
    return { field: 'framing.maxFrameLen', reason, value: framing.maxFrameLen };
  }
  return undefined;
}

function isByteCap(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
