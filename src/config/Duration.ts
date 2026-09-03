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

/**
 * Unit name (lowercase) → milliseconds.
 *
 * The table has a **null prototype**.  It is indexed by a unit name lifted
 * verbatim out of an operator-authored config string, and with
 * `Object.prototype` still in the chain `UNIT_MS['constructor']` answered with
 * the `Object` function instead of `undefined`.  `constructor` is the whole
 * exposure — every other inherited member is mixed-case and cannot survive the
 * `.toLowerCase()` in {@link parseDuration}.  The old `factor === undefined`
 * guard therefore waved it through, and `parseFloat(num) * Object` yielded a
 * silent `NaN` where every other unrecognised unit throws (#785).
 *
 * The same treatment `DEFAULT_MIME_TYPES` got in #608, and the value-side
 * counterpart of #589 / #406, which hardened the config *key* path while
 * leaving this one open.
 *
 * `satisfies` is load-bearing: `Object.setPrototypeOf` is typed to return
 * `any`, so without it the entries below would go unchecked and the outer
 * annotation would be the only surviving type.
 */
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.setPrototypeOf(
    {
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
    } satisfies Record<string, number>,
    null,
  ) as Record<string, number>,
);

/**
 * The postcondition every caller of {@link parseDuration} is entitled to: the
 * answer is a real number of milliseconds, or nothing came back at all.
 *
 * It runs on the **returned** value rather than only on a numeric argument,
 * which is where the guard used to sit.  A `NaN` or an `Infinity` produced by
 * the arithmetic below is indistinguishable from a valid duration to every
 * consumer, and two documented keys reach a runtime effect with no options
 * validator between them and the timer — `actor-ts.system.shutdown-drain-timeout`
 * (a `NaN` makes `deadline = Date.now() + NaN`, so the drain budget is silently
 * zero and the `<= 0` opt-out never fires either) and
 * `actor-ts.coordinated-shutdown.default-phase-timeout` (copied into all twelve
 * canonical phases and handed to `setTimeout`, which coerces `NaN` to 0, so
 * every shutdown task times out at once).  Failing loudly here is the only
 * place that covers both (#785).
 */
function finiteDuration(milliseconds: number, input: string | number): number {
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid duration: ${input}`);
  return milliseconds;
}

export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return finiteDuration(input, input);
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Invalid duration: empty string');
  // Bare number ⇒ ms.  Still checked: a literal long enough to overflow a
  // double parses cleanly and comes back `Infinity`.
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return finiteDuration(parseFloat(trimmed), input);

  const match = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*([A-Za-zμ]+)$/);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const [, num, unitRaw] = match;
  const unit = unitRaw!.toLowerCase();
  // Positive — "is it declared here" — rather than a list of names to refuse,
  // for the reason #589 settled: a blocklist cannot enumerate a prototype
  // chain that engine and host additions keep extending.  Redundant with the
  // null prototype above by construction, and kept anyway: it is the half that
  // survives someone reshaping the table.
  if (!Object.hasOwn(UNIT_MS, unit)) {
    throw new Error(`Unknown duration unit "${unitRaw}" in ${input}`);
  }
  return finiteDuration(parseFloat(num!) * UNIT_MS[unit], input);
}
