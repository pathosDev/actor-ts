/**
 * The two JSON-safety primitives every structured sink needs, factored out
 * of `JsonLogger` so the NDJSON formatter, the OTLP attribute mapper and the
 * GELF payload builder all serialise a hostile value the same way.
 *
 * Nothing here imports anything: a log call must never fail because of what
 * it was handed, so these stay dependency-free and total.
 */

/**
 * Turn an `Error` into a plain object so `JSON.stringify` doesn't
 * collapse it to `"{}"` (Error's enumerable surface is empty).
 * Other values pass through unchanged — the replacer handles
 * remaining quirks (BigInt, circular).
 */
export function normaliseArg(v: unknown): unknown {
  if (v instanceof Error) {
    return {
      name: v.name,
      message: v.message,
      ...(v.stack ? { stack: v.stack } : {}),
    };
  }
  return v;
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
