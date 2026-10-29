/**
 * A config key may be named after an `Object.prototype` member: `toString`,
 * `valueOf` or `hasOwnProperty` are ordinary words to HOCON, and only
 * `__proto__`, `constructor` and `prototype` are refused.  The objects the
 * parser builds are plain object literals, though, so they inherit every one
 * of those members, and the value a key already holds is read before the next
 * assignment to it — for an optional substitution, to keep as its fallback.
 * Read through the prototype chain, a key that was not set yet looked set to
 * the inherited function, and an optional substitution that nothing answered
 * fell back to that function as if the document had assigned it.
 *
 * The list is literal so a runtime cannot shrink it, and the first test holds
 * it to the runtime's own `Object.prototype` so it cannot fall behind either.
 */
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import {
  deepMerge,
  isForbiddenConfigKey,
  parseHocon,
  resolveSubstitutions,
  stripUndefined,
} from '../../../src/config/HoconParser.js';

const OBJECT_PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const;

/** The members a document may use as a key: the parser refuses the other two. */
const KEY_NAMES = OBJECT_PROTOTYPE_NAMES.filter((name) => !isForbiddenConfigKey(name));

/** Resolved against an empty environment, so nothing outside the test answers. */
const resolve = (tree: ReturnType<typeof parseHocon>) => stripUndefined(resolveSubstitutions(tree, {}));
const parse = (source: string) => resolve(parseHocon(source));

describe('the fixture', () => {
  test('names every own member of Object.prototype on this runtime', () => {
    for (const member of Object.getOwnPropertyNames(Object.prototype)) {
      expect(OBJECT_PROTOTYPE_NAMES as readonly string[]).toContain(member);
    }
  });

  test('leaves ten of them to the documents', () => {
    expect(KEY_NAMES).toHaveLength(10);
  });
});

describe('a key named after an Object.prototype member that an optional substitution leaves unset', () => {
  test('is absent from an object literal, at the root and down a path expression', () => {
    for (const name of KEY_NAMES) {
      expect({ name, tree: parse(`app { ${name} = \${?UNSET} }`) }).toEqual({ name, tree: { app: {} } });
      expect({ name, tree: parse(`${name} = \${?UNSET}`) }).toEqual({ name, tree: {} });
      expect({ name, tree: parse(`app.${name} = \${?UNSET}`) }).toEqual({ name, tree: { app: {} } });
    }
  });

  test('is absent when the layers meet before resolution', () => {
    for (const name of KEY_NAMES) {
      const base = parseHocon('app { kept = 1 }');
      const overlay = parseHocon(`app { ${name} = \${?UNSET} }`);
      expect({ name, tree: resolve(deepMerge(base, overlay)) }).toEqual({ name, tree: { app: { kept: 1 } } });
      // The same pair as one document, where the second block reaches the merge
      // through the parser's own key-path write.
      expect({ name, tree: parse(`app { kept = 1 }\napp { ${name} = \${?UNSET} }`) })
        .toEqual({ name, tree: { app: { kept: 1 } } });
    }
  });

  test('is not a path of the config', () => {
    const config = Config.parseString('app { toString = ${?ACTOR_TS_TEST_NEVER_SET} }');
    expect(config.hasPath('app.toString')).toBe(false);
    expect(Object.hasOwn(config.getObject('app'), 'toString')).toBe(false);
  });

  test('still falls back to a value the document did set', () => {
    for (const name of KEY_NAMES) {
      expect({ name, tree: parse(`${name} = mine\n${name} = \${?UNSET}`) }).toEqual({ name, tree: { [name]: 'mine' } });
      const merged = resolve(deepMerge(parseHocon(`${name} = mine`), parseHocon(`${name} = \${?UNSET}`)));
      expect({ name, tree: merged }).toEqual({ name, tree: { [name]: 'mine' } });
    }
  });
});
