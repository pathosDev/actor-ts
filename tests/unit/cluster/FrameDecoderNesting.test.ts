import { describe, expect, test } from 'bun:test';
import { FrameDecoder } from '../../../src/cluster/Protocol.js';

/**
 * The cluster wire's share of #880.
 *
 * `FrameDecoder` bounds the BYTES a peer may make this node buffer
 * (`actor-ts.remote.max-frame-bytes`, 16 MiB) and, before this, nothing else.
 * A frame comfortably inside that cap can still be `[[[[…` a hundred thousand
 * levels deep, and the walker it is handed to — `decodeJsonTree` — recursed
 * once per level with no counter.  `JSON.parse` does not save it: JSC's parser
 * is iterative and accepts a million levels without complaint, so the only
 * thing that ever stopped the payload was the JS stack, and a `RangeError`
 * escaping `push` is not the typed failure the transport's error handling is
 * written against.
 *
 * Every frame here is assembled by hand rather than through `encodeFrame`,
 * because the whole question is what an ATTACKER can put on the wire — and an
 * attacker does not go through this project's encoder.
 */

/** The wire's big-endian uint32 length prefix — `Protocol.ts`'s `HEADER_SIZE`. */
const HEADER_SIZE = 4;

/** A length-prefixed wire frame carrying `json` verbatim. */
function frameOf(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

const nestedArrayJson = (levels: number): string => '['.repeat(levels) + ']'.repeat(levels);

describe('FrameDecoder — nesting', () => {
  test('a deeply nested frame is refused with the payload error, not a RangeError', () => {
    // 4 000 levels: two orders of magnitude under the depth at which the
    // walker's own stack gives out, and 8 KB on the wire — so before #880 this
    // frame was accepted in full and the cap under test is the only thing that
    // refuses it now.
    const decoder = new FrameDecoder();
    let thrown: unknown;
    try {
      decoder.push(frameOf(nestedArrayJson(4_000)));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect((thrown as Error).message).toContain('Invalid wire frame payload');
    expect((thrown as Error).message).toContain('nesting deeper than 256');
  });

  test('the frame that is one level inside the cap still decodes', () => {
    // Guards against a fix that bounds the attack by making legitimate frames
    // unreachable: 200 levels is absurd for a wire message and still accepted.
    const decoder = new FrameDecoder();
    const messages = decoder.push(frameOf(nestedArrayJson(200)));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(Array);
  });

  test('an ordinary frame is unaffected', () => {
    const decoder = new FrameDecoder();
    const messages = decoder.push(frameOf(JSON.stringify({ kind: 'ping', from: 'a@h:1' })));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'ping' });
  });

  test('a configured-lower depth refuses what the default admits', () => {
    const frame = frameOf(nestedArrayJson(40));
    expect(new FrameDecoder().push(frame)).toHaveLength(1);
    expect(() => new FrameDecoder(undefined, { maxNestingDepth: 8 }).push(frame))
      .toThrow(/nesting deeper than 8/);
  });

  test('the frame cap and the nesting cap are separate bounds', () => {
    // Both are in force at once, and neither substitutes for the other: this
    // frame is inside a 1 MiB byte cap and outside a 16-level depth cap.
    const decoder = new FrameDecoder(1024 * 1024, { maxNestingDepth: 16 });
    expect(() => decoder.push(frameOf(nestedArrayJson(64)))).toThrow(/nesting deeper than 16/);
  });
});
