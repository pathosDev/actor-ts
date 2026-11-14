/**
 * Payloads nobody chose, fed to the WebSocket inbound path (#1369).
 *
 * The RFC 6455 framing itself is not parsed here: the backends (`ws`, Bun's
 * and Deno's servers, a native client `WebSocket`) take the frames off the
 * socket and hand over a payload.  What this framework parses is everything
 * after that, in the order `WebsocketConnectionActor.handleInbound` runs it:
 * `normalizeInbound` turns whatever shape the backend delivered into a frame,
 * `frameByteLength` measures it against the route's frame cap, and the
 * route's codec decodes it.  These properties feed each step arbitrary input:
 *
 *  - `normalizeInbound` keeps every byte of a binary payload, in order,
 *    however the backend shaped it — one buffer, an `ArrayBuffer`, a view into
 *    a larger buffer, or the fragment list `ws` delivers;
 *  - `frameByteLength` is the UTF-8 size of any string, since that is what the
 *    cap is written in;
 *  - `jsonCodec().decode` returns a value or throws `WebsocketDecodeError`
 *    carrying the frame, for arbitrary bytes, arbitrary text and a validator
 *    that throws anything at all.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { frameByteLength, normalizeInbound, utf8ByteLength, type WebsocketFrame } from '../../../../src/http/websocket/Types.js';
import { jsonCodec, WebsocketDecodeError } from '../../../../src/http/websocket/WebsocketCodec.js';
import { foreignError, outcomeOf } from '../../../util/DecoderFuzz.js';

/** A payload shape a backend delivers, built around the same bytes. */
const deliveredShape = fc.tuple(
  fc.uint8Array({ maxLength: 64 }),
  fc.constantFrom('uint8array', 'arraybuffer', 'offset-view', 'fragments'),
  fc.array(fc.integer({ min: 1, max: 16 }), { maxLength: 6 }),
).map(([bytes, shape, cuts]) => {
  if (shape === 'uint8array') return { bytes, delivered: bytes as unknown };
  if (shape === 'arraybuffer') return { bytes, delivered: bytes.slice().buffer as unknown };
  if (shape === 'offset-view') {
    // A view into the middle of a larger buffer, as a pooled `Buffer` is.
    const backing = new Uint8Array(bytes.byteLength + 8).fill(0xee);
    backing.set(bytes, 4);
    return { bytes, delivered: backing.subarray(4, 4 + bytes.byteLength) as unknown };
  }
  const fragments: Uint8Array[] = [];
  let offset = 0;
  for (const cut of cuts) {
    if (offset >= bytes.byteLength) break;
    fragments.push(bytes.slice(offset, offset + cut));
    offset += cut;
  }
  fragments.push(bytes.slice(offset));
  return { bytes, delivered: fragments as unknown };
});

/** Strings of every UTF-16 shape, lone surrogates included — which `String` holds and a socket can deliver. */
const anyString = fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }), fc.string({ unit: fc.integer({ min: 0xd7f0, max: 0xe010 }).map((code) => String.fromCharCode(code)) }));

/** Decode through the route's codec, recording rather than propagating. */
function decodeOutcome(frame: WebsocketFrame, validate?: (value: unknown) => unknown) {
  return outcomeOf(() => jsonCodec<never, unknown>(validate === undefined ? {} : { validate }).decode(frame));
}

describe('normalizeInbound over arbitrary payloads', () => {
  test('property: a binary payload keeps every byte in order, whatever shape the backend delivered it in', () => {
    fc.assert(fc.property(deliveredShape, ({ bytes, delivered }) => {
      const frame = normalizeInbound(delivered);
      expect(frame?.kind).toBe('binary');
      expect([...(frame as { data: Uint8Array }).data]).toEqual([...bytes]);
      expect(frameByteLength(frame!)).toBe(bytes.byteLength);
    }));
  });
});

describe('frameByteLength over arbitrary strings', () => {
  test('a lone high surrogate is the three bytes TextEncoder writes for it, and swallows no neighbour (#1369)', () => {
    // The property's counterexample first, then its parts: the count took
    // every high surrogate as the start of a pair, so an unpaired one counted
    // four bytes and skipped the character after it.
    expect(utf8ByteLength('\udde7\ude60\ud959')).toBe(9);
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('\ud800\ud800')).toBe(6);
    expect(utf8ByteLength('\ud800a')).toBe(4);
    expect(utf8ByteLength('𐀀')).toBe(4);
  });

  test('property: the size the frame cap is held against is the UTF-8 size of the text', () => {
    fc.assert(fc.property(anyString, (text) => {
      expect(frameByteLength({ kind: 'text', data: text })).toBe(new TextEncoder().encode(text).byteLength);
    }));
  });
});

describe('jsonCodec over arbitrary frames', () => {
  test('property: arbitrary bytes or text decode, or throw WebsocketDecodeError carrying the frame', () => {
    const frames: fc.Arbitrary<WebsocketFrame> = fc.oneof(
      fc.uint8Array({ maxLength: 64 }).map((data) => ({ kind: 'binary' as const, data })),
      anyString.map((data) => ({ kind: 'text' as const, data })),
      fc.jsonValue().map((value) => ({ kind: 'text' as const, data: JSON.stringify(value) })),
    );
    fc.assert(fc.property(frames, (frame) => {
      const outcome = decodeOutcome(frame);
      expect(foreignError(outcome, [WebsocketDecodeError])).toBeNull();
      if (outcome.kind === 'threw') expect((outcome.error as WebsocketDecodeError).frame).toBe(frame);
    }));
  });

  test('property: a validator throwing anything at all surfaces as WebsocketDecodeError, never as itself', () => {
    fc.assert(fc.property(fc.jsonValue(), fc.anything(), (value, thrown) => {
      const frame: WebsocketFrame = { kind: 'text', data: JSON.stringify(value) };
      const outcome = decodeOutcome(frame, () => {
        throw thrown;
      });
      expect(foreignError(outcome, [WebsocketDecodeError])).toBeNull();
      expect(outcome.kind).toBe('threw');
      expect((outcome as { error: WebsocketDecodeError }).error.cause).toBe(thrown);
    }));
  });
});
