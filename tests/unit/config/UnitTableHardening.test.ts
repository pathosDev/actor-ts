/**
 * **The two unit tables stay hardened, and stay fully exercised** (#785).
 *
 * `Duration.ts`'s `UNIT_MS` and `Size.ts`'s `BYTE_UNITS` are indexed by a name
 * lifted verbatim out of an operator-authored config string, so #785 gave each
 * of them three separate pieces of armour: `Object.freeze`, a **null
 * prototype**, and a positive `Object.hasOwn` lookup guard.
 *
 * ## Why a source-level assertion, of all things
 *
 * Two of the three are invisible to any test that goes through `parseDuration`
 * / `parseSize`, and that is by design rather than by accident:
 *
 * - The null prototype and `Object.hasOwn` are **deliberately redundant** — the
 *   note at `Duration.ts` says so ("Redundant with the null prototype above by
 *   construction, and kept anyway: it is the half that survives someone
 *   reshaping the table").  Remove either one and the other still rejects
 *   `constructor`, so `Duration.test.ts`'s own-property test binds the *pair*
 *   and neither half.  Verified by swapping `Object.hasOwn` back for the
 *   pre-#785 `UNIT_MS[unit] === undefined` guard, and separately by dropping
 *   `Object.setPrototypeOf`: `bun test tests/unit/config/` stayed green for
 *   both.
 * - `Object.freeze` guards a **module-private** constant that no export
 *   reaches, so nothing outside these two files can attempt the mutation it
 *   refuses.  Removing it leaves the whole suite green because there is no
 *   runtime seam for a test to reach through.
 *
 * Which leaves the source as the only place the three are observable at all.
 * That is the instrument `NoDeadConfigKeys` and `SystemQueueProducers` already
 * use for the same reason — a claim that is true of the tree rather than of a
 * value — and it is enough here: a refactor that drops one of the three turns
 * this red instead of landing silently, which is precisely the failure #785
 * left open.  It is not a substitute for the behavioural tests beside it; it is
 * the half those cannot express.
 *
 * ## And the inventory
 *
 * The unit names are read out of the table too, so **every** declared unit is
 * exercised rather than a hand-picked sample.  That is the direction the
 * hand-written lists in `Duration.test.ts` / `Size.test.ts` cannot cover: they
 * catch a unit *deleted* from the table, this catches one *added* to it and
 * left untested — which is how eleven duration spellings came to be
 * deletable under a test named 'every declared unit still resolves'.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseDuration } from '../../../src/config/Duration.js';
import { parseSize } from '../../../src/config/Size.js';

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', 'src');
const DURATION_SOURCE = join(SOURCE_ROOT, 'config', 'Duration.ts');
const SIZE_SOURCE = join(SOURCE_ROOT, 'config', 'Size.ts');

/**
 * One unit table under test: where its source lives, what the constant is
 * called, and how the parser in front of it answers.
 *
 * A plain data shape, so a `type` rather than an `interface` — the two
 * function-typed members are properties, not call signatures the declaration
 * prescribes.
 */
type UnitTableUnderTest = {
  readonly label: string;
  readonly source: string;
  readonly constantName: string;
  readonly parse: (input: string) => number;
  /** How the parser spells its unknown-unit refusal. */
  readonly unknownUnitMessage: RegExp;
  /** How many entries the table is expected to declare. */
  readonly declaredUnits: number;
};

const TABLES: readonly UnitTableUnderTest[] = [
  {
    label: 'UNIT_MS (Duration.ts)',
    source: DURATION_SOURCE,
    constantName: 'UNIT_MS',
    parse: parseDuration,
    unknownUnitMessage: /Unknown duration unit/,
    declaredUnits: 34,
  },
  {
    label: 'BYTE_UNITS (Size.ts)',
    source: SIZE_SOURCE,
    constantName: 'BYTE_UNITS',
    parse: parseSize,
    unknownUnitMessage: /Unknown size unit/,
    declaredUnits: 38,
  },
];

/** The object-literal body of `const <name> = …` up to its `satisfies` clause. */
const tableBody = (source: string, constantName: string): string => {
  const start = source.indexOf(`const ${constantName}`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('} satisfies Record<string, number>');
  expect(end).toBeGreaterThan(0);
  return rest.slice(0, end);
};

/**
 * `name: value` pairs out of a table body.
 *
 * The value grammar is exactly the four forms the two tables use — a plain
 * integer with optional `_` separators, an exponent (`1e-6`), and `1024 ** 3`.
 * Anything else is a new form that should be looked at rather than silently
 * skipped, so {@link evaluateUnitValue} refuses what it cannot read.
 */
const UNIT_ENTRY = /(?:^|[{,\s])'?([A-Za-zμ]+)'?\s*:\s*([0-9][0-9_.]*(?:e[+-]?[0-9]+)?(?:\s*\*\*\s*[0-9]+)?)/g;

const evaluateUnitValue = (literal: string): number => {
  const cleaned = literal.replace(/_/g, '');
  const power = cleaned.match(/^([0-9.]+)\s*\*\*\s*([0-9]+)$/);
  if (power) return Math.pow(Number(power[1]), Number(power[2]));
  const value = Number(cleaned);
  expect(Number.isFinite(value)).toBe(true);
  return value;
};

/** Every unit the table declares, in source order, with its value. */
const declaredUnitsOf = (table: UnitTableUnderTest): ReadonlyArray<readonly [string, number]> => {
  const body = tableBody(readFileSync(table.source, 'utf8'), table.constantName);
  return [...body.matchAll(UNIT_ENTRY)].map(
    (match) => [match[1]!, evaluateUnitValue(match[2]!)] as const,
  );
};

describe('the config unit tables stay hardened — #785', () => {
  for (const table of TABLES) {
    describe(table.label, () => {
      test('is frozen, null-prototyped, and looked up with Object.hasOwn', () => {
        const source = readFileSync(table.source, 'utf8');
        const body = tableBody(source, table.constantName);

        // Each of the three is asserted on its own, because each of the three
        // was individually deletable with the suite green.
        expect(body).toContain('Object.freeze(');
        expect(body).toContain('Object.setPrototypeOf(');
        // The prototype argument, not merely the call: `setPrototypeOf(x, {})`
        // compiles and hardens nothing.
        expect(source.slice(source.indexOf(body)))
          .toMatch(/\} satisfies Record<string, number>,\s*null,/);
        expect(source).toContain(`Object.hasOwn(${table.constantName}, unit)`);
      });

      test('declares exactly the units the hand-written lists exercise', () => {
        const declared = declaredUnitsOf(table);
        // A unit added to the table and to no list makes this red — the
        // direction a list of examples can never cover.
        expect(declared).toHaveLength(table.declaredUnits);
        expect(new Set(declared.map(([unit]) => unit)).size).toBe(table.declaredUnits);
      });

      test('every declared unit resolves to its declared value', () => {
        for (const [unit, value] of declaredUnitsOf(table)) {
          // `1` of the unit is the value of the unit, in both the spelling the
          // table uses and the upper case an operator may well have typed —
          // the guard sees the lowercased name, so a guard written against the
          // raw capture would reject the second form.
          expect(table.parse(`1${unit}`)).toBeCloseTo(value, 9);
          // ASCII only: `μs` is the one declared unit whose upper case the
          // *unit pattern* refuses, because `[A-Za-zμ]` whitelists lowercase
          // mu and nothing else.  A real gap in a parser documented as
          // case-insensitive, and not this guard's to close — asserting the
          // uppercase form here would only conflate the two.
          if (/^[a-z]+$/.test(unit)) {
            expect(table.parse(`1 ${unit.toUpperCase()}`)).toBeCloseTo(value, 9);
          }
        }
      });
    });
  }

  /**
   * The pair, against an arbitrary key rather than only `constructor`.
   *
   * `Duration.test.ts` reasons that `constructor` "is the whole exposure —
   * every other inherited member is mixed-case and cannot survive the
   * `.toLowerCase()`".  True of a *stock* `Object.prototype`, and the premise
   * a polluted one removes: a single lowercase property planted anywhere in
   * the process makes itself a unit for every table that resolves through the
   * chain.  This is the threat model #589 / #406 / #608 hardened the config
   * *key* path against, asserted on the value path.
   */
  test('a polluted Object.prototype supplies neither table a unit', () => {
    const planted = 'parsecs';
    Object.defineProperty(Object.prototype, planted, {
      value: 42, writable: true, enumerable: false, configurable: true,
    });
    try {
      for (const table of TABLES) {
        expect(() => table.parse(`1${planted}`)).toThrow(table.unknownUnitMessage);
      }
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)[planted];
    }
    expect(planted in Object.prototype).toBe(false);
  });
});

/**
 * The microsecond unit accepts every spelling of its own letter.
 *
 * The table is keyed on U+03BC GREEK SMALL LETTER MU, and the parser's unit
 * class admitted only that one — so `1 µs` written with U+00B5 MICRO SIGN was
 * rejected, and rejected as a *malformed duration* rather than as an unknown
 * unit, because the class runs before the table is ever consulted.  U+00B5 is
 * the character a German keyboard produces (AltGr+M) and the one most copied
 * text carries, so the spelling that failed was the likeliest one to be typed.
 *
 * Documented as case-insensitive, which the ASCII units already were: `US`
 * resolves, so `ΜS` has to as well.
 */
describe('parseDuration accepts every spelling of the micro prefix', () => {
  // Escapes rather than literals: the three characters are visually identical
  // in most fonts, and a test that cannot be read is worse than none.
  const MICRO_SIGN = '\u00B5';        // µ — AltGr+M, and what NFKC folds away
  const GREEK_SMALL_MU = '\u03BC';    // μ — the key the table declares
  const GREEK_CAPITAL_MU = '\u039C';  // Μ — the upper case of the key

  const spellings: ReadonlyArray<readonly [string, string]> = [
    ['micro sign, lower s', `1 ${MICRO_SIGN}s`],
    ['micro sign, upper S', `1 ${MICRO_SIGN}S`],
    ['greek small mu', `1 ${GREEK_SMALL_MU}s`],
    ['greek small mu, upper S', `1 ${GREEK_SMALL_MU}S`],
    ['greek capital mu', `1 ${GREEK_CAPITAL_MU}s`],
    ['greek capital mu, upper S', `1 ${GREEK_CAPITAL_MU}S`],
  ];

  test.each(spellings)('%s resolves to one microsecond', (_label, input) => {
    expect(parseDuration(input)).toBe(1e-3);
  });

  test('the ASCII spelling is unchanged, in both cases', () => {
    // The control: `us` always worked, and the fix must not have reached it.
    expect(parseDuration('1 us')).toBe(1e-3);
    expect(parseDuration('1 US')).toBe(1e-3);
  });

  test('normalising the unit does not start accepting units that do not exist', () => {
    // NFKC folds more than the micro sign, so the widened class and the
    // normalisation both have to stay narrow: a unit is still only valid when
    // the table declares it.
    expect(() => parseDuration('1 xs')).toThrow();
    expect(() => parseDuration(`1 ${GREEK_SMALL_MU}`)).toThrow();
    expect(() => parseDuration(`1 ${MICRO_SIGN}${MICRO_SIGN}s`)).toThrow();
  });
});
