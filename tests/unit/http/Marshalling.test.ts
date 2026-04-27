import { describe, expect, test } from 'bun:test';
import {
  entity,
  marshal,
  pickRequestSerializer,
  pickResponseSerializer,
} from '../../../src/http/Marshalling.js';
import type { HttpRequest } from '../../../src/http/types.js';
import { HttpError } from '../../../src/http/types.js';

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
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
    expect(pickRequestSerializer(req({ headers: { 'content-type': 'application/json' } })).name)
      .toBe('json');
  });

  test('returns CBOR for application/cbor', () => {
    expect(pickRequestSerializer(req({ headers: { 'content-type': 'application/cbor' } })).name)
      .toBe('cbor');
  });

  test('defaults to JSON for missing / unknown content types', () => {
    expect(pickRequestSerializer(req()).name).toBe('json');
    expect(pickRequestSerializer(req({ headers: { 'content-type': 'text/plain' } })).name)
      .toBe('json');
  });

  test('ignores parameters in content-type', () => {
    expect(pickRequestSerializer(req({ headers: { 'content-type': 'application/json; charset=utf-8' } })).name)
      .toBe('json');
  });
});

describe('pickResponseSerializer', () => {
  test('honours Accept: application/cbor', () => {
    const { serializer, contentType } = pickResponseSerializer(
      req({ headers: { accept: 'application/cbor' } }),
    );
    expect(serializer.name).toBe('cbor');
    expect(contentType).toBe('application/cbor');
  });

  test('defaults to JSON for Accept: */*', () => {
    expect(pickResponseSerializer(req({ headers: { accept: '*/*' } })).serializer.name).toBe('json');
  });

  test('defaults to JSON when Accept header is missing', () => {
    expect(pickResponseSerializer(req()).serializer.name).toBe('json');
  });

  test('multi-value Accept picks the first match', () => {
    const { serializer } = pickResponseSerializer(
      req({ headers: { accept: 'application/xml,application/cbor,application/json' } }),
    );
    expect(serializer.name).toBe('cbor');
  });
});

describe('entity', () => {
  test('decodes JSON request body', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const decoded = entity<{ a: number }>(req({
      headers: { 'content-type': 'application/json' },
      body,
    }));
    expect(decoded.a).toBe(1);
  });

  test('throws 400 on missing body', () => {
    expect(() => entity(req())).toThrow(HttpError);
  });

  test('throws 400 on malformed JSON', () => {
    const body = new TextEncoder().encode('{nope}');
    expect(() => entity(req({
      headers: { 'content-type': 'application/json' },
      body,
    }))).toThrow(HttpError);
  });
});

describe('marshal', () => {
  test('encodes an object as JSON by default', () => {
    const { body, contentType } = marshal(req(), { x: 1 });
    expect(new TextDecoder().decode(body)).toBe('{"x":1}');
    expect(contentType).toContain('application/json');
  });

  test('encodes as CBOR when Accept requests it', () => {
    const { body, contentType } = marshal(req({ headers: { accept: 'application/cbor' } }), { x: 1 });
    expect(contentType).toBe('application/cbor');
    expect(body).toBeInstanceOf(Uint8Array);
    // First byte for a 1-entry map is 0xa1 in CBOR.
    expect(body[0]).toBe(0xa1);
  });
});
