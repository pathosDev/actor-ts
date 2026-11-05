/**
 * Smoke case: a `__bigint__` decodes from the encoder's own spelling only,
 * and inside `-2^8192 … 2^8192 - 1` only, on every runtime (#967).
 *
 * This case exists because `BigInt()` is runtime-dependent where the decoder
 * used to lean on it.  JavaScriptCore (Bun) returns `0n` for a lone `-` or
 * `+`, while V8 (Node, Deno) throws a SyntaxError, so the same payload
 * decoded on one runtime and was refused on the others.  The decoder now
 * refuses every spelling but `String(value)`'s before anything is parsed, so
 * the assertions below hold on all three; the engine's own verdict is printed
 * rather than asserted, since pinning it would be pinning the engine.
 *
 * Opens no handles on any path: everything here is in-process computation, so
 * there is nothing for a timeout or a throw to leave behind.
 */
export const name = 'bigint spelling and range';
export const description = 'a __bigint__ decodes from the canonical spelling only, within the 8192-bit range';

export async function run({ loadEntry, runtime }) {
  const {
    CborDecoder,
    CborEncodeError,
    CborEncoder,
    decodeJsonTree,
    encodeJsonTree,
    SerializationError,
  } = await loadEntry('serialization');
  const fail = (message) => { throw new Error(message); };

  /** What `fn` threw, or `undefined` if it returned. */
  const thrownBy = (fn) => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return e;
    }
  };

  // Informational: what this engine's own BigInt() makes of a lone sign.
  const engineVerdict = thrownBy(() => BigInt('-'));
  console.log(
    `  (${runtime}: BigInt('-') ${
      engineVerdict === undefined ? `returns ${String(BigInt('-'))}n` : `throws ${engineVerdict.name}`
    })`,
  );

  for (const digits of ['', '-', '+', '+5', '0x1f', ' 5', '5 ', '007', '-0']) {
    const verdict = thrownBy(() => decodeJsonTree({ __bigint__: digits }));
    if (!(verdict instanceof SerializationError)) {
      fail(`__bigint__ ${JSON.stringify(digits)} was not refused: ${verdict === undefined ? 'it decoded' : verdict.name}`);
    }
  }

  const limit = 1n << 8192n;
  for (const value of [0n, -1n, limit - 1n, -limit]) {
    if (decodeJsonTree({ __bigint__: String(value) }) !== value) {
      fail(`a canonical __bigint__ of ${String(value).length} characters did not decode to itself`);
    }
  }

  // Past either end: refused by the decoder and by both encoders, so nothing
  // is written that a decoder would refuse.
  for (const value of [limit, -limit - 1n]) {
    if (!(thrownBy(() => decodeJsonTree({ __bigint__: String(value) })) instanceof SerializationError)) {
      fail('decodeJsonTree accepted an integer past the 8192-bit range');
    }
    if (!(thrownBy(() => encodeJsonTree(value)) instanceof SerializationError)) {
      fail('encodeJsonTree wrote an integer past the 8192-bit range');
    }
    if (!(thrownBy(() => new CborEncoder().encode(value)) instanceof CborEncodeError)) {
      fail('CborEncoder wrote an integer past the 8192-bit range');
    }
  }
  for (const value of [limit - 1n, -limit]) {
    if (new CborDecoder().decode(new CborEncoder().encode(value)) !== value) {
      fail('an end of the range did not survive a CBOR round trip');
    }
  }

  // The digit bound keeps the parse cheap on every engine: four million
  // digits are refused before BigInt() is handed them.
  const digits = '9'.repeat(4_000_000);
  const started = performance.now();
  const longVerdict = thrownBy(() => decodeJsonTree({ __bigint__: digits }));
  const elapsedMs = performance.now() - started;
  if (!(longVerdict instanceof SerializationError)) fail('four million digits were not refused');
  if (elapsedMs > 1_000) fail(`refusing four million digits took ${elapsedMs.toFixed(0)} ms`);
}
