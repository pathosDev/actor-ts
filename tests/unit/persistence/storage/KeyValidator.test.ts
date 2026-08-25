/**
 * Direct tests for `makeKeyValidator` — the shared factory every storage and
 * cache backend routes its key checks through.
 *
 * It had none (#747).  The factory was covered only *through* its consumers:
 * the filesystem backend suite, the Memcached suite and the re-encryption
 * sweep each exercised the rules they happen to switch on, so a rule no
 * backend used was checked by nothing, and the interaction between two rules
 * — which of `rejectNul` and `rejectControlChars` wins, whether an unset
 * optional rule is a no-op — was never stated anywhere. That is exactly the
 * shape of module whose behaviour drifts silently: it is security-critical,
 * declarative, and every caller sees only its own slice.
 *
 * `ObjectStorageWriteKeyRules` is tested here too, because it is the reason
 * the object-storage write paths and the rotation sweep cannot disagree.
 */
import { describe, expect, test } from 'bun:test';
import {
  makeKeyValidator,
  ObjectStorageWriteKeyRules,
  type KeyValidationRules,
} from '../../../../src/persistence/storage/KeyValidator.js';

class TestKeyError extends Error {}

/** Every rule set below shares the error plumbing; only the rules differ. */
const rulesWith = (extra: Partial<KeyValidationRules>): KeyValidationRules => ({
  errorClass: TestKeyError,
  errorPrefix: 'test key',
  ...extra,
});

const validatorWith = (extra: Partial<KeyValidationRules>): ((key: string) => void) =>
  makeKeyValidator(rulesWith(extra));

/**
 * Composed rather than written as a literal: a raw control byte in a source
 * file makes git treat it as binary, and an escape sequence has to survive
 * every tool that rewrites the file.
 */
const withCharCode = (charCode: number): string => `a${String.fromCharCode(charCode)}b`;

describe('makeKeyValidator — length and type', () => {
  const assertKey = validatorWith({});

  test('rejects a non-string and an empty string alike', () => {
    expect(() => assertKey('')).toThrow(/test key: must be a non-empty string/);
    expect(() => assertKey(undefined as unknown as string)).toThrow(/must be a non-empty string/);
    expect(() => assertKey(42 as unknown as string)).toThrow(/must be a non-empty string/);
  });

  test('accepts a plain key when no optional rule is set', () => {
    expect(() => assertKey('user-1/state.json')).not.toThrow();
  });

  test('minLength defaults to 1 and is honoured when raised', () => {
    const assertLongEnough = validatorWith({ minLength: 4 });
    expect(() => assertLongEnough('abc')).toThrow(/must be a non-empty string/);
    expect(() => assertLongEnough('abcd')).not.toThrow();
  });

  test('maxLength counts characters', () => {
    const assertShortEnough = validatorWith({ maxLength: 4 });
    expect(() => assertShortEnough('abcd')).not.toThrow();
    expect(() => assertShortEnough('abcde')).toThrow(/exceeds 4-byte limit \(got 5\)/);
  });

  test('an unset optional rule is a no-op rather than a default rejection', () => {
    // The rules are opt-in: a backend that names none of them gets only the
    // type/length floor.  Asserting it here because every consumer switches
    // some rule on, so nothing else covers the empty rule set.
    expect(() => assertKey('/absolute')).not.toThrow();
    expect(() => assertKey('../traversal')).not.toThrow();
    expect(() => assertKey('has space')).not.toThrow();
    expect(() => assertKey(withCharCode(10))).not.toThrow();
  });
});

describe('makeKeyValidator — maxLengthBytes counts UTF-8 bytes, not characters (#747)', () => {
  /**
   * The distinction is the whole reason the rule exists: S3 publishes its
   * 1024 limit in encoded bytes, so a character count would pass a key the
   * service then rejects — turning a local, attributable refusal into an SDK
   * 400 several frames away.
   */
  test('a multi-byte key is measured by its encoding', () => {
    const assertWithinBytes = validatorWith({ maxLengthBytes: 8 });
    // 4 CJK characters = 12 UTF-8 bytes, comfortably inside a 8-character cap.
    const fourCjk = '\u4e00\u4e8c\u4e09\u56db';
    expect(fourCjk.length).toBe(4);
    expect(() => assertWithinBytes(fourCjk)).toThrow(/exceeds 8-byte limit \(got 12 UTF-8 bytes from 4 characters\)/);
    expect(() => assertWithinBytes('12345678')).not.toThrow();
  });

  test('the count matches TextEncoder across the encoding boundaries', () => {
    const encoder = new TextEncoder();
    const samples = [
      'plain-ascii',
      '\u00e9\u00fc',               // 2-byte
      '\u4e00\u56db',               // 3-byte
      '\u{1f600}\u{1d11e}',         // 4-byte, surrogate pairs
      'mixed-\u00e9\u4e00\u{1f600}',
      '\ud800',                     // lone lead surrogate -> U+FFFD, 3 bytes
      '\udc00tail',                 // lone trail surrogate
      '\ud800\ud800',               // two lead surrogates, neither paired
    ];
    for (const sample of samples) {
      const expected = encoder.encode(sample).length;
      // A validator bounded one byte below the true length must reject, and
      // one bounded at it must accept — which pins the count exactly.
      expect(() => validatorWith({ maxLengthBytes: expected })(sample)).not.toThrow();
      expect(() => validatorWith({ maxLengthBytes: expected - 1 })(sample)).toThrow(/exceeds/);
    }
  });

  test('maxLength and maxLengthBytes are independent', () => {
    const assertBoth = validatorWith({ maxLength: 4, maxLengthBytes: 12 });
    expect(() => assertBoth('\u4e00\u4e8c\u4e09\u56db')).not.toThrow();  // 4 chars, 12 bytes
    expect(() => assertBoth('abcde')).toThrow(/exceeds 4-byte limit/);   // character cap
    expect(() => assertBoth('\u4e00\u4e8c\u4e09')).not.toThrow();
  });
});

describe('makeKeyValidator — NUL and control characters', () => {
  test('rejectNul defaults to on', () => {
    expect(() => validatorWith({})('a\0b')).toThrow(/test key: NUL byte not allowed/);
  });

  test('rejectNul can be switched off', () => {
    expect(() => validatorWith({ rejectNul: false })('a\0b')).not.toThrow();
  });

  test('rejectControlChars covers NUL and reports the sharper message', () => {
    // Precedence, not redundancy: with both rules on, the control-character
    // branch wins so the message names the index and the code.
    const assertNoControl = validatorWith({ rejectControlChars: true });
    expect(() => assertNoControl('a\0b')).toThrow(/contains control character at index 1 \(charCode=0\)/);
  });

  test('rejectControlChars spans 0x00-0x1F and 0x7F but not 0x20 or 0x80', () => {
    const assertNoControl = validatorWith({ rejectControlChars: true });
    for (const charCode of [0, 1, 9, 10, 13, 0x1f, 0x7f]) {
      expect(() => assertNoControl(withCharCode(charCode))).toThrow(/control character/);
    }
    for (const charCode of [0x20, 0x21, 0x80, 0xa0]) {
      expect(() => assertNoControl(withCharCode(charCode))).not.toThrow();
    }
  });

  test('the message no longer claims protocol injection (#747)', () => {
    // The phrase was Memcached's reason for the rule, baked into a shared
    // factory and therefore printed by two object-storage backends that adopt
    // the rule for an unrelated one.
    let message = '';
    try { validatorWith({ rejectControlChars: true })('a\nb'); }
    catch (thrown) { message = (thrown as Error).message; }
    expect(message).toContain('control character');
    expect(message).not.toContain('protocol injection');
  });

  test('rejectSpace is separate from the control-character rule', () => {
    expect(() => validatorWith({ rejectSpace: true })('a b')).toThrow(/contains space at index 1/);
    expect(() => validatorWith({ rejectControlChars: true })('a b')).not.toThrow();
  });
});

describe('makeKeyValidator — path rules', () => {
  const assertPathSafe = validatorWith({
    rejectAbsolutePaths: true,
    rejectRelativeTraversal: true,
  });

  test('rejects POSIX, UNC-style and drive-letter absolute paths', () => {
    expect(() => assertPathSafe('/etc/passwd')).toThrow(/absolute paths not allowed/);
    expect(() => assertPathSafe('\\windows\\system32')).toThrow(/absolute paths not allowed/);
    expect(() => assertPathSafe('C:\\Windows')).toThrow(/absolute paths not allowed/);
    expect(() => assertPathSafe('c:/windows')).toThrow(/absolute paths not allowed/);
  });

  test('rejects a traversal segment on either separator', () => {
    expect(() => assertPathSafe('a/../b')).toThrow(/path-traversal segments/);
    expect(() => assertPathSafe('a\\..\\b')).toThrow(/path-traversal segments/);
    expect(() => assertPathSafe('..')).toThrow(/path-traversal segments/);
  });

  test('a dotted name that is not a traversal segment is allowed', () => {
    // `..` has to be a whole segment — refusing every key that merely
    // contains two dots would reject `snapshot..json` and a pid ending in a
    // version like `v1..2`.
    expect(() => assertPathSafe('a/..b/c')).not.toThrow();
    expect(() => assertPathSafe('snapshot..json')).not.toThrow();
    expect(() => assertPathSafe('a/./b')).not.toThrow();
  });
});

/**
 * #747 — the object-storage write paths and the rotation sweep have to agree
 * on what a key may contain, and the way they disagreed was by restating the
 * same rule in three places and then changing one of them.
 */
describe('ObjectStorageWriteKeyRules — the shared write-path addendum', () => {
  test('is exactly the control-character rule', () => {
    expect(ObjectStorageWriteKeyRules).toEqual({ rejectControlChars: true });
  });

  test('spreading it over a read rule set only ever tightens', () => {
    // The write set must be the read set plus this — never a replacement that
    // could silently drop a read-path rule on the way in.
    const readRules = rulesWith({ rejectNul: true, rejectAbsolutePaths: true });
    const writeRules = { ...readRules, ...ObjectStorageWriteKeyRules };
    const assertWritable = makeKeyValidator(writeRules);

    expect(() => assertWritable('/absolute')).toThrow(/absolute paths not allowed/);
    expect(() => assertWritable(withCharCode(1))).toThrow(/control character/);
    expect(() => assertWritable('user-1/state.json')).not.toThrow();
  });
});
