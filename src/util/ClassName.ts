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
 *
 * **The class is read off the prototype, never off the value** (#1442).
 * `value.constructor` finds an *own* `constructor` property first, and a
 * decoded peer body may carry one: `JsonSerializer` keeps every key of the
 * frame as data, so the "class name" of `{"constructor": {"name": …}}` was
 * whatever the peer wrote — a CR/LF that forged a second record in
 * `DeadLetterRef`'s default-on log, or an object whose interpolation threw out
 * of `deadLetters.tell` and restarted the actor that declined it through
 * `Actor.unhandled` (the receptionist lost its registrations that way, the
 * outcome #713 had closed).  The prototype of a decoded body is
 * `Object.prototype` — both decoders keep a `__proto__` key as data instead of
 * re-parenting the object (#581) — so the peer has no channel left into the
 * answer, and there is nothing to escape or clip.
 *
 * The two guards are for what a prototype can still do: a `name` that is not
 * a string is refused rather than handed to a template that would throw on
 * it, and a getter or a Proxy trap that throws lands on the floor rather than
 * on the caller's stack — every caller of this is a sink that must not fail
 * because of the message it is describing.
 */
export function classNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  try {
    const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
    return typeof name === 'string' ? name : 'Object';
  } catch {
    return 'Object';
  }
}
