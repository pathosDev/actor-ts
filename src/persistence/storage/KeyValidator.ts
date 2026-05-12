/**
 * Shared factory for backend-specific key-validation functions.
 *
 * Storage and cache backends each have slightly different rules for
 * what makes a "safe" key — Memcached forbids whitespace because of
 * its text protocol, the filesystem forbids `..` segments because of
 * path traversal, S3 has its own constraints, and so on.  Before
 * this module existed, each backend had a hand-rolled
 * `assertSafeXxxKey` function with subtle drift between sites.
 *
 * `makeKeyValidator(rules)` materialises a `(key: string) => void`
 * validator from a declarative `KeyValidationRules` object.  The
 * rules cover the union of all checks any current backend cares
 * about; individual backends select the rules that apply to them
 * via the pre-defined `*KeyRules` constants below.
 *
 * Adding a new backend (S3, GCS, …): create a new `XxxKeyRules`
 * constant, instantiate the validator via `makeKeyValidator`, call
 * it on every key the backend touches.  No bespoke validator code
 * needed.
 *
 * **Security-critical**: this module is the front-line for path-
 * traversal and protocol-injection defences.  Changes to the rules
 * must preserve every rejected-input the pre-refactor validators
 * caught.  Adversarial test cases live alongside each backend.
 */

export interface KeyValidationRules {
  /** Error constructor used for every thrown rejection. */
  readonly errorClass: new (msg: string) => Error;
  /**
   * Phrase prepended to every rejection message — typically the
   * backend name ('memcached key', 'invalid key' for FS, etc.).
   */
  readonly errorPrefix: string;
  /** Minimum key length.  Default: 1 (non-empty). */
  readonly minLength?: number;
  /** Maximum key length.  Default: unbounded. */
  readonly maxLength?: number;
  /**
   * Reject NUL bytes (`\0`).  C-level APIs treat NUL as terminator;
   * letting it pass would let an attacker truncate keys.  Default: true.
   */
  readonly rejectNul?: boolean;
  /**
   * Reject all ASCII control characters (0x00–0x1F, 0x7F).
   * Memcached's text protocol uses these as command separators —
   * passing one through is a protocol-injection vector.  Default: false.
   * (Implies `rejectNul` if set.)
   */
  readonly rejectControlChars?: boolean;
  /**
   * Reject the ASCII space character (0x20).  Memcached treats space
   * as a command delimiter.  Default: false.
   */
  readonly rejectSpace?: boolean;
  /**
   * Reject keys that look like absolute paths.  POSIX leading `/`,
   * Windows leading `\\` or drive-letter (`C:\` / `C:/`).  Required
   * for filesystem keys — `path.join('/safe', '/etc/passwd')` returns
   * `'/etc/passwd'`, defeating any root check.  Default: false.
   */
  readonly rejectAbsolutePaths?: boolean;
  /**
   * Reject keys containing a `..` segment when split on path
   * separators.  Required for filesystem keys — `..` collapses up
   * the tree on `path.resolve()`.  Default: false.
   */
  readonly rejectRelativeTraversal?: boolean;
}

/**
 * Build a key-validator function from a rule set.  Returns
 * `(key: string) => void` that throws on rejected input.
 *
 * Validator semantics: short-circuits on the first failed rule.
 * Order of checks: type/length → NUL → control chars → space →
 * absolute path → traversal segments.  Per-rule comments below
 * document the precedence rationale.
 */
export function makeKeyValidator(rules: KeyValidationRules): (key: string) => void {
  const {
    errorClass,
    errorPrefix,
    minLength = 1,
    maxLength,
    rejectNul = true,
    rejectControlChars = false,
    rejectSpace = false,
    rejectAbsolutePaths = false,
    rejectRelativeTraversal = false,
  } = rules;

  return (key: string): void => {
    // Type + length first — every subsequent check assumes a non-empty
    // string of the right type.
    if (typeof key !== 'string' || key.length < minLength) {
      throw new errorClass(`${errorPrefix}: must be a non-empty string`);
    }
    if (maxLength !== undefined && key.length > maxLength) {
      throw new errorClass(`${errorPrefix}: exceeds ${maxLength}-byte limit (got ${key.length})`);
    }
    // Control chars cover NUL and more — Memcached protocol injection
    // vector.  Checked BEFORE the NUL-only check so the sharper
    // "control character (charCode=N)" message wins when both rules
    // are on (matches the pre-refactor MemcachedCache behaviour).
    if (rejectControlChars) {
      for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        if (c <= 0x1F || c === 0x7F) {
          throw new errorClass(
            `${errorPrefix}: contains control character at index ${i} ` +
            `(charCode=${c}) — would allow protocol injection`,
          );
        }
      }
    }
    // NUL byte — handled when `rejectControlChars` is OFF (e.g. for
    // filesystem keys, where we want to reject \0 but allow other
    // control chars in legitimate filenames if any user code ever
    // does that).  Sharper error message than the generic
    // control-char rule.
    if (rejectNul && !rejectControlChars && key.includes('\0')) {
      throw new errorClass(`${errorPrefix}: NUL byte not allowed`);
    }
    if (rejectSpace) {
      const spaceIdx = key.indexOf(' ');
      if (spaceIdx >= 0) {
        throw new errorClass(
          `${errorPrefix}: contains space at index ${spaceIdx} — would allow protocol injection`,
        );
      }
    }
    // Absolute-path rejection — POSIX `/foo`, Windows `\foo`, drive-letter.
    if (rejectAbsolutePaths && (key.startsWith('/') || key.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(key))) {
      throw new errorClass(`${errorPrefix}: absolute paths not allowed (got ${key})`);
    }
    // Relative-traversal: split on either separator since FS code uses
    // path.join which is platform-aware.
    if (rejectRelativeTraversal) {
      const segs = key.split(/[/\\]/);
      if (segs.some((s) => s === '..')) {
        throw new errorClass(
          `${errorPrefix}: path-traversal segments ("..") not allowed (got ${key})`,
        );
      }
    }
  };
}
