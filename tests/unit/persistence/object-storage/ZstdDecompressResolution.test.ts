import { afterEach, describe, expect, test } from 'bun:test';
import { decompress as fzstdDecompress } from 'fzstd';
import {
  compressorFor,
  resetCompressionCache,
  setNativeZstdDecompressCandidatesOverride,
} from '../../../../src/persistence/object-storage/Compression.js';

/**
 * The zstd READ ladder in `Compression.ts`: `node:zlib`, then `Bun`'s global,
 * then the pure-JS `fzstd` peer — and only the first rung ever ran (#780).
 *
 * Nothing here is about whether `fzstd` works; `tests/unit/ci/
 * OptionalPeerModuleShapes.test.ts` settled that against the real package when
 * #676 gave it a devDependency. What that could not reach is the BRANCH. A
 * candidate is accepted by being *called* against the resolver's canary frame,
 * and on both Bun and Node `node:zlib` decodes it and enforces `maxOutputLength`
 * — so resolution returns two rungs above `fzstd`, and the one zstd read path a
 * runtime without native zstd has is executed by no gate in this repository.
 * That runtime is supported per AGENTS.md, and the failure it hides is silent
 * in the worst way: a `return` added higher up, or the two native rungs swapped,
 * breaks object-storage reads there while `bun test`, the smoke matrix and the
 * coverage badge all stay green.
 *
 * `setNativeZstdDecompressCandidatesOverride` is the seam that closes it,
 * modelled on `setRuntimeOverride` — the internal, barrel-less override the
 * runtime detector already uses. It only ever SUPPRESSES or substitutes the two
 * *native* candidates; the `fzstd` rung still imports the real package, so the
 * first two tests below run the production fallback rather than a rehearsal of
 * it.
 *
 * The fakes for the native rungs decode through `fzstd` too, deliberately: a
 * hand-rolled decoder would have to special-case the 17-byte canary to be
 * accepted at all, which duplicates a constant from the file under test and
 * makes the fake pass the probe by construction rather than by decoding. These
 * are real decoders that differ from each other only in the one property the
 * resolver ranks them on — whether they abort on a bound (#580) — and in the
 * label they append to `decodeLog`, which is how each test reads off which rung
 * actually served the call.
 */

/** 1 792 bytes — comfortably over every cap used below, and highly compressible. */
const PAYLOAD = new TextEncoder().encode('actor-ts zstd read fallback '.repeat(64));

/**
 * The two cap mechanisms, told apart by the TAIL of the message exactly as
 * `tests/unit/persistence/DecompressCap.test.ts` does. That distinction is what
 * makes an over-cap read *evidence* here: only a rung that took the bound into
 * the decoder can abort before allocating, so the wording names the rung that
 * served the call without the test having to trust `decodeLog`.
 */
const ABORTED_BEFORE_ALLOCATION = /maxOutputBytes=\d+ \(aborted before the output was allocated\)/;
const MEASURED_AFTER_DECODING = /maxOutputBytes=\d+ \(got \d+\)/;

type FakeNativeDecoderSpec = {
  /** Appended to `decodeLog` on every successful decode. */
  readonly label: string;
  /**
   * Whether the decoder aborts on a `maxOutputLength` below its output size —
   * the property that separates `node:zlib` from every other implementation,
   * and the one the resolver ranks a candidate on once it decodes at all.
   */
  readonly enforcesCap: boolean;
};

/**
 * A native-rung stand-in that really decodes, so it passes the canary probe the
 * way the implementation it stands for does.
 */
function fakeNativeDecoder(
  decodeLog: string[],
  spec: FakeNativeDecoderSpec,
): (input: Uint8Array, options?: { maxOutputLength?: number }) => Uint8Array {
  return (input, options) => {
    const output = fzstdDecompress(input);
    if (spec.enforcesCap && options?.maxOutputLength !== undefined && output.length > options.maxOutputLength) {
      // zlib's own wording and error code — `decompressWithinCap` keys the
      // "aborted before the output was allocated" translation off the code.
      const error = new RangeError(`${spec.label}: output exceeds maxOutputLength`) as RangeError & { code?: string };
      error.code = 'ERR_BUFFER_TOO_LARGE';
      throw error;
    }
    decodeLog.push(spec.label);
    return output;
  };
}

/**
 * A frame written by the NATIVE compress path, which the override never
 * touches: `fzstd` exposes no `compress`, so a runtime that reads through it
 * can only ever be reading bytes some other runtime wrote. Producing the frame
 * that way is the interoperability claim, not a detail of the fixture.
 */
async function nativeZstdFrame(): Promise<Uint8Array> {
  resetCompressionCache();
  const frame = await compressorFor('zstd').compress(PAYLOAD, 3);
  // Resolution is memoised, so the natively-picked decompressor has to go
  // before an override can be seen.
  resetCompressionCache();
  return frame;
}

afterEach(() => {
  // Either call clears the override; both are here so this stays correct if
  // `resetCompressionCache` ever stops doing it. bun runs every test file in
  // one process, and a leaked suppression would quietly move unrelated suites
  // onto the pure-JS read path.
  setNativeZstdDecompressCandidatesOverride(null);
  resetCompressionCache();
});

/**
 * Every test here pairs "the bytes came back" with the cap wording, and the
 * pairing was forced by a wrong-fix run rather than chosen for symmetry. A seam
 * that silently failed to suppress anything — `loadNativeZstdDecompress-
 * Candidates` ignoring the override — leaves a bare payload assertion GREEN,
 * because the real `node:zlib` decodes the frame perfectly and the test then
 * proves only that zstd works. The wording is the one observable that separates
 * the rung that took the bound into the decoder from the two that could not, so
 * it is what makes these tests about the fzstd rung at all.
 */
describe('zstd read resolution — the fzstd fallback rung (#780)', () => {
  test('a runtime with no native zstd reads a natively-written frame through fzstd, unbounded', async () => {
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({});

    const output = await compressorFor('zstd').decompress(frame);
    expect(
      output,
      'With both native candidates suppressed the fzstd rung is the only one '
      + 'left, so a correct decode here IS that rung executing.',
    ).toEqual(PAYLOAD);

    // `fzstd` sizes its own output buffer and takes no bound, so the post-decode
    // assertion in `decompressWithinCap` is the whole of what stands between an
    // operator's cap and a bomb on this rung. An `(aborted before …)` here would
    // mean a capped native decoder served the call — the suppression did not
    // happen, and the assertion above was never about fzstd.
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });

  test('a native decoder that fails the canary is skipped, and fzstd catches the fall', async () => {
    // Deno's `node:zlib` exports `zstdDecompressSync` with no native binding
    // behind it, which is why resolution calls a candidate instead of testing
    // that the symbol exists. This is that runtime, modelled — and it is a live
    // configuration, not a historical one: measured on Deno 2.6.8, both zstd
    // symbols are present, calling either throws `binding.ZstdDecompress is not
    // a constructor`, and there is no `Bun` global, so the rung this file
    // covers is what actually serves a zstd read there today.
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({
      nodeZlib: () => { throw new TypeError('binding.ZstdDecompress is not a constructor'); },
    });

    expect(await compressorFor('zstd').decompress(frame)).toEqual(PAYLOAD);
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });
});

describe('zstd read resolution — rung order (#580)', () => {
  test('a capped node:zlib outranks both Bun and fzstd', async () => {
    const decodeLog: string[] = [];
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({
      nodeZlib: fakeNativeDecoder(decodeLog, { label: 'node:zlib', enforcesCap: true }),
      bunGlobal: fakeNativeDecoder(decodeLog, { label: 'Bun', enforcesCap: false }),
    });

    expect(await compressorFor('zstd').decompress(frame)).toEqual(PAYLOAD);
    expect(decodeLog.at(-1)).toBe('node:zlib');
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(ABORTED_BEFORE_ALLOCATION);
  });

  test("Bun's global serves the read when node:zlib has no zstd decoder", async () => {
    const decodeLog: string[] = [];
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({
      bunGlobal: fakeNativeDecoder(decodeLog, { label: 'Bun', enforcesCap: false }),
    });

    expect(await compressorFor('zstd').decompress(frame)).toEqual(PAYLOAD);
    expect(decodeLog.at(-1)).toBe('Bun');
    // No options parameter to carry a bound, so this rung is a post-mortem too.
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });

  test('a node:zlib that decodes but ignores the bound loses its priority, not its place', async () => {
    // The documented rule: falling through from an uncapped decoder to an
    // equally uncapped one would trade a working decoder for nothing, so the
    // first one found still serves the read.
    const decodeLog: string[] = [];
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({
      nodeZlib: fakeNativeDecoder(decodeLog, { label: 'node:zlib', enforcesCap: false }),
      bunGlobal: fakeNativeDecoder(decodeLog, { label: 'Bun', enforcesCap: false }),
    });

    expect(await compressorFor('zstd').decompress(frame)).toEqual(PAYLOAD);
    expect(decodeLog.at(-1)).toBe('node:zlib');
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });
});
