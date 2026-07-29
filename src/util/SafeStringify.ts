/**
 * A `JSON.stringify` that cannot throw.
 *
 * Intended for **error and log paths**, where the whole point is to describe a
 * value that has already gone wrong.  `JSON.stringify` throws on a circular
 * structure and on `BigInt`, so using it to build an error message can replace
 * the error being reported with a different one — thrown from inside the
 * reporting code, where a caller is least likely to be handling it.
 *
 * Deliberately *not* a serializer.  The output is for humans reading a message,
 * so it is lossy on purpose: cycles collapse to a marker, `BigInt` renders with
 * an `n` suffix, and the result is length-capped rather than allowed to grow
 * into a multi-megabyte string that blocks the event loop while being built.
 * Nothing here should be parsed back.
 */

/** Longest string produced.  Past this the output is truncated with a suffix. */
const DEFAULT_MAX_LENGTH = 8 * 1024;

/**
 * Render `value` as a string, never throwing.
 *
 * @param maxLength Cap on the returned string; the tail is replaced with a
 *   truncation marker.  A large body is a latency problem rather than a
 *   correctness one, but an error message has no use for the rest of it.
 */
export function safeStringify(value: unknown, maxLength: number = DEFAULT_MAX_LENGTH): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, replacer()) ?? String(value);
  } catch (e) {
    // A getter that throws, a Proxy that refuses, a toJSON that blows up —
    // anything the replacer cannot anticipate.  Fall back to a description
    // rather than propagating: this function exists so the caller does not
    // have to care.
    //
    // The fallback itself must not touch the value in any way that can trap.
    // An earlier version read `value.constructor?.name` here and so threw from
    // inside this very catch block when handed a Proxy whose `get` throws.
    rendered = `[unserializable ${describe(value)}: ${describeError(e)}]`;
  }
  return rendered.length > maxLength
    ? `${rendered.slice(0, maxLength)}… [truncated, ${rendered.length} chars total]`
    : rendered;
}

/**
 * Per-call replacer, because the `seen` set must not be shared between calls.
 * Uses a `Set` rather than a `WeakSet` since it is discarded immediately and
 * needs to hold the ancestor chain only.
 */
function replacer(): (key: string, value: unknown) => unknown {
  const seen = new Set<unknown>();
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * Name the *kind* of thing `value` is, using only operations that cannot run
 * user code.  `typeof` and a `null` comparison are trap-free; reading a
 * property is not, which matters because this only ever runs on a value that
 * has already proven hostile.
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Same rule for the thrown thing: a hostile object could throw from `String`. */
function describeError(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return 'unprintable error';
  }
}
