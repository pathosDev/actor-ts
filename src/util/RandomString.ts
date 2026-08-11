/**
 * Cryptographically random strings for names and identifiers.  The framework
 * draws its own generated actor names, reply refs and trace ids from here, and
 * so can you.
 *
 * One recipe, in one place: `globalThis.crypto` for entropy, rejection sampling
 * to remove modulo bias, and a loop that makes the requested length a guarantee
 * rather than a best effort.  Deciding those three once is the point — the two
 * shapes a call site reaches for instead, `Math.random()` and a sliced
 * `randomUUID()`, are respectively not random and not the length you asked for.
 *
 * The *unsliced* UUID is here as {@link randomUuid}, so that the one identifier
 * question this file cannot answer with an alphabet and a length — "give me one
 * that will not collide with an identifier minted in some other process" — does
 * not have to leave the module either.
 */

const LOWERCASE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const HEX_DIGITS = '0123456789abcdef';

/**
 * Which character classes {@link randomString} draws from.  Every class defaults
 * to enabled, so `randomString(12)` is alphanumeric.
 *
 * There is deliberately no `letters` flag: it would overlap with the two case
 * flags and admit states with no meaning — `letters: false` alongside
 * `upperCase: true`, or `letters: true` with both cases off.  Three orthogonal
 * classes have no such state, and "letters" is simply `lowerCase || upperCase`.
 */
export type RandomStringOptions = {
  /** Include `a`–`z`.  Default `true`. */
  readonly lowerCase?: boolean;
  /** Include `A`–`Z`.  Default `true`. */
  readonly upperCase?: boolean;
  /** Include `0`–`9`.  Default `true`. */
  readonly digits?: boolean;
};

/**
 * `length` characters drawn uniformly from the enabled character classes.
 *
 * Always returns exactly `length` characters — see {@link fromAlphabet} for what
 * makes that a guarantee rather than a best effort.  Throws if `length` is not a
 * non-negative integer, or if every class is disabled: an empty alphabet has
 * nothing to draw from, and failing loudly beats a call that never returns.
 */
export function randomString(length: number, options: RandomStringOptions = {}): string {
  const alphabet =
    ((options.lowerCase ?? true) ? LOWERCASE_LETTERS : '')
    + ((options.upperCase ?? true) ? UPPERCASE_LETTERS : '')
    + ((options.digits ?? true) ? DIGITS : '');
  return fromAlphabet(length, alphabet);
}

/**
 * `length` lowercase hex characters.
 *
 * Deliberately not a {@link randomString} flag combination — `a`–`f` is a subset
 * of the letters, not a class of its own.  It is separate because W3C
 * trace-context *mandates* this alphabet: a `traceparent` header carries
 * `[0-9a-f]{32}` and `[0-9a-f]{16}`, and a peer rejects anything else.
 */
export function randomHex(length: number): string {
  return fromAlphabet(length, HEX_DIGITS);
}

/**
 * `length` random characters for something the framework has to name itself.
 *
 * Such a name ends up in an actor path, and a path is an address: on the cluster
 * wire anything that can render one can send to it.  A counter makes that
 * address guessable — knowing one hands you the next — which is why `ask`'s
 * reply refs and anonymous actors both draw from here.  Twelve hex characters
 * are ~48 bits, far past the number of names either site has live at once, which
 * is the only uniqueness that has to hold.
 *
 * Hex rather than the full alphanumeric range, even though nothing mandates it
 * here the way `traceparent` does for {@link randomHex}: these names are read far
 * more often than they are typed — a log line, a DevTools row, a grep — and one
 * case with no letter/digit lookalikes reads better there than the extra bits per
 * character are worth.  Kept distinct from `randomHex` so that reasoning stays
 * local: this one names a *purpose* and could change alphabet, that one names an
 * *external constraint* and cannot.
 */
export function randomId(length: number): string {
  return randomHex(length);
}

/**
 * A random version-4 UUID — `'f81d4fae-7dec-41d0-a765-00a0c91e6bf6'`.
 *
 * The counterpart to {@link randomId}.  That one names something *inside* one
 * process and only has to be unguessable among the names that process holds live
 * at once, which is why ~48 bits are plenty.  This one has to stay distinct from
 * identifiers minted by other processes, on other machines, years apart, with
 * nothing coordinating them: a `PersistenceId` for a new aggregate, a
 * correlation id carried across a broker, a key some other system will read
 * later.  122 random bits are what makes that hold without a coordinator.
 *
 * Delegates to `globalThis.crypto.randomUUID()` instead of assembling one from
 * {@link randomHex}, because six of the 128 bits are not entropy: RFC 9562 fixes
 * a version and a variant field, and a hex string with dashes inserted in the
 * right places merely *looks* like a UUID — anything that parses a version out
 * of it reads garbage.  Delegating gets that right by construction, and keeps
 * the choice of primitive in the one file that owns where identifiers come from
 * rather than re-made per call site.
 *
 * No `length` parameter, deliberately: a UUID is 36 characters, and cutting one
 * down is the exact mistake this module exists to make unnecessary — reach for
 * {@link randomHex} or {@link randomId} when you want *n* characters.
 */
export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

function fromAlphabet(length: number, alphabet: string): string {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`length must be a non-negative integer, got ${length}`);
  }
  if (alphabet.length === 0) {
    throw new RangeError('at least one character class must be enabled');
  }
  if (length === 0) return '';

  // `byte % k` is biased unless k divides 256: for the 62-character alphabet the
  // first eight characters would come up ~1.6 % more often — a quiet shave off
  // the entropy of identifiers whose whole purpose is to be unguessable.
  // Discarding every byte at or above the largest multiple of k removes that
  // bias exactly, and drawing again until `length` characters have been accepted
  // is what turns the output length into a guarantee.  Worst case is the
  // 52-character alphabet (letters, no digits) at 18.75 % rejection, so a second
  // draw is occasionally needed and a third is rare.
  const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
  const bytes = new Uint8Array(length);
  let out = '';
  while (out.length < length) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= ceiling) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}
