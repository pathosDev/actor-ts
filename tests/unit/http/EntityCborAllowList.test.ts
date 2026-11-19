/**
 * #967 on the CBOR edge — `entity()` with `application/cbor` decodes plain
 * data unless the route opts in, exactly like a JSON body.
 *
 * CBOR carries every rich type natively: a tag picks `Date`, `Set`, `Map`,
 * `URL`, a bignum, a `RegExp` or an `Error`, and simple value 23 is an
 * `undefined` no JSON body could express.  So the client chose the runtime
 * class of a value here too.  Plain data is the JSON data model — null,
 * booleans, finite numbers, strings, arrays, string-keyed maps — and anything
 * outside it needs its tag name in `EntityOptions.withTags`.  A CBOR tag has
 * no literal form to fall back to, unlike `{"__date__": …}` in JSON, so an
 * unadmitted one is a 400 naming it rather than data of another shape.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { EntityOptions } from '../../../src/http/EntityOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { entity } from '../../../src/http/Marshalling.js';
import { completeJson, post } from '../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { CborDecoder, CborEncoder } from '../../../src/serialization/CborCodec.js';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from '../../../src/serialization/Constants.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

const SAMPLES: Readonly<Record<JsonTreeTagName, unknown>> = {
  'date': new Date(0),
  'bytes': new Uint8Array([1, 2]),
  'map': new Map<unknown, unknown>([[1, 'one']]),
  'set': new Set([1]),
  'bidirectional-map': new BidirectionalMap([['a', 1]]),
  'bidirectional-multi-map': new BidirectionalMultiMap([['a', 1]]),
  'bigint': 12n,
  'number': Number.POSITIVE_INFINITY,
  'undefined': undefined,
  // Deliberately catastrophic (js/redos): the test proves this pattern is refused
  // before it is ever compiled, so it has to be one that would backtrack.
  'regexp': /(a+)+$/g,
  'url': new URL('file:///etc/passwd'),
  'error': new TypeError('x'),
  'typed-array': new Float64Array([1.5]),
};

function cborRequest(value: unknown): HttpRequest {
  return {
    method: 'POST', path: '/', headers: { 'content-type': 'application/cbor' }, query: {}, params: {},
    body: new CborEncoder().encode(value),
  };
}

function refusalOf(run: () => unknown): HttpError {
  try {
    run();
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected a refusal');
}

describe('entity() on a CBOR body — plain data by default', () => {
  test('plain data decodes as it would from JSON', () => {
    const body = { name: 'Ada', n: 1.5, negativeZero: -0, ok: true, none: null, list: [1, 'two', { deep: [] }] };
    expect(entity<typeof body>(cborRequest(body))).toEqual(body);
  });

  test('every rich type is a 400 naming its tag, not a value of the class the client picked', () => {
    for (const name of JSON_TREE_TAG_NAMES) {
      const refusal = refusalOf(() => entity(cborRequest({ value: SAMPLES[name] })));
      expect(refusal).toBeInstanceOf(HttpError);
      expect(refusal.status).toBe(Status.BadRequest);
      expect(refusal.message).toContain(`'${name}'`);
    }
  });

  test('a native 64-bit integer past 2^53 is a bigint, and refused as one', () => {
    // 0x1b + eight bytes: major type 0 with a uint64 argument — no tag at all.
    const body = new Uint8Array([0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    const request: HttpRequest = { ...cborRequest(null), body };
    expect(refusalOf(() => entity(request)).message).toContain("'bigint'");
  });

  test('a refused RegExp is never compiled', () => {
    // 27(["RegExp", "(", "zz"]) — unbuildable, so building it would throw a different error.
    const unbuildable = new Uint8Array([
      0xd8, 0x1b, 0x83, 0x66, ...new TextEncoder().encode('RegExp'), 0x61, 0x28, 0x62, 0x7a, 0x7a,
    ]);
    const request: HttpRequest = { ...cborRequest(null), body: unbuildable };
    expect(refusalOf(() => entity(request)).message).toContain("'regexp'");
  });
});

describe('entity() on a CBOR body — per-tag opt-in', () => {
  test('each admitted tag builds its class; the rest stay refused', () => {
    for (const name of JSON_TREE_TAG_NAMES) {
      const decoded = entity<{ value: unknown }>(cborRequest({ value: SAMPLES[name] }), { tags: [name] });
      expect(decoded.value).toEqual(SAMPLES[name]);
    }
    const entityOptions = EntityOptions.create().withTags(['date']);
    expect(refusalOf(() => entity(cborRequest({ when: new Date(0), pattern: /x/ }), entityOptions)).message)
      .toContain("'regexp'");
  });

  test('a bignum needs bigint, not bytes, though its body is a byte string', () => {
    const big = 2n ** 80n;
    expect(entity<{ n: bigint }>(cborRequest({ n: big }), { tags: ['bigint'] }).n).toBe(big);
  });

  test('a typed array needs typed-array, not bytes', () => {
    const decoded = entity<{ v: unknown }>(cborRequest({ v: new Float64Array([2]) }), { tags: ['typed-array'] });
    expect(decoded.v).toBeInstanceOf(Float64Array);
  });

  test('admitting set does not admit an undefined inside it', () => {
    expect(refusalOf(() => entity(cborRequest({ s: new Set([undefined]) }), { tags: ['set'] })).message)
      .toContain("'undefined'");
  });
});

const bindings: ServerBinding[] = [];
const systems: ActorSystem[] = [];

afterEach(async () => {
  while (bindings.length) await bindings.shift()!.unbind();
  while (systems.length) await systems.shift()!.terminate();
});

describe('entity() on a CBOR body — through a live route', () => {
  test('a RegExp posted as CBOR is a 400, and plain CBOR reaches the handler', async () => {
    const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('entity-cbor', systemOptions);
    systems.push(system);
    const backend = new FastifyBackend({ logger: false });
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(backend)
      .bind(post((request) => completeJson(Status.OK, { got: entity(request) as object })));
    bindings.push(binding);
    const url = `http://${binding.host}:${binding.port}/`;
    const encoder = new CborEncoder();

    // A deliberately catastrophic pattern (js/redos): it must be refused, never compiled.
    const hostile = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/cbor' }, body: new Uint8Array(encoder.encode({ p: /(a+)+$/ })),
    });
    expect(hostile.status).toBe(400);

    const plain = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/cbor' }, body: new Uint8Array(new CborEncoder().encode({ a: [1, 'b'] })),
    });
    expect(await plain.json()).toEqual({ got: { a: [1, 'b'] } });
  });
});

describe('CborDecoder tag options — the structure an admitted collection is built of, and nothing more', () => {
  test('a BidirectionalMap needs no map, but a Set stored in it still needs set', () => {
    const plainValues = new BidirectionalMap([['a', 1]]);
    expect(new CborDecoder({}, { tags: ['bidirectional-map'] }).decode(new CborEncoder().encode(plainValues)))
      .toEqual(plainValues);
    const holdingASet = new BidirectionalMap([['a', new Set([1])]]);
    expect(() => new CborDecoder({}, { tags: ['bidirectional-map'] }).decode(new CborEncoder().encode(holdingASet)))
      .toThrow("'set'");
  });

  test('a BidirectionalMultiMap needs neither map nor set for its own rows, but a Map left does', () => {
    const rows = new BidirectionalMultiMap([['a', 1], ['a', 2]]);
    expect(new CborDecoder({}, { tags: ['bidirectional-multi-map'] }).decode(new CborEncoder().encode(rows)))
      .toEqual(rows);
    const mapLeft = new BidirectionalMultiMap<unknown, number>([[new Map([[1, 1]]), 1]]);
    expect(() => new CborDecoder({}, { tags: ['bidirectional-multi-map'] }).decode(new CborEncoder().encode(mapLeft)))
      .toThrow("'map'");
  });

  test('property: any JSON value encoded as CBOR decodes unchanged under tags: []', () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const parsed = JSON.parse(JSON.stringify(value)) as unknown;
      expect(new CborDecoder({}, { tags: [] }).decode(new CborEncoder().encode(parsed))).toEqual(parsed);
    }));
  });
});
