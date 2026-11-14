/**
 * #967 / #1303 — the decode allow-list both untrusted edges share.
 *
 * `decodeJsonTree` was built to read back what this framework wrote, and on
 * that path every tag is an instruction worth following.  On a request body or
 * a cluster frame somebody else wrote the bytes, so a tag is a stranger
 * choosing the runtime class of a value.  `tags` is the one knob both edges
 * use to say which classes they will construct for a stranger: an empty list
 * is plain JSON, a non-empty list is the tagged format restricted to those
 * names, and leaving it out is the full set the persistence codec needs.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from '../../../src/serialization/Constants.js';
import { decodeJsonTree, encodeJsonTree, RefusedTagError } from '../../../src/serialization/JsonTree.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

/** One value per tag name, encoded by the real encoder so the fixture is a real tag. */
const SAMPLES: Readonly<Record<JsonTreeTagName, unknown>> = {
  'date': new Date('2026-11-14T00:00:00.000Z'),
  'bytes': new Uint8Array([1, 2, 3]),
  'map': new Map([['a', 1]]),
  'set': new Set(['x']),
  'bidirectional-map': new BidirectionalMap([['left', 1]]),
  'bidirectional-multi-map': new BidirectionalMultiMap([['left', 1]]),
  'bigint': 12n,
  'number': Number.NaN,
  'undefined': [undefined],
  'regexp': /(a+)+$/g,
  'url': new URL('file:///etc/passwd'),
  'error': new TypeError('x'),
  'typed-array': new Float64Array([1.5]),
};

/** What the tag object looks like on the wire, as a stranger would write it. */
function tagged(name: JsonTreeTagName): unknown {
  return JSON.parse(JSON.stringify(encodeJsonTree(SAMPLES[name], { undefinedValues: 'omit' })));
}

describe('tags: [] — plain JSON', () => {
  test('every tag arrives as the plain object the JSON said, not as a class', () => {
    for (const name of JSON_TREE_TAG_NAMES) {
      const wire = { value: tagged(name) };
      const decoded = decodeJsonTree(wire, { tags: [] });
      expect(decoded).toEqual(wire);
      const value = (decoded as { value: unknown }).value;
      // `undefined`'s sample is an array — what matters is that its slot is not
      // the `undefined` no `JSON.parse` can produce.
      const inner = Array.isArray(value) ? value[0] : value;
      expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
    }
  });

  test('the escape wrapper is plain data too — nothing in the body is format machinery', () => {
    const wire = { __literal__: { __date__: 'x' } };
    expect(decodeJsonTree(wire, { tags: [] })).toEqual(wire);
  });

  test('a malformed tag is not an error, because there is no tag', () => {
    expect(decodeJsonTree({ __regexp__: 5 }, { tags: [] })).toEqual({ __regexp__: 5 });
  });

  test('property: decoding any JSON document is the identity — what JSON.parse gave', () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const parsed = JSON.parse(JSON.stringify(value)) as unknown;
      expect(decodeJsonTree(parsed, { tags: [] })).toEqual(parsed);
    }));
  });

  test('property: reserved keys anywhere in the tree stay plain data', () => {
    const reservedKey = fc.constantFrom(
      '__date__', '__bytes__', '__map__', '__set__', '__bigint__', '__number__',
      '__undefined__', '__regexp__', '__url__', '__error__', '__typedarray__', '__literal__',
    );
    const hostile = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        fc.jsonValue({ maxDepth: 1 }),
        fc.tuple(reservedKey, tie('node')).map(([key, inner]) => ({ [key]: inner })),
        fc.array(tie('node'), { maxLength: 3 }),
      ),
    })).node;
    fc.assert(fc.property(hostile, (value) => {
      const parsed = JSON.parse(JSON.stringify(value)) as unknown;
      expect(decodeJsonTree(parsed, { tags: [] })).toEqual(parsed);
    }));
  });
});

describe('tags: [...] — an allow-list', () => {
  test('an admitted tag constructs its class', () => {
    const decoded = decodeJsonTree({ when: tagged('date') }, { tags: ['date'] }) as { when: unknown };
    expect(decoded.when).toBeInstanceOf(Date);
  });

  test('every tag outside the list is refused with a typed error naming it, at any depth', () => {
    for (const name of JSON_TREE_TAG_NAMES) {
      const others = JSON_TREE_TAG_NAMES.filter((candidate) => candidate !== name);
      let caught: unknown;
      try {
        decodeJsonTree({ outer: [{ inner: tagged(name) }] }, { tags: others });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RefusedTagError);
      expect(caught).toBeInstanceOf(SerializationError);
      expect((caught as RefusedTagError).tag).toBe(name);
      expect((caught as Error).message).toContain(name);
    }
  });

  test('a refused tag is refused before its content is read — a RegExp is never compiled', () => {
    // Malformed content would throw a "Malformed" error if it were read first.
    expect(() => decodeJsonTree({ __regexp__: { source: '(', flags: 'zz' } }, { tags: ['date'] }))
      .toThrow(RefusedTagError);
  });

  test('the escape wrapper is honoured, so data the encoder escaped round-trips', () => {
    const value = { __date__: 'not really a date' };
    const wire = JSON.parse(JSON.stringify(encodeJsonTree(value))) as unknown;
    expect(decodeJsonTree(wire, { tags: ['date'] })).toEqual(value);
  });

  test('an unknown name in the list is a programming error, reported as such', () => {
    expect(() => decodeJsonTree({}, { tags: ['regex' as JsonTreeTagName] }))
      .toThrow(/unknown JsonTree tag name 'regex'/);
  });
});

describe('no tags option — the full set, for bytes this framework wrote', () => {
  test('every sample round-trips through its own tag', () => {
    for (const name of JSON_TREE_TAG_NAMES) {
      expect(decodeJsonTree(tagged(name))).toEqual(SAMPLES[name]);
    }
  });

  test('listing every name is the same as leaving the option out', () => {
    for (const name of JSON_TREE_TAG_NAMES) {
      expect(decodeJsonTree(tagged(name), { tags: JSON_TREE_TAG_NAMES })).toEqual(SAMPLES[name]);
    }
  });
});
