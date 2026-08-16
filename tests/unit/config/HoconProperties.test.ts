import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { parseDuration } from '../../../src/config/Duration.js';
import { deepMerge, parseHocon, resolveSubstitutions } from '../../../src/config/HoconParser.js';
import { parseSize } from '../../../src/config/Size.js';

/**
 * Round-trip properties for the HOCON parser and the two config scalar
 * parsers (#543).
 *
 * The issue asks for a "parse/print round-trip", which cannot be written as
 * stated: there is no printer.  `src/config/index.ts` exports `parseHocon`,
 * `resolveSubstitutions`, `deepMerge` and `isPlainObject` and nothing else, and
 * no module in `src/` renders a config back to text.  So the direction is
 * reversed and the loop closes through a renderer that lives HERE:
 *
 *     model → render (in this file) → parseHocon → compare to model
 *
 * That is the stronger direction anyway.  A printer's output is whatever the
 * printer chose, so a print/parse loop mostly tests that the two agree with
 * each other; generating the model first means the parser is held against an
 * independent statement of what the text means.  It also lets one property
 * cover the whole syntax surface at once, by rendering the SAME model in
 * randomly varying styles — `=` against `:`, commas against newlines, explicit
 * against implicit root braces, the `key { … }` shorthand against `key = { … }`,
 * with and without comments and indentation.  Every style must land on the
 * same object, which is the real claim: those choices are insignificant.
 *
 * THE RENDERER STAYS INSIDE THE IMPLEMENTED SUBSET.  Four things are out, and
 * for three different reasons — worth separating, because only one of them is
 * a gap that might close:
 *
 *  1. Array and string concatenation (`a += [x]`, `"hi " ${name}`) and
 *     triple-quoted strings are unimplemented and tracked (#537,
 *     `src/config/HoconParser.ts:17-19`).
 *  2. `include` is NOT in that category.  It is a deliberate, permanent
 *     refusal with its own diagnostic (`src/config/HoconParser.ts:21-23`,
 *     `:119-124`, `:373-386`) — resolving one would let a config source name
 *     the next file the process reads.  An emitted `include` directive throws
 *     by design, forever, so the renderer never emits one; the refusal is
 *     pinned as a property instead.  Note this bites only the DIRECTIVE
 *     position: `include` is an ordinary key when followed by `=`/`:`/`{`, and
 *     it is in the generated key pool precisely to keep that true.
 *  3. `__proto__`, `constructor` and `prototype` are refused as key segments
 *     and inside `${…}` (`src/config/HoconParser.ts:58`, `:271`, `:222`).
 *     They are excluded from the key pool because a generator that emitted
 *     them would report a working prototype-pollution guard as a round-trip
 *     failure; the guard gets its own property instead.
 *  4. `-0` as a number, because `String(-0)` is `"0"` — the sign is lost by
 *     the renderer, before the parser ever sees it.  That is a fact about
 *     `Number.prototype.toString`, not about HOCON.
 */

const RUNS = 120;

/* -------------------------------- The model ------------------------------- */

type ModelValue = string | number | boolean | null | ModelValue[] | ModelObject;
type ModelObject = { [key: string]: ModelValue };

/** Exactly the character class `parseBareKeySegment` accepts. */
const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const BARE_KEY_CHARACTERS = 'abcXYZ019_-';

/**
 * Keys that must survive quoting.  `dotted.key` is the interesting one: a
 * quoted dot is one segment, where a bare dot would expand into a path.
 * `include` is here as a bare key on purpose — see note 2 in the header.
 */
const EXOTIC_KEYS: readonly string[] = [
  'key with spaces', 'dotted.key', 'ünïcøde', 'with"quote', 'tab\ttab',
  '', 'include', 'a=b', '#hash', '//slashes', 'trailing ',
];

const keyArbitrary = fc.oneof(
  fc.array(fc.constantFrom(...BARE_KEY_CHARACTERS), { minLength: 1, maxLength: 6 })
    .map((characters) => characters.join('')),
  fc.constantFrom(...EXOTIC_KEYS),
);

const primitiveArbitrary = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
  fc.string({ maxLength: 20 }),
);

type ModelTree = { value: ModelValue; array: ModelValue[]; object: ModelObject };

const modelTree = fc.letrec<ModelTree>((tie) => ({
  value: fc.oneof({ maxDepth: 3 }, primitiveArbitrary, tie('array'), tie('object')),
  array: fc.array(tie('value'), { maxLength: 4 }),
  // Spread to a plain object: `toStrictEqual` compares prototypes, and the
  // parser always builds `{}` literals.
  object: fc.dictionary(keyArbitrary, tie('value'), { maxKeys: 4 })
    .map((entries) => ({ ...entries })),
}));

const modelArbitrary = modelTree.object;

/* ------------------------------ The renderer ------------------------------ */

type RenderStyle = {
  readonly assignment: '=' | ':';
  /** `'comma'` renders a trailing comma as well as the newline — both are separators. */
  readonly separator: 'newline' | 'comma';
  readonly explicitRootBraces: boolean;
  /** `key { … }`, the HOCON shorthand that omits the assignment operator. */
  readonly objectShorthand: boolean;
  readonly comments: boolean;
  readonly indentation: string;
};

const styleArbitrary = fc.record<RenderStyle>({
  assignment: fc.constantFrom('=', ':'),
  separator: fc.constantFrom('newline', 'comma'),
  explicitRootBraces: fc.boolean(),
  objectShorthand: fc.boolean(),
  comments: fc.boolean(),
  indentation: fc.constantFrom('', ' ', '  ', '\t'),
});

const isModelObject = (value: ModelValue): value is ModelObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const renderKey = (key: string): string =>
  BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);

/**
 * `JSON.stringify` is the string renderer because every escape it emits —
 * `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f` and `\uXXXX` for control
 * characters and lone surrogates — is one `parseQuotedString` accepts
 * (`src/config/HoconParser.ts:177-192`).  Strings are always quoted, which
 * also keeps `#`, `//` and `,` inside a value from being read as a comment or
 * a separator.
 */
function renderValue(value: ModelValue, style: RenderStyle, depth: number): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => renderValue(entry, style, depth)).join(', ')}]`;
  }
  return renderObject(value, style, depth);
}

function renderObject(value: ModelObject, style: RenderStyle, depth: number): string {
  const body = renderFields(value, style, depth + 1);
  if (body === '') return '{}';
  return `{\n${body}\n${style.indentation.repeat(depth)}}`;
}

function renderFields(value: ModelObject, style: RenderStyle, depth: number): string {
  const padding = style.indentation.repeat(depth);
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (style.comments) lines.push(`${padding}# a comment nobody reads`);
    const rendered = renderValue(entry, style, depth);
    const head = style.objectShorthand && isModelObject(entry)
      ? `${padding}${renderKey(key)} ${rendered}`
      : `${padding}${renderKey(key)} ${style.assignment} ${rendered}`;
    lines.push(style.separator === 'comma' ? `${head},` : head);
  }
  if (style.comments) lines.push(`${padding}// and a trailing one`);
  return lines.join('\n');
}

function renderRoot(model: ModelObject, style: RenderStyle): string {
  if (!style.explicitRootBraces) return renderFields(model, style, 0);
  const body = renderFields(model, style, 1);
  return body === '' ? '{}' : `{\n${body}\n}`;
}

/* ------------------------------- Properties ------------------------------- */

describe('HOCON properties — a model survives the text', () => {
  test('every rendering style parses back to the same object', () => {
    fc.assert(
      fc.property(modelArbitrary, styleArbitrary, (model, style) => {
        expect(parseHocon(renderRoot(model, style))).toStrictEqual(model);
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The same claim stated as an equivalence rather than an identity: whatever
   * the parser does with a model, it must do independently of how the text was
   * laid out.  Worth its own property because it fails differently — a bug
   * that mangled every style identically would pass this and fail the one
   * above, and a bug in exactly one style branch does the reverse.
   */
  test('two renderings of one model parse to the same object', () => {
    fc.assert(
      fc.property(modelArbitrary, styleArbitrary, styleArbitrary, (model, first, second) => {
        expect(parseHocon(renderRoot(model, first)))
          .toStrictEqual(parseHocon(renderRoot(model, second)));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('HOCON properties — path expressions are nesting', () => {
  /**
   * `a.b.c = 1` and `a { b { c = 1 } }` are the same document.  Generated as a
   * path of bare segments, since a dot inside a QUOTED segment is data rather
   * than a separator — the case the round-trip property above already covers.
   */
  test('a dotted path equals the nested braces it expands to', () => {
    const bareSegment = fc
      .array(fc.constantFrom(...BARE_KEY_CHARACTERS), { minLength: 1, maxLength: 5 })
      .map((characters) => characters.join(''));

    fc.assert(
      fc.property(
        fc.array(bareSegment, { minLength: 1, maxLength: 4 }),
        primitiveArbitrary,
        (segments, leaf) => {
          const style: RenderStyle = {
            assignment: '=', separator: 'newline', explicitRootBraces: false,
            objectShorthand: false, comments: false, indentation: '',
          };
          const rendered = renderValue(leaf, style, 0);
          // `minLength: 1` guarantees a head segment, so the expansion is
          // always an object — which is what `parseHocon` returns.
          const nested: ModelObject = {
            [segments[0]!]: segments.slice(1).reduceRight<ModelValue>(
              (inner, segment) => ({ [segment]: inner }),
              leaf,
            ),
          };
          expect(parseHocon(`${segments.join('.')} = ${rendered}`)).toStrictEqual(nested);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('HOCON properties — declaring a key twice merges', () => {
  /**
   * Two sources concatenated must equal the two parsed separately and merged,
   * which is what `Config.parseFile(a).merge(b)` promises — and, since
   * `include` is refused, the ONLY way to compose config from several places.
   * Holding the parser's own merge against the exported `deepMerge` is what
   * makes the two impossible to drift apart.
   */
  test('concatenating two documents equals deep-merging them', () => {
    fc.assert(
      fc.property(modelArbitrary, modelArbitrary, styleArbitrary, (base, overlay, style) => {
        const combined = `${renderRoot(base, { ...style, explicitRootBraces: false })}\n`
          + `${renderRoot(overlay, { ...style, explicitRootBraces: false })}`;
        expect(parseHocon(combined)).toStrictEqual(deepMerge(base, overlay));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('HOCON properties — substitutions read the tree', () => {
  /**
   * `${path}` resolves against the parsed tree before the environment, so a
   * reference to a key that exists is that key's value.  The alias name cannot
   * collide with a generated key: the bare-key pool has no `l`, `s`, `T`, `r`,
   * `g`, `e` or `t`, so `aliasTarget` is unreachable from it.
   */
  test('a substitution of an existing key resolves to that key value', () => {
    const bareKeyed = fc.dictionary(
      fc.array(fc.constantFrom(...BARE_KEY_CHARACTERS), { minLength: 1, maxLength: 5 })
        .map((characters) => characters.join('')),
      primitiveArbitrary,
      { minKeys: 1, maxKeys: 4 },
    ).map((entries) => ({ ...entries }));

    fc.assert(
      fc.property(bareKeyed, fc.integer({ min: 0, max: 99 }), fc.boolean(), (model, pick, optional) => {
        const keys = Object.keys(model);
        const target = keys[pick % keys.length]!;
        const style: RenderStyle = {
          assignment: '=', separator: 'newline', explicitRootBraces: false,
          objectShorthand: false, comments: false, indentation: '',
        };
        const source = `${renderRoot(model, style)}\naliasTarget = \${${optional ? '?' : ''}${target}}`;
        // An empty env so a stray matching variable cannot answer instead.
        const resolved = resolveSubstitutions(parseHocon(source), {});
        expect(resolved['aliasTarget']).toStrictEqual(model[target]);
      }),
      { numRuns: RUNS },
    );
  });

  test('an unresolvable substitution throws when required and vanishes when optional', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...BARE_KEY_CHARACTERS), { minLength: 1, maxLength: 6 })
          .map((characters) => characters.join('')),
        (missing) => {
          expect(() => resolveSubstitutions(parseHocon(`a = \${${missing}zzz}`), {})).toThrow();
          const optional = resolveSubstitutions(parseHocon(`a = \${?${missing}zzz}`), {});
          expect(optional['a']).toBeUndefined();
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('HOCON properties — the refusals hold', () => {
  const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

  /**
   * Stated positively so the suite reads as a test of the hardening rather
   * than a bug report against it: these keys are refused everywhere a key or a
   * substitution path can appear, and nothing reaches the prototype.
   */
  test('a forbidden key is refused at every position', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FORBIDDEN_KEYS), primitiveArbitrary, (forbidden, leaf) => {
        const style: RenderStyle = {
          assignment: '=', separator: 'newline', explicitRootBraces: false,
          objectShorthand: false, comments: false, indentation: '',
        };
        const rendered = renderValue(leaf, style, 0);
        for (const source of [
          `${forbidden} = ${rendered}`,
          `${JSON.stringify(forbidden)} = ${rendered}`,
          `outer.${forbidden}.inner = ${rendered}`,
          `outer { ${forbidden} = ${rendered} }`,
          `value = \${${forbidden}}`,
          `value = \${outer.${forbidden}}`,
        ]) {
          expect(() => parseHocon(source)).toThrow();
        }
        expect(Object.hasOwn(Object.prototype, 'inner')).toBe(false);
        expect(({} as Record<string, unknown>)['inner']).toBeUndefined();
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The permanent refusal (#537 covers the merely-unimplemented syntax; this
   * is not that).  The second half is the part that would rot silently: the
   * refusal keys off the DIRECTIVE position, so `include` has to keep working
   * as an ordinary key, or every config with a field named `include` breaks.
   */
  test('an include directive is refused while an include key stays ordinary', () => {
    fc.assert(
      fc.property(fc.constantFrom('base.conf', 'x/y.conf', 'https://example.test/a.conf'), (target) => {
        for (const directive of [
          `include ${JSON.stringify(target)}`,
          `include file(${JSON.stringify(target)})`,
          `include required(url(${JSON.stringify(target)}))`,
        ]) {
          expect(() => parseHocon(directive)).toThrow(/include/);
        }
        expect(parseHocon(`include = ${JSON.stringify(target)}`)).toStrictEqual({ include: target });
        expect(parseHocon(`include { path = ${JSON.stringify(target)} }`))
          .toStrictEqual({ include: { path: target } });
      }),
      { numRuns: RUNS },
    );
  });
});

/* --------------------------- Duration and Size ---------------------------- */

/**
 * Unit spellings only — deliberately NOT the factors.  Restating the factor
 * table here would just assert that a copy of it equals the original, so the
 * properties below are the ones that hold without knowing any factor:
 * a unit is linear, and its spelling is insensitive to case and to the space
 * before it.
 */
const DURATION_UNITS = ['ms', 'millis', 'milliseconds', 's', 'sec', 'seconds', 'm', 'min', 'minutes', 'h', 'hours', 'd', 'days'] as const;
const SIZE_UNITS = ['B', 'bytes', 'K', 'KB', 'KiB', 'M', 'MB', 'MiB', 'G', 'GB', 'GiB'] as const;

describe('Duration and Size properties', () => {
  const countArbitrary = fc.integer({ min: 0, max: 10_000 });

  test('a duration unit is linear in its count', () => {
    fc.assert(
      fc.property(countArbitrary, fc.constantFrom(...DURATION_UNITS), (count, unit) => {
        expect(parseDuration(`${count}${unit}`)).toBe(count * parseDuration(`1${unit}`));
      }),
      { numRuns: RUNS },
    );
  });

  test('a size unit is linear in its count', () => {
    fc.assert(
      fc.property(countArbitrary, fc.constantFrom(...SIZE_UNITS), (count, unit) => {
        expect(parseSize(`${count}${unit}`)).toBe(count * parseSize(`1${unit}`));
      }),
      { numRuns: RUNS },
    );
  });

  test('unit spelling is insensitive to case and to surrounding space', () => {
    fc.assert(
      fc.property(countArbitrary, fc.constantFrom(...DURATION_UNITS), (count, unit) => {
        const canonical = parseDuration(`${count}${unit}`);
        expect(parseDuration(`${count} ${unit}`)).toBe(canonical);
        expect(parseDuration(`  ${count}${unit.toUpperCase()}  `)).toBe(canonical);
        expect(parseDuration(`${count}\t${unit.toLowerCase()}`)).toBe(canonical);
      }),
      { numRuns: RUNS },
    );
    fc.assert(
      fc.property(countArbitrary, fc.constantFrom(...SIZE_UNITS), (count, unit) => {
        const canonical = parseSize(`${count}${unit}`);
        expect(parseSize(`${count} ${unit}`)).toBe(canonical);
        expect(parseSize(`  ${count}${unit.toUpperCase()}  `)).toBe(canonical);
        expect(parseSize(`${count}${unit.toLowerCase()}`)).toBe(canonical);
      }),
      { numRuns: RUNS },
    );
  });

  test('a bare count is milliseconds and bytes respectively', () => {
    fc.assert(
      fc.property(countArbitrary, (count) => {
        expect(parseDuration(`${count}`)).toBe(count);
        expect(parseDuration(count)).toBe(count);
        expect(parseSize(`${count}`)).toBe(count);
        expect(parseSize(count)).toBe(count);
      }),
      { numRuns: RUNS },
    );
  });
});
