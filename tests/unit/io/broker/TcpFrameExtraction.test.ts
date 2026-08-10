/**
 * The framing extractors, tested directly (#158).
 *
 * The algorithms used to be private methods on `TcpSocketActor`; the listener
 * needs the same three strategies **per accepted connection**, so they moved
 * into `TcpFraming` and are now shared rather than copied — four open
 * security issues hang off this parsing (#578, #610, #752, #789) and a second
 * copy would have to be fixed twice.
 *
 * `TcpFraming.test.ts` still drives `lines` through the actor, which is what
 * pins the extraction to the actor's observable behaviour.  This file covers
 * the functions themselves, including `length-prefixed`, which had no direct
 * coverage at all before the move.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_FRAME_LENGTH,
  DEFAULT_MAX_LINE_LENGTH,
  appendChunk,
  extractFrames,
  extractLengthPrefixedFrames,
  extractLineFrames,
  findFramingCapViolation,
} from '../../../../src/io/broker/TcpFraming.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** `[uint32 big-endian length][payload]`, the wire shape the extractor reads. */
function lengthPrefixed(...payloads: string[]): Uint8Array {
  const parts = payloads.map((payload) => {
    const body = encode(payload);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, false);
    frame.set(body, 4);
    return frame;
  });
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

describe('appendChunk', () => {
  test('hands the chunk straight back when there is nothing pending', () => {
    const chunk = encode('abc');
    expect(appendChunk(new Uint8Array(0), chunk)).toBe(chunk);
  });

  test('concatenates in order when a partial frame is pending', () => {
    expect(decode(appendChunk(encode('ab'), encode('cd')))).toBe('abcd');
  });
});

describe('extractLineFrames', () => {
  test('delivers terminated lines and keeps the remainder', () => {
    const result = extractLineFrames(encode('a\nbb\nccc'), '\n', 8);
    expect(result.frames).toEqual(['a', 'bb']);
    expect(result.overflow).toBeUndefined();
    expect(decode(result.remainder)).toBe('ccc');
  });

  test('returns the input buffer untouched when nothing was consumed', () => {
    const buffer = encode('partial');
    const result = extractLineFrames(buffer, '\n', 8);
    expect(result.frames).toEqual([]);
    // Same reference: no decode/encode round-trip for a still-partial line.
    expect(result.remainder).toBe(buffer);
  });

  test('an over-long TERMINATED line reports overflow and stops there', () => {
    const result = extractLineFrames(encode('ok\n' + 'x'.repeat(20) + '\nlater\n'), '\n', 8);
    expect(result.frames).toEqual(['ok']);   // everything before the breach still delivered
    expect(result.overflow).toMatch(/maxLineLen=8/);
  });

  test('an over-long UNTERMINATED remainder reports overflow (BRK-1)', () => {
    // The unbounded-buffer case: a peer streaming delimiter-free bytes must
    // not be able to grow the caller's buffer without limit.
    const result = extractLineFrames(encode('x'.repeat(32)), '\n', 8);
    expect(result.frames).toEqual([]);
    expect(result.overflow).toMatch(/unterminated line/);
  });

  test('honours a multi-character delimiter', () => {
    const result = extractLineFrames(encode('a\r\nb\r\nc'), '\r\n', 64);
    expect(result.frames).toEqual(['a', 'b']);
    expect(decode(result.remainder)).toBe('c');
  });
});

describe('extractLengthPrefixedFrames', () => {
  test('peels whole frames and keeps a partial tail', () => {
    const buffer = appendChunk(lengthPrefixed('one', 'two'), new Uint8Array([0, 0, 0, 9, 1, 2]));
    const result = extractLengthPrefixedFrames(buffer, DEFAULT_MAX_FRAME_LENGTH);
    expect(result.frames.map((f) => decode(f as Uint8Array))).toEqual(['one', 'two']);
    expect(result.overflow).toBeUndefined();
    expect(result.remainder.length).toBe(6);   // the 9-byte frame is still arriving
  });

  test('a header shorter than 4 bytes is kept, not misread', () => {
    const buffer = new Uint8Array([0, 0, 3]);
    const result = extractLengthPrefixedFrames(buffer, DEFAULT_MAX_FRAME_LENGTH);
    expect(result.frames).toEqual([]);
    expect(result.remainder).toBe(buffer);
  });

  test('a zero-length frame is a frame', () => {
    const result = extractLengthPrefixedFrames(lengthPrefixed(''), DEFAULT_MAX_FRAME_LENGTH);
    expect(result.frames.length).toBe(1);
    expect((result.frames[0] as Uint8Array).length).toBe(0);
  });

  test('rejects a DECLARED length past the cap, before waiting for the body', () => {
    // The attack: four bytes claiming 4 GiB. Waiting for the payload to
    // arrive before checking is what would let it allocate.
    const header = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const result = extractLengthPrefixedFrames(header, 1024);
    expect(result.overflow).toMatch(/maxFrameLen=1024/);
    expect(result.frames).toEqual([]);
  });

  test('reads the prefix as unsigned — a high bit is not a negative length', () => {
    const header = new Uint8Array([0x80, 0x00, 0x00, 0x00]);
    const result = extractLengthPrefixedFrames(header, 1024);
    // 0x80000000 unsigned = 2 GiB, which is over the cap; signed it would be
    // negative and slip through every `length > cap` test.
    expect(result.overflow).toMatch(/maxFrameLen/);
  });
});

describe('extractFrames — strategy dispatch and defaults', () => {
  test('bytes hands the whole buffer over and consumes it', () => {
    const buffer = encode('anything');
    const result = extractFrames(buffer, { kind: 'bytes' });
    expect(result.frames).toEqual([buffer]);
    expect(result.remainder.length).toBe(0);
  });

  test('lines defaults to a newline delimiter', () => {
    expect(extractFrames(encode('a\nb'), { kind: 'lines' }).frames).toEqual(['a']);
  });

  test('the unset caps fall through to the shipped defaults', () => {
    // Just under the default line cap: no overflow, still pending.
    const long = 'x'.repeat(DEFAULT_MAX_LINE_LENGTH - 1);
    expect(extractFrames(encode(long), { kind: 'lines' }).overflow).toBeUndefined();
    // Just over it.
    const tooLong = 'x'.repeat(DEFAULT_MAX_LINE_LENGTH + 1);
    expect(extractFrames(encode(tooLong), { kind: 'lines' }).overflow).toMatch(/unterminated/);
  });
});

describe('findFramingCapViolation', () => {
  test('passes when the caps are unset — they fall through to the defaults', () => {
    expect(findFramingCapViolation(undefined)).toBeUndefined();
    expect(findFramingCapViolation({ kind: 'lines' })).toBeUndefined();
    expect(findFramingCapViolation({ kind: 'bytes' })).toBeUndefined();
  });

  test('names the offending field for a NaN cap', () => {
    expect(findFramingCapViolation({ kind: 'lines', maxLineLen: Number.NaN })?.field)
      .toBe('framing.maxLineLen');
    expect(findFramingCapViolation({ kind: 'length-prefixed', maxFrameLen: -1 })?.field)
      .toBe('framing.maxFrameLen');
  });
});
