import { describe, expect, test } from 'bun:test';
import {
  deepMerge,
  isForbiddenConfigKey,
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

describe('include directives (#135)', () => {
  // The parser never ignored `include` — it read the keyword as an ordinary key
  // and then failed on the string after it with `Expected '=' or ':' after key
  // "include"`, which names the keyword but not the reason.  These pin the
  // replacement diagnostic, and just as importantly the keys it must not claim.

  test('a plain include is refused with its reason and its target', () => {
    expect(() => parseHocon('include "shared-cluster.conf"\na = 1'))
      .toThrow(/`include "shared-cluster\.conf"` is not supported/);
    expect(() => parseHocon('include "shared-cluster.conf"\na = 1'))
      .toThrow(/Merge the sources in code instead/);
  });

  test('the message no longer reads as a syntax error', () => {
    expect(() => parseHocon('include "x.conf"')).not.toThrow(/Expected '=' or ':'/);
  });

  test('file, url, classpath and required forms all get the same refusal', () => {
    for (const source of [
      'include file("base.conf")',
      'include url("https://example.com/base.conf")',
      'include classpath("base.conf")',
      'include required(file("base.conf"))',
    ]) {
      expect(() => parseHocon(source)).toThrow(/`include ".+"` is not supported/);
    }
  });

  test('the suggested snippet names the real target so it can be pasted as-is', () => {
    expect(() => parseHocon('include file("base.conf")'))
      .toThrow(/Config\.parseFile\("base\.conf"\)\.merge\(/);
  });

  test('a url target is echoed but never suggested to parseFile', () => {
    // `parseFile` reads from disk, so proposing it for an http target would be
    // advice that fails when followed — the failure mode this message replaces.
    expect(() => parseHocon('include url("https://example.com/base.conf")'))
      .toThrow(/`include "https:\/\/example\.com\/base\.conf"`/);
    expect(() => parseHocon('include url("https://example.com/base.conf")'))
      .toThrow(/Config\.parseFile\("base\.conf"\)/);
  });

  test('an include carries a source position like every other parse error', () => {
    expect(() => parseHocon('a = 1\nb = 2\ninclude "late.conf"')).toThrow(/line 3/);
  });

  test('an include nested in an object is refused too', () => {
    // Real HOCON allows the directive in any object body, so the check sits
    // where the directive is recognised rather than at the top level only.
    expect(() => parseHocon('app {\n  include "base.conf"\n  a = 1\n}'))
      .toThrow(/`include "base\.conf"` is not supported/);
  });

  test('an include without a quoted target still explains itself', () => {
    expect(() => parseHocon('include base.conf')).toThrow(/`include` is not supported/);
  });

  test('a key legitimately named include keeps working', () => {
    // The refusal fires only where neither `=`/`:` nor `{` follows — the
    // directive position — so every ordinary use of the word is untouched.
    expect(parseHocon('app { include = "x" }')).toEqual({ app: { include: 'x' } });
    expect(parseHocon('include = "x"')).toEqual({ include: 'x' });
    expect(parseHocon('include : 7')).toEqual({ include: 7 });
    expect(parseHocon('include { a = 1 }')).toEqual({ include: { a: 1 } });
    expect(parseHocon('include.a = 1')).toEqual({ include: { a: 1 } });
    expect(parseHocon('"include" = 5')).toEqual({ include: 5 });
    expect(parseHocon('a.include.b = 1')).toEqual({ a: { include: { b: 1 } } });
  });

  test('a comment that mentions include is still just a comment', () => {
    expect(parseHocon('# include "base.conf" is unsupported\na = 1')).toEqual({ a: 1 });
    expect(parseHocon('// include "base.conf"\na = 1')).toEqual({ a: 1 });
  });

  test('other keys still get the generic missing-assignment error', () => {
    expect(() => parseHocon('imports "base.conf"')).toThrow(/Expected '=' or ':' after key "imports"/);
  });
});

describe('prototype pollution (#406)', () => {
  // Every case asserts on a freshly built object rather than a captured one:
  // pollution shows up as an inherited property, so a fresh `{}` is the probe.
  const probe = () => ({}) as Record<string, unknown>;

  test('a __proto__ key path is refused instead of polluting Object.prototype', () => {
    // Before the fix this parsed to `{}` — looking harmless — while setting
    // `Object.prototype.polluted`, poisoning every object in the process.
    expect(() => parseHocon('__proto__.polluted = true')).toThrow(/Refusing "__proto__"/);
    expect(probe().polluted).toBeUndefined();
  });

  test('a quoted __proto__ key is refused too', () => {
    // The single-segment variant replaced the config object's own prototype.
    expect(() => parseHocon('"__proto__" { hacked = 1 }')).toThrow(/Refusing "__proto__"/);
    expect(probe().hacked).toBeUndefined();
  });

  test('__proto__ is refused at any depth in a path', () => {
    expect(() => parseHocon('a.__proto__.b = 1')).toThrow(/Refusing "__proto__"/);
    expect(() => parseHocon('a { b { __proto__ { c = 1 } } }')).toThrow(/Refusing "__proto__"/);
  });

  test('constructor and prototype keys are refused as well', () => {
    expect(() => parseHocon('constructor.prototype.cpwned = 1')).toThrow(/Refusing "constructor"/);
    expect(() => parseHocon('prototype = 1')).toThrow(/Refusing "prototype"/);
    expect(probe().cpwned).toBeUndefined();
  });

  test('the error carries a source position, like every other parse error', () => {
    expect(() => parseHocon('a = 1\n__proto__.x = 2')).toThrow(/line 2/);
  });

  test('a substitution may not read through the prototype chain', () => {
    // `${__proto__}` resolved to Object.prototype and spliced it into config.
    expect(() => parseHocon('x = ${__proto__}')).toThrow(/Refusing the substitution/);
    expect(() => parseHocon('x = ${a.constructor}')).toThrow(/Refusing the substitution/);
  });

  test('keys that merely resemble the forbidden ones still work', () => {
    // The guard is exact-match; it must not swallow legitimate keys.
    expect(parseHocon('_proto_ = 1')).toEqual({ _proto_: 1 });
    expect(parseHocon('constructorName = "x"')).toEqual({ constructorName: 'x' });
    expect(parseHocon('a.prototypes.b = 1')).toEqual({ a: { prototypes: { b: 1 } } });
  });

  test('deepMerge drops an own __proto__ property from the overlay', () => {
    // JSON.parse produces an *own* __proto__, which Object.entries reports and
    // a plain assignment would then feed to the prototype setter.
    const overlay = JSON.parse('{"__proto__":{"dmPwned":1}}');
    const merged = deepMerge({ a: 1 }, overlay);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged).toEqual({ a: 1 });
    expect((merged as Record<string, unknown>).dmPwned).toBeUndefined();
    expect(probe().dmPwned).toBeUndefined();
  });

  test('deepMerge drops an own __proto__ property from the base', () => {
    // The base used to be copied with `{ ...base }`, which carries it through.
    const base = JSON.parse('{"__proto__":{"basePwned":1},"a":1}');
    const merged = deepMerge(base, { b: 2 });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged).toEqual({ a: 1, b: 2 });
    expect((merged as Record<string, unknown>).basePwned).toBeUndefined();
  });

  test('stripUndefined and substitution resolution drop forbidden keys', () => {
    const evil = JSON.parse('{"__proto__":{"spPwned":1},"a":1}');
    expect(stripUndefined(evil)).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(stripUndefined(evil))).toBe(Object.prototype);

    const resolved = resolveSubstitutions(JSON.parse('{"__proto__":{"rsPwned":1},"a":1}'));
    expect(resolved).toEqual({ a: 1 });
    expect(probe().rsPwned).toBeUndefined();
  });

  test('isForbiddenConfigKey names exactly the three guarded keys', () => {
    expect(isForbiddenConfigKey('__proto__')).toBe(true);
    expect(isForbiddenConfigKey('constructor')).toBe(true);
    expect(isForbiddenConfigKey('prototype')).toBe(true);
    expect(isForbiddenConfigKey('proto')).toBe(false);
    expect(isForbiddenConfigKey('__proto__x')).toBe(false);
  });
});

describe('substitutions read own properties only (#589)', () => {
  // The three guarded keys are a blocklist; `Object.prototype` has a dozen more
  // members, and every one of them used to answer a substitution lookup.  These
  // cases pin the positive guard instead: nothing inherited resolves, whatever
  // it is called.
  const inherited = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString'];

  test('a required substitution naming a prototype member stays unresolved', () => {
    for (const member of inherited) {
      // Before the fix this spliced the native function into the config tree,
      // where the next typed getter met it as a value.
      expect(() => resolveSubstitutions(parseHocon(`x = \${${member}}`)))
        .toThrow(`Unresolved substitution: \${${member}}`);
    }
  });

  test('a prototype member never resolves through a nested path either', () => {
    expect(() => resolveSubstitutions(parseHocon('a { b = 1 }\nx = ${a.toString}')))
      .toThrow(/Unresolved substitution/);
  });

  test('an optional substitution now falls through to the environment', () => {
    // The tree hit short-circuited `resolveOne` before it reached `env`, so a
    // shadowed name could never be supplied from outside.
    const resolved = resolveSubstitutions(parseHocon('x = ${?toString}'), { toString: 'from-env' });
    expect(resolved).toEqual({ x: 'from-env' });
  });

  test('an optional substitution with no environment entry is dropped, not shadowed', () => {
    expect(stripUndefined(resolveSubstitutions(parseHocon('x = ${?valueOf}'), {}))).toEqual({});
  });

  test('no function value can reach the resolved tree', () => {
    const resolved = resolveSubstitutions(parseHocon('a = 1\nb = ${?hasOwnProperty}'), {});
    for (const value of Object.values(resolved)) expect(typeof value).not.toBe('function');
  });

  test('an own __proto__ on the root is still not readable as a substitution source', () => {
    // `Object.hasOwn` alone would wave this one through — `resolveOne` looks up
    // against the caller's unfiltered object — which is why the forbidden-key
    // check stays in the descent next to it.
    const evil = JSON.parse('{"__proto__":{"leak":1},"x":{"__substitution":true,"path":"__proto__.leak","optional":true}}');
    expect(stripUndefined(resolveSubstitutions(evil, {}))).toEqual({});
  });

  test('ordinary keys that shadow a prototype member still resolve', () => {
    // The guard must not cost a legitimate key: an explicitly declared
    // `toString` is an own property and stays readable.
    expect(resolveSubstitutions(parseHocon('toString = "mine"\nx = ${toString}')))
      .toEqual({ toString: 'mine', x: 'mine' });
  });
});
