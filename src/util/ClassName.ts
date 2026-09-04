/**
 * Best available name for a value's runtime class — what a diagnostic may say
 * *about* a payload without saying anything *from* it.
 *
 * That distinction is the whole reason this exists.  A dead letter's message
 * and a payload a codec refused are both untrusted application data, and a log
 * line, a metric label or a queue entry must not carry it: the class name is
 * enough to find the sender and identify the shape, and holds none of the
 * values.  Two subsystems needed the same four lines for that reason
 * (`DeadLetterQueue`'s degraded entries, `DeadLetterRef`'s log record), which
 * is why it lives here rather than in whichever of them wrote it first.
 *
 * `null` and the primitives answer with what they are: `null.constructor`
 * throws, and `(5).constructor.name` is `'Number'`, which would read in a log
 * as a boxed object that was never there.  A prototype-less object —
 * `Object.create(null)`, and every JSON-shaped value a wire decoder builds
 * that way — has no `constructor` at all, so `'Object'` is the honest floor
 * rather than a crash.
 */
export function classNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return (value as object).constructor?.name ?? 'Object';
}
