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
 * **Two rule sets per object-storage backend, not one** (#747).  Each
 * declares an `XxxKeyRules` for `get`/`delete`/`list` and an
 * `XxxWriteKeyRules` — the same rules plus
 * {@link ObjectStorageWriteKeyRules} — for `put`.  The asymmetry is
 * deliberate and matches the one `PersistenceIdValidator` documents: a
 * rule tightened on the read path does not reject a *new* bad key, it
 * strands an *existing* object, which becomes unreadable and
 * undeletable through the very backend that wrote it.  Tightening only
 * the write path makes the change recoverable — the operator can still
 * list, read and delete whatever the old rules let in.
 *
 * **Security-critical**: this module is the front-line for path-
 * traversal and protocol-injection defences.  Changes to the rules
 * must preserve every rejected-input the pre-refactor validators
 * caught.  Adversarial test cases live alongside each backend.
 */

export type KeyValidationRules = {
  /** Error constructor used for every thrown rejection. */
  readonly errorClass: new (message: string) => Error;
  /**
   * Phrase prepended to every rejection message — typically the
   * backend name ('memcached key', 'invalid key' for FS, etc.).
   */
  readonly errorPrefix: string;
  /** Minimum key length.  Default: 1 (non-empty). */
  readonly minLength?: number;
  /** Maximum key length, in UTF-16 code units.  Default: unbounded. */
  readonly maxLength?: number;
  /**
   * Maximum key length in **UTF-8 bytes**.  Default: unbounded.
   *
   * Separate from {@link maxLength} because the two disagree exactly where
   * it matters.  `maxLength` counts `String.length`, i.e. UTF-16 code
   * units, while every remote store that publishes a key-length limit
   * publishes it in encoded bytes — S3's is 1024 UTF-8 bytes.  A key of
   * 600 CJK characters is 600 code units and 1800 bytes: it passes a
   * 1024-`maxLength` check and is then rejected by the service, which
   * turns a local, attributable rejection into a remote 400 several
   * frames away.
   *
   * Both may be set; each is checked on its own terms.  `maxLength` is
   * kept for backends whose limit really is a character count.
   */
  readonly maxLengthBytes?: number;
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
};

/**
 * The rules every object-storage **write** path adds on top of its own read
 * rules, and the rules the master-key rotation sweep enforces on the way back
 * out of the bucket (#747).
 *
 * One object spread into all three sites, rather than the same literal
 * written three times, because agreement between them is the property that
 * failed: the sweep already validated with `rejectControlChars` while
 * neither backend did, so the framework wrote keys its own rotation tool then
 * refused — and refusing one is what now fails a sweep.  Restating the rule
 * is how that drift happened; spreading it is what makes a future divergence
 * an edit to this line rather than a silent mismatch.
 *
 * It lives here, beside {@link KeyValidationRules}, because it *is* a
 * fragment of that shape — it has no meaning apart from the validator it
 * configures, and no consumer reads it as a tuned value.
 */
export const ObjectStorageWriteKeyRules = {
  rejectControlChars: true,
} as const;

/**
 * UTF-8 byte length of `key`, counted rather than encoded.
 *
 * `new TextEncoder().encode(key).length` would be the obvious spelling and
 * is what this reproduces byte for byte — including the U+FFFD (3-byte)
 * substitution WHATWG mandates for an unpaired surrogate.  Counting avoids
 * allocating a throwaway buffer per validated key on what is the hot path
 * of every `put`/`get`/`delete`, and a validator that allocates in
 * proportion to the input it is bounding is the wrong shape for a limit
 * check.
 */
function utf8ByteLength(key: string): number {
  let bytes = 0;
  for (let index = 0; index < key.length; index++) {
    const unit = key.charCodeAt(index);
    if (unit < 0x80) { bytes += 1; continue; }
    if (unit < 0x800) { bytes += 2; continue; }
    // A well-formed surrogate pair is one code point encoded in 4 bytes;
    // consume the trail unit here so it is not counted a second time.
    if (unit >= 0xD800 && unit <= 0xDBFF && index + 1 < key.length) {
      const trail = key.charCodeAt(index + 1);
      if (trail >= 0xDC00 && trail <= 0xDFFF) { bytes += 4; index += 1; continue; }
    }
    // Everything else — BMP code points and unpaired surrogates, the
    // latter encoded as U+FFFD — is 3 bytes.
    bytes += 3;
  }
  return bytes;
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
    maxLengthBytes,
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
    if (maxLengthBytes !== undefined) {
      const encodedLength = utf8ByteLength(key);
      if (encodedLength > maxLengthBytes) {
        throw new errorClass(
          `${errorPrefix}: exceeds ${maxLengthBytes}-byte limit `
          + `(got ${encodedLength} UTF-8 bytes from ${key.length} characters)`,
        );
      }
    }
    // Control chars cover NUL and more.  Checked BEFORE the NUL-only check
    // so the sharper "control character (charCode=N)" message wins when both
    // rules are on (matches the pre-refactor MemcachedCache behaviour).
    //
    // The message states the fact and stops there.  It used to append "would
    // allow protocol injection", which was Memcached's reason for the rule
    // baked into a shared factory — true there, and false on the two
    // object-storage write paths that adopted the rule for an unrelated one
    // (#747).  Each rule set's JSDoc carries its own why.
    if (rejectControlChars) {
      for (let i = 0; i < key.length; i++) {
        const charCode = key.charCodeAt(i);
        if (charCode <= 0x1F || charCode === 0x7F) {
          throw new errorClass(
            `${errorPrefix}: contains control character at index ${i} (charCode=${charCode})`,
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
      const spaceIndex = key.indexOf(' ');
      if (spaceIndex >= 0) {
        throw new errorClass(
          `${errorPrefix}: contains space at index ${spaceIndex} — would allow protocol injection`,
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
