import { SerializationError, type Serializer } from '../../serialization/Serializer.js';
import {
  decodeJsonTree,
  encodeJsonTree,
  fromBase64,
  SERIALIZED_TAG,
  toBase64,
} from '../../serialization/JsonTree.js';

/**
 * THE stored payload format for every journal, snapshot store and
 * durable-state store — the single place that turns a domain value into the
 * string a backend writes, and back.
 *
 * Default path: the tagged JSON tree (`JsonTree.ts`) with
 * `JSON.stringify`-compatible `undefined` handling, so `Set`/`Map`/`Date`/
 * `bigint`/`Uint8Array` round-trip on every backend while rows written by
 * older versions (bare `JSON.stringify`) keep decoding unchanged (#888).
 *
 * Custom-serializer path: when a store is configured with a `Serializer`,
 * payloads are framed self-describingly as
 * `{"__serialized__":{"id":…,"manifest":…,"data":"<base64>"}}` — no schema
 * change, and default-format rows and serializer rows can coexist in one
 * stream, because decode dispatches per row.
 *
 * Both formats are append-only stable: anything written from now on must
 * remain readable by all future versions.  Third-party store
 * implementations should call these functions instead of `JSON.stringify`
 * so their rows match the framework's.
 */

type SerializedFrame = {
  readonly id: number;
  readonly manifest: string;
  readonly data: string;
};

export function encodePayload(value: unknown, serializer?: Serializer): string {
  if (serializer) {
    const bytes = serializer.toBinary(value);
    const frame: SerializedFrame = {
      id: serializer.id,
      manifest: serializer.manifest(value),
      data: toBase64(bytes),
    };
    return JSON.stringify({ [SERIALIZED_TAG]: frame });
  }
  return JSON.stringify(encodeJsonTree(value, { undefinedValues: 'omit' }));
}

export function decodePayload(text: string, serializer?: Serializer): unknown {
  const parsed: unknown = JSON.parse(text);
  const frame = serializedFrame(parsed);
  if (frame !== undefined) {
    if (!serializer) {
      throw new SerializationError(
        `stored payload was written with serializer id ${frame.id}`
        + `${frame.manifest ? ` (manifest '${frame.manifest}')` : ''},`
        + ' but no serializer is configured for this store',
      );
    }
    if (serializer.id !== frame.id) {
      throw new SerializationError(
        `stored payload was written with serializer id ${frame.id}, but the`
        + ` configured serializer is '${serializer.name}' (id ${serializer.id})`,
      );
    }
    return serializer.fromBinary(fromBase64(frame.data), frame.manifest);
  }
  return decodeJsonTree(parsed);
}

/**
 * A frame is only recognised when the parsed root is a single-key
 * `__serialized__` object with the full `{id, data}` shape.  The encoder's
 * escape mechanism guarantees user data can never produce that shape from
 * this version on; a legacy row that merely resembles it (wrong inner
 * shape) falls through and decodes as the plain data it always was.
 */
function serializedFrame(parsed: unknown): SerializedFrame | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== SERIALIZED_TAG) return undefined;
  const inner = (parsed as Record<string, unknown>)[SERIALIZED_TAG];
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
  const candidate = inner as Record<string, unknown>;
  if (typeof candidate['id'] !== 'number' || typeof candidate['data'] !== 'string') return undefined;
  return {
    id: candidate['id'],
    manifest: typeof candidate['manifest'] === 'string' ? candidate['manifest'] : '',
    data: candidate['data'],
  };
}
