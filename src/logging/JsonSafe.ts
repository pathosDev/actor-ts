/**
 * The two JSON-safety primitives every structured sink needs, factored out
 * of `JsonLogger` so the NDJSON formatter, the OTLP attribute mapper and the
 * GELF payload builder all serialise a hostile value the same way.
 *
 * Nothing here imports anything: a log call must never fail because of what
 * it was handed, so these stay dependency-free and total.
 */

/**
 * What a log record shows in place of a value that cannot be read at all —
 * an error whose `message` getter throws, a revoked proxy, an object whose
 * custom inspect throws.  Format vocabulary of the normalisation below, so it
 * lives beside it.
 */
export const UNRENDERABLE_VALUE = '[unrenderable value]';

/**
 * Turn an `Error` into a plain object so `JSON.stringify` doesn't
 * collapse it to `"{}"` (Error's enumerable surface is empty).
 * Other values pass through unchanged — the replacer handles
 * remaining quirks (BigInt, circular).
 *
 * **Total**, because it runs outside every logger's own `try` and a log call
 * must never throw (#1749).  Each field is read under its own guard, so an
 * error whose `message` getter throws still shows its name and stack, with
 * {@link UNRENDERABLE_VALUE} where the message would be.  A value that cannot
 * even be asked `instanceof` — a revoked proxy throws from its prototype
 * lookup — becomes the placeholder outright.  This used to throw from inside
 * the framework's own report of a lifecycle failure, which then skipped the
 * supervision step that report was for.
 */
export function normaliseArg(v: unknown): unknown {
  let isError: boolean;
  try {
    isError = v instanceof Error;
  } catch {
    return UNRENDERABLE_VALUE;
  }
  if (!isError) return v;
  const error = v as Error;
  const stack = readField(() => error.stack);
  return {
    name: readField(() => error.name),
    message: readField(() => error.message),
    ...(stack ? { stack } : {}),
  };
}

/** One field of a hostile value, or the placeholder if reading it throws. */
function readField(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNRENDERABLE_VALUE;
  }
}

/**
 * JSON.stringify replacer:
 *  - BigInt → string (BigInt can't be JSON-serialised natively)
 *  - circular → `'[Circular]'`
 *  - function → undefined (drop)
 */
export function jsonSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (_key, value) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return undefined;
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}
