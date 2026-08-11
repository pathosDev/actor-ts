/**
 * The format-agnostic half of rich-type support: which binary views and error
 * classes exist, what they are called on the wire, and how to rebuild one.
 *
 * Both `JsonTree` and `CborCodec` carry the same set of rich types, and they
 * disagreed about it once already (#1036) — `CborCodec` flattened `Map`, `Set`
 * and `BidirectionalMap` to `{}` while the JSON tree restored them.  Keeping
 * the tables here means the two codecs cannot drift by accident: adding a
 * binary kind or an error class is one edit that both formats pick up.
 *
 * Nothing in here throws.  A value the tables do not cover comes back as
 * `undefined`, so each codec can raise its own error type with its own
 * context — `SerializationError` with a key path in the JSON tree,
 * `CborEncodeError` / `CborDecodeError` with a byte offset in CBOR.
 */

/** A binary-view constructor plus the element width its byte length must be a multiple of. */
interface BinaryViewConstructor {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer): ArrayBufferView;
}

/**
 * The standard `ArrayBuffer` views by their wire `kind` name.
 * `Float16Array` is reached via `globalThis` — it is ES2025 and absent from
 * older runtimes and TS lib targets, and the format must not depend on the
 * writer's runtime having it.
 */
export const TYPED_ARRAY_CONSTRUCTORS: ReadonlyArray<readonly [string, BinaryViewConstructor]> = [
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
  ...((): ReadonlyArray<readonly [string, BinaryViewConstructor]> => {
    const float16 = (globalThis as { Float16Array?: BinaryViewConstructor }).Float16Array;
    return float16 ? [['Float16Array', float16]] : [];
  })(),
];

/**
 * The wire name for a binary value, or `undefined` for an exotic view neither
 * codec can rebuild — the caller refuses it rather than guessing.
 *
 * `Uint8Array` is deliberately absent: both formats carry it in their own
 * compact way (base64 under `__bytes__`, a bare byte string in CBOR), so it
 * never reaches this table.
 */
export function binaryKindOf(value: ArrayBufferView | ArrayBuffer): string | undefined {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (value instanceof DataView) return 'DataView';
  for (const [kind, constructor] of TYPED_ARRAY_CONSTRUCTORS) {
    if (value instanceof constructor) return kind;
  }
  return undefined;
}

/**
 * The bytes behind a binary value, as a view — no copy.  Callers that hand the
 * result to something long-lived must copy; `rebuildBinaryView` already does.
 */
export function binaryBytesOf(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Rebuild a binary value from its wire name and bytes; `undefined` when the
 * name is unknown or the byte length is not a whole number of elements.
 *
 * The buffer is normalised to an exact, offset-0 allocation first.  Decoded
 * bytes can arrive as a view into a shared pool at an arbitrary `byteOffset`
 * (`Buffer.from(…, 'base64')` does exactly this) — multi-byte views need
 * offset-0 alignment, and handing out a pool-backed buffer would expose
 * unrelated bytes (#619).
 */
export function rebuildBinaryView(kind: string, bytes: Uint8Array): ArrayBufferView | ArrayBuffer | undefined {
  const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
  if (kind === 'ArrayBuffer') return exact.buffer as ArrayBuffer;
  if (kind === 'DataView') return new DataView(exact.buffer as ArrayBuffer);
  for (const [name, constructor] of TYPED_ARRAY_CONSTRUCTORS) {
    if (name !== kind) continue;
    // A trailing partial element means the payload was truncated or forged.
    // Without this check the constructor throws a raw `RangeError` naming
    // neither the tag nor the value that produced it (#1036).
    if (exact.byteLength % constructor.BYTES_PER_ELEMENT !== 0) return undefined;
    return new constructor(exact.buffer as ArrayBuffer);
  }
  return undefined;
}

/** The error constructors a decoder may reconstruct; unknown names fall back to `Error` + `name`. */
export const ERROR_CONSTRUCTORS: Readonly<Record<string, new (message?: string) => Error>> = {
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
};

/**
 * Rebuild an error from its wire fields.  `cause` is deliberately NOT a
 * parameter: both formats distinguish "no cause" from "a cause that is
 * `undefined`" by key presence, which only the caller can see, so it assigns
 * `cause` itself afterwards.
 *
 * `errors` is present only for `AggregateError`, whose member errors are a
 * constructor argument rather than an assignable field.
 */
export function rebuildError(name: string, message: string, errors: readonly unknown[] | undefined): Error {
  if (name === 'AggregateError' && errors !== undefined) {
    return new AggregateError(errors, message);
  }
  const constructor = ERROR_CONSTRUCTORS[name] ?? Error;
  const out = new constructor(message);
  if (out.name !== name) out.name = name;
  return out;
}
