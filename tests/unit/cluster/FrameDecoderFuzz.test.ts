/**
 * Bytes nobody chose, fed to the cluster wire's `FrameDecoder` (#1369).
 *
 * `Protocol.test.ts` holds the decoder to crafted frames — a 1 GiB length
 * claim, a quadratic chunking pattern, one malformed tag.  These properties
 * hold it to arbitrary ones: uniform noise in arbitrary chunks, valid frame
 * streams cut at every offset, length prefixes overwritten with anything, and
 * payloads dense in JSON-tree tags under a random allow-list.  Whatever
 * arrives, `push` either returns frames or throws `FrameDecodeError` — which
 * `Transport` answers by dropping the connection — and:
 *
 *  - **how the bytes were split never changes what comes out.**  A peer picks
 *    the chunking, and TCP may re-split it on the way, so the frames, the
 *    refusals and the error must be the same however the stream is cut;
 *  - **every frame is what the JSON-tree walker makes of its payload** under
 *    the same allow-list and depth ceiling — delivered, refused alone, or the
 *    end of the connection — so the wire cannot drift from the walker;
 *  - **buffering stays linear** in what arrived, extending the one-shape copy
 *    count of `Protocol.test.ts` to arbitrary streams and splits.
 *
 * The deep run is `tests/nightly/DecoderFuzzDeep.nightly.ts`.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { FrameDecodeError, FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from '../../../src/serialization/Constants.js';
import { CborEncoder } from '../../../src/serialization/CborCodec.js';
import { decodeJsonTree, RefusedTagError } from '../../../src/serialization/JsonTree.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import {
  admittedTagsArbitrary,
  byteReplacementsArbitrary,
  chunksOf,
  foreignError,
  jsonTreeDocumentArbitrary,
  outcomeOf,
  unadmittedClassesIn,
  withBytesReplaced,
} from '../../util/DecoderFuzz.js';

/** Small enough that random length prefixes regularly land on both sides of it. */
const MAXIMUM_FRAME_BYTES = 512;
/** The second cap on the same prefix, below the first so a claim can fall between the two. */
const MAXIMUM_DOCUMENT_BYTES = 384;
/** Low enough that the generated documents cross it. */
const MAXIMUM_NESTING_DEPTH = 4;

/** `undefined` lists every name, so it means here what it means to `decodeJsonTree`. */
const decoderFor = (tags: readonly JsonTreeTagName[] | undefined): FrameDecoder => new FrameDecoder(
  MAXIMUM_FRAME_BYTES,
  { maxNestingDepth: MAXIMUM_NESTING_DEPTH, maxDocumentBytes: MAXIMUM_DOCUMENT_BYTES },
  { admittedTags: tags ?? JSON_TREE_TAG_NAMES },
);

/** What a whole stream amounted to: the frames, the refusals, the bytes held back, and the error that ended it. */
type StreamResult = {
  readonly frames: readonly WireMessage[];
  readonly refused: number;
  readonly pending: number;
  readonly error: string | null;
  readonly foreign: string | null;
};

/** Feed `chunks` in order the way `Transport` does — stopping at the first throw, which drops the connection. */
function feed(chunks: readonly Uint8Array[], tags: readonly JsonTreeTagName[] | undefined): StreamResult {
  const decoder = decoderFor(tags);
  const frames: WireMessage[] = [];
  for (const chunk of chunks) {
    const outcome = outcomeOf(() => decoder.push(chunk));
    if (outcome.kind === 'threw') {
      return {
        frames, refused: decoder.refusedFrames, pending: decoder.pendingBytes(),
        error: String((outcome.error as Error).message),
        foreign: foreignError(outcome, [FrameDecodeError]),
      };
    }
    frames.push(...(outcome.value as WireMessage[]));
  }
  return { frames, refused: decoder.refusedFrames, pending: decoder.pendingBytes(), error: null, foreign: null };
}

/** `payload` behind its 4-byte big-endian length prefix. */
function frameOf(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Up to four JSON-tree documents, each as its own frame. */
const documents = fc.array(jsonTreeDocumentArbitrary(), { minLength: 1, maxLength: 4 });
const streamOf = (values: readonly unknown[]): Uint8Array =>
  concatenated(values.map((value) => frameOf(new TextEncoder().encode(JSON.stringify(value)))));

/** A split into pieces of 1 to 40 bytes — down to one byte per push. */
const splits = fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 24 });

/**
 * The part of `result` that must match the uncut stream's.  Frames delivered
 * before an error are left out when the uncut stream failed, on purpose: a
 * single `push` that throws discards the frames it had already decoded, while
 * a split stream handed some of them over in an earlier `push` — the
 * connection is dropped either way, so only the error has to match.
 */
function comparable(result: StreamResult, whole: StreamResult): unknown {
  return whole.error === null
    ? { frames: result.frames.map(canonical), refused: result.refused, pending: result.pending, error: result.error }
    : { error: result.error };
}

/**
 * A frame as its CBOR encoding, which is how two frames are compared: a
 * malformed `__date__` decodes to an Invalid Date, which never equals itself,
 * and `toEqual` keys a `Map`'s object keys by identity.
 */
const canonical = (frame: unknown): number[] => [...new CborEncoder().encode(frame)];

describe('FrameDecoder over arbitrary bytes', () => {
  test('property: noise in any split returns frames or throws FrameDecodeError, the same for every split', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 160 }), splits, admittedTagsArbitrary(), (bytes, lengths, tags) => {
      const whole = feed([bytes], tags);
      const split = feed(chunksOf(bytes, lengths), tags);
      expect([whole.foreign, split.foreign]).toEqual([null, null]);
      expect(comparable(split, whole)).toEqual(comparable(whole, whole));
      const admitted = tags === undefined ? undefined : new Set(tags);
      expect(split.frames.flatMap((frame) => unadmittedClassesIn(frame, admitted))).toEqual([]);
      expect(split.pending).toBeLessThanOrEqual(bytes.byteLength);
    }));
  });

  test('property: a frame stream cut at every offset decodes exactly as the uncut stream', () => {
    fc.assert(fc.property(documents, admittedTagsArbitrary(), (values, tags) => {
      const stream = streamOf(values);
      const whole = feed([stream], tags);
      expect(whole.foreign).toBeNull();
      const disagreeing: number[] = [];
      for (let cut = 0; cut <= stream.byteLength; cut++) {
        const split = feed([stream.subarray(0, cut), stream.subarray(cut)], tags);
        if (split.foreign !== null) disagreeing.push(cut);
        else if (!Bun.deepEquals(comparable(split, whole), comparable(whole, whole), true)) disagreeing.push(cut);
      }
      expect(disagreeing).toEqual([]);
    }));
  });

  test('property: a length prefix or payload byte overwritten with anything is refused with FrameDecodeError', () => {
    fc.assert(fc.property(
      documents, byteReplacementsArbitrary(), fc.option(fc.oneof(fc.nat({ max: 2 * MAXIMUM_FRAME_BYTES }), fc.nat({ max: 0xffffffff })), { nil: undefined }), splits, admittedTagsArbitrary(),
      (values, replacements, claim, lengths, tags) => {
        const stream = withBytesReplaced(streamOf(values), replacements);
        if (claim !== undefined) new DataView(stream.buffer).setUint32(0, claim, false);
        const whole = feed([stream], tags);
        const split = feed(chunksOf(stream, lengths), tags);
        expect([whole.foreign, split.foreign]).toEqual([null, null]);
        expect(comparable(split, whole)).toEqual(comparable(whole, whole));
        // A claim past either cap is refused on the header, before its payload is buffered.
        if (claim !== undefined && claim > MAXIMUM_FRAME_BYTES) expect(whole.error).toContain('maxFrameBytes');
        else if (claim !== undefined && claim > MAXIMUM_DOCUMENT_BYTES) expect(whole.error).toContain('maxDocumentBytes');
      },
    ));
  });

  test('property: every frame is what the JSON-tree walker makes of its payload, under the same list and ceiling', () => {
    fc.assert(fc.property(documents, admittedTagsArbitrary(), (values, tags) => {
      const fitting = values.filter((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAXIMUM_DOCUMENT_BYTES);
      fc.pre(fitting.length > 0);
      const expectedFrames: unknown[] = [];
      let expectedRefusals = 0;
      let expectedError: string | null = null;
      for (const value of fitting) {
        // The walker is handed what the wire carried, not the generated value:
        // `JSON.stringify(-0)` is `0`, so the two differ by exactly the frame.
        const carried: unknown = JSON.parse(JSON.stringify(value));
        const reference = outcomeOf(() => decodeJsonTree(carried, { maxNestingDepth: MAXIMUM_NESTING_DEPTH, tags }));
        if (reference.kind === 'decoded') {
          expectedFrames.push(reference.value);
        } else if (reference.error instanceof RefusedTagError) {
          expectedRefusals += 1;
        } else {
          expect(reference.error).toBeInstanceOf(SerializationError);
          expectedError = `Invalid wire frame payload: ${(reference.error as Error).message}`;
          break;
        }
      }
      const result = feed([streamOf(fitting)], tags);
      expect(result.foreign).toBeNull();
      expect(result.error).toBe(expectedError);
      if (expectedError === null) {
        expect(result.frames.map(canonical)).toEqual(expectedFrames.map(canonical));
        expect(result.refused).toBe(expectedRefusals);
      }
    }));
  });

  test('property: a payload nested far past the depth ceiling ends the connection with FrameDecodeError', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 50_000 }), fc.constantFrom('[', '{"a":'), (depth, opener) => {
      const closer = opener === '[' ? ']' : '}';
      const payload = new TextEncoder().encode(opener.repeat(depth) + '0' + closer.repeat(depth));
      const decoder = new FrameDecoder(payload.byteLength + 4, { maxNestingDepth: MAXIMUM_NESTING_DEPTH });
      const outcome = outcomeOf(() => decoder.push(frameOf(payload)));
      expect(foreignError(outcome, [FrameDecodeError])).toBeNull();
      // `depth` containers put the innermost one at level depth - 1.
      expect(outcome.kind).toBe(depth - 1 > MAXIMUM_NESTING_DEPTH ? 'threw' : 'decoded');
    }), { numRuns: 40 });
  });

  test('property: assembling any stream in any split copies each byte a bounded number of times', () => {
    fc.assert(fc.property(documents, splits, (values, lengths) => {
      const stream = streamOf(values);
      const realSet = Uint8Array.prototype.set;
      const realCopyWithin = Uint8Array.prototype.copyWithin;
      let copied = 0;
      Uint8Array.prototype.set = function (this: Uint8Array, source: ArrayLike<number>, offset?: number): void {
        copied += source.length;
        realSet.call(this, source, offset);
      };
      Uint8Array.prototype.copyWithin = function (this: Uint8Array, target: number, start: number, end?: number): Uint8Array {
        copied += (end ?? this.length) - start;
        return realCopyWithin.call(this, target, start, end);
      };
      try {
        feed(chunksOf(stream, lengths), undefined);
      } finally {
        Uint8Array.prototype.set = realSet;
        Uint8Array.prototype.copyWithin = realCopyWithin;
      }
      // Once on arrival, plus once per doubling and per compaction a byte
      // lives through — a constant multiple, never a function of the split.
      expect(copied).toBeLessThanOrEqual(stream.byteLength * 4);
    }));
  });
});
