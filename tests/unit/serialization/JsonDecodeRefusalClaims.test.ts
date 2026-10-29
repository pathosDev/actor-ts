import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';

/**
 * `serialization/json.mdx` says, in both languages, what the JSON decoder
 * refuses and what it does not — and the first version of that paragraph was
 * false.  It promised a typed refusal for every malformed tag while an
 * `__error__` named `toString` escaped `fromBinary` as a raw `TypeError` and
 * one named `constructor` decoded to a `String` wrapper (#1449).  Prose has no
 * gate of its own, so this file gives the paragraph one, in the shape
 * `tests/unit/http/cache/RateLimitEvictionClaims.test.ts` uses: every fact the
 * paragraph states is re-measured here, and the paragraph itself is read, so a
 * rewrite that drops or inverts the corrected sentences turns a test red
 * rather than only a reviewer's head.
 *
 * The reading drops MDX and HTML comments first — a sentence inside
 * `{/* … *\/}` renders nothing, so it must not count as said — and folds line
 * endings and wrapping away, so neither CRLF nor a re-wrap moves the result.
 * What it cannot catch is a contradicting sentence written somewhere else on
 * the page in words these checks do not look for; that is the accepted ceiling.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const PAGES = [
  {
    language: 'en',
    path: 'docs/src/content/docs/serialization/json.mdx',
    heading: 'What the decoder refuses',
    sentences: [
      '`fromBinary` refuses a document that is not JSON at all with a `SerializationError` naming the parse failure, and a malformed type tag inside well-formed JSON with one naming the tag',
      'An `__error__` whose `name` or `message` is not a string is such a malformed tag.',
      'A `name` with no built-in error class behind it is not: that error decodes to a plain `Error` that keeps the name',
      'a member of `Object.prototype` such as `toString` or `constructor` is no exception.',
    ],
    refusalWords: /refus|reject|SerializationError|throw/i,
  },
  {
    language: 'de',
    path: 'docs/src/content/docs/de/serialization/json.mdx',
    heading: 'Was der Decoder ablehnt',
    sentences: [
      '`fromBinary` lehnt ein Dokument, das gar kein JSON ist, mit einem `SerializationError` ab, der den Parse-Fehler benennt, und einen fehlerhaften Type-Tag in wohlgeformtem JSON mit einem, der den Tag benennt',
      'Ein `__error__`, dessen `name` oder `message` kein String ist, ist ein solcher fehlerhafter Tag.',
      'Ein `name` ohne eingebaute Fehlerklasse dahinter ist es nicht: Dieser Fehler kommt als einfacher `Error` an, der den Namen behält',
      'ein Member von `Object.prototype` wie `toString` oder `constructor` ist keine Ausnahme.',
    ],
    refusalWords: /lehnt|ablehn|abgelehnt|SerializationError|wirft|geworfen/i,
  },
] as const;

/**
 * The first paragraph under `## <heading>`, as a reader sees it: comments that
 * render nothing are removed, and every run of whitespace is one space.
 */
function renderedOpeningParagraph(relativePath: string, heading: string): string {
  const text = readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`${relativePath} has no '## ${heading}' section`);
  const paragraph: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  return paragraph.join(' ').replace(/\s+/g, ' ').trim();
}

/** Inline code spans in order — the part of a paragraph a translation must not change. */
function codeSpans(paragraph: string): string[] {
  return [...paragraph.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

function errorThrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the decode to throw');
}

describe('json.mdx "What the decoder refuses" states the typed-error rule as it is (#1449)', () => {
  for (const page of PAGES) {
    test(`${page.language}: the paragraph carries every corrected sentence`, () => {
      const paragraph = renderedOpeningParagraph(page.path, page.heading);
      for (const sentence of page.sentences) expect(paragraph).toContain(sentence);
    });

    test(`${page.language}: no sentence that names an Object.prototype member calls it refused`, () => {
      const paragraph = renderedOpeningParagraph(page.path, page.heading);
      const offending = paragraph
        .split(/(?<=\.)\s+/)
        .filter((sentence) => /`toString`|`constructor`|`Object\.prototype`/.test(sentence))
        .filter((sentence) => page.refusalWords.test(sentence));
      expect(offending).toEqual([]);
    });
  }

  test('the two languages carry the same code spans in the same order', () => {
    const [english, german] = PAGES.map((page) => codeSpans(renderedOpeningParagraph(page.path, page.heading)));
    expect(german).toEqual(english!);
  });
});

describe('every fact that paragraph states, measured', () => {
  const json = new JsonSerializer();
  const encoder = new TextEncoder();
  const decode = (document: string): unknown => json.fromBinary(encoder.encode(document), '');

  test('a document that is not JSON is a SerializationError naming the parse failure', () => {
    const error = errorThrownBy(() => decode('{not json'));
    expect(error).toBeInstanceOf(SerializationError);
    expect(error.message).toStartWith('JsonSerializer: document is not valid JSON: ');
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test('a malformed tag inside well-formed JSON is a SerializationError naming the tag', () => {
    const error = errorThrownBy(() => decode('{"__map__":5}'));
    expect(error).toBeInstanceOf(SerializationError);
    expect(error.message).toContain('__map__');
    expect(error.message).not.toContain('not valid JSON');
  });

  test('an __error__ whose name or message is not a string is such a malformed tag', () => {
    for (const document of [
      '{"__error__":{"name":42,"message":"x"}}',
      '{"__error__":{"name":"Error","message":42}}',
      '{"__error__":{"message":"x"}}',
    ]) {
      const error = errorThrownBy(() => decode(document));
      expect(error).toBeInstanceOf(SerializationError);
      expect(error.message).toBe('Malformed __error__ tag: expected a { name, message } object');
    }
  });

  test('a name with no built-in class behind it decodes to a plain Error that keeps the name', () => {
    for (const name of ['PaymentDeclinedError', 'AskTimeoutError', ...Object.getOwnPropertyNames(Object.prototype)]) {
      const decoded = decode(JSON.stringify({ __error__: { name, message: 'x' } })) as Error;
      expect(Object.getPrototypeOf(decoded)).toBe(Error.prototype);
      expect(decoded.name).toBe(name);
      expect(decoded.message).toBe('x');
    }
  });

  test('a built-in name still rebuilds its own class, which is what "no built-in class" sets apart', () => {
    const decoded = decode('{"__error__":{"name":"RangeError","message":"x"}}');
    expect(Object.getPrototypeOf(decoded)).toBe(RangeError.prototype);
  });
});
