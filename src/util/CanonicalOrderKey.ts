/**
 * A string key whose ordinary `<` / `>` comparison ranks any two values in a
 * total order that every replica computes alike — the last key of a
 * last-writer-wins tie-break (#950, #1841).
 *
 * **Injective by construction.**  The key is a typed, self-delimiting
 * encoding: every value starts with a one-letter type tag, every string-like
 * part (a string, an object key, a symbol's description, a class or function
 * text) is JSON-quoted, and containers are bracketed.  So two values share a
 * key only when they have the same type and the same canonical content.  The
 * JSON rendering the tie-break used before was not injective, and a tie
 * between two values sharing a key went to whichever register was `this`:
 * `1n` and the string `"1n"` rendered alike, as did `undefined` and a
 * function (both to the empty key), and `a.merge(b)` and `b.merge(a)` kept
 * different values.
 *
 * **Genuinely equal values still tie, and that is fine.**  Two structurally
 * equal values are interchangeable, so it does not matter which one a merge
 * keeps.  An object's own keys are sorted, so `{ a, b }` and `{ b, a }` tie
 * rather than rank by insertion order — the order a decoder happens to
 * rebuild them in is not part of the value.  `-0` is told apart from `0`
 * because `Object.is` tells them apart.
 *
 * **Total.**  It never throws, so a merge or a fold that calls it cannot fail:
 * a cycle encodes as a back-reference to the ancestor it closes on, a
 * `bigint` as its digits, and values that have no wire form at all (a
 * function, a symbol) by their source text or description — deterministic
 * across replicas running the same code, which is the only place such a
 * value could come from.  Two closures with the same source text, or two
 * symbols with the same description, are the one residual tie: neither has
 * a content that could rank them identically on two machines.
 */
export function canonicalOrderKey(value: unknown): string {
  return encode(value, []);
}

function encode(value: unknown, ancestors: object[]): string {
  switch (typeof value) {
    case 'undefined': return 'u';
    case 'boolean': return value ? 'b1' : 'b0';
    case 'number': return `n${Object.is(value, -0) ? '-0' : String(value)}`;
    case 'bigint': return `i${value.toString()}`;
    case 'string': return `s${JSON.stringify(value)}`;
    case 'symbol': return `y${JSON.stringify(value.description ?? '')}`;
    case 'function': return `f${JSON.stringify(functionText(value as (...parameters: unknown[]) => unknown))}`;
    default: return value === null ? 'z' : encodeObject(value as object, ancestors);
  }
}

function encodeObject(value: object, ancestors: object[]): string {
  const depth = ancestors.indexOf(value);
  // A back-reference by distance to the ancestor the cycle closes on: the same
  // shape of cycle encodes alike on every replica, and the walk terminates.
  if (depth !== -1) return `c${ancestors.length - depth}`;
  ancestors.push(value);
  try {
    if (Array.isArray(value)) return `a[${value.map((element) => encode(element, ancestors)).join(',')}]`;
    if (value instanceof Date) return `d${String(value.getTime())}`;
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `v${JSON.stringify(className(value))}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    if (value instanceof Map) {
      const entries = Array.from(value, ([key, inner]) => `${encode(key, ancestors)}:${encode(inner, ancestors)}`).sort();
      return `m{${entries.join(',')}}`;
    }
    if (value instanceof Set) {
      const members = Array.from(value, (member) => encode(member, ancestors)).sort();
      return `t{${members.join(',')}}`;
    }
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], ancestors)}`);
    return `o${JSON.stringify(className(value))}{${fields.join(',')}}`;
  } catch {
    // A getter that throws or a Proxy that refuses: still a key, never a throw
    // out of a merge.  Ranks by class alone.
    return `x${JSON.stringify(className(value))}`;
  } finally {
    ancestors.pop();
  }
}

/** The constructor's name, `''` for a plain or prototype-less object. */
function className(value: object): string {
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === null || prototype === Object.prototype) return '';
    const constructor: unknown = (prototype as { constructor?: unknown }).constructor;
    return typeof constructor === 'function' ? constructor.name : '';
  } catch {
    return '';
  }
}

function functionText(value: (...parameters: unknown[]) => unknown): string {
  try {
    return Function.prototype.toString.call(value);
  } catch {
    return value.name;
  }
}
