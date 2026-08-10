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
/** Cap on one `lines` frame when `maxLineLen` is unset. */
export const DEFAULT_MAX_LINE_LENGTH = 1_048_576;
/** Cap on one `length-prefixed` frame when `maxFrameLen` is unset. */
export const DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * What one extraction pass produced.
 *
 * `remainder` is only meaningful when `overflow` is unset: a breached cap
 * leaves the caller's buffer untouched, because the connection is about to go
 * away and re-slicing a buffer nobody will read again would only obscure that.
 */
export type FrameExtraction = {
  /** Frames completed in this pass, in arrival order. */
  readonly frames: readonly TcpFrame[];
  /** Bytes left over for the next chunk — assign back to the caller's buffer. */
  readonly remainder: Uint8Array;
  /** Set when a frame breached its size cap; the reason, for the error. */
  readonly overflow?: string;
};

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

/** Run `framing`'s extractor over `buffer`, filling in the unset caps. */
export function extractFrames(buffer: Uint8Array, framing: TcpFraming): FrameExtraction {
  if (framing.kind === 'bytes') return { frames: [buffer], remainder: new Uint8Array(0) };
  if (framing.kind === 'lines') {
    return extractLineFrames(
      buffer,
      framing.delimiter ?? DEFAULT_LINE_DELIMITER,
      framing.maxLineLen ?? DEFAULT_MAX_LINE_LENGTH,
    );
  }
  return extractLengthPrefixedFrames(buffer, framing.maxFrameLen ?? DEFAULT_MAX_FRAME_LENGTH);
}

/**
 * Split `buffer` on `delimiter`, rejecting any line longer than `maxLineLen`.
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
): FrameExtraction {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const frames: TcpFrame[] = [];
  let cursor = 0;
  for (;;) {
    const index = text.indexOf(delimiter, cursor);
    if (index < 0) break;
    const line = text.slice(cursor, index);
    if (line.length > maxLineLen) {
      return { frames, remainder: buffer, overflow: `line exceeds maxLineLen=${maxLineLen}` };
    }
    frames.push(line);
    cursor = index + delimiter.length;
  }
  if (text.length - cursor > maxLineLen) {
    return {
      frames,
      remainder: buffer,
      overflow: `unterminated line exceeds maxLineLen=${maxLineLen}`,
    };
  }
  // Nothing consumed → hand the buffer straight back rather than paying a
  // decode/encode round-trip for a chunk that is still one partial line.
  if (cursor === 0) return { frames, remainder: buffer };
  return { frames, remainder: new TextEncoder().encode(text.slice(cursor)) };
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

/** A framing size cap that is present but outside its domain. */
export type FramingCapViolation = {
  readonly field: string;
  readonly reason: string;
  readonly value: number;
};

/**
 * The offending size cap in `framing`, or `undefined` when both are fine —
 * the rule shared by every TCP options validator.
 *
 * `framing` carries the two inbound size caps, and both are DoS limits: a
 * frame past the cap drops the connection instead of buffering without
 * bound.  They sit one level down, so the validators' check helpers — typed
 * against the top-level fields of an options type — cannot reach them, which
 * is why this is spelled out as a free function instead.
 *
 * The failure mode is worse than a merely wrong number.  Both caps are
 * applied as `length > cap`, and any comparison against `NaN` is `false` —
 * so a non-numeric value read from HOCON does not clamp anything, it
 * **removes the cap entirely** and restores the unbounded buffering the
 * limit exists to prevent.  A zero or negative cap fails the other way,
 * dropping every connection immediately.
 */
export function findFramingCapViolation(
  framing: TcpFraming | undefined,
): FramingCapViolation | undefined {
  if (framing === undefined) return undefined;
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
