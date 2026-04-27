/**
 * Parse a HOCON-style duration string into milliseconds.
 *
 *   parseDuration("500ms")       → 500
 *   parseDuration("2 seconds")   → 2000
 *   parseDuration("1 h")         → 3_600_000
 *   parseDuration(42)            → 42          (already a number)
 *   parseDuration("42")          → 42          (bare number → ms)
 *
 * Accepts short and long unit names, case-insensitive, with or without
 * whitespace between the number and the unit.  Negative and fractional
 * values are allowed (e.g. "1.5s" → 1500).
 */
const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  nano: 1e-6,
  nanos: 1e-6,
  nanosecond: 1e-6,
  nanoseconds: 1e-6,
  us: 1e-3,
  'μs': 1e-3,
  micro: 1e-3,
  micros: 1e-3,
  microsecond: 1e-3,
  microseconds: 1e-3,
  ms: 1,
  milli: 1,
  millis: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Invalid duration: ${input}`);
    return input;
  }
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Invalid duration: empty string');
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return parseFloat(trimmed); // bare number ⇒ ms

  const match = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*([A-Za-zμ]+)$/);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const [, num, unitRaw] = match;
  const factor = UNIT_MS[unitRaw!.toLowerCase()];
  if (factor === undefined) throw new Error(`Unknown duration unit "${unitRaw}" in ${input}`);
  return parseFloat(num!) * factor;
}
