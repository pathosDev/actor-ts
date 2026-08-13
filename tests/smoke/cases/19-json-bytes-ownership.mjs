/**
 * Smoke case: decoded JSON payloads own their bytes (#619).
 *
 * This case exists because `bun test` structurally cannot see the defect it
 * guards.  `Buffer.from(str, 'base64')` decodes into a shared pool and hands
 * back a *view* at an arbitrary offset — in one sample run `byteOffset` 1656
 * of a 65536-byte pool on Node 26.7.0 and 96 of an 8192-byte pool on Deno
 * 2.6.8, at every payload size from 1 byte to 8 KB — while Bun returns an exact
 * allocation.  The obvious regression test is therefore green on the BROKEN
 * code under the project's own unit runner, and only a real Node or Deno run
 * has any binding force.  That is not a hypothetical: the unit suite for this
 * fix has to patch `Buffer.from` to reproduce pooling on Bun at all.
 *
 * What leaks without the copy: `JsonSerializer` is the default for HTTP
 * `entity()` bodies and for every journal / snapshot / durable-state read
 * through `PayloadCodec`, so a decoded `Uint8Array` whose `.buffer` is the
 * pool exposes bytes decoded for OTHER requests to anything that reads
 * `.buffer` rather than the view — a `DataView`, a `TextDecoder`, a
 * user-supplied `Serializer.fromBinary`.  Holding it alive also pins the
 * whole pool.
 */
export const name = 'JSON byte ownership';
export const description = 'decoded __bytes__ / __typedarray__ payloads own an exact, offset-0 buffer';

export async function run({ actorTs, runtime }) {
  const { JsonSerializer } = actorTs;
  const json = new JsonSerializer();
  const fail = (message) => { throw new Error(message); };

  const decode = (value) => json.fromBinary(json.toBinary(value), json.manifest(value));
  const ownsExactBuffer = (view) => view.byteOffset === 0 && view.buffer.byteLength === view.byteLength;
  const describeView = (view) => `byteOffset ${view.byteOffset} of ${view.buffer.byteLength}, byteLength ${view.byteLength}`;

  // Say plainly whether this runtime can even exhibit the hazard, so a green
  // run on Bun is not mistaken for proof about the other two.
  const probe = typeof Buffer === 'undefined' ? undefined : Buffer.from('AQIDBA==', 'base64');
  const pools = probe !== undefined && probe.buffer.byteLength !== probe.byteLength;
  console.log(`  (${runtime}: base64 decodes are ${pools ? 'POOLED' : 'not pooled'} — this case is ${pools ? 'binding' : 'a no-op guard'} here)`);

  // The `__bytes__` tag: the path an HTTP body takes.  A "secret" payload is
  // decoded first so a leak has something recognisable to expose.
  const secret = decode(new TextEncoder().encode('SECRET-SESSION-TOKEN-abcdefghijklmno'));
  const small = decode(new Uint8Array([1, 2, 3, 4]));
  if (!(small instanceof Uint8Array)) fail(`__bytes__ decoded as ${small?.constructor?.name ?? typeof small}`);
  if (small.constructor !== Uint8Array) {
    // A `Buffer` would make `rebuildBinaryView`'s `slice()` a `subarray`.
    fail(`__bytes__ decoded as a ${small.constructor.name}, not a plain Uint8Array`);
  }
  if (!ownsExactBuffer(small)) fail(`__bytes__ still points into the decode pool: ${describeView(small)}`);
  if (small.buffer === secret.buffer) fail('two decoded payloads share one backing buffer');
  const throughBuffer = new TextDecoder().decode(new Uint8Array(small.buffer));
  if (throughBuffer.includes('SECRET')) {
    fail(`another payload's plaintext is readable through .buffer: ${JSON.stringify(throughBuffer.slice(0, 48))}`);
  }
  if (small.join(',') !== '1,2,3,4') fail(`__bytes__ content changed: ${small.join(',')}`);

  // Node pools large decodes too — the issue's "a payload over 4 KB is safe"
  // assumption is wrong, and this is where that would show.
  const large = decode(new Uint8Array(5000).fill(7));
  if (!ownsExactBuffer(large)) fail(`a 5000-byte payload still points into the pool: ${describeView(large)}`);
  if (large.byteLength !== 5000 || large[4999] !== 7) fail('a 5000-byte payload decoded wrong');

  // The `__typedarray__` sibling normalises separately and stays correct only
  // while `fromBase64` returns a plain `Uint8Array`.  `DataView` is the reader
  // that goes through `.buffer` by construction.
  const counts = decode(new Uint16Array([1, 2, 3]));
  if (counts.constructor !== Uint16Array) fail(`Uint16Array decoded as ${counts?.constructor?.name ?? typeof counts}`);
  if (!ownsExactBuffer(counts)) fail(`__typedarray__ still points into the decode pool: ${describeView(counts)}`);
  if (counts.join(',') !== '1,2,3') fail(`Uint16Array content changed: ${counts.join(',')}`);

  const dataView = decode(new DataView(new Uint8Array([0, 1, 0, 2]).buffer));
  if (!(dataView instanceof DataView)) fail(`DataView decoded as ${dataView?.constructor?.name ?? typeof dataView}`);
  if (!ownsExactBuffer(dataView)) fail(`DataView still points into the decode pool: ${describeView(dataView)}`);
  if (dataView.getUint16(0) !== 1 || dataView.getUint16(2) !== 2) fail('DataView content changed');
}
