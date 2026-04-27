import { describe, expect, test } from 'bun:test';
import {
  deepMerge,
  isPlainObject,
  isSubstitution,
  parseHocon,
  resolveSubstitutions,
  stripUndefined,
} from '../../../src/config/HoconParser.js';

describe('parseHocon — JSON compatibility', () => {
  test('parses a minimal JSON object', () => {
    expect(parseHocon('{"a": 1, "b": "two", "c": true, "d": null}')).toEqual({
      a: 1, b: 'two', c: true, d: null,
    });
  });

  test('parses nested JSON', () => {
    expect(parseHocon('{"a":{"b":{"c":[1,2,3]}}}')).toEqual({
      a: { b: { c: [1, 2, 3] } },
    });
  });

  test('supports JSON strings with escapes', () => {
    expect(parseHocon('{"a":"hi\\nworld\\t\\"end"}')).toEqual({ a: 'hi\nworld\t"end' });
  });

  test('supports \\uXXXX escapes', () => {
    expect(parseHocon('{"a":"\\u00e9"}')).toEqual({ a: 'é' });
  });
});

describe('parseHocon — HOCON extensions', () => {
  test('allows implicit root object', () => {
    expect(parseHocon('a = 1\nb = two')).toEqual({ a: 1, b: 'two' });
  });

  test('accepts = or : as assignment', () => {
    expect(parseHocon('a = 1\nb : 2')).toEqual({ a: 1, b: 2 });
  });

  test('newlines work as field separators', () => {
    expect(parseHocon(`
      a = 1
      b = 2
      c = 3
    `)).toEqual({ a: 1, b: 2, c: 3 });
  });

  test('commas also work as separators', () => {
    expect(parseHocon('a=1, b=2, c=3')).toEqual({ a: 1, b: 2, c: 3 });
  });

  test('unquoted keys', () => {
    expect(parseHocon('foo-bar_baz = 42')).toEqual({ 'foo-bar_baz': 42 });
  });

  test('unquoted string values', () => {
    expect(parseHocon('name = hello-world')).toEqual({ name: 'hello-world' });
  });

  test('path expressions expand to nested objects', () => {
    expect(parseHocon('a.b.c = 1')).toEqual({ a: { b: { c: 1 } } });
  });

  test('object literal after key (no = / :)', () => {
    expect(parseHocon('foo { a = 1, b = 2 }')).toEqual({ foo: { a: 1, b: 2 } });
  });

  test('same key twice — scalars overwrite, objects merge', () => {
    expect(parseHocon(`
      foo = 1
      foo = 2
    `)).toEqual({ foo: 2 });
    expect(parseHocon(`
      foo { a = 1 }
      foo { b = 2 }
    `)).toEqual({ foo: { a: 1, b: 2 } });
  });

  test('deep path expressions merge instead of overwriting siblings', () => {
    expect(parseHocon(`
      a.b.c = 1
      a.b.d = 2
    `)).toEqual({ a: { b: { c: 1, d: 2 } } });
  });

  test('comments: # and //', () => {
    expect(parseHocon(`
      # first comment
      a = 1 # trailing
      // second comment
      b = 2 // trailing
    `)).toEqual({ a: 1, b: 2 });
  });

  test('arrays', () => {
    expect(parseHocon('xs = [1, two, true, null]'))
      .toEqual({ xs: [1, 'two', true, null] });
    expect(parseHocon('xs = [\n 1\n 2\n 3\n]')).toEqual({ xs: [1, 2, 3] });
  });

  test('literal bool / null / number detection', () => {
    expect(parseHocon('a = true\nb = false\nc = null\nd = -3.14e2'))
      .toEqual({ a: true, b: false, c: null, d: -314 });
  });

  test('numbers with decimals and signs', () => {
    expect(parseHocon('a = 1.5\nb = -.25\nc = +7'))
      .toEqual({ a: 1.5, b: -0.25, c: 7 });
  });

  test('captures substitutions as opaque nodes before resolution', () => {
    const parsed = parseHocon('a = ${foo.bar}\nb = ${?opt}');
    expect(isSubstitution(parsed.a)).toBe(true);
    expect((parsed.a as any).path).toBe('foo.bar');
    expect((parsed.a as any).optional).toBe(false);
    expect((parsed.b as any).optional).toBe(true);
  });

  test('raises a helpful error on malformed input', () => {
    expect(() => parseHocon('a = { b = 1')).toThrow(/parse error/);
  });

  test('rejects unterminated strings', () => {
    expect(() => parseHocon('a = "hello')).toThrow(/Unterminated string/);
  });
});

describe('resolveSubstitutions', () => {
  test('resolves to a path inside the same tree', () => {
    const parsed = parseHocon(`
      host = example.com
      url = \${host}
    `);
    // `\${host}` resolves to the string "example.com".
    expect(resolveSubstitutions(parsed)).toEqual({ host: 'example.com', url: 'example.com' });
  });

  test('throws when required substitution is missing', () => {
    const parsed = parseHocon('a = ${missing}');
    expect(() => resolveSubstitutions(parsed, {})).toThrow(/Unresolved substitution/);
  });

  test('optional substitutions stay undefined (and are stripped by Config)', () => {
    const parsed = parseHocon('a = ${?missing}');
    const resolved = resolveSubstitutions(parsed, {});
    expect(resolved.a).toBeUndefined();
  });

  test('pulls from the environment map', () => {
    const parsed = parseHocon('a = ${POD_IP}');
    const resolved = resolveSubstitutions(parsed, { POD_IP: '10.0.0.5' });
    expect(resolved.a).toBe('10.0.0.5');
  });

  test('maps dotted paths to uppercased underscore env vars', () => {
    const parsed = parseHocon('a = ${pod.ip}');
    const resolved = resolveSubstitutions(parsed, { POD_IP: '10.0.0.5' });
    expect(resolved.a).toBe('10.0.0.5');
  });

  test('ENV values that look like JSON are decoded', () => {
    const parsed = parseHocon('a = ${FLAG}\nb = ${COUNT}\nc = ${NESTED}');
    const resolved = resolveSubstitutions(parsed, {
      FLAG: 'true',
      COUNT: '42',
      NESTED: '{"x":1}',
    });
    expect(resolved.a).toBe(true);
    expect(resolved.b).toBe(42);
    expect(resolved.c).toEqual({ x: 1 });
  });

  test('stripUndefined removes optional-miss holes after resolution', () => {
    const parsed = parseHocon(`
      a = keep
      b = \${?nope}
    `);
    const resolved = resolveSubstitutions(parsed, {});
    expect(stripUndefined(resolved)).toEqual({ a: 'keep' });
  });
});

describe('deepMerge', () => {
  test('overlay wins for scalars', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('objects merge recursively', () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 20, z: 30 } }))
      .toEqual({ a: { x: 1, y: 20, z: 30 } });
  });

  test('arrays are replaced, not concatenated', () => {
    expect(deepMerge({ xs: [1, 2] }, { xs: [3] })).toEqual({ xs: [3] });
  });

  test('missing keys in overlay are untouched', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: 9 })).toEqual({ a: 9, b: 2 });
  });
});

describe('isPlainObject', () => {
  test('returns true for plain objects, false for arrays/null/primitives/subs', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject({ __substitution: true, path: 'a', optional: false })).toBe(false);
  });
});
