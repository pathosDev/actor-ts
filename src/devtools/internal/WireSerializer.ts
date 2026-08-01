/**
 * Make arbitrary user data safe to put on the wire.
 *
 * Journal events and reconstructed state are whatever the application
 * decided they are: cyclic, enormous, full of `Map`s, `Error`s and
 * functions.  `JSON.stringify` throws on the first cycle and happily
 * serialises a hundred megabytes otherwise — neither is acceptable for
 * a debugger that must not become the reason a system falls over.
 *
 * Truncation is **visible**: anything trimmed is replaced by a marker
 * string, and the caller learns whether it happened, so the panel can
 * say "this is not the whole value" rather than silently lying.
 */

/** Limits applied while sanitising. */
export type WireLimits = {
  /** Nesting beyond this is replaced by a marker. */
  readonly maxDepth: number;
  /** Array entries / object keys beyond this are dropped. */
  readonly maxEntries: number;
  /** Strings longer than this are cut. */
  readonly maxStringLength: number;
};

export const DEFAULT_WIRE_LIMITS: WireLimits = {
  maxDepth: 12,
  maxEntries: 200,
  maxStringLength: 8_192,
};

/** A sanitised value plus whether anything was left out. */
export type WireValue = {
  readonly value: unknown;
  readonly truncated: boolean;
};

/**
 * Convert `input` into something `JSON.stringify` can handle.
 *
 * Cycles become `'[circular]'` rather than an exception: a debugger
 * showing most of a cyclic object beats one that shows nothing.
 */
export function toWireValue(input: unknown, limits: WireLimits = DEFAULT_WIRE_LIMITS): WireValue {
  let truncated = false;
  const seen = new Set<object>();

  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value ?? null;

    switch (typeof value) {
      case 'string':
        if (value.length <= limits.maxStringLength) return value;
        truncated = true;
        return `${value.slice(0, limits.maxStringLength)}… [+${value.length - limits.maxStringLength} chars]`;
      case 'number':
        // NaN and ±Infinity are not JSON; keep them readable instead of
        // letting them silently become null.
        return Number.isFinite(value) ? value : String(value);
      case 'boolean':
        return value;
      case 'bigint':
        return `${value.toString()}n`;
      case 'function':
        return `[function ${(value as { name?: string }).name || 'anonymous'}]`;
      case 'symbol':
        return String(value);
      default:
        break;
    }

    if (depth >= limits.maxDepth) {
      truncated = true;
      return '[depth limit]';
    }
    const object = value as object;
    if (seen.has(object)) return '[circular]';
    seen.add(object);
    try {
      return walkObject(object, depth);
    } finally {
      // Leave the set on the way out so a value referenced twice in
      // SIBLING positions is rendered twice, not called circular.
      seen.delete(object);
    }
  };

  const walkObject = (value: object, depth: number): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value instanceof Map) return walk(Object.fromEntries(cap(value.entries())), depth + 1);
    if (value instanceof Set) return walk([...cap(value.values())], depth + 1);
    if (ArrayBuffer.isView(value)) {
      truncated = true;
      return `[binary ${(value as ArrayBufferView).byteLength} bytes]`;
    }
    if (Array.isArray(value)) {
      const kept = value.slice(0, limits.maxEntries).map((entry) => walk(entry, depth + 1));
      if (value.length > limits.maxEntries) {
        truncated = true;
        kept.push(`… [+${value.length - limits.maxEntries} more]`);
      }
      return kept;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, nested] of Object.entries(value)) {
      if (count++ >= limits.maxEntries) {
        truncated = true;
        out['…'] = `[+${Object.keys(value).length - limits.maxEntries} more keys]`;
        break;
      }
      out[key] = walk(nested, depth + 1);
    }
    return out;
  };

  const cap = <T>(iterable: Iterable<T>): T[] => {
    const out: T[] = [];
    for (const entry of iterable) {
      if (out.length >= limits.maxEntries) {
        truncated = true;
        break;
      }
      out.push(entry);
    }
    return out;
  };

  return { value: walk(input, 0), truncated };
}
