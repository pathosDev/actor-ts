import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **No broker reader hands a `Config` accessor a path that holds a string
 * literal — anywhere in the argument, on any line of it** (#1443).
 *
 * Every broker leaf is read through a full-path constant: its block's
 * `ConfigKeys` group, or a composer.  That is what makes a misspelt or retired
 * leaf a compile error instead of a key nothing reads, and it is held per line
 * by `BrokerConfigCompleteness.test.ts`, which matches a literal that opens
 * the argument on the accessor's own line.  Two ordinary ways of writing a
 * read pass that check: the argument on the line after the opening
 * parenthesis, as a long call is formatted, and a path assembled from a
 * constant and a literal — `keys.root + '.legacyUrl'`.  Either one reads a key
 * the typed tree does not hold.
 *
 * So this walks each accessor call's argument list to its closing parenthesis
 * — across lines, through nested calls — and fails on any string or template
 * literal inside it.  Comments are blanked first, so a commented-out read
 * binds nothing; a literal inside another string is not code either.
 *
 * What it cannot see: a literal that reaches the accessor through a local
 * (`const path = 'x'; config.getString(path)`), and an accessor called under
 * another name.  Both are a deliberate detour rather than a way of
 * formatting a read.
 */

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'src');

/** What each character of a source file is: code, inside a literal, or inside a comment. */
const CODE = 0;
const LITERAL = 1;
const COMMENT = 2;

/** Characters after which a `/` opens a regular expression rather than dividing. */
const REGULAR_EXPRESSION_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Keywords after which a `/` opens a regular expression. */
const REGULAR_EXPRESSION_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do']);

/**
 * Classify every character of `source`.  A small lexer, not a parser: it
 * knows quotes, template literals with their `${…}` holes, comments and
 * regular expression literals — enough that a quote inside a regex or a
 * comment does not open a string, which a line-wise pattern cannot tell.
 */
function classify(source: string): Uint8Array {
  const kinds = new Uint8Array(source.length);

  const mark = (from: number, to: number, kind: number): void => { kinds.fill(kind, from, to); };

  /** The last non-space code character before `at`, and the word it ends, if any. */
  function precedingToken(at: number): { readonly character: string; readonly word: string } {
    let cursor = at - 1;
    while (cursor >= 0 && (/\s/.test(source[cursor]!) || kinds[cursor] === COMMENT)) cursor--;
    if (cursor < 0) return { character: '', word: '' };
    let start = cursor;
    while (start > 0 && /[A-Za-z_$]/.test(source[start - 1]!)) start--;
    return { character: source[cursor]!, word: source.slice(start, cursor + 1) };
  }

  /** Skip a quoted string opened at `at`; returns the index after it. */
  function skipQuoted(at: number): number {
    const quote = source[at]!;
    let cursor = at + 1;
    while (cursor < source.length && source[cursor] !== quote && source[cursor] !== '\n') {
      cursor += source[cursor] === '\\' ? 2 : 1;
    }
    return Math.min(cursor + 1, source.length);
  }

  /** Skip a template literal opened at `at`, holes included; returns the index after it. */
  function skipTemplate(at: number): number {
    let cursor = at + 1;
    while (cursor < source.length && source[cursor] !== '`') {
      if (source[cursor] === '\\') { cursor += 2; continue; }
      if (source[cursor] === '$' && source[cursor + 1] === '{') {
        cursor = skipCode(cursor + 2, '}');
        continue;
      }
      cursor++;
    }
    return Math.min(cursor + 1, source.length);
  }

  /** Skip a regular expression literal opened at `at`, flags included. */
  function skipRegularExpression(at: number): number {
    let cursor = at + 1;
    let inClass = false;
    while (cursor < source.length && source[cursor] !== '\n') {
      const character = source[cursor]!;
      if (character === '\\') { cursor += 2; continue; }
      if (character === '[') inClass = true;
      else if (character === ']') inClass = false;
      else if (character === '/' && !inClass) break;
      cursor++;
    }
    cursor++;
    while (cursor < source.length && /[a-z]/i.test(source[cursor]!)) cursor++;
    return cursor;
  }

  /**
   * Classify code from `at` until `closer` at depth zero (or the end), marking
   * literals and comments on the way; returns the index after the closer.
   */
  function skipCode(at: number, closer: string | null): number {
    let cursor = at;
    let depth = 0;
    while (cursor < source.length) {
      const character = source[cursor]!;
      const next = source[cursor + 1];
      if (character === '/' && next === '/') {
        const end = source.indexOf('\n', cursor);
        const stop = end === -1 ? source.length : end;
        mark(cursor, stop, COMMENT);
        cursor = stop;
        continue;
      }
      if (character === '/' && next === '*') {
        const end = source.indexOf('*/', cursor + 2);
        const stop = end === -1 ? source.length : end + 2;
        mark(cursor, stop, COMMENT);
        cursor = stop;
        continue;
      }
      if (character === '\'' || character === '"') {
        const stop = skipQuoted(cursor);
        mark(cursor, stop, LITERAL);
        cursor = stop;
        continue;
      }
      if (character === '`') {
        const stop = skipTemplate(cursor);
        mark(cursor, stop, LITERAL);
        cursor = stop;
        continue;
      }
      if (character === '/') {
        const { character: before, word } = precedingToken(cursor);
        if (before === '' || REGULAR_EXPRESSION_PRECEDERS.has(before) || REGULAR_EXPRESSION_KEYWORDS.has(word)) {
          const stop = skipRegularExpression(cursor);
          mark(cursor, stop, LITERAL);
          cursor = stop;
          continue;
        }
      }
      if (closer !== null) {
        if (character === '{') depth++;
        else if (character === '}') {
          if (depth === 0) return cursor + 1;
          depth--;
        }
      }
      cursor++;
    }
    return cursor;
  }

  skipCode(0, null);
  return kinds;
}

/** `.hasPath(` and every `.get…(` — so a getter added to `Config` later is covered the day it lands. */
const ACCESSOR_CALL = /\.(?:hasPath|get[A-Z]\w*)\s*\(/g;

/**
 * Every accessor call in `source` whose argument list holds a string or
 * template literal, as `line: call` with the call's text flattened.
 */
function literalPathArgumentsIn(source: string): ReadonlyArray<string> {
  const kinds = classify(source);
  const out: string[] = [];
  for (const match of source.matchAll(ACCESSOR_CALL)) {
    const start = match.index;
    if (kinds[start] !== CODE) continue;
    const open = start + match[0].length - 1;
    let depth = 1;
    let literal = false;
    let cursor = open + 1;
    for (; cursor < source.length && depth > 0; cursor++) {
      const kind = kinds[cursor];
      if (kind === LITERAL) literal = true;
      if (kind !== CODE) continue;
      if (source[cursor] === '(') depth++;
      else if (source[cursor] === ')') depth--;
    }
    if (!literal) continue;
    const line = source.slice(0, start).split('\n').length;
    out.push(`${line}: ${source.slice(start, cursor).replace(/\s+/g, ' ').trim()}`);
  }
  return out;
}

/**
 * The files that read a broker block: every one that exports a
 * `read…FromConfig` function — each broker's reader, the shared leaves' in
 * `BrokerOptions.ts`, the framing reader, and the WebSocket client's, which
 * lives outside `src/io/broker/` and is a broker all the same.
 */
function readerFiles(): ReadonlyArray<string> {
  const candidates = [
    ...readdirSync(join(SOURCE_ROOT, 'io', 'broker'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `io/broker/${name}`),
    'http/websocket/WebsocketClientActor.ts',
  ];
  return candidates.filter((file) =>
    /export function read\w*FromConfig\(/.test(readFileSync(join(SOURCE_ROOT, file), 'utf8'))).sort();
}

describe('the literal-path scan', () => {
  test('finds a literal wherever it sits in the argument list', () => {
    expect(literalPathArgumentsIn("if (config.hasPath('url')) out.url = config.getString('url');")).toHaveLength(2);
    // On the line after the opening parenthesis, as a long call is formatted.
    expect(literalPathArgumentsIn('out.url = config.getString(\n  \'actor-ts.io.broker.mqtt.url\',\n);'))
      .toEqual(["1: .getString( 'actor-ts.io.broker.mqtt.url', )"]);
    // Assembled from a constant and a literal.
    expect(literalPathArgumentsIn("out.url = config.getString(keys.root + '.legacyUrl');")).toHaveLength(1);
    expect(literalPathArgumentsIn('x = config.getBytes(`${keys.root}.max-frame-len`);')).toHaveLength(1);
    expect(literalPathArgumentsIn('x = config.getInt("port");')).toHaveLength(1);
    // Inside a nested call that builds the path.
    expect(literalPathArgumentsIn("x = config.getString(join(keys.root, 'url'));")).toHaveLength(1);
    // CRLF line endings, as a Windows checkout has them.
    expect(literalPathArgumentsIn('a = 1;\r\nb = sub.getInt(\r\n  \'port\',\r\n);\r\n'))
      .toEqual(["2: .getInt( 'port', )"]);
  });

  test('finds nothing in a read through constants, a comment, or a string', () => {
    expect(literalPathArgumentsIn('if (config.hasPath(keys.url)) out.url = config.getString(keys.url);')).toEqual([]);
    expect(literalPathArgumentsIn('out.port = config.getInt(\n  keys.port,\n);')).toEqual([]);
    expect(literalPathArgumentsIn("// out.url = config.getString('url');\nout.url = config.getString(keys.url);"))
      .toEqual([]);
    expect(literalPathArgumentsIn("/* config.getString('url') */ out.url = config.getString(keys.url);")).toEqual([]);
    expect(literalPathArgumentsIn("throw new Error(\"call config.getString('url') instead\");")).toEqual([]);
    // A literal outside the argument list is not the path.
    expect(literalPathArgumentsIn("label = config.getString(keys.url) + '/stream';")).toEqual([]);
    // `get` alone is not an accessor; a regex holding a quote opens no string.
    expect(literalPathArgumentsIn("const value = headers.get('x');")).toEqual([]);
    expect(literalPathArgumentsIn("const quoted = /['\"]/.test(raw); out.url = config.getString(keys.url);"))
      .toEqual([]);
  });

  test('a template literal with a hole is one literal, and the code after it is code again', () => {
    expect(literalPathArgumentsIn('const label = `${host}:${port}`;\nout.url = config.getString(keys.url);')).toEqual([]);
    expect(literalPathArgumentsIn('const label = `${f(`x`)}`;\nout.url = config.getString(\'url\');')).toHaveLength(1);
  });
});

describe('no broker reader passes a literal path to a Config accessor, on any line of the call', () => {
  const files = readerFiles();

  test('the scan covers every broker reader', () => {
    // Discovery that matched nothing would pass every file; the four named
    // here are the shapes the set has to include.
    expect(files.length).toBeGreaterThanOrEqual(18);
    for (const file of ['io/broker/BrokerOptions.ts', 'io/broker/TcpFraming.ts', 'io/broker/JetStreamActor.ts',
      'http/websocket/WebsocketClientActor.ts']) {
      expect(files).toContain(file);
    }
  });

  test.each([...files])('%s reads through constants only', (file) => {
    expect(
      literalPathArgumentsIn(readFileSync(join(SOURCE_ROOT, file), 'utf8')),
      `${file} hands a Config accessor a path holding a string literal.  Read every broker leaf through a `
      + 'full-path constant — its block\'s ConfigKeys group, or a composer — so a misspelt or retired leaf is a '
      + 'compile error rather than a key nothing reads (#1443).',
    ).toEqual([]);
  });
});
