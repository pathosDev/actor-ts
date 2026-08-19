/**
 * The wire budget for a warm-hand-over snapshot (#194), pinned as arithmetic
 * rather than left to a comment.
 *
 * The number that looks obviously right here is the frame cap, and it is wrong
 * by a third. A cluster frame is `JSON.stringify(encodeJsonTree(message))`
 * (`cluster/Protocol.ts`), and `JsonTree` encodes a `Uint8Array` as **base64**
 * under its `__bytes__` tag — four characters per three bytes. So a snapshot
 * sized to the cap produces a frame about 33 % over it.
 *
 * What makes that worth its own test is the failure mode on the other side of
 * the line. The cap is enforced by the *receiver's* `FrameDecoder`, which
 * throws, and `Transport` answers a throw by dropping the connection — taking
 * heartbeats, membership gossip and every other cross-node `tell` with the
 * offending frame. Nothing on the send side reports anything, because `send` is
 * fire-and-forget. So a snapshot one byte too large is not a lost message; it is
 * a node that keeps knocking its own links down and never learns why.
 *
 * These cases exist so that budget cannot quietly drift back to "the frame cap".
 * The base64 ratio is checked against `JsonTree`'s actual output rather than
 * asserted from the same formula the implementation uses — a test that recomputed
 * `4/3` would agree with a wrong implementation just as readily as with a right
 * one.
 */
import { describe, expect, test } from 'bun:test';
import { handOverStateFitsFrame } from '../../../src/cluster/singleton/WarmHandOver.js';
import { isSingletonMessage } from '../../../src/cluster/singleton/SingletonProtocol.js';
import { decodeJsonTree, encodeJsonTree } from '../../../src/serialization/JsonTree.js';
import { DEFAULT_MAX_FRAME_BYTES } from '../../../src/cluster/Protocol.js';

/** What `n` bytes of snapshot actually cost inside a JSON cluster frame. */
function encodedFrameBytes(n: number): number {
  const body = { kind: 'singleton.HandOverAcknowledgment', typeName: 'counter', state: new Uint8Array(n) };
  return new TextEncoder().encode(JSON.stringify(encodeJsonTree(body))).byteLength;
}

describe('warm hand-over wire budget (#194)', () => {
  test('a Uint8Array really does cost ~4/3 of its length in a JSON frame', () => {
    // The premise the budget rests on, measured rather than assumed.  If
    // `JsonTree` ever stopped base64-encoding bytes — a CBOR frame codec would
    // be the obvious reason — this is the case that says the budget can be
    // relaxed, instead of the budget silently staying pessimistic forever.
    const payload = 30_000;
    const overhead = encodedFrameBytes(0);
    const bytesForPayload = encodedFrameBytes(payload) - overhead;
    expect(bytesForPayload).toBeGreaterThanOrEqual(Math.ceil(payload * 4 / 3));
    // And not dramatically worse than 4/3 — a JSON string of base64 needs no
    // escaping, so the only additions are the quotes counted in `overhead`.
    expect(bytesForPayload).toBeLessThan(Math.ceil(payload * 4 / 3) + 8);
  });

  test('a snapshot sized to the frame cap does NOT fit — the 33 % is the whole point', () => {
    // The mistake this guard exists to prevent, stated as a test: the issue's
    // own design sketch proposed `maxStateBytes: 16 MB` and called it "matches
    // the wire-frame cap".
    expect(handOverStateFitsFrame(DEFAULT_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES)).toBe(false);
    // Three quarters of the cap is the honest ceiling, and it is under it.
    expect(handOverStateFitsFrame(Math.floor(DEFAULT_MAX_FRAME_BYTES * 3 / 4) - 4_096, DEFAULT_MAX_FRAME_BYTES))
      .toBe(true);
  });

  test('what the budget admits genuinely encodes inside the cap', () => {
    // The two halves joined up: the predicate is only worth anything if a
    // snapshot it accepts produces a frame the decoder accepts.  Checked at a
    // small cap so the frame can actually be built and measured.
    const cap = 64 * 1_024;
    // Binary search the largest snapshot the budget admits, then encode it.
    let low = 0;
    let high = cap;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (handOverStateFitsFrame(middle, cap)) low = middle;
      else high = middle - 1;
    }
    expect(low).toBeGreaterThan(0);
    expect(encodedFrameBytes(low)).toBeLessThanOrEqual(cap);
    // And the budget is not so pessimistic as to be useless: it admits most of
    // what base64 leaves room for.
    expect(low).toBeGreaterThan(Math.floor(cap * 0.7));
  });

  test('an unframed transport has no cap to respect, and says so with `true`', () => {
    // `InMemoryTransport`, `MessageChannelTransport` and `MultiNodeTransport`
    // hand the message object to the peer — there is no length prefix to
    // overflow, so any number here would be invented.  `undefined` therefore
    // means "only `maxHandOverStateBytes` applies", not "unlimited by accident".
    expect(handOverStateFitsFrame(1, undefined)).toBe(true);
    expect(handOverStateFitsFrame(512 * 1_024 * 1_024, undefined)).toBe(true);
  });

  test('a zero-byte snapshot fits any cap that can hold the envelope', () => {
    expect(handOverStateFitsFrame(0, DEFAULT_MAX_FRAME_BYTES)).toBe(true);
    // And a cap smaller than the reserved envelope allowance admits nothing,
    // rather than admitting a snapshot the envelope leaves no room for.
    expect(handOverStateFitsFrame(0, 512)).toBe(false);
  });
});

describe('a hand-over acknowledgment survives the frame codec (#194)', () => {
  // The integration tests cannot cover this and it is worth saying why:
  // `InMemoryTransport` hands the message *object* to the peer, so a
  // `Uint8Array` in an envelope body reaches the far side as the very array that
  // was put in it and no encoding happens at all.  Every in-process test of warm
  // hand-over is therefore blind to whether the snapshot survives a real frame
  // — which is the one step between two actual nodes that could mangle it.
  //
  // `JsonTree` is pure JavaScript with no runtime-specific dependency, so
  // round-tripping it here is the substance of "cross-runtime parity" for this
  // payload; what a smoke case would add on top is the socket, not the codec.

  test('the state comes back as the same bytes, and still passes the guard', () => {
    const state = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const sent = {
      kind: 'singleton.HandOverAcknowledgment' as const,
      typeName: 'counter',
      state,
    };
    const wire = JSON.parse(JSON.stringify(encodeJsonTree(sent))) as unknown;
    const received = decodeJsonTree(wire);

    // The guard has to accept the *decoded* form.  Accepting only the
    // pre-encoding object would mean the check passed in every test and never
    // once on the wire.
    expect(isSingletonMessage(received)).toBe(true);
    const { state: back } = received as { state: Uint8Array };
    expect(back).toBeInstanceOf(Uint8Array);
    expect([...back]).toEqual([...state]);
  });

  test('the high byte values that break a naive codec survive', () => {
    // 0x80–0xFF are where a `String.fromCharCode` / `TextDecoder` mix-up shows
    // up: they round-trip as U+FFFD through a UTF-8 decode and the corruption is
    // invisible in a test that only uses ASCII-range bytes.
    const state = new Uint8Array(256);
    for (let index = 0; index < 256; index++) state[index] = index;
    const sent = { kind: 'singleton.HandOverAcknowledgment' as const, typeName: 'c', state };
    const received = decodeJsonTree(JSON.parse(JSON.stringify(encodeJsonTree(sent)))) as {
      state: Uint8Array;
    };
    expect([...received.state]).toEqual([...state]);
  });

  test('an acknowledgment without state round-trips unchanged', () => {
    const sent = { kind: 'singleton.HandOverAcknowledgment' as const, typeName: 'counter' };
    const received = decodeJsonTree(JSON.parse(JSON.stringify(encodeJsonTree(sent))));
    expect(isSingletonMessage(received)).toBe(true);
    expect((received as { state?: unknown }).state).toBeUndefined();
  });
});

describe('the inbound guard on a hand-over frame (#194)', () => {
  // `state` is the one field of this protocol that reaches *user* code — it is
  // handed to `restoreFromHandOver` on the incoming host — so the shape check in
  // front of it is what separates "bytes from an authenticated peer" from
  // "whatever a peer put in a JSON object".  Unknown wire kinds pass validation
  // by design and the extension owns its own payload
  // (`cluster/WireValidation.ts`), so there is no layer below this one that
  // would catch it.

  test('accepts an acknowledgment with and without state', () => {
    expect(isSingletonMessage({
      kind: 'singleton.HandOverAcknowledgment', typeName: 'counter',
    })).toBe(true);
    expect(isSingletonMessage({
      kind: 'singleton.HandOverAcknowledgment', typeName: 'counter', state: new Uint8Array([1, 2]),
    })).toBe(true);
    expect(isSingletonMessage({
      kind: 'singleton.HandOverRequest', typeName: 'counter',
    })).toBe(true);
  });

  test('rejects a state that is not bytes, whatever it is instead', () => {
    // Rejecting the whole frame rather than stripping the field: a body this
    // wrong is not one to act on at all — acting on the `kind` while quietly
    // dropping a malformed field would let a peer stop a singleton with a frame
    // it could not have produced honestly.
    for (const state of [
      'AAAA',                       // base64 that never went through JsonTree
      [1, 2, 3],                    // a plain array
      { 0: 1, length: 1 },          // array-like
      { __bytes__: 'AAAA' },        // the encoded form, undecoded
      42,
      null,
      true,
    ]) {
      expect(isSingletonMessage({
        kind: 'singleton.HandOverAcknowledgment', typeName: 'counter', state,
      })).toBe(false);
    }
  });

  test('still rejects everything it rejected before state existed', () => {
    expect(isSingletonMessage({ kind: 'HandOverRequest', typeName: 'counter' })).toBe(false);
    expect(isSingletonMessage({ kind: 'singleton.Unknown', typeName: 'counter' })).toBe(false);
    expect(isSingletonMessage({ kind: 'singleton.HandOverRequest' })).toBe(false);
    expect(isSingletonMessage({ kind: 'singleton.HandOverRequest', typeName: 7 })).toBe(false);
    expect(isSingletonMessage(null)).toBe(false);
    expect(isSingletonMessage('singleton.HandOverRequest')).toBe(false);
  });
});
