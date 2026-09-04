import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CborDecodeError, CborDecoder, CborEncoder } from '../../../src/serialization/CborCodec.js';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { MAX_NESTING_DEPTH } from '../../../src/serialization/Constants.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { decodeJsonTree, encodeJsonTree } from '../../../src/serialization/JsonTree.js';
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_STRING_LENGTH,
  ReadConstraintsOptions,
  ReadConstraintsOptionsValidator,
  readReadConstraintsOptionsFromConfig,
} from '../../../src/serialization/ReadConstraintsOptions.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * `actor-ts.serialization.read-constraints.*` and the two decoders behind it
 * (#880).
 *
 * The JSON half is the part with no prior coverage at all: `decodeJsonTree`
 * recursed once per level with no counter, and `JSON.parse` supplies nothing
 * to inherit — it is iterative in every runtime this project supports, so the
 * only thing that ever stopped a nested payload was the JS stack running out.
 * Every tagged container gets its own case below, because the depth counter is
 * threaded through each recursion site by hand and a missed one is silently
 * unguarded for exactly that shape.
 */

/** `n` levels of plain array nesting, as the JSON text a peer would send. */
function nestedArrayJson(levels: number): string {
  return '['.repeat(levels) + ']'.repeat(levels);
}

/** One CBOR text string of `length` bytes, header included. */
function cborTextString(length: number): Uint8Array {
  const out = new Uint8Array(5 + length);
  out[0] = 0x60 | 26; // major 3 (text), 4-byte length
  new DataView(out.buffer).setUint32(1, length, false);
  out.fill(0x61, 5); // 'a'
  return out;
}

describe('read constraints — the shipped defaults', () => {
  test('the nesting default IS the encoder ceiling, so the halves start equal', () => {
    // Not "both happen to be 256": the read default is *derived* from the
    // encoder's constant, so a future change to one cannot leave the other
    // behind and silently reintroduce the #1036 asymmetry.
    expect(DEFAULT_MAX_NESTING_DEPTH).toBe(MAX_NESTING_DEPTH);
  });

  test('the string ceiling sits above the wire frame cap, and the document one is off', () => {
    // Documented as inert on the cluster wire — a CBOR string large enough to
    // reach it cannot fit in a frame the frame cap admits.
    expect(DEFAULT_MAX_STRING_LENGTH).toBeGreaterThan(16 * 1024 * 1024);
    expect(DEFAULT_MAX_DOCUMENT_BYTES).toBe(0);
  });
});

describe('JSON tree — the depth cap reaches every recursion site', () => {
  test('a payload past the cap is a SerializationError, not a stack overflow', () => {
    const parsed = JSON.parse(nestedArrayJson(4_000)) as unknown;
    // The pre-#880 walker accepted this silently: 4 000 levels is far short of
    // the ~200 000 at which the stack actually gives out, so a test that only
    // looked for a crash would have proved nothing about the cap.
    expect(() => decodeJsonTree(parsed)).toThrow(SerializationError);
    expect(() => decodeJsonTree(parsed)).toThrow(/nesting deeper than 256/);
  });

  test('ordinary payloads are untouched at the default', () => {
    expect(decodeJsonTree(JSON.parse(nestedArrayJson(200)))).toBeInstanceOf(Array);
    expect(decodeJsonTree({ a: [{ b: [{ c: 1 }] }] })).toEqual({ a: [{ b: [{ c: 1 }] }] });
  });

  test('a lower cap refuses what the default accepts, a higher one takes it back', () => {
    const parsed = JSON.parse(nestedArrayJson(40)) as unknown;
    expect(() => decodeJsonTree(parsed, { maxNestingDepth: 8 })).toThrow(SerializationError);
    expect(decodeJsonTree(parsed, { maxNestingDepth: 64 })).toBeInstanceOf(Array);
  });

  // Each tagged container re-enters the walker through its own hand-written
  // call.  A bare nested array would exercise one of them; these exercise the
  // rest, which is where a missed `childDepth` would hide.
  const deepPlainObject = (levels: number): unknown => {
    let node: unknown = 1;
    for (let i = 0; i < levels; i++) node = { nested: node };
    return node;
  };

  test.each([
    ['__map__', (inner: unknown) => new Map([['k', inner]])],
    ['__set__', (inner: unknown) => new Set([inner])],
    ['__error__', (inner: unknown) => Object.assign(new Error('boom'), { cause: inner })],
    ['plain object', (inner: unknown) => ({ nested: inner })],
    ['array', (inner: unknown) => [inner]],
  ])('%s recursion is charged against the cap', (_tag, wrap) => {
    // Encoded once with the real encoder, so the tree under test is the exact
    // shape the walker meets on the wire rather than a hand-written guess at it.
    const tree = encodeJsonTree(wrap(deepPlainObject(60)));
    expect(() => decodeJsonTree(tree, { maxNestingDepth: 10 })).toThrow(SerializationError);
    // Assigned rather than returned: an `__error__` payload decodes TO an
    // `Error`, and a callback that returns one reads to `not.toThrow` as a
    // throw.
    let decoded: unknown;
    expect(() => { decoded = decodeJsonTree(tree, { maxNestingDepth: 200 }); }).not.toThrow();
    expect(decoded).toBeDefined();
  });

  test('the __literal__ escape does not open a hole in the cap', () => {
    // The escape re-enters through `decodePlainObject` rather than
    // `decodeNode`, which is the one path that could have been left uncharged.
    const tree = encodeJsonTree({ __map__: deepPlainObject(60) });
    expect(() => decodeJsonTree(tree, { maxNestingDepth: 10 })).toThrow(SerializationError);
    let decoded: unknown;
    expect(() => { decoded = decodeJsonTree(tree, { maxNestingDepth: 200 }); }).not.toThrow();
    expect(decoded).toEqual({ __map__: deepPlainObject(60) });
  });
});

describe('CBOR — the configurable ceilings', () => {
  test('the #618 default still refuses a 100k-deep payload', () => {
    const deep = new Uint8Array(100_000).fill(0x81);
    expect(() => new CborDecoder().decode(deep)).toThrow(CborDecodeError);
  });

  test('a lower depth refuses what the default accepts', () => {
    const encoded = new CborEncoder().encode([[[[[[[[[[1]]]]]]]]]]);
    expect(new CborDecoder().decode(encoded)).toBeInstanceOf(Array);
    expect(() => new CborDecoder({ maxNestingDepth: 3 }).decode(encoded))
      .toThrow(/nesting deeper than 3/);
    expect(new CborDecoder({ maxNestingDepth: 32 }).decode(encoded)).toBeInstanceOf(Array);
  });

  test('an over-long string is refused on its length prefix, before the bytes', () => {
    // 64 KiB of payload against a 1 KiB ceiling.  The header alone decides it,
    // which is what makes the check worth having.
    const payload = cborTextString(64 * 1024);
    expect(() => new CborDecoder({ maxStringLength: 1024 }).decode(payload))
      .toThrow(/exceeds maxStringLength 1024/);
    expect(new CborDecoder({ maxStringLength: 128 * 1024 }).decode(payload)).toHaveLength(64 * 1024);
  });

  test('a truncated header cannot buy an allocation past the ceiling', () => {
    // Claims 4 GiB, carries nothing.  Refused by the ceiling rather than by
    // `readBytes`'s truncation check, i.e. without the slice being attempted.
    const claim = new Uint8Array([0x7a, 0xff, 0xff, 0xff, 0xff]);
    expect(() => new CborDecoder({ maxStringLength: 1024 }).decode(claim))
      .toThrow(/exceeds maxStringLength/);
  });

  test('0 removes the string ceiling', () => {
    const payload = cborTextString(4096);
    expect(new CborDecoder({ maxStringLength: 0 }).decode(payload)).toHaveLength(4096);
  });
});

describe('the serializers carry the ceilings', () => {
  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

  test('JsonSerializer refuses a document past maxDocumentBytes before parsing', () => {
    const serializer = new JsonSerializer({ maxDocumentBytes: 16 });
    expect(() => serializer.fromBinary(bytesOf('{"a":"'.padEnd(64, 'x') + '"}'), ''))
      .toThrow(/exceeds maxDocumentBytes 16/);
    expect(serializer.fromBinary(bytesOf('{"a":1}'), '')).toEqual({ a: 1 });
  });

  test('JsonSerializer applies the depth cap to untrusted bytes', () => {
    const serializer = new JsonSerializer({ maxNestingDepth: 8 });
    expect(() => serializer.fromBinary(bytesOf(nestedArrayJson(40)), ''))
      .toThrow(SerializationError);
    expect(serializer.fromBinary(bytesOf(nestedArrayJson(4)), '')).toBeInstanceOf(Array);
  });

  test('CborSerializer refuses a document past maxDocumentBytes', () => {
    const serializer = new CborSerializer({ maxDocumentBytes: 8 });
    const encoded = serializer.toBinary({ a: 'a fairly ordinary but not tiny string' });
    expect(() => serializer.fromBinary(encoded, '')).toThrow(/exceeds maxDocumentBytes 8/);
  });

  test('CborSerializer passes its depth cap down to the decoder it builds', () => {
    const serializer = new CborSerializer({ maxNestingDepth: 3 });
    const encoded = new CborEncoder().encode([[[[[1]]]]]);
    expect(() => serializer.fromBinary(encoded, '')).toThrow(/nesting deeper than 3/);
  });

  test('both keep their historical behaviour when constructed with nothing', () => {
    expect(new JsonSerializer().fromBinary(bytesOf(nestedArrayJson(100)), '')).toBeInstanceOf(Array);
    const encoded = new CborSerializer().toBinary({ a: [1, 2, 3] });
    expect(new CborSerializer().fromBinary(encoded, '')).toEqual({ a: [1, 2, 3] });
  });
});

describe('validation', () => {
  const validate = (settings: Record<string, number>): void => {
    new ReadConstraintsOptionsValidator().validate(settings);
  };

  test('the read depth may not exceed the encoder ceiling', () => {
    expect(() => validate({ maxNestingDepth: MAX_NESTING_DEPTH })).not.toThrow();
    expect(() => validate({ maxNestingDepth: MAX_NESTING_DEPTH + 1 })).toThrow(OptionsError);
    expect(() => validate({ maxNestingDepth: MAX_NESTING_DEPTH + 1 }))
      .toThrow(/must not exceed the encoder/);
  });

  test('a depth of zero or below is refused, a byte ceiling of zero is not', () => {
    expect(() => validate({ maxNestingDepth: 0 })).toThrow(OptionsError);
    expect(() => validate({ maxDocumentBytes: 0 })).not.toThrow();
    expect(() => validate({ maxStringLength: 0 })).not.toThrow();
    expect(() => validate({ maxStringLength: -1 })).toThrow(OptionsError);
  });

  test('a decoder built past the ceiling fails at construction, not at decode', () => {
    expect(() => new CborDecoder({ maxNestingDepth: MAX_NESTING_DEPTH + 1 })).toThrow(OptionsError);
  });
});

describe('config', () => {
  test('the shipped reference values are what the reader returns', () => {
    const fromConfig = readReadConstraintsOptionsFromConfig(Config.parseString(REFERENCE_CONF));
    expect(fromConfig).toEqual({
      maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH,
      maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
      maxStringLength: DEFAULT_MAX_STRING_LENGTH,
    });
  });

  test('an absent key is absent, not an explicit undefined', () => {
    // `Config.parseString`, never `Config.fromObject({'actor-ts.x.y': …})`:
    // the latter keeps the dotted string as one literal top-level key, so
    // `hasPath` would resolve the reference.conf value underneath and the
    // assertion would be about nothing.
    const config = Config.parseString(`
      actor-ts.serialization.read-constraints.max-nesting-depth = 32
    `);
    const fromConfig = readReadConstraintsOptionsFromConfig(config);
    expect(fromConfig).toEqual({ maxNestingDepth: 32 });
    expect('maxDocumentBytes' in fromConfig).toBe(false);
  });

  test('explicit options beat HOCON, which beats the built-in default', () => {
    const config = Config.parseString(`
      actor-ts.serialization.read-constraints {
        max-nesting-depth = 32
        max-string-length = 4M
      }
    `);
    const fromConfig = readReadConstraintsOptionsFromConfig(config);
    expect(fromConfig.maxNestingDepth).toBe(32);
    expect(fromConfig.maxStringLength).toBe(4 * 1024 * 1024);

    const explicit = ReadConstraintsOptions.create().withMaxNestingDepth(8);
    const merged = { ...fromConfig, ...explicit.build() };

    // Per field: explicit where it was set, HOCON where it was not, and the
    // built-in default where neither had an opinion.
    expect(merged.maxNestingDepth).toBe(8);
    expect(merged.maxStringLength).toBe(4 * 1024 * 1024);
    expect(merged.maxDocumentBytes).toBeUndefined();
    expect(new CborDecoder(merged as Record<string, number>).decode(new CborEncoder().encode(1)))
      .toBe(1);
  });

  test('a builder is structurally the options bag consumers read', () => {
    const options = ReadConstraintsOptions.create()
      .withMaxNestingDepth(16)
      .withMaxDocumentBytes(1024)
      .withMaxStringLength(512);
    expect({ ...options }).toEqual({
      maxNestingDepth: 16,
      maxDocumentBytes: 1024,
      maxStringLength: 512,
    });
    const decoder = new CborDecoder(options);
    expect(() => decoder.decode(cborTextString(4096))).toThrow(/exceeds maxStringLength 512/);
  });
});
