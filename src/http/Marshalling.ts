import {
  CborSerializer,
  JsonSerializer,
  type Serializer,
} from '../serialization/index.js';
import { HttpError, type HttpRequest, Status } from './types.js';

/**
 * Map from a Content-Type / Accept token to a concrete Serializer.  Minimal
 * so we can stay independent of the SerializationExtension (which is
 * class-binding, not MIME-based).
 */
const MIME_TO_SERIALIZER: Array<{ pattern: RegExp; ctor: () => Serializer }> = [
  { pattern: /application\/(json|\*)(;.*)?$/i, ctor: () => new JsonSerializer() },
  { pattern: /application\/cbor(;.*)?$/i, ctor: () => new CborSerializer() },
  { pattern: /application\/x-cbor(;.*)?$/i, ctor: () => new CborSerializer() },
];

/** Pick a marshaller for the incoming request body, based on Content-Type. */
export function pickRequestSerializer(req: HttpRequest): Serializer {
  const ct = req.headers['content-type'] ?? '';
  const match = MIME_TO_SERIALIZER.find(m => m.pattern.test(ct));
  return match ? match.ctor() : new JsonSerializer();
}

/** Pick a serializer for the response body, using the client's `Accept`. */
export function pickResponseSerializer(req: HttpRequest): {
  serializer: Serializer;
  contentType: string;
} {
  const accept = req.headers['accept'] ?? 'application/json';
  for (const tok of accept.split(',')) {
    const mediaType = tok.trim().split(';')[0]!.toLowerCase();
    if (mediaType === 'application/cbor' || mediaType === 'application/x-cbor') {
      return { serializer: new CborSerializer(), contentType: 'application/cbor' };
    }
    if (mediaType === 'application/json' || mediaType === '*/*') {
      return { serializer: new JsonSerializer(), contentType: 'application/json; charset=utf-8' };
    }
  }
  return { serializer: new JsonSerializer(), contentType: 'application/json; charset=utf-8' };
}

/**
 * Decode the request body into a typed value.  Throws an HTTP 400 if the
 * body is malformed.  Returns undefined for empty bodies.
 */
export function entity<T = unknown>(req: HttpRequest): T {
  if (!req.body || req.body.byteLength === 0) {
    throw new HttpError(Status.BadRequest, 'Missing request body');
  }
  const serializer = pickRequestSerializer(req);
  try {
    return serializer.fromBinary(req.body, '') as T;
  } catch (e) {
    throw new HttpError(Status.BadRequest, `Cannot decode body: ${(e as Error).message}`);
  }
}

/** Encode a value into `{body, contentType}` suitable for an HttpResponse. */
export function marshal(
  req: HttpRequest,
  value: unknown,
): { body: Uint8Array; contentType: string } {
  const { serializer, contentType } = pickResponseSerializer(req);
  return { body: serializer.toBinary(value), contentType };
}
