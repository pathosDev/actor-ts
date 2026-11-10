import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { urlQueryPairs } from '../../../src/persistence/journals/ConnectionStringInspection.js';
import { asUrlParserReadsIt } from '../../../src/util/StripCharacters.js';

/**
 * Three configuration parsers carried regular expressions that CodeQL's
 * `js/polynomial-redos` flagged and that measured quadratic: 2–8 s on a value
 * of 40 000 characters (#1792).  Each case below feeds the shape that was slow
 * at 100 000 characters, where the old spelling needs tens of seconds, and
 * holds it to a bound two orders of magnitude above what a linear scan takes —
 * so a loaded runner cannot turn it red, and a quadratic spelling cannot pass.
 */
const LENGTH = 100_000;
const BOUND_MS = 500;

function elapsedMs(body: () => unknown): number {
  const start = performance.now();
  body();
  return performance.now() - start;
}

/** The two removals as the module spelled them before #1792 — the oracle. */
const OLD_URL_NORMALISATION = (value: string): string =>
  value.replace(/^[\u0000- ]+|[\u0000- ]+$|[\t\n\r]/g, '');

describe('polynomial regular expressions in config parsing (#1792)', () => {
  test('asUrlParserReadsIt removes exactly what the regex removed', () => {
    const cases = [
      '', ' ', 'a', ' file:worker.js', '\tfile:worker.js', 'fi\tle:worker.js',
      '\r\n  file:./worker.js', '\u0000\u0001x\u001F ', 'a b', 'a\u0001b',
      ' file:worker.js', ' \t mongodb://h/?tls=false \n', 'x  ',
    ];
    for (const value of cases) expect(asUrlParserReadsIt(value)).toBe(OLD_URL_NORMALISATION(value));
  });

  test('an interior run of controls is linear to normalise', () => {
    const value = `a${'\u0001'.repeat(LENGTH)}a`;
    expect(elapsedMs(() => asUrlParserReadsIt(value))).toBeLessThan(BOUND_MS);
  });

  test('a connection string with an interior run of controls is linear to read', () => {
    const url = `postgres://h/db${'\u0001'.repeat(LENGTH)}x?sslmode=require`;
    expect(elapsedMs(() => urlQueryPairs(url))).toBeLessThan(BOUND_MS);
  });

  test('an unquoted value of many zeros is linear to parse, and stays a string', () => {
    const value = `${'0'.repeat(LENGTH)}x`;
    let parsed: Config | undefined;
    expect(elapsedMs(() => { parsed = Config.parseString(`k = ${value}`); })).toBeLessThan(BOUND_MS);
    expect(parsed!.getString('k')).toBe(value);
  });

  test('the number literal accepts exactly what it accepted before', () => {
    const before = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
    const after = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    const cases = [
      '0', '1.', '1.5', '.5', '+.5e3', '-1e-3', '1e', 'e1', '.', '1..2', '007',
      '1.2.3', '+', '--1', '1.e5', '10x', '-0.0', '+1E+10', '1e5.5', '',
    ];
    for (const raw of cases) expect(after.test(raw)).toBe(before.test(raw));
    for (const [raw, expected] of [['1.5', 1.5], ['-1e-3', -0.001], ['.5', 0.5], ['007', 7]] as const) {
      expect(Config.parseString(`k = ${raw}`).getNumber('k')).toBe(expected);
    }
  });
});
