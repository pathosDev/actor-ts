import { describe, expect, test } from 'bun:test';
import { parseEnvironmentFile } from '../../../src/config/EnvironmentFile.js';

/**
 * The grammar of a `.env` file (#1785) — Node's `--env-file` grammar, so the
 * cases below were each checked against `util.parseEnv` on Node 26, which is
 * the reference.  A parser of its own because Deno has no `util.parseEnv`.
 */
const parse = (text: string): Record<string, string> => ({ ...parseEnvironmentFile(text) });

describe('parseEnvironmentFile (#1785)', () => {
  test('reads KEY=value lines, with or without export', () => {
    expect(parse('A=1\nB=two words')).toStrictEqual({ A: '1', B: 'two words' });
    expect(parse('export A=exported\n  export   B = 1')).toStrictEqual({ A: 'exported', B: '1' });
    expect(parse('export=1\nexported=2')).toStrictEqual({ export: '1', exported: '2' });
  });

  test('drops whitespace around the key and an unquoted value', () => {
    expect(parse('  A  =  padded value  ')).toStrictEqual({ A: 'padded value' });
    expect(parse('\tA\t=\tt\t')).toStrictEqual({ A: 't' });
  });

  test('a quoted value is the text between the quotes, in any of three quotes', () => {
    expect(parse('A="double"\nB=\'single\'\nC=`back`')).toStrictEqual({ A: 'double', B: 'single', C: 'back' });
    expect(parse('A = " spaced "  ')).toStrictEqual({ A: ' spaced ' });
    expect(parse('A=\'it"s\'')).toStrictEqual({ A: 'it"s' });
  });

  test('a quoted value may span lines, so a PEM key fits', () => {
    expect(parse('KEY="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nB=2'))
      .toStrictEqual({ KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----', B: '2' });
  });

  test('reads \\n as a line break inside double quotes only, and no other escape', () => {
    expect(parse('A="a\\nb"')).toStrictEqual({ A: 'a\nb' });
    expect(parse("A='a\\nb'")).toStrictEqual({ A: 'a\\nb' });
    expect(parse('A=a\\nb')).toStrictEqual({ A: 'a\\nb' });
    expect(parse('A="a\\tb"')).toStrictEqual({ A: 'a\\tb' });
    expect(parse('A=C:\\logs\\app')).toStrictEqual({ A: 'C:\\logs\\app' });
  });

  test('a # starts a comment in an unquoted value, but not inside quotes', () => {
    expect(parse('A=plain # trailing\nB=plain#x')).toStrictEqual({ A: 'plain', B: 'plain' });
    expect(parse('A="x # y"\nB="v" # c')).toStrictEqual({ A: 'x # y', B: 'v' });
    expect(parse('# a comment\n\n   # indented\nA=1\n# tail')).toStrictEqual({ A: '1' });
  });

  test('keeps $VAR as written — no expansion, so a bcrypt hash survives', () => {
    expect(parse('HASH=$2b$10$abcdefghijk\nB=1\nA=x$B ${B}')).toStrictEqual({ HASH: '$2b$10$abcdefghijk', B: '1', A: 'x$B ${B}' });
  });

  test('the last assignment wins, and a line without = is ignored', () => {
    expect(parse('A=1\nA=2')).toStrictEqual({ A: '2' });
    expect(parse('A=1\ngarbage line\nB=2')).toStrictEqual({ A: '1', B: '2' });
    expect(parse('=novalue\nJUSTAWORD')).toStrictEqual({});
  });

  test('an empty value is kept as empty — whether that counts as set is the resolver\'s call', () => {
    expect(parse('A=\nB=""\nC=\'\'')).toStrictEqual({ A: '', B: '', C: '' });
  });

  test('an unterminated quote is read to the end of its line, quote included', () => {
    expect(parse('A="unterminated\nB=2')).toStrictEqual({ A: '"unterminated', B: '2' });
  });

  test('tolerates CRLF line ends and drops a leading byte-order mark', () => {
    expect(parse('A=1\r\nB=2\r\n')).toStrictEqual({ A: '1', B: '2' });
    expect(parse('\uFEFFA=1')).toStrictEqual({ A: '1' });
  });

  test('a key named __proto__ is an ordinary variable and reaches no prototype', () => {
    const variables = parseEnvironmentFile('__proto__=x\nconstructor=y');
    expect(Object.hasOwn(variables, '__proto__')).toBe(true);
    expect(variables['__proto__']).toBe('x');
    expect(Object.getPrototypeOf(variables)).toBeNull();
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
});
