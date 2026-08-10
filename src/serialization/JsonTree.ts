import { BidirectionalMap } from '../util/BidirectionalMap.js';
import { SerializationError } from './Serializer.js';

/**
 * The tagged JSON tree format — one walker, two consumers: `JsonSerializer`
 * (HTTP marshalling) and the persistence `PayloadCodec` (every journal /
 * snapshot store / durable-state store).  Values that plain JSON silently
 * corrupts (`Set`/`Map` → `{}`, `Date` → string, `bigint` → throw,
 * `Uint8Array` → index-keyed object, `NaN`/`Infinity`/`-0` → `null`/`0`,
 * `RegExp`/`Error` → `{}`, `URL` → string, typed arrays → index objects)
 * are wrapped in single-key tag objects so they survive the round-trip;
 * inherently non-serialisable values (functions, symbols, `Promise`,
 * `WeakMap`/`WeakSet`, cycles) throw a `SerializationError` instead of
 * degrading silently.  `BidirectionalMap` is tagged too — the only framework
 * class here, because a collection that cannot be held in persistent state is
 * not much of a collection.
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
/**
 * The one framework class with a tag of its own.  A `BidirectionalMap` in an
 * actor's state would otherwise fall to `encodeObject` and come back as a
 * plain `{ forward, reverse }` — data intact, class gone.  Tagging it here is
 * what lets it be held in persistent state at all, with no adapter and no
 * registration, exactly like the `Map` it wraps.
 */
const BIDIRECTIONAL_MAP_TAG = '__bidirectionalmap__';
const BIGINT_TAG = '__bigint__';
/** Non-finite numbers and `-0` — plain JSON silently turns them into `null` / `0`. */
const NUMBER_TAG = '__number__';
/**
 * `undefined` in a VALUE position (array slot, `Set` member, `Map` key or
 * value) under the `'omit'` policy — plain JSON would turn it into `null`,
 * which is a different value.  Object properties are still dropped, matching
 * `JSON.stringify`, so ordinary optional-field payloads stay byte-identical.
 */
const UNDEFINED_TAG = '__undefined__';
const REGEXP_TAG = '__regexp__';
const URL_TAG = '__url__';
/**
 * `Error`: name + message + cause (+ `errors` for `AggregateError`).
 * Deliberately NOT the stack — a persisted stack leaks filesystem layout
 * into long-lived rows, and a replayed stack would lie about where the
 * error was thrown.
 */
const ERROR_TAG = '__error__';
/** Every `ArrayBuffer` view except `Uint8Array` (which keeps `__bytes__`), plus `DataView` and `ArrayBuffer`. */
const TYPEDARRAY_TAG = '__typedarray__';
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
  DATE_TAG, BYTES_TAG, MAP_TAG, SET_TAG, BIDIRECTIONAL_MAP_TAG, BIGINT_TAG,
  NUMBER_TAG, UNDEFINED_TAG, REGEXP_TAG, URL_TAG, ERROR_TAG, TYPEDARRAY_TAG,
  LITERAL_TAG, SERIALIZED_TAG,
]);

/**
 * How `undefined` is handled during encode.  `'reject'` throws (the HTTP
 * marshalling contract — a lossy payload is a bug there); `'omit'` matches
 * `JSON.stringify` for object properties (an `undefined` value drops the
 * property, so existing `persist({ optionalField: undefined })` callers keep
 * working byte-for-byte) while `undefined` in VALUE positions (array slots,
 * `Set` members, `Map` keys/values) is preserved via `__undefined__` —
 * plain JSON's `null` there would be a different value.
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
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (value instanceof Uint8Array) return { [BYTES_TAG]: toBase64(value) };
  // Ahead of the `Map` branch on purpose.  `BidirectionalMap` only implements
  // the interface today, so `instanceof Map` does not catch it — but if that
  // ever changes, the wrong branch would silently start dropping the class.
  if (value instanceof BidirectionalMap) return encodeBidirectionalMap(value, context);
  if (value instanceof Map) return encodeMap(value, context);
  if (value instanceof Set) return encodeSet(value, context);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return encodeBinaryView(value, context);
  if (value instanceof RegExp) {
    // lastIndex is a transient cursor, not data — deliberately not carried.
    return { [REGEXP_TAG]: { source: value.source, flags: value.flags } };
  }
  // Before the toJSON probe: URL.prototype.toJSON would collapse it to a string.
  if (value instanceof URL) return { [URL_TAG]: value.href };
  if (value instanceof Error) return encodeError(value, context);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    // Wrapper objects unwrap like JSON.stringify does.
    return encodeNode(value.valueOf(), context, false);
  }
  if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
    // Inherently non-serialisable — refuse loudly instead of storing `{}`.
    throw new SerializationError(
      `Unsupported value of type ${value.constructor.name} at ${formatPath(context.path)}`,
    );
  }
  if (Array.isArray(value)) return encodeArray(value, context);
  if (typeof value === 'object') return encodeObject(value, context, allowToJson);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SerializationError(`Unsupported value of type ${typeof value} at ${formatPath(context.path)}`);
  }
  return value;
}

function encodeNumber(value: number): unknown {
  if (Number.isNaN(value)) return { [NUMBER_TAG]: 'nan' };
  if (value === Infinity) return { [NUMBER_TAG]: 'infinity' };
  if (value === -Infinity) return { [NUMBER_TAG]: '-infinity' };
  if (Object.is(value, -0)) return { [NUMBER_TAG]: '-0' };
  return value;
}

function enterContainer(container: object, context: EncodeContext): void {
  if (context.ancestors.has(container)) {
    throw new SerializationError(`circular reference at ${formatPath(context.path)}`);
  }
  context.ancestors.add(container);
}

/**
 * Entry pairs, encoded.  Shared by the `Map` and `BidirectionalMap` tags —
 * they differ only in the tag they are filed under, and a second copy of this
 * loop would be a second place for the `undefined`-in-value-position rule to
 * drift.  The caller owns `enterContainer` / `ancestors.delete`.
 */
function encodeEntryPairs(
  entries: Iterable<readonly [unknown, unknown]>,
  context: EncodeContext,
): Array<[unknown, unknown]> {
  const encoded: Array<[unknown, unknown]> = [];
  let index = 0;
  for (const [key, entryValue] of entries) {
    context.path.push(index);
    const encodedKey = encodeNode(key, context, true);
    const encodedValue = encodeNode(entryValue, context, true);
    context.path.pop();
    encoded.push([
      encodedKey === OMITTED ? { [UNDEFINED_TAG]: true } : encodedKey,
      encodedValue === OMITTED ? { [UNDEFINED_TAG]: true } : encodedValue,
    ]);
    index++;
  }
  return encoded;
}

function encodeMap(map: ReadonlyMap<unknown, unknown>, context: EncodeContext): unknown {
  enterContainer(map, context);
  try {
    return { [MAP_TAG]: encodeEntryPairs(map.entries(), context) };
  } finally {
    context.ancestors.delete(map);
  }
}

/**
 * Only the forward direction is written — the reverse map is fully determined
 * by it, so storing both would double the row for nothing and give a decoder
 * two sources of truth to disagree about.
 */
function encodeBidirectionalMap(
  map: BidirectionalMap<unknown, unknown>,
  context: EncodeContext,
): unknown {
  enterContainer(map, context);
  try {
    return { [BIDIRECTIONAL_MAP_TAG]: encodeEntryPairs(map.entries(), context) };
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
      values.push(encoded === OMITTED ? { [UNDEFINED_TAG]: true } : encoded);
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
      out[index] = encoded === OMITTED ? { [UNDEFINED_TAG]: true } : encoded;
    }
    return out;
  } finally {
    context.ancestors.delete(values);
  }
}

/**
 * The standard `ArrayBuffer` views by their stored `kind` name.
 * `Float16Array` is reached via `globalThis` — it is ES2025 and absent from
 * older runtimes and TS lib targets, and the format must not depend on the
 * writer's runtime having it.
 */
const TYPED_ARRAY_CONSTRUCTORS: ReadonlyArray<readonly [string, new (buffer: ArrayBuffer) => ArrayBufferView]> = [
  ['Int8Array', Int8Array],
  ['Uint8ClampedArray', Uint8ClampedArray],
  ['Int16Array', Int16Array],
  ['Uint16Array', Uint16Array],
  ['Int32Array', Int32Array],
  ['Uint32Array', Uint32Array],
  ['Float32Array', Float32Array],
  ['Float64Array', Float64Array],
  ['BigInt64Array', BigInt64Array],
  ['BigUint64Array', BigUint64Array],
  ...((): ReadonlyArray<readonly [string, new (buffer: ArrayBuffer) => ArrayBufferView]> => {
    const float16 = (globalThis as { Float16Array?: new (buffer: ArrayBuffer) => ArrayBufferView }).Float16Array;
    return float16 ? [['Float16Array', float16]] : [];
  })(),
];

function encodeBinaryView(value: ArrayBufferView | ArrayBuffer, context: EncodeContext): unknown {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return { [TYPEDARRAY_TAG]: { kind: binaryKind(value, context), data: toBase64(bytes) } };
}

function binaryKind(value: ArrayBufferView | ArrayBuffer, context: EncodeContext): string {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (value instanceof DataView) return 'DataView';
  for (const [kind, constructor] of TYPED_ARRAY_CONSTRUCTORS) {
    if (value instanceof constructor) return kind;
  }
  // An exotic ArrayBuffer view we cannot reconstruct — refuse rather than guess.
  throw new SerializationError(
    `Unsupported binary view ${value.constructor?.name ?? 'unknown'} at ${formatPath(context.path)}`,
  );
}

function encodeError(error: Error, context: EncodeContext): unknown {
  enterContainer(error, context);
  try {
    const payload: Record<string, unknown> = { name: error.name, message: error.message };
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
      context.path.push('cause');
      const encoded = encodeNode(cause, context, true);
      context.path.pop();
      if (encoded !== OMITTED) payload['cause'] = encoded;
    }
    // AggregateError carries its member errors in `errors`.
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      context.path.push('errors');
      payload['errors'] = encodeArray(errors, context);
      context.path.pop();
    }
    return { [ERROR_TAG]: payload };
  } finally {
    context.ancestors.delete(error);
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
    case BIDIRECTIONAL_MAP_TAG: {
      const entries = obj[BIDIRECTIONAL_MAP_TAG];
      if (!Array.isArray(entries)) {
        throw malformedTag(BIDIRECTIONAL_MAP_TAG, 'an array of entry pairs');
      }
      // The constructor rebuilds the reverse direction from these pairs, so a
      // row that somehow carries a duplicate value resolves last-wins rather
      // than restoring a map whose two halves disagree.
      return new BidirectionalMap(entries.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw malformedTag(BIDIRECTIONAL_MAP_TAG, 'an array of entry pairs');
        }
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
    case NUMBER_TAG: {
      switch (obj[NUMBER_TAG]) {
        case 'nan': return NaN;
        case 'infinity': return Infinity;
        case '-infinity': return -Infinity;
        case '-0': return -0;
        default: throw malformedTag(NUMBER_TAG, "'nan', 'infinity', '-infinity' or '-0'");
      }
    }
    case UNDEFINED_TAG: {
      if (obj[UNDEFINED_TAG] !== true) throw malformedTag(UNDEFINED_TAG, 'true');
      return undefined;
    }
    case REGEXP_TAG: {
      const inner = obj[REGEXP_TAG] as { source?: unknown; flags?: unknown } | null;
      if (inner === null || typeof inner !== 'object' || typeof inner.source !== 'string' || typeof inner.flags !== 'string') {
        throw malformedTag(REGEXP_TAG, 'a { source, flags } pair of strings');
      }
      return new RegExp(inner.source, inner.flags);
    }
    case URL_TAG: {
      const href = obj[URL_TAG];
      if (typeof href !== 'string') throw malformedTag(URL_TAG, 'a string');
      return new URL(href);
    }
    case ERROR_TAG:
      return decodeError(obj[ERROR_TAG]);
    case TYPEDARRAY_TAG:
      return decodeBinaryView(obj[TYPEDARRAY_TAG]);
    case LITERAL_TAG:
      return decodeLiteral(obj[LITERAL_TAG]);
    default:
      // Includes SERIALIZED_TAG: the PayloadCodec interprets that framing at
      // the root before this walker runs — anywhere else it is plain data.
      return NOT_TAGGED;
  }
}

/** The error constructors decode may reconstruct; unknown names fall back to `Error` + `name`. */
const ERROR_CONSTRUCTORS: Readonly<Record<string, new (message?: string) => Error>> = {
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
};

function decodeError(inner: unknown): Error {
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    throw malformedTag(ERROR_TAG, 'a { name, message } object');
  }
  const payload = inner as { name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof payload.name !== 'string' || typeof payload.message !== 'string') {
    throw malformedTag(ERROR_TAG, 'a { name, message } object');
  }
  let out: Error;
  if (payload.name === 'AggregateError' && Array.isArray(payload.errors)) {
    out = new AggregateError((decodeJsonTree(payload.errors) as unknown[]), payload.message);
  } else {
    const constructor = ERROR_CONSTRUCTORS[payload.name] ?? Error;
    out = new constructor(payload.message);
    if (out.name !== payload.name) out.name = payload.name;
  }
  if ('cause' in payload) (out as { cause?: unknown }).cause = decodeJsonTree(payload.cause);
  return out;
}

function decodeBinaryView(inner: unknown): unknown {
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    throw malformedTag(TYPEDARRAY_TAG, 'a { kind, data } object');
  }
  const payload = inner as { kind?: unknown; data?: unknown };
  if (typeof payload.kind !== 'string' || typeof payload.data !== 'string') {
    throw malformedTag(TYPEDARRAY_TAG, 'a { kind, data } object');
  }
  // Copy out of the base64 result: it may be a view into a shared Buffer
  // pool at an arbitrary byteOffset — multi-byte views need offset-0
  // alignment, and handing out a pool-backed buffer would expose unrelated
  // bytes (#619).  `.slice()` yields a fresh, exact-length buffer.
  const bytes = fromBase64(payload.data).slice();
  if (payload.kind === 'ArrayBuffer') return bytes.buffer;
  if (payload.kind === 'DataView') return new DataView(bytes.buffer);
  for (const [kind, constructor] of TYPED_ARRAY_CONSTRUCTORS) {
    if (kind === payload.kind) return new constructor(bytes.buffer);
  }
  throw malformedTag(TYPEDARRAY_TAG, `a known binary kind (got '${payload.kind}')`);
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
