/**
 * Smoke case: CBOR carries the same rich types as the JSON tree (#1036).
 *
 * The parity unit suite proves the two codecs agree, but it imports the
 * sources directly on Bun.  Two things it therefore cannot see:
 *
 *   - `Float16Array` is reached through `globalThis` because it is ES2025 and
 *     absent from older runtimes.  Since the binary-kind table moved into
 *     `RichTypes` it is SHARED by both codecs, so a runtime where the
 *     presence check answers differently now affects both — and only a real
 *     Bun/Node/Deno run exercises that.
 *   - `Error` reconstruction goes through a constructor table, and
 *     `AggregateError` through a different branch again; both are built-in
 *     but resolved from the bundle here rather than from source.
 *
 * The assertions check classes, not just data: everything here decodes to
 * *something* even when the format is broken, which is exactly how #1036
 * stayed invisible.
 */
export const name = 'CBOR rich types';
export const description = 'CBOR round-trips Map, Set, typed arrays, Error and friends on the built package';

export async function run({ actorTs, loadEntry }) {
  const { BidirectionalMap, BidirectionalMultiMap } = actorTs;
  const { CborSerializer, JsonSerializer } = await loadEntry('serialization');
  const cbor = new CborSerializer();
  const json = new JsonSerializer();

  const roundTrip = (value) => cbor.fromBinary(cbor.toBinary(value), cbor.manifest(value));
  const fail = (message) => { throw new Error(message); };

  // The three collections that used to encode as `{}`.
  const map = roundTrip(new Map([['ada', 1]]));
  if (!(map instanceof Map)) fail(`Map lost its class: ${map?.constructor?.name ?? typeof map}`);
  if (map.get('ada') !== 1) fail(`Map lost its entries: size ${map.size}`);

  const set = roundTrip(new Set(['alpha', 'beta']));
  if (!(set instanceof Set)) fail(`Set lost its class: ${set?.constructor?.name ?? typeof set}`);
  if (set.size !== 2 || !set.has('beta')) fail(`Set lost its members: size ${set.size}`);

  const bidirectional = roundTrip(new BidirectionalMap([['grace', 2]]));
  if (!(bidirectional instanceof BidirectionalMap)) fail('BidirectionalMap lost its class');
  if (bidirectional.getKey(2) !== 'grace') fail('BidirectionalMap inverse not rebuilt');

  const multi = roundTrip(new BidirectionalMultiMap([['news', 'ada'], ['news', 'grace']]));
  if (!(multi instanceof BidirectionalMultiMap)) fail('BidirectionalMultiMap lost its class');
  if (multi.size !== 2) fail(`BidirectionalMultiMap lost pairs: size ${multi.size}`);
  if ([...multi.getKeys('grace')].join(',') !== 'news') fail('BidirectionalMultiMap inverse not rebuilt');

  // A plain object must NOT come back as a Map — the reason Map is tagged.
  if (roundTrip({ ada: 1 }) instanceof Map) fail('a plain object decoded as a Map');

  // Binary views, including the globalThis-gated one where it exists.
  const kinds = [
    ['Int8Array', new Int8Array([-1, 2])],
    ['Uint16Array', new Uint16Array([0, 65535])],
    ['Float64Array', new Float64Array([1.5, -0])],
    ['BigInt64Array', new BigInt64Array([-5n, 5n])],
  ];
  if (typeof globalThis.Float16Array === 'function') {
    kinds.push(['Float16Array', new globalThis.Float16Array([1.5])]);
  }
  for (const [kind, view] of kinds) {
    const decoded = roundTrip(view);
    if (decoded.constructor.name !== kind) {
      fail(`${kind} decoded as ${decoded.constructor?.name ?? typeof decoded}`);
    }
    if (decoded.length !== view.length) fail(`${kind} length ${decoded.length} !== ${view.length}`);
    for (let i = 0; i < view.length; i++) {
      if (!Object.is(decoded[i], view[i])) fail(`${kind}[${i}] ${decoded[i]} !== ${view[i]}`);
    }
  }

  // Uint8Array keeps the bare byte string — the size argument for CBOR.
  const bytes = roundTrip(new Uint8Array([1, 2, 3]));
  if (!(bytes instanceof Uint8Array)) fail('Uint8Array lost its class');
  if (cbor.toBinary(new Uint8Array([1, 2, 3])).byteLength !== 4) {
    fail('Uint8Array is no longer a bare byte string');
  }

  // Errors, including the AggregateError branch.
  const typeError = roundTrip(new TypeError('bad shape', { cause: new RangeError('too deep') }));
  if (!(typeError instanceof TypeError)) fail(`Error decoded as ${typeError?.constructor?.name}`);
  if (!(typeError.cause instanceof RangeError)) fail('Error cause lost its class');
  if (typeError.message !== 'bad shape') fail(`Error message: ${typeError.message}`);

  const aggregate = roundTrip(new AggregateError([new TypeError('a')], 'several failed'));
  if (!(aggregate instanceof AggregateError)) fail('AggregateError lost its class');
  if (aggregate.errors.length !== 1) fail(`AggregateError members: ${aggregate.errors.length}`);

  // The remaining tagged types.
  if (!(roundTrip(new Date(0)) instanceof Date)) fail('Date lost its class');
  if (!(roundTrip(/ab+/gi) instanceof RegExp)) fail('RegExp lost its class');
  if (roundTrip(/ab+/gi).flags !== 'gi') fail('RegExp lost its flags');
  if (!(roundTrip(new URL('https://example.test/p')) instanceof URL)) fail('URL lost its class');
  if (roundTrip(2n ** 70n) !== 2n ** 70n) fail('bigint lost precision');
  if (!Object.is(roundTrip(-0), -0)) fail('-0 lost its sign');
  if (!Number.isNaN(roundTrip(NaN))) fail('NaN lost');

  // Both codecs must still refuse the same things on the built bundle.
  for (const [what, value] of [['a Promise', Promise.resolve(1)], ['a WeakMap', new WeakMap()]]) {
    let cborThrew = false;
    let jsonThrew = false;
    try { cbor.toBinary(value); } catch { cborThrew = true; }
    try { json.toBinary(value); } catch { jsonThrew = true; }
    if (!cborThrew) fail(`CBOR silently encoded ${what}`);
    if (!jsonThrew) fail(`JSON silently encoded ${what}`);
  }
}
