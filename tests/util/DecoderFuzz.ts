import fc from 'fast-check';
import { parseHocon } from '../../src/config/HoconParser.js';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from '../../src/serialization/Constants.js';
import { BidirectionalMap } from '../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../src/util/BidirectionalMultiMap.js';

/**
 * Shared vocabulary of the byte-level decoder properties (#1369).
 *
 * Every property in those files makes the same three claims about a decoder
 * fed bytes nobody chose: it **returns or throws its own error** (never a
 * `RangeError`, a `TypeError` or a stack overflow from somewhere inside), it
 * **builds only what it was allowed to build**, and the value it builds is
 * **no larger than the input that paid for it**.  The helpers here state each
 * claim once, so the files differ only in which decoder they hold to it.
 */

/** A decode that finished: the value it returned. */
export type DecodedOutcome = { readonly kind: 'decoded'; readonly value: unknown };
/** A decode that threw: the error, whatever it was. */
export type ThrewOutcome = { readonly kind: 'threw'; readonly error: unknown };
export type DecodeOutcome = DecodedOutcome | ThrewOutcome;

/** Run `decode` and record what happened instead of letting it propagate. */
export function outcomeOf(decode: () => unknown): DecodeOutcome {
  try {
    return { kind: 'decoded', value: decode() };
  } catch (error) {
    return { kind: 'threw', error };
  }
}

/**
 * `null` when the outcome is a value or an error of one of `allowed`; otherwise
 * a description of the foreign error, which is what a failing `expect` prints.
 *
 * A description rather than a boolean because the interesting failure is the
 * one nobody predicted, and `expected false to be true` would hide its name and
 * message — the two things needed to turn it into an example test.
 */
export function foreignError(
  outcome: DecodeOutcome,
  allowed: ReadonlyArray<abstract new (...parameters: never[]) => Error>,
): string | null {
  if (outcome.kind === 'decoded') return null;
  if (allowed.some((type) => outcome.error instanceof type)) return null;
  const error = outcome.error as { constructor?: { name?: string }; message?: unknown } | null;
  return `${error?.constructor?.name ?? typeof error}: ${String(error?.message ?? error)}`;
}

/**
 * The allow-list names under which a decoder may build `value`'s own class, or
 * `[]` when it is plain JSON data that needs none.
 *
 * A `Uint8Array` answers to two names, because both codecs build one under
 * either — a byte string or `__bytes__` is `bytes`, a typed array of kind
 * `Uint8Array` is `typed-array`.  `-0` needs none: `JSON.parse('-0')` already
 * produces it, so neither codec can treat it as a rich type.
 */
function namesFor(value: unknown): readonly JsonTreeTagName[] | 'plain' | 'unknown' {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint'];
  if (typeof value === 'number') return Number.isFinite(value) ? 'plain' : ['number'];
  if (value === null || typeof value !== 'object') return 'plain';
  if (Array.isArray(value)) return 'plain';
  if (value instanceof Date) return ['date'];
  if (value instanceof Uint8Array && value.constructor === Uint8Array) return ['bytes', 'typed-array'];
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return ['typed-array'];
  if (value instanceof BidirectionalMap) return ['bidirectional-map'];
  if (value instanceof BidirectionalMultiMap) return ['bidirectional-multi-map'];
  if (value instanceof Map) return ['map'];
  if (value instanceof Set) return ['set'];
  if (value instanceof RegExp) return ['regexp'];
  if (value instanceof URL) return ['url'];
  if (value instanceof Error) return ['error'];
  return Object.getPrototypeOf(value) === Object.prototype ? 'plain' : 'unknown';
}

/** The values one level inside `value`, in every position a decoder can put one. */
function childrenOf(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value;
  if (value instanceof BidirectionalMap || value instanceof Map) {
    return [...(value as Map<unknown, unknown>).entries()].flat();
  }
  if (value instanceof BidirectionalMultiMap) {
    // Iteration yields one `[left, right]` per pair, repeating a left once per
    // partner — the wire held it once, so it is counted once.
    const pairs = [...value];
    return [...new Set(pairs.map(([left]) => left)), ...pairs.map(([, right]) => right)];
  }
  if (value instanceof Set) return [...value];
  if (value instanceof Error) {
    const out: unknown[] = [];
    if ('cause' in value) out.push(value.cause);
    if (value instanceof AggregateError) out.push(...value.errors);
    return out;
  }
  if (Object.getPrototypeOf(value) === Object.prototype) return Object.values(value);
  return [];
}

/**
 * Every place in `value` holding a class `admitted` does not name — empty when
 * the decoder kept to its allow-list.  `admitted` of `undefined` admits every
 * name, which leaves only the check that no unknown class and no re-parented
 * object (`__proto__` taken as a prototype) came out.
 */
export function unadmittedClassesIn(
  value: unknown,
  admitted: ReadonlySet<JsonTreeTagName> | undefined,
): string[] {
  const out: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    const names = namesFor(next);
    if (names === 'unknown') {
      out.push(`an object of unknown class ${String((next as object).constructor?.name)}`);
      continue;
    }
    if (names !== 'plain' && admitted !== undefined && !names.some((name) => admitted.has(name))) {
      out.push(`${names.join(' or ')} not admitted`);
    }
    pending.push(...childrenOf(next));
  }
  return out;
}

/** Whether any node of `value`, itself included, satisfies `predicate`. */
export function containsNode(value: unknown, predicate: (node: unknown) => boolean): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (predicate(next)) return true;
    pending.push(...childrenOf(next));
  }
  return false;
}

/**
 * Nodes plus string and byte units in `value` — the size of what a decoder
 * built, to set against the size of the input that paid for it.
 *
 * Every decoded node costs at least one input unit and every string or byte
 * payload at least one per unit it holds, so a decoder that builds more than
 * it read is amplifying: allocating on a claim instead of on bytes received.
 * A `RegExp`, a `URL` and a `Date` count as one node however they print —
 * `new RegExp('').source` is `(?:)` and a URL's `href` gains a slash, so their
 * text is the engine's, not the input's.
 */
export function builtSize(value: unknown): number {
  let size = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    size += 1;
    if (typeof next === 'string') size += next.length;
    else if (next instanceof ArrayBuffer) size += next.byteLength;
    else if (ArrayBuffer.isView(next)) size += next.byteLength;
    else if (next instanceof Error) size += next.message.length;
    pending.push(...childrenOf(next));
  }
  return size;
}

/** A random allow-list — `undefined` (every name) about a fifth of the time. */
export function admittedTagsArbitrary(): fc.Arbitrary<readonly JsonTreeTagName[] | undefined> {
  return fc.option(fc.subarray([...JSON_TREE_TAG_NAMES]), { nil: undefined, freq: 4 });
}

/** `bytes` cut into consecutive pieces at the given lengths, the rest in a final piece. */
export function chunksOf(bytes: Uint8Array, lengths: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const length of lengths) {
    if (offset >= bytes.byteLength) break;
    out.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + length)));
    offset += length;
  }
  out.push(bytes.subarray(Math.min(offset, bytes.byteLength)));
  return out;
}

/**
 * A copy of `bytes` with each `[index, byte]` written in (index taken modulo
 * the length) — the "valid frame, k bytes flipped" input, which reaches far
 * deeper into a parser than uniform noise, whose first byte already fails.
 */
export function withBytesReplaced(
  bytes: Uint8Array,
  replacements: ReadonlyArray<readonly [index: number, byte: number]>,
): Uint8Array {
  const out = bytes.slice();
  if (out.byteLength === 0) return out;
  for (const [index, byte] of replacements) out[index % out.byteLength] = byte;
  return out;
}

/** Arbitrary `[index, byte]` replacements for {@link withBytesReplaced}. */
export function byteReplacementsArbitrary(
  maximum = 4,
): fc.Arbitrary<ReadonlyArray<readonly [number, number]>> {
  return fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: maximum });
}

/* ------------------------------ Arbitraries ------------------------------- */

/**
 * A value of every type the two codecs carry, nested a few levels — what an
 * encoder is fed to seed the structure-aware inputs.  Bounded: the bignums stay
 * far inside the 8192-bit cap and the strings short, so a mutated encoding is
 * small enough to truncate at every offset inside one case.
 */
export function richValueArbitrary(): fc.Arbitrary<unknown> {
  const leaf = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.double(),
    fc.integer(),
    fc.maxSafeInteger(),
    fc.string({ maxLength: 12 }),
    fc.constant(undefined),
    fc.date({ noInvalidDate: true }),
    fc.uint8Array({ maxLength: 12 }),
    fc.bigInt({ min: -(2n ** 160n), max: 2n ** 160n }),
    fc.float64Array({ maxLength: 3 }),
    fc.int16Array({ maxLength: 3 }),
    fc.constantFrom<unknown>(
      /a+(b|c)*$/gi,
      new URL('https://example.com/a?b=c'),
      new TypeError('t'),
      new Error('outer', { cause: new RangeError('inner') }),
      new BidirectionalMap<unknown, unknown>([['a', 1], [2, 'b']]),
      new BidirectionalMultiMap<unknown, unknown>([['a', 1], ['a', 2]]),
    ),
  );
  return fc.letrec<{ value: unknown }>((tie) => ({
    value: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.array(tie('value'), { maxLength: 4 }),
      fc.dictionary(fc.string({ maxLength: 6 }), tie('value'), { maxKeys: 4 }),
      fc.array(tie('value'), { maxLength: 3 }).map((members) => new Set(members)),
      fc.array(fc.tuple(tie('value'), tie('value')), { maxLength: 3 }).map((entries) => new Map(entries)),
    ),
  })).value;
}

/** Every JSON-tree tag key, the framing escape among them. */
const JSON_TREE_KEYS = [
  '__date__', '__bytes__', '__map__', '__set__', '__bidirectionalmap__', '__bidirectionalmultimap__',
  '__bigint__', '__number__', '__undefined__', '__regexp__', '__url__', '__error__', '__typedarray__',
  '__literal__', '__serialized__',
] as const;

/**
 * JSON documents dense in tag keys and in the shapes their bodies take —
 * entry pairs, `{ source, flags }`, `{ name, message, cause }`, `{ kind, data }`
 * — with the strings those bodies parse (base64, ISO dates, digit runs, binary
 * kind names, URL-ish text).  Uniform `fc.jsonValue()` almost never produces a
 * single-key object whose key is a tag, so it would exercise none of the tag
 * branches at all.
 */
export function jsonTreeDocumentArbitrary(): fc.Arbitrary<unknown> {
  const text = fc.oneof(
    fc.string({ maxLength: 8 }),
    fc.constantFrom(
      '', 'AAAA', 'AA==', '!!', 'nan', 'infinity', '-infinity', '-0', '0', '-', '12345678901234567890',
      '2020-01-01T00:00:00Z', 'whenever', 'Float64Array', 'Uint8Array', 'DataView', 'ArrayBuffer', 'Error',
      'AggregateError', 'TypeError', 'toString', 'constructor', '__proto__', 'g', 'gg', '(', 'a+', 'https://x',
      'not a url', 'file:///etc/passwd',
    ),
  );
  const key = fc.oneof(
    fc.constantFrom(...JSON_TREE_KEYS),
    fc.constantFrom('source', 'flags', 'name', 'message', 'cause', 'errors', 'kind', 'data', '__proto__', 'x'),
    fc.string({ maxLength: 4 }),
  );
  const scalar = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer(),
    text,
  );
  return fc.letrec<{ value: unknown }>((tie) => ({
    value: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      scalar,
      fc.array(tie('value'), { maxLength: 4 }),
      fc.dictionary(key, tie('value'), { maxKeys: 3 }),
      fc.tuple(fc.constantFrom(...JSON_TREE_KEYS), tie('value')).map(([tag, body]) => ({ [tag]: body })),
    ),
  })).value;
}

/* --------------------------------- HOCON ---------------------------------- */

/**
 * Everything wrong with parsing `text`, or `[]`.  The parser has no error class
 * of its own: its contract is a plain `Error` whose message begins
 * `HOCON parse error at line`, which names the line and column to an operator.
 * A `RangeError`, a `TypeError`, or an `Error` without that prefix is foreign.
 */
export function hoconViolations(text: string): string[] {
  const outcome = outcomeOf(() => parseHocon(text));
  if (outcome.kind === 'decoded') return [];
  const error = outcome.error;
  if (error instanceof Error && error.constructor === Error && error.message.startsWith('HOCON parse error at line ')) {
    return [];
  }
  return [foreignError(outcome, []) ?? 'unreachable'];
}

/**
 * A valid HOCON document, rendered from a random model in a random style —
 * `=` or `:`, commas or newlines, comments, quoted or bare keys, path
 * expressions, the `key { … }` shorthand, substitutions — so a mutation of it
 * lands inside every construct the parser knows.  Validity is the point: the
 * properties edit or cut it afterwards, and the closer the start is to valid
 * the deeper an edit reaches.
 */
export function hoconDocumentArbitrary(): fc.Arbitrary<string> {
  const bareKey = fc.stringMatching(/^[a-z][a-z0-9_-]{0,5}$/);
  const scalar = fc.oneof(
    fc.integer().map(String),
    fc.double({ noNaN: true, noDefaultInfinity: true }).map(String),
    fc.constantFrom('true', 'false', 'null', 'localhost:2552', '30s', 'two words'),
    fc.string({ maxLength: 8 }).map((text) => JSON.stringify(text)),
    fc.constantFrom('${?a}', '${?a.b}', '"x"${?y}"z"'),
  );
  const separator = fc.constantFrom(' = ', ': ', '=', ' : ');
  const lineEnd = fc.constantFrom('\n', ', ', ',\n', ' # note\n', ' // note\n');
  const key = fc.oneof(
    bareKey,
    fc.array(bareKey, { minLength: 2, maxLength: 3 }).map((segments) => segments.join('.')),
    bareKey.map((segment) => JSON.stringify(segment)),
  );
  return fc.letrec<{ value: string; object: string }>((tie) => ({
    value: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      scalar,
      fc.array(tie('value'), { maxLength: 3 }).map((items) => `[${items.join(', ')}]`),
      tie('object').map((body) => `{\n${body}}`),
    ),
    object: fc.array(fc.tuple(key, separator, tie('value'), lineEnd), { maxLength: 4 }).map((fields) =>
      fields.map(([name, assign, value, end]) => `${name}${assign}${value}${end}`).join('')),
  })).object.chain((body) => fc.constantFrom(body, `{\n${body}}`));
}
