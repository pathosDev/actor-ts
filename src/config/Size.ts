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
const BYTE_UNITS: Record<string, number> = {
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
};

export function parseSize(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Invalid size: ${input}`);
    return Math.round(input);
  }
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Invalid size: empty string');
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
  if (!match) throw new Error(`Invalid size: ${input}`);
  const [, num, unitRaw] = match;
  const factor = BYTE_UNITS[unitRaw!.toLowerCase()];
  if (factor === undefined) throw new Error(`Unknown size unit "${unitRaw}" in ${input}`);
  return Math.round(parseFloat(num!) * factor);
}
