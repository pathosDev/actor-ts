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
import { Config, ConfigError } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  extractFrames,
  extractLengthPrefixedFrames,
  extractLineFrames,
  findFramingViolation,
  readFramingFromConfig,
  RETIRED_TCP_FRAMING_LEAVES,
} from '../../../../src/io/broker/TcpFraming.js';
import type { FrameExtraction, TcpFramingKeys } from '../../../../src/io/broker/TcpFraming.js';
import { TcpServerOptionsValidator } from '../../../../src/io/broker/TcpServerOptions.js';
import { TcpSocketOptionsValidator } from '../../../../src/io/broker/TcpSocketOptions.js';
import { expectExactOptions } from '../../../util/ExactOptions.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * What is left pending after a pass.
 *
 * A count, not an array, is what the extractors report (#610): the window
 * belongs to whoever owns the buffer, and slicing a fresh array off it per
 * chunk is the copy the incremental buffer exists to avoid.  A view over the
 * tail is the reading the caller applies to its own cursor.
 */
const pendingAfter = (buffer: Uint8Array, pass: FrameExtraction): Uint8Array =>
  buffer.subarray(pass.consumed);

/** Accumulate chunks the way `TcpInboundBuffer` does, minus its slab. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  return merged;
}

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

describe('extractLineFrames', () => {
  test('delivers terminated lines and keeps the remainder', () => {
    const buffer = encode('a\nbb\nccc');
    const result = extractLineFrames(buffer, '\n', 8);
    expect(result.frames).toEqual(['a', 'bb']);
    expect(result.overflow).toBeUndefined();
    expect(decode(pendingAfter(buffer, result))).toBe('ccc');
  });

  test('consumes nothing when the line is still partial', () => {
    const buffer = encode('partial');
    const result = extractLineFrames(buffer, '\n', 8);
    expect(result.frames).toEqual([]);
    // Nothing taken: no decode/encode round-trip, and no re-slice, for a line
    // that is still arriving.
    expect(result.consumed).toBe(0);
  });

  test('an over-long TERMINATED line reports overflow and stops there', () => {
    const result = extractLineFrames(encode('ok\n' + 'x'.repeat(20) + '\nlater\n'), '\n', 8);
    expect(result.frames).toEqual(['ok']);   // everything before the breach still delivered
    expect(result.overflow).toMatch(/maxLineBytes=8/);
  });

  test('an over-long UNTERMINATED remainder reports overflow (BRK-1)', () => {
    // The unbounded-buffer case: a peer streaming delimiter-free bytes must
    // not be able to grow the caller's buffer without limit.
    const result = extractLineFrames(encode('x'.repeat(32)), '\n', 8);
    expect(result.frames).toEqual([]);
    // The cap is named in this branch's text too, not only in the terminated
    // one: the two are separate template strings, and either can keep a stale
    // field name on its own.
    expect(result.overflow).toMatch(/unterminated line exceeds maxLineBytes=8/);
  });

  test('honours a multi-character delimiter', () => {
    const buffer = encode('a\r\nb\r\nc');
    const result = extractLineFrames(buffer, '\r\n', 64);
    expect(result.frames).toEqual(['a', 'b']);
    expect(decode(pendingAfter(buffer, result))).toBe('c');
  });

  test('the cap counts BYTES, not decoded characters (#752)', () => {
    // U+20AC is three UTF-8 bytes but one UTF-16 code unit, so a cap measured
    // on the decoded string let a peer buffer 3x what the validator promises
    // ("a positive integer number of bytes").  Both checks must see bytes.
    const unterminated = extractLineFrames(encode('€'.repeat(4)), '\n', 8);  // 12 bytes / 4 units
    expect(unterminated.overflow).toMatch(/unterminated line/);
    const terminated = extractLineFrames(encode('€€€\n'), '\n', 8);          // 9-byte line
    expect(terminated.overflow).toMatch(/maxLineBytes=8/);
    expect(terminated.frames).toEqual([]);
  });

  test('a line of exactly maxLineBytes still passes', () => {
    // The boundary the byte comparison must not move: `>`, not `>=`.
    const result = extractLineFrames(encode('€€\n'), '\n', 6);
    expect(result.overflow).toBeUndefined();
    expect(result.frames).toEqual(['€€']);
  });

  test('a character split across chunks survives the boundary (#610)', () => {
    // 'ä' is C3 A4.  Decoding the whole buffer turned a trailing lone C3 into
    // U+FFFD and re-encoded THAT into the leftover, so the A4 arriving in the
    // next chunk could never repair it.  Raw bytes go back untouched.
    const firstChunk = new Uint8Array([...encode('a\n'), 0xc3]);
    const first = extractLineFrames(firstChunk, '\n', 64);
    expect(first.frames).toEqual(['a']);
    expect([...pendingAfter(firstChunk, first)]).toEqual([0xc3]);

    const merged = concat(pendingAfter(firstChunk, first), new Uint8Array([0xa4, 0x0a]));
    const second = extractLineFrames(merged, '\n', 64, first.scanFrom);
    expect(second.frames).toEqual(['ä']);
  });

  test('a delimiter-free stream re-searches nothing (#610)', () => {
    // Half the quadratic claim, made observable: after every chunk the
    // reported `scanFrom` already covers the whole pending buffer, so the next
    // pass starts at its end instead of re-decoding all of it from offset 0.
    // (The other half — that appending the chunk does not re-copy the buffer
    // either — is `TcpInboundBuffering.test.ts`.)
    let buffer: Uint8Array = new Uint8Array(0);
    let scanFrom = 0;
    let passes = 0;
    for (let chunk = 0; chunk < 16; chunk++) {
      buffer = concat(buffer, encode('x'.repeat(64)));
      const pass = extractLineFrames(buffer, '\n', 4096, scanFrom);
      expect(pass.frames).toEqual([]);
      expect(pass.overflow).toBeUndefined();
      expect(pass.consumed).toBe(0);          // no line completed, nothing taken
      scanFrom = pass.scanFrom ?? 0;
      expect(scanFrom).toBe(buffer.length);   // nothing left to look at twice
      passes++;
    }
    expect(passes).toBe(16);
    expect(buffer.length).toBe(16 * 64);
  });

  test('a multi-byte delimiter straddling the resume point is still found', () => {
    // The trap in resuming: stopping at the buffer's end would step over a
    // '\r' whose '\n' is in the next chunk, and that line never completes.
    const firstChunk = encode('abc\r');
    const first = extractLineFrames(firstChunk, '\r\n', 64);
    expect(first.frames).toEqual([]);
    expect(first.scanFrom).toBe(3);          // backed off, so the '\r' is re-read

    const merged = concat(pendingAfter(firstChunk, first), encode('\ndef'));
    const second = extractLineFrames(merged, '\r\n', 64, first.scanFrom);
    expect(second.frames).toEqual(['abc']);
    expect(decode(pendingAfter(merged, second))).toBe('def');
  });

  test('an out-of-range scanFrom cannot push the scan outside the buffer', () => {
    // Defensive only — the contract is that the caller hands back the value
    // the previous pass reported.  A negative one must not read behind the
    // buffer, one past the end must not index outside it.
    expect(extractLineFrames(encode('a\nb'), '\n', 64, -5).frames).toEqual(['a']);
    const buffer = encode('ab');
    const beyond = extractLineFrames(buffer, '\n', 64, 9_999);
    expect(beyond.frames).toEqual([]);
    expect(decode(pendingAfter(buffer, beyond))).toBe('ab');
  });
});

describe('extractLengthPrefixedFrames', () => {
  test('peels whole frames and keeps a partial tail', () => {
    const buffer = concat(lengthPrefixed('one', 'two'), new Uint8Array([0, 0, 0, 9, 1, 2]));
    const result = extractLengthPrefixedFrames(buffer, DEFAULT_MAX_FRAME_BYTES);
    expect(result.frames.map((f) => decode(f as Uint8Array))).toEqual(['one', 'two']);
    expect(result.overflow).toBeUndefined();
    // The 9-byte frame is still arriving, so its 6 bytes stay pending.
    expect(pendingAfter(buffer, result).length).toBe(6);
  });

  test('a header shorter than 4 bytes is kept, not misread', () => {
    const buffer = new Uint8Array([0, 0, 3]);
    const result = extractLengthPrefixedFrames(buffer, DEFAULT_MAX_FRAME_BYTES);
    expect(result.frames).toEqual([]);
    expect(result.consumed).toBe(0);
  });

  test('a zero-length frame is a frame', () => {
    const result = extractLengthPrefixedFrames(lengthPrefixed(''), DEFAULT_MAX_FRAME_BYTES);
    expect(result.frames.length).toBe(1);
    expect((result.frames[0] as Uint8Array).length).toBe(0);
  });

  test('rejects a DECLARED length past the cap, before waiting for the body', () => {
    // The attack: four bytes claiming 4 GiB. Waiting for the payload to
    // arrive before checking is what would let it allocate.
    const header = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const result = extractLengthPrefixedFrames(header, 1024);
    expect(result.overflow).toMatch(/maxFrameBytes=1024/);
    expect(result.frames).toEqual([]);
  });

  test('reads the prefix as unsigned — a high bit is not a negative length', () => {
    const header = new Uint8Array([0x80, 0x00, 0x00, 0x00]);
    const result = extractLengthPrefixedFrames(header, 1024);
    // 0x80000000 unsigned = 2 GiB, which is over the cap; signed it would be
    // negative and slip through every `length > cap` test.
    expect(result.overflow).toMatch(/maxFrameBytes/);
  });
});

describe('extractFrames — strategy dispatch and defaults', () => {
  test('bytes hands the whole buffer over and consumes it', () => {
    const buffer = encode('anything');
    const result = extractFrames(buffer, { kind: 'bytes' });
    expect(result.frames).toEqual([buffer]);
    expect(pendingAfter(buffer, result).length).toBe(0);
  });

  test('lines defaults to a newline delimiter', () => {
    expect(extractFrames(encode('a\nb'), { kind: 'lines' }).frames).toEqual(['a']);
  });

  test('the unset caps fall through to the shipped defaults', () => {
    // Just under the default line cap: no overflow, still pending.
    const long = 'x'.repeat(DEFAULT_MAX_LINE_BYTES - 1);
    expect(extractFrames(encode(long), { kind: 'lines' }).overflow).toBeUndefined();
    // Just over it.
    const tooLong = 'x'.repeat(DEFAULT_MAX_LINE_BYTES + 1);
    expect(extractFrames(encode(tooLong), { kind: 'lines' }).overflow).toMatch(/unterminated/);
  });
});

describe('findFramingViolation', () => {
  test('passes when the caps are unset — they fall through to the defaults', () => {
    expect(findFramingViolation(undefined)).toBeUndefined();
    expect(findFramingViolation({ kind: 'lines' })).toBeUndefined();
    expect(findFramingViolation({ kind: 'bytes' })).toBeUndefined();
  });

  test('names the offending field for a NaN cap', () => {
    expect(findFramingViolation({ kind: 'lines', maxLineBytes: Number.NaN })?.field)
      .toBe('framing.maxLineBytes');
    expect(findFramingViolation({ kind: 'length-prefixed', maxFrameBytes: -1 })?.field)
      .toBe('framing.maxFrameBytes');
  });

  test('rejects an empty delimiter — it would wedge the extractor (#789)', () => {
    // The primary proof, and deliberately at this level: an empty delimiter
    // never reaches the extractor because the validators refuse the settings
    // in preStart, before a socket exists.
    const violation = findFramingViolation({ kind: 'lines', delimiter: '' });
    expect(violation?.field).toBe('framing.delimiter');
    expect(violation?.value).toBe('');
    // One rule, both actors: the client and the listener delegate here, so
    // neither validator can be the one that forgot.
    const framing = { kind: 'lines', delimiter: '' } as const;
    expect(() => new TcpSocketOptionsValidator().validate({ framing }))
      .toThrow(/framing\.delimiter/);
    expect(() => new TcpServerOptionsValidator().validate({ framing }))
      .toThrow(/framing\.delimiter/);
  });

  test('a delimiter that is set and non-empty passes', () => {
    expect(findFramingViolation({ kind: 'lines', delimiter: '\r\n' })).toBeUndefined();
    expect(findFramingViolation({ kind: 'lines', delimiter: '\0' })).toBeUndefined();
  });
});

/*
 * Where the framing block meets HOCON (#1443).  The block hangs under both TCP
 * roots, so its leaves are composed once, by `tcpFramingKeysUnder` in
 * `ConfigKeys`, and the reader is handed the system config and one root's
 * keys — the way every broker reader addresses its block.  The two caps are
 * sizes, read with `getBytes`, so `64K` is 65 536 bytes.  Their camelCase
 * spellings, which were also the names of the fields until those were named
 * after the unit they count, are refused by name: both caps bound what an
 * untrusted peer can make the actor buffer, and an ignored one would restore
 * the built-in default without a word.
 */
describe('readFramingFromConfig', () => {
  const tcp = ConfigKeys.io.broker.tcp.framing;
  const tcpServer = ConfigKeys.io.broker.tcpServer.framing;

  /** What reading `hocon` through `keys` throws, or a failure naming its absence. */
  function refusalOf(hocon: string, keys: TcpFramingKeys): ConfigError {
    try {
      readFramingFromConfig(Config.parseString(hocon), keys);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return e as ConfigError;
    }
    throw new Error(`nothing refused ${hocon}`);
  }

  test('the block\'s leaves are kebab-case under both TCP roots, and the caps keep their unit', () => {
    expectExactOptions(tcp, {
      root: 'actor-ts.io.broker.tcp.framing',
      kind: 'actor-ts.io.broker.tcp.framing.kind',
      delimiter: 'actor-ts.io.broker.tcp.framing.delimiter',
      maxLineBytes: 'actor-ts.io.broker.tcp.framing.max-line-bytes',
      maxFrameBytes: 'actor-ts.io.broker.tcp.framing.max-frame-bytes',
    });
    expectExactOptions(tcpServer, {
      root: 'actor-ts.io.broker.tcp-server.framing',
      kind: 'actor-ts.io.broker.tcp-server.framing.kind',
      delimiter: 'actor-ts.io.broker.tcp-server.framing.delimiter',
      maxLineBytes: 'actor-ts.io.broker.tcp-server.framing.max-line-bytes',
      maxFrameBytes: 'actor-ts.io.broker.tcp-server.framing.max-frame-bytes',
    });
  });

  test('the line cap lands in maxLineBytes', () => {
    const config = Config.parseString(`${tcp.root} { kind = "lines", max-line-bytes = 64 }`);
    expectExactOptions(readFramingFromConfig(config, tcp), { kind: 'lines', maxLineBytes: 64 });
  });

  test('the frame cap lands in maxFrameBytes', () => {
    const config = Config.parseString(`${tcp.root} { kind = "length-prefixed", max-frame-bytes = 4096 }`);
    expectExactOptions(readFramingFromConfig(config, tcp), { kind: 'length-prefixed', maxFrameBytes: 4096 });
  });

  test('both caps are sizes: 64K is 65536 bytes', () => {
    // `getInt` refuses `64K` outright, which is how the cap used to be read.
    const lines = Config.parseString(`${tcpServer.root} { kind = "lines", max-line-bytes = 64K }`);
    const prefixed = Config.parseString(`${tcpServer.root} { kind = "length-prefixed", max-frame-bytes = 64K }`);
    expectExactOptions(readFramingFromConfig(lines, tcpServer), { kind: 'lines', maxLineBytes: 65_536 });
    expectExactOptions(readFramingFromConfig(prefixed, tcpServer), { kind: 'length-prefixed', maxFrameBytes: 65_536 });
  });

  test('a delimiter is read beside the line cap, and an unset leaf is omitted', () => {
    const delimited = Config.parseString(`${tcp.root} { kind = "lines", delimiter = "|" }`);
    expectExactOptions(readFramingFromConfig(delimited, tcp), { kind: 'lines', delimiter: '|' });
    const bare = Config.parseString(`${tcp.root}.kind = "length-prefixed"`);
    expectExactOptions(readFramingFromConfig(bare, tcp), { kind: 'length-prefixed' });
  });

  test('each root\'s keys read that root\'s block and no other', () => {
    const config = Config.parseString(`
      ${tcp.root} { kind = "lines", max-line-bytes = 128 }
      ${tcpServer.root} { kind = "length-prefixed", max-frame-bytes = 256 }
    `);
    expectExactOptions(readFramingFromConfig(config, tcp), { kind: 'lines', maxLineBytes: 128 });
    expectExactOptions(readFramingFromConfig(config, tcpServer), { kind: 'length-prefixed', maxFrameBytes: 256 });
  });

  test('the field names are not leaves either', () => {
    // Nothing camelCase is read: not the retired leaf, and not the field name
    // a reader of the TypeScript might write instead.
    const lines = Config.parseString(`${tcp.root} { kind = "lines", maxLineBytes = 64 }`);
    const prefixed = Config.parseString(`${tcp.root} { kind = "length-prefixed", maxFrameBytes = 64 }`);
    expectExactOptions(readFramingFromConfig(lines, tcp), { kind: 'lines' });
    expectExactOptions(readFramingFromConfig(prefixed, tcp), { kind: 'length-prefixed' });
  });

  test('the retired table names exactly the two caps, each with its replacement', () => {
    expect(RETIRED_TCP_FRAMING_LEAVES).toEqual({ maxLineLen: 'max-line-bytes', maxFrameLen: 'max-frame-bytes' });
  });

  test.each([
    { retired: 'maxLineLen', current: 'max-line-bytes', kind: 'lines' },
    { retired: 'maxFrameLen', current: 'max-frame-bytes', kind: 'length-prefixed' },
  ])('$retired is refused under either root, naming $current and the renamed fields', ({ retired, current, kind }) => {
    for (const keys of [tcp, tcpServer]) {
      const refusal = refusalOf(`${keys.root} { kind = "${kind}", ${retired} = 4096 }`, keys);
      expect(refusal.message).toContain(`${keys.root}.${retired} has been renamed to ${keys.root}.${current}`);
      // The rename moved the TypeScript fields too, so the default note — no
      // code change needed — would be false here.
      expect(refusal.message).toContain('maxLineBytes');
      expect(refusal.message).toContain('maxFrameBytes');
      expect(refusal.message).not.toContain('field names and builder methods are unchanged');
    }
  });

  test('a retired cap is refused whatever kind it sits beside, before the kind is read', () => {
    // Beside the other strategy it would never have been read; without a
    // kind the block could not be read at all.  Neither hides the old name.
    expect(refusalOf(`${tcp.root} { kind = "bytes", maxFrameLen = 4096 }`, tcp).message)
      .toContain(`${tcp.root}.maxFrameLen has been renamed`);
    expect(refusalOf(`${tcpServer.root}.maxLineLen = 4096`, tcpServer).message)
      .toContain(`${tcpServer.root}.maxLineLen has been renamed`);
  });
});

describe('extractLineFrames — empty delimiter (#789)', () => {
  test('is refused outright rather than scanned with', () => {
    // NOTE for whoever breaks this: a regression here does not fail the test,
    // it WEDGES the run.  An empty delimiter matches at every offset without
    // consuming anything, and the scan loop is synchronous, so bun's per-test
    // timeout cannot interrupt it — the suite hangs until the growing frame
    // array exhausts memory.  The guard is the first statement in the
    // function precisely so this assertion can never be the thing that hangs.
    expect(() => extractLineFrames(encode('a\nb'), '', 64)).toThrow(/delimiter/);
    expect(() => extractLineFrames(new Uint8Array(0), '', 64)).toThrow(/delimiter/);
    expect(() => extractFrames(encode('a\nb'), { kind: 'lines', delimiter: '' }))
      .toThrow(/delimiter/);
  });
});
