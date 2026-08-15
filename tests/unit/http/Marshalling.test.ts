import { describe, expect, test } from 'bun:test';
import {
  entity,
  marshal,
  pickRequestSerializer,
  pickResponseSerializer,
} from '../../../src/http/Marshalling.js';
import { FormUrlEncodedSerializer } from '../../../src/http/FormUrlEncodedSerializer.js';
import type { HttpRequest } from '../../../src/http/Types.js';
import { HttpError, Status } from '../../../src/http/Types.js';
import { SerializationError } from '../../../src/serialization/index.js';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    path: '/',
    headers: {},
    query: {},
    params: {},
    body: null,
    ...overrides,
  };
}

describe('pickRequestSerializer', () => {
  test('returns JSON for application/json', () => {
    expect(pickRequestSerializer(request({ headers: { 'content-type': 'application/json' } })).name)
      .toBe('json');
  });

  test('returns CBOR for application/cbor', () => {
    expect(pickRequestSerializer(request({ headers: { 'content-type': 'application/cbor' } })).name)
      .toBe('cbor');
  });

  test('returns the form decoder for application/x-www-form-urlencoded', () => {
    expect(pickRequestSerializer(request({ headers: { 'content-type': 'application/x-www-form-urlencoded' } })).name)
      .toBe('form-urlencoded');
  });

  // Split off from the old 'missing / unknown' test: the two halves are
  // separate policies now, and bundling them hid which one a change moved.
  test('defaults to JSON when no content-type is stated', () => {
    expect(pickRequestSerializer(request()).name).toBe('json');
    expect(pickRequestSerializer(request({ headers: { 'content-type': '' } })).name).toBe('json');
  });

  test('rejects an unknown content-type with 415 (#669)', () => {
    let thrown: HttpError | undefined;
    try {
      pickRequestSerializer(request({ headers: { 'content-type': 'text/xml' } }));
    } catch (e) { thrown = e as HttpError; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown!.status).toBe(Status.UnsupportedMediaType);
    expect(thrown!.message).toContain('text/xml');
  });

  test('the 415 advertises the accepted media types as a header and a body field', () => {
    let thrown: HttpError | undefined;
    try {
      pickRequestSerializer(request({ headers: { 'content-type': 'text/plain' } }));
    } catch (e) { thrown = e as HttpError; }
    const accepted = thrown!.extra!.accepted as string[];
    expect(accepted).toEqual([
      'application/json',
      'application/cbor',
      'application/x-cbor',
      'application/x-www-form-urlencoded',
    ]);
    expect(thrown!.headers!.accept).toBe(accepted.join(', '));
  });

  test('ignores parameters in content-type', () => {
    expect(pickRequestSerializer(request({ headers: { 'content-type': 'application/json; charset=utf-8' } })).name)
      .toBe('json');
    expect(pickRequestSerializer(request({ headers: { 'content-type': '  APPLICATION/CBOR ; x=1' } })).name)
      .toBe('cbor');
  });

  // The old table tested unanchored regexes against the WHOLE header, so a
  // parameter naming a known type selected that type.  Harmless while every
  // miss fell back to JSON; a bypass of the 415 the moment it stopped.
  test('a known media type inside a parameter does not pick the serializer (#669)', () => {
    expect(() => pickRequestSerializer(request({
      headers: { 'content-type': 'multipart/form-data; boundary=----application/cbor' },
    }))).toThrow(HttpError);
  });

  test('honours the +json structured-syntax suffix (#669)', () => {
    for (const mediaType of ['application/vnd.api+json', 'application/merge-patch+json', 'application/problem+json']) {
      expect(pickRequestSerializer(request({ headers: { 'content-type': mediaType } })).name).toBe('json');
    }
  });
});

describe('FormUrlEncodedSerializer', () => {
  const decode = (text: string) =>
    new FormUrlEncodedSerializer().fromBinary(new TextEncoder().encode(text), '');

  test('decodes a flat form body into string fields', () => {
    expect(decode('name=Ada&age=36')).toEqual({ name: 'Ada', age: '36' });
  });

  test('a repeated field becomes an array, matching how query strings widen', () => {
    expect(decode('tag=a&tag=b&only=x')).toEqual({ tag: ['a', 'b'], only: 'x' });
  });

  test('percent-escapes and + decode per the HTML form rules', () => {
    expect(decode('greeting=hello+world&sign=%26')).toEqual({ greeting: 'hello world', sign: '&' });
  });

  test('a __proto__ field stays data and does not re-parent the record', () => {
    const fields = decode('__proto__=a&__proto__=b');
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(fields, '__proto__')!.value).toEqual(['a', 'b']);
    expect(({} as Record<string, unknown>)['0']).toBeUndefined();
  });

  test('round-trips through toBinary', () => {
    const serializer = new FormUrlEncodedSerializer();
    const fields = { name: 'Ada', tag: ['a', 'b'] };
    expect(serializer.fromBinary(serializer.toBinary(fields), '')).toEqual(fields);
  });

  test('toBinary refuses a value form encoding cannot carry', () => {
    expect(() => new FormUrlEncodedSerializer().toBinary(
      { nested: { deep: true } } as unknown as Record<string, string>,
    )).toThrow(SerializationError);
  });
});

describe('pickResponseSerializer', () => {
  test('honours Accept: application/cbor', () => {
    const { serializer, contentType } = pickResponseSerializer(
      request({ headers: { accept: 'application/cbor' } }),
    );
    expect(serializer.name).toBe('cbor');
    expect(contentType).toBe('application/cbor');
  });

  test('defaults to JSON for Accept: */*', () => {
    expect(pickResponseSerializer(request({ headers: { accept: '*/*' } })).serializer.name).toBe('json');
  });

  test('defaults to JSON when Accept header is missing', () => {
    expect(pickResponseSerializer(request()).serializer.name).toBe('json');
  });

  test('multi-value Accept picks the first match', () => {
    const { serializer } = pickResponseSerializer(
      request({ headers: { accept: 'application/xml,application/cbor,application/json' } }),
    );
    expect(serializer.name).toBe('cbor');
  });
});

describe('entity', () => {
  test('decodes JSON request body', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const decoded = entity<{ a: number }>(request({
      headers: { 'content-type': 'application/json' },
      body,
    }));
    expect(decoded.a).toBe(1);
  });

  test('throws 400 on missing body', () => {
    expect(() => entity(request())).toThrow(HttpError);
  });

  test('throws 400 on malformed JSON', () => {
    const body = new TextEncoder().encode('{nope}');
    expect(() => entity(request({
      headers: { 'content-type': 'application/json' },
      body,
    }))).toThrow(HttpError);
  });

  test('decodes a urlencoded form POST (#669)', () => {
    const decoded = entity<Record<string, string>>(request({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new TextEncoder().encode('name=Ada&age=36'),
    }));
    expect(decoded).toEqual({ name: 'Ada', age: '36' });
  });

  test('a charset parameter on the form type still decodes (#669)', () => {
    const decoded = entity<Record<string, string>>(request({
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new TextEncoder().encode('name=Ada'),
    }));
    expect(decoded).toEqual({ name: 'Ada' });
  });

  // The heart of #669: an unknown type used to reach JsonSerializer and die
  // as a misleading 400 'Cannot decode body'.  The 415 must survive the catch
  // that produces that 400.
  test('throws 415 — not a JSON-parse 400 — for text/xml (#669)', () => {
    let thrown: HttpError | undefined;
    try {
      entity(request({
        headers: { 'content-type': 'text/xml' },
        body: new TextEncoder().encode('<order/>'),
      }));
    } catch (e) { thrown = e as HttpError; }
    expect(thrown!.status).toBe(Status.UnsupportedMediaType);
    expect(thrown!.message).not.toContain('Cannot decode body');
  });

  test('an empty body is still a 400, whatever type it claims', () => {
    let thrown: HttpError | undefined;
    try {
      entity(request({ headers: { 'content-type': 'text/xml' }, body: new Uint8Array(0) }));
    } catch (e) { thrown = e as HttpError; }
    expect(thrown!.status).toBe(Status.BadRequest);
  });

  // src/http/HttpClient.ts only sets content-type for object bodies, so the
  // framework's own client posts a string body bare.  A blanket 415 would
  // reject it.
  test('a body with no content-type still decodes as JSON', () => {
    const decoded = entity<{ a: number }>(request({ body: new TextEncoder().encode('{"a":1}') }));
    expect(decoded.a).toBe(1);
  });
});

describe('marshal', () => {
  test('encodes an object as JSON by default', () => {
    const { body, contentType } = marshal(request(), { x: 1 });
    expect(new TextDecoder().decode(body)).toBe('{"x":1}');
    expect(contentType).toContain('application/json');
  });

  test('encodes as CBOR when Accept requests it', () => {
    const { body, contentType } = marshal(request({ headers: { accept: 'application/cbor' } }), { x: 1 });
    expect(contentType).toBe('application/cbor');
    expect(body).toBeInstanceOf(Uint8Array);
    // First byte for a 1-entry map is 0xa1 in CBOR.
    expect(body[0]).toBe(0xa1);
  });
});
