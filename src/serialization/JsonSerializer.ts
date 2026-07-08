import { SerializationError, type Serializer } from './Serializer.js';

/**
 * JSON serializer — the default fallback.  Handles plain objects, arrays,
 * strings, numbers, booleans, `null`, and — via pre/post-walking the tree
 * before `JSON.stringify` — `Date`, `Uint8Array`, `Map`, `Set`, and
 * `bigint`.  Class identity for custom user types is NOT preserved; the
 * decoded value is a plain object.  Callers that need stronger typing
 * should register a custom serializer via `SerializationExtension`.
 */
export class JsonSerializer implements Serializer<unknown> {
  readonly id = 1;
  readonly name = 'json';
  readonly includesManifest = false;

  manifest(_obj: unknown): string { return ''; }

  toBinary(obj: unknown): Uint8Array {
    let encoded: unknown;
    try { encoded = encodeTree(obj); } catch (e) {
      throw new SerializationError(`JsonSerializer encode failed: ${(e as Error).message}`);
    }
    const json = JSON.stringify(encoded);
    if (json === undefined) {
      throw new SerializationError('JsonSerializer: value is not JSON-serializable');
    }
    return new TextEncoder().encode(json);
  }

  fromBinary(bytes: Uint8Array, _manifest: string): unknown {
    const text = new TextDecoder().decode(bytes);
    return decodeTree(JSON.parse(text));
  }
}

/* ------------------------- Tagged representations ------------------------- */

const DATE_TAG = '__date__';
const BYTES_TAG = '__bytes__';
const MAP_TAG = '__map__';
const SET_TAG = '__set__';
const BIGINT_TAG = '__bigint__';

function encodeTree(value: unknown): unknown {
  if (value === undefined) throw new Error('undefined is not JSON-serialisable');
  if (value === null) return null;
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (value instanceof Uint8Array) return { [BYTES_TAG]: toBase64(value) };
  if (value instanceof Map) {
    return {
      [MAP_TAG]: Array.from(value.entries()).map(([k, v]) => [encodeTree(k), encodeTree(v)]),
    };
  }
  if (value instanceof Set) {
    return { [SET_TAG]: Array.from(value.values()).map(encodeTree) };
  }
  if (Array.isArray(value)) return value.map(encodeTree);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeTree(v);
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`Unsupported value of type ${typeof value}`);
  }
  return value;
}

function decodeTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeTree);
  const obj = value as Record<string, unknown>;
  if (DATE_TAG in obj) return new Date(obj[DATE_TAG] as string);
  if (BYTES_TAG in obj) return fromBase64(obj[BYTES_TAG] as string);
  if (MAP_TAG in obj) {
    return new Map(
      (obj[MAP_TAG] as Array<[unknown, unknown]>).map(([k, v]) => [decodeTree(k), decodeTree(v)]),
    );
  }
  if (SET_TAG in obj) return new Set((obj[SET_TAG] as unknown[]).map(decodeTree));
  if (BIGINT_TAG in obj) return BigInt(obj[BIGINT_TAG] as string);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // `out.__proto__ = …` would invoke the prototype setter rather than
    // create a data property, letting a hostile `{"__proto__": …}` payload
    // change the decoded object's prototype.  Define it explicitly so the
    // key round-trips as plain data and the prototype stays untouched
    // (SECURITY_AUDIT.md #9).
    if (k === '__proto__') {
      Object.defineProperty(out, k, {
        value: decodeTree(v), enumerable: true, writable: true, configurable: true,
      });
    } else {
      out[k] = decodeTree(v);
    }
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(s, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
