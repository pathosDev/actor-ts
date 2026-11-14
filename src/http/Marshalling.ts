import {
  CborSerializer,
  JsonSerializer,
  type Serializer,
} from '../serialization/index.js';
import type { JsonTreeTagOptions } from '../serialization/JsonTree.js';
import { EntityOptionsValidator, type EntityOptions, type EntityOptionsType } from './EntityOptions.js';
import { FormUrlEncodedSerializer } from './FormUrlEncodedSerializer.js';
import { HttpError, type HttpRequest, Status } from './Types.js';

/**
 * Map from a request media type to a concrete Serializer.  Minimal so we can
 * stay independent of the SerializationExtension (which is class-binding, not
 * media-type-based).
 *
 * The keys are exact, already-normalised media types — not patterns.  The
 * previous regex table tested the *whole* header, unanchored at the start, so
 * `multipart/form-data; boundary=----application/cbor` matched the CBOR entry
 * on its boundary parameter.  While every miss fell back to JSON that was
 * harmless noise; now that a miss is a 415 it would be a bypass, letting a
 * caller pick a decoder — and slip past the rejection — by naming one inside a
 * parameter.  Parsing the header first and looking the result up exactly is
 * what closes that (#669).
 *
 * Each factory takes the tag options of the request being decoded, and only
 * the JSON one uses them: CBOR and form bodies have no `JsonTree` tags.
 */
type SerializerFactory = (tagOptions: JsonTreeTagOptions) => Serializer;
const MEDIA_TYPE_TO_SERIALIZER: ReadonlyMap<string, SerializerFactory> = new Map<string, SerializerFactory>([
  ['application/json', (tagOptions) => new JsonSerializer({}, tagOptions)],
  ['application/cbor', () => new CborSerializer()],
  ['application/x-cbor', () => new CborSerializer()],
  ['application/x-www-form-urlencoded', () => new FormUrlEncodedSerializer()],
]);

/**
 * The media types `entity()` will decode, in the order they are advertised on
 * a 415.  Derived from the table above so the two can never disagree — a list
 * written out by hand is one edit away from promising a type nothing decodes.
 */
const ACCEPTED_REQUEST_MEDIA_TYPES: readonly string[] = [...MEDIA_TYPE_TO_SERIALIZER.keys()];

/**
 * Reduce a `Content-Type` header to its bare media type: `application/json;
 * charset=utf-8` → `application/json`.  Returns `''` when the header is
 * absent or empty, which callers treat as "the client stated nothing".
 *
 * Same shape as the `Accept` parsing in {@link pickResponseSerializer}; the
 * request side had been comparing against the raw header instead.
 */
function requestMediaType(request: HttpRequest): string {
  return (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Resolve a parsed media type to a serializer factory, honouring the RFC 6839
 * structured-syntax suffix: `application/vnd.api+json`,
 * `application/merge-patch+json` and `application/problem+json` are JSON to
 * everyone who handles them, and before #669 they were decoded as JSON only
 * because they missed the table and hit the fallback.  Making a miss a 415
 * without this would have turned three working request shapes into rejections.
 */
function serializerFactoryFor(mediaType: string): SerializerFactory | undefined {
  const exact = MEDIA_TYPE_TO_SERIALIZER.get(mediaType);
  if (exact) return exact;
  const suffix = mediaType.lastIndexOf('+');
  if (suffix < 0) return undefined;
  return MEDIA_TYPE_TO_SERIALIZER.get(`application/${mediaType.slice(suffix + 1)}`);
}

/** No tag is special: what `JSON.parse` produced is what the handler gets. */
const PLAIN_JSON: JsonTreeTagOptions = { tags: [] };

/**
 * Pick a marshaller for the incoming request body, based on Content-Type.
 *
 * Throws `HttpError(415)` for a media type nothing here decodes, listing the
 * accepted ones both as an `Accept` response header (RFC 9110 §12.5.1 defines
 * that as "what to send next time") and as an `accepted` field in the body.
 * Until #669 every unknown type silently got a `JsonSerializer`, which turned
 * a content-negotiation failure into either a misleading 400 from
 * `JSON.parse` or — worse, when the body happened to be valid JSON — a
 * success the client never asked for.
 *
 * A MISSING Content-Type deliberately keeps the JSON default rather than
 * joining the rejected set.  RFC 9110 §8.3 leaves the recipient free to guess
 * when the sender states nothing, and actor-ts's own `HttpClient` relies on
 * it: `normaliseHeaders` only sets the header for object bodies, so a string
 * body ships bare and a blanket rule would 415 the framework's own client.
 *
 * `tagOptions` reaches the JSON decoder only, and its default is plain JSON
 * (`{ tags: [] }`): a request body is bytes a stranger wrote, so no tag in it
 * picks a value's runtime class unless the route asked for that tag (#967).
 */
export function pickRequestSerializer(
  request: HttpRequest,
  tagOptions: JsonTreeTagOptions = PLAIN_JSON,
): Serializer {
  const mediaType = requestMediaType(request);
  if (mediaType === '') return new JsonSerializer({}, tagOptions);
  const factory = serializerFactoryFor(mediaType);
  if (factory) return factory(tagOptions);
  throw new HttpError(
    Status.UnsupportedMediaType,
    `Unsupported Content-Type: ${mediaType}`,
    { accepted: ACCEPTED_REQUEST_MEDIA_TYPES },
    { accept: ACCEPTED_REQUEST_MEDIA_TYPES.join(', ') },
  );
}

/** Pick a serializer for the response body, using the client's `Accept`. */
export function pickResponseSerializer(request: HttpRequest): {
  serializer: Serializer;
  contentType: string;
} {
  const accept = request.headers['accept'] ?? 'application/json';
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
 * Decode the request body into a typed value.  Throws an HTTP 400 if the body
 * is missing or malformed, and an HTTP 415 if the stated Content-Type is one
 * no built-in serializer decodes (see {@link pickRequestSerializer}).
 *
 * **A JSON body is plain JSON** unless `options.tags` names the `JsonTree`
 * tags this route accepts (#967).  It used to be decoded with the full tag
 * set, the one built for reading back the framework's own persisted rows, so
 * the client chose the runtime class of any value: `{"__regexp__": …}` arrived
 * as a `RegExp` it wrote, `{"__bigint__": "1"}` as a `bigint` that passes
 * `amount > 0` and then throws out of the response encoder.  With an opt-in,
 * a tag outside the list is a 400 naming it — never a value of a class the
 * route did not ask for.  `as T` stays a cast either way; it checks nothing.
 *
 * The body check runs first, so an empty body is a 400 whatever type it
 * claims: "you sent nothing" is the more actionable of the two answers.
 *
 * `pickRequestSerializer` is called OUTSIDE the try on purpose — inside it,
 * the catch below would relabel its 415 as a 400 and put the framework right
 * back where #669 found it.
 */
export function entity<T = unknown>(request: HttpRequest, options: EntityOptions = {}): T {
  // Ahead of everything else and outside the try: an unknown tag name is the
  // route's own bug, and the catch below would turn it into the client's 400.
  const settings = options as EntityOptionsType;
  new EntityOptionsValidator().validate(settings);
  if (!request.body || request.body.byteLength === 0) {
    throw new HttpError(Status.BadRequest, 'Missing request body');
  }
  const serializer = pickRequestSerializer(request, { tags: settings.tags ?? [] });
  try {
    return serializer.fromBinary(request.body, '') as T;
  } catch (e) {
    throw new HttpError(Status.BadRequest, `Cannot decode body: ${(e as Error).message}`);
  }
}

/** Encode a value into `{body, contentType}` suitable for an HttpResponse. */
export function marshal(
  request: HttpRequest,
  value: unknown,
): { body: Uint8Array; contentType: string } {
  const { serializer, contentType } = pickResponseSerializer(request);
  return { body: serializer.toBinary(value), contentType };
}
