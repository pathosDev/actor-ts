/**
 * Parse a HOCON-style size string into bytes.
 *
 *   parseSize("1K")   → 1024          // HOCON: single-letter is binary (IEC)
 *   parseSize("1KB")  → 1000          // decimal (SI)
 *   parseSize("1KiB") → 1024          // binary (IEC)
 *   parseSize(2048)   → 2048          // already a number
 *   parseSize("2048") → 2048          // bare number → bytes
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
 * The postcondition every caller of {@link parseSize} is entitled to — the
 * byte-count twin of `finiteDuration` in `Duration.ts`, and there for the same
 * reason: the guard used to cover only a numeric argument, so a `NaN` or
 * `Infinity` produced by the arithmetic reached a cap comparison intact, where
 * it fails open rather than loudly (#785).
 */
function finiteBytes(bytes: number, input: string | number): number {
  if (!Number.isFinite(bytes)) throw new Error(`Invalid size: ${input}`);
  return bytes;
}

export function parseSize(input: string | number): number {
  if (typeof input === 'number') return finiteBytes(Math.round(input), input);
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Invalid size: empty string');
  // Bare number ⇒ bytes.  Still checked: a literal long enough to overflow a
  // double parses cleanly and comes back `Infinity`.
  if (/^\d+$/.test(trimmed)) return finiteBytes(parseInt(trimmed, 10), input);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
  if (!match) throw new Error(`Invalid size: ${input}`);
  const [, num, unitRaw] = match;
  const unit = unitRaw!.toLowerCase();
  // Positive — "is it declared here" — rather than a list of names to refuse;
  // see the note on the same guard in `Duration.ts`.
  if (!Object.hasOwn(BYTE_UNITS, unit)) {
    throw new Error(`Unknown size unit "${unitRaw}" in ${input}`);
  }
  return finiteBytes(Math.round(parseFloat(num!) * BYTE_UNITS[unit]), input);
}
