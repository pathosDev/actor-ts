/**
 * Parse a HOCON-style size string into bytes.
 *
 *   parseSize("1K")   → 1024          // HOCON: single-letter is binary (IEC)
 *   parseSize("1KB")  → 1000          // decimal (SI)
 *   parseSize("1KiB") → 1024          // binary (IEC)
 *   parseSize(2048)   → 2048          // already a number
 *   parseSize("2048") → 2048          // bare number → bytes
 *   parseSize("1.5K") → 1536          // a fraction that comes to whole bytes
 *   parseSize("1.1K") → throws        // 1126.4 bytes: a size is whole bytes
 *
 * Recognised units:
 *   B / byte / bytes
 *   K, KB, KiB, kilobyte, kibibyte, ...
 *   M, MB, MiB, megabyte, mebibyte, ...
 *   G, GB, GiB, gigabyte, gibibyte, ...
 *   T, TB, TiB, terabyte, tebibyte, ...
 *   P, PB, PiB, petabyte, pebibyte, ...
 */

/**
 * Unit name (lowercase) → bytes.
 *
 * Null-prototyped for the reason spelled out beside `UNIT_MS` in
 * `Duration.ts`: the index comes from an operator-authored config string, and
 * `BYTE_UNITS['constructor']` used to resolve through `Object.prototype` to the
 * `Object` function, defeating the unknown-unit error and returning a silent
 * `NaN` — which then disables a `>` cap, since every comparison against `NaN`
 * is false (#785).
 *
 * `Object.freeze` is the third piece, for the reason given beside `UNIT_MS`:
 * it is the one of the three no behavioural test can reach, because the table
 * is module-private and no export hands it out, so it is asserted at source
 * level by `tests/unit/config/UnitTableHardening.test.ts` instead.
 *
 * `satisfies` is load-bearing: `Object.setPrototypeOf` is typed to return
 * `any`, so without it the entries below would go unchecked.
 */
const BYTE_UNITS: Readonly<Record<string, number>> = Object.freeze(
  Object.setPrototypeOf(
    {
      b: 1,
      byte: 1,
      bytes: 1,

      k: 1024, kib: 1024, kibibyte: 1024, kibibytes: 1024,
      kb: 1000, kilobyte: 1000, kilobytes: 1000,

      m: 1024 ** 2, mib: 1024 ** 2, mebibyte: 1024 ** 2, mebibytes: 1024 ** 2,
      mb: 1e6, megabyte: 1e6, megabytes: 1e6,

      g: 1024 ** 3, gib: 1024 ** 3, gibibyte: 1024 ** 3, gibibytes: 1024 ** 3,
      gb: 1e9, gigabyte: 1e9, gigabytes: 1e9,

      t: 1024 ** 4, tib: 1024 ** 4, tebibyte: 1024 ** 4, tebibytes: 1024 ** 4,
      tb: 1e12, terabyte: 1e12, terabytes: 1e12,

      p: 1024 ** 5, pib: 1024 ** 5, pebibyte: 1024 ** 5, pebibytes: 1024 ** 5,
      pb: 1e15, petabyte: 1e15, petabytes: 1e15,
    } satisfies Record<string, number>,
    null,
  ) as Record<string, number>,
);

/**
 * The longest fraction any unit can still make a whole number of bytes: 2^-50
 * of a pebibyte is one byte, and written out it has fifty decimals.
 *
 * A fraction of `f` decimals, the last of them not 0, is `F / 10^f` with `F`
 * not divisible by both 2 and 5.  Times a unit `2^a · 5^b` that is whole only
 * when `f <= a` or `f <= b`, and the deepest power of either in
 * {@link BYTE_UNITS} is the 2^50 of `PiB`.  Beyond this length the answer is
 * known without the exact arithmetic, whose cost would otherwise grow with a
 * config value of any length.
 */
const MAX_WHOLE_FRACTION_DIGITS = 50;

/**
 * The postcondition every caller of {@link parseSize} is entitled to: a finite,
 * whole number of bytes.
 *
 * Finite is the byte-count twin of `finiteDuration` in `Duration.ts`, there for
 * the same reason: the guard used to cover only a numeric argument, so a `NaN`
 * or `Infinity` produced by the arithmetic reached a cap comparison intact,
 * where it fails open rather than loudly (#785).  Whole because a size used to
 * be rounded to the nearest byte, so a slip quietly became another size —
 * `1420.5B` was 1421, and `0.4B` was 0, which several caps read as "no cap"
 * (#1728).
 */
function wholeBytes(bytes: number, input: string | number): number {
  if (!Number.isFinite(bytes)) throw new Error(`Invalid size: ${input}`);
  if (!Number.isInteger(bytes)) throw notWhole(input);
  return bytes;
}

function notWhole(input: string | number): Error {
  return new Error(`Invalid size: ${input} is not a whole number of bytes`);
}

/**
 * The bytes `whole.fraction` of `unit` comes to, refused when that is not a
 * whole number.
 *
 * Decided on the decimal as written, not on the double it parses to, since the
 * double misses both ways: `1.001KB` multiplies out to 1000.9999999999999
 * though it is 1001 bytes, and `1.0000000000000001K` to exactly 1024 though it
 * is not whole.  Only the fraction needs exact arithmetic — the whole part
 * times the unit is whole already — and {@link MAX_WHOLE_FRACTION_DIGITS}
 * bounds it.  Trailing zeros are dropped by hand: `/0+$/` backtracks over every
 * run of zeros that does not end the string.
 */
function bytesOf(whole: string, fraction: string, unit: number, input: string): number {
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === 0x30) end--;
  if (end === 0) return wholeBytes(Number(whole) * unit, input);
  if (end > MAX_WHOLE_FRACTION_DIGITS) throw notWhole(input);
  const scaled = BigInt(fraction.slice(0, end)) * BigInt(unit);
  const scale = 10n ** BigInt(end);
  if (scaled % scale !== 0n) throw notWhole(input);
  return wholeBytes(Number(whole) * unit + Number(scaled / scale), input);
}

export function parseSize(input: string | number): number {
  if (typeof input === 'number') return wholeBytes(input, input);
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Invalid size: empty string');
  // Bare number ⇒ bytes.  Still checked: a literal long enough to overflow a
  // double parses cleanly and comes back `Infinity`.
  if (/^\d+$/.test(trimmed)) return wholeBytes(parseInt(trimmed, 10), input);
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?\s*([A-Za-z]+)$/);
  if (!match) throw new Error(`Invalid size: ${input}`);
  const [, whole, fraction = '', unitRaw] = match;
  const unit = unitRaw!.toLowerCase();
  // Positive — "is it declared here" — rather than a list of names to refuse;
  // see the note on the same guard in `Duration.ts`.
  if (!Object.hasOwn(BYTE_UNITS, unit)) {
    throw new Error(`Unknown size unit "${unitRaw}" in ${input}`);
  }
  return bytesOf(whole!, fraction, BYTE_UNITS[unit], input);
}
