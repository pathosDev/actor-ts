import { SerializationError } from './Serializer.js';

/**
 * The tagged JSON tree format — one walker, two consumers: `JsonSerializer`
 * (HTTP marshalling) and the persistence `PayloadCodec` (every journal /
 * snapshot store / durable-state store).  Values that plain JSON silently
 * corrupts (`Set`/`Map` → `{}`, `Date` → string, `bigint` → throw,
 * `Uint8Array` → index-keyed object) are wrapped in single-key tag objects
 * so they survive the round-trip.
 *
 * The format is append-only stable: rows written with these tags must stay
 * readable by every future version.  Plain JSON written before the tags
 * existed decodes unchanged, because a tag is only interpreted when it is
 * an object's SOLE own enumerable key — and the encoder escapes user data
 * that happens to look like a tag (see `LITERAL_TAG`), so nothing written
 * from now on can be misread either.
 */

const DATE_TAG = '__date__';
const BYTES_TAG = '__bytes__';
const MAP_TAG = '__map__';
const SET_TAG = '__set__';
const BIGINT_TAG = '__bigint__';
/**
 * Escape wrapper: a plain user object whose encoded form would consist of
 * exactly one reserved tag key is wrapped as `{ __literal__: … }` so decode
 * reconstructs it as plain data instead of a `Set`/`Date`/….  Long-lived
 * stored rows make this essential — without it, user data shaped like a tag
 * would silently change type on recovery.
 */
const LITERAL_TAG = '__literal__';
/**
 * Reserved for the persistence `PayloadCodec` framing of custom-serializer
 * payloads.  Never produced or interpreted by this walker — it is in the
 * reserved set only so user data cannot forge the wrapper.
 */
export const SERIALIZED_TAG = '__serialized__';

const RESERVED_TAGS: ReadonlySet<string> = new Set([
  DATE_TAG, BYTES_TAG, MAP_TAG, SET_TAG, BIGINT_TAG, LITERAL_TAG, SERIALIZED_TAG,
]);

/**
 * How `undefined` is handled during encode.  `'reject'` throws (the HTTP
 * marshalling contract — a lossy payload is a bug there); `'omit'` matches
 * `JSON.stringify`: object properties with `undefined` values are dropped
 * and `undefined` in value positions (array slots, `Set` members, `Map`
 * keys/values) becomes `null`.  Persistence uses `'omit'` so existing
 * `persist({ optionalField: undefined })` callers keep working byte-for-byte.
 */
export type UndefinedValueHandling = 'reject' | 'omit';

export type JsonTreeEncodeOptions = {
  readonly undefinedValues?: UndefinedValueHandling;
};

/**
 * Internal sentinel: "this node vanishes" — an `undefined` under `'omit'`.
 * Object properties drop it, value positions turn it into `null`, and the
 * root converts it into an error; it never leaks out of the walker.
 */
const OMITTED = Symbol('omitted');

/** Decode sentinel: "the sole key was not a known tag — plain data". */
const NOT_TAGGED = Symbol('not-tagged');

type EncodeContext = {
  readonly undefinedValues: UndefinedValueHandling;
  /**
   * Objects on the path from the root to the current node.  Revisiting one
   * is a cycle — reported as a `SerializationError` with the key path
   * instead of overflowing the stack.  Siblings sharing a reference (a DAG)
   * are fine and get duplicated, same as `JSON.stringify`.
   */
  readonly ancestors: Set<object>;
  /** Key path to the current node, for error messages only. */
  readonly path: Array<string | number>;
};

export function encodeJsonTree(value: unknown, options?: JsonTreeEncodeOptions): unknown {
  const context: EncodeContext = {
    undefinedValues: options?.undefinedValues ?? 'reject',
    ancestors: new Set(),
    path: [],
  };
  const encoded = encodeNode(value, context, true);
  if (encoded === OMITTED) {
    throw new SerializationError('undefined is not JSON-serialisable');
  }
  return encoded;
}

export function decodeJsonTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => decodeJsonTree(entry));
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const tagged = decodeTagged(keys[0]!, obj);
    if (tagged !== NOT_TAGGED) return tagged;
  }
  return decodePlainObject(obj);
}

/* -------------------------------- Encode --------------------------------- */

function encodeNode(value: unknown, context: EncodeContext, allowToJson: boolean): unknown {
  if (value === undefined) {
    if (context.undefinedValues === 'reject') {
      throw new SerializationError(`undefined is not JSON-serialisable at ${formatPath(context.path)}`);
    }
    return OMITTED;
  }
  if (value === null) return null;
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (value instanceof Uint8Array) return { [BYTES_TAG]: toBase64(value) };
  if (value instanceof Map) return encodeMap(value, context);
  if (value instanceof Set) return encodeSet(value, context);
  if (Array.isArray(value)) return encodeArray(value, context);
  if (typeof value === 'object') return encodeObject(value, context, allowToJson);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SerializationError(`Unsupported value of type ${typeof value} at ${formatPath(context.path)}`);
  }
  return value;
}

function enterContainer(container: object, context: EncodeContext): void {
  if (context.ancestors.has(container)) {
    throw new SerializationError(`circular reference at ${formatPath(context.path)}`);
  }
  context.ancestors.add(container);
}

function encodeMap(map: ReadonlyMap<unknown, unknown>, context: EncodeContext): unknown {
  enterContainer(map, context);
  try {
    const entries: Array<[unknown, unknown]> = [];
    let index = 0;
    for (const [key, entryValue] of map.entries()) {
      context.path.push(index);
      const encodedKey = encodeNode(key, context, true);
      const encodedValue = encodeNode(entryValue, context, true);
      context.path.pop();
      entries.push([
        encodedKey === OMITTED ? null : encodedKey,
        encodedValue === OMITTED ? null : encodedValue,
      ]);
      index++;
    }
    return { [MAP_TAG]: entries };
  } finally {
    context.ancestors.delete(map);
  }
}

function encodeSet(set: ReadonlySet<unknown>, context: EncodeContext): unknown {
  enterContainer(set, context);
  try {
    const values: unknown[] = [];
    let index = 0;
    for (const member of set.values()) {
      context.path.push(index);
      const encoded = encodeNode(member, context, true);
      context.path.pop();
      values.push(encoded === OMITTED ? null : encoded);
      index++;
    }
    return { [SET_TAG]: values };
  } finally {
    context.ancestors.delete(set);
  }
}

function encodeArray(values: ReadonlyArray<unknown>, context: EncodeContext): unknown {
  enterContainer(values, context);
  try {
    const out: unknown[] = new Array(values.length);
    for (let index = 0; index < values.length; index++) {
      context.path.push(index);
      const encoded = encodeNode(values[index], context, true);
      context.path.pop();
      out[index] = encoded === OMITTED ? null : encoded;
    }
    return out;
  } finally {
    context.ancestors.delete(values);
  }
}

function encodeObject(value: object, context: EncodeContext, allowToJson: boolean): unknown {
  if (allowToJson) {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      // Honour `toJSON()` like `JSON.stringify` does — user types (Luxon,
      // Temporal wrappers, …) rely on it, and the stores called
      // `JSON.stringify` before this walker existed.  Per spec the result
      // is NOT re-consulted for `toJSON` at this node (prevents infinite
      // recursion on `toJSON` returning `this`); nested values inside the
      // result get the normal treatment again.
      const resolved = (value as { toJSON: () => unknown }).toJSON();
      return encodeNode(resolved, context, false);
    }
  }
  enterContainer(value, context);
  try {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      context.path.push(key);
      const encoded = encodeNode(entryValue, context, true);
      context.path.pop();
      if (encoded === OMITTED) continue;
      defineOwnProperty(out, key, encoded);
    }
    // Escape check runs on the ENCODED form — exactly what decode will see.
    const outKeys = Object.keys(out);
    if (outKeys.length === 1 && RESERVED_TAGS.has(outKeys[0]!)) {
      return { [LITERAL_TAG]: out };
    }
    return out;
  } finally {
    context.ancestors.delete(value);
  }
}

/* -------------------------------- Decode --------------------------------- */

function decodeTagged(key: string, obj: Record<string, unknown>): unknown {
  switch (key) {
    case DATE_TAG: {
      const iso = obj[DATE_TAG];
      if (typeof iso !== 'string') throw malformedTag(DATE_TAG, 'a string');
      return new Date(iso);
    }
    case BYTES_TAG: {
      const base64 = obj[BYTES_TAG];
      if (typeof base64 !== 'string') throw malformedTag(BYTES_TAG, 'a string');
      return fromBase64(base64);
    }
    case MAP_TAG: {
      const entries = obj[MAP_TAG];
      if (!Array.isArray(entries)) throw malformedTag(MAP_TAG, 'an array of entry pairs');
      return new Map(entries.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw malformedTag(MAP_TAG, 'an array of entry pairs');
        return [decodeJsonTree(entry[0]), decodeJsonTree(entry[1])] as [unknown, unknown];
      }));
    }
    case SET_TAG: {
      const values = obj[SET_TAG];
      if (!Array.isArray(values)) throw malformedTag(SET_TAG, 'an array');
      return new Set(values.map((entry) => decodeJsonTree(entry)));
    }
    case BIGINT_TAG: {
      const digits = obj[BIGINT_TAG];
      if (typeof digits !== 'string') throw malformedTag(BIGINT_TAG, 'a string');
      return BigInt(digits);
    }
    case LITERAL_TAG:
      return decodeLiteral(obj[LITERAL_TAG]);
    default:
      // Includes SERIALIZED_TAG: the PayloadCodec interprets that framing at
      // the root before this walker runs — anywhere else it is plain data.
      return NOT_TAGGED;
  }
}

function decodeLiteral(inner: unknown): unknown {
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return decodeJsonTree(inner);
  // The escape's contract: the wrapped object's TOP-LEVEL keys are plain
  // data, never tags — but the values underneath decode normally.
  return decodePlainObject(inner as Record<string, unknown>);
}

function decodePlainObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(obj)) {
    defineOwnProperty(out, key, decodeJsonTree(entryValue));
  }
  return out;
}

/* -------------------------------- Helpers -------------------------------- */

/**
 * `out.__proto__ = …` would invoke the prototype setter rather than create
 * a data property, letting a hostile `{"__proto__": …}` payload change the
 * built object's prototype.  Define it explicitly so the key round-trips as
 * plain data and the prototype stays untouched (security audit #9) — on
 * BOTH directions of the walk: decode rebuilds parsed JSON, and encode
 * rebuilds user objects that may themselves stem from `JSON.parse`.
 */
function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function malformedTag(tag: string, expected: string): SerializationError {
  return new SerializationError(`Malformed ${tag} tag: expected ${expected}`);
}

function formatPath(path: ReadonlyArray<string | number>): string {
  let out = '$';
  for (const segment of path) {
    out += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binaryString = '';
  for (let i = 0; i < bytes.byteLength; i++) binaryString += String.fromCharCode(bytes[i]!);
  return btoa(binaryString);
}

export function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(s, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
