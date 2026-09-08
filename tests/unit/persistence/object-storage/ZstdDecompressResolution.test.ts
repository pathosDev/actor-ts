import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ZstdErrorCode, decompress as fzstdDecompress } from 'fzstd';
import * as nodeZlibModule from 'node:zlib';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  compressorFor,
  resetCompressionCache,
  setNativeZstdDecompressCandidatesOverride,
  zstdDecompressorRung,
} from '../../../../src/persistence/object-storage/Compression.js';

/**
 * The zstd READ ladder in `Compression.ts`: `node:zlib`, then `Bun`'s global,
 * then the pure-JS `fzstd` peer — and only the first rung ever ran (#780).
 *
 * Nothing here is about whether `fzstd` works; `tests/unit/ci/
 * OptionalPeerModuleShapes.test.ts` settled that against the real package when
 * #676 gave it a devDependency. What that could not reach is the BRANCH — and,
 * once reached, what the branch's body actually IS, which the last block below
 * is about. A candidate is accepted by being *called* against the resolver's
 * canary frame, and on both Bun and Node `node:zlib` decodes it
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
 * *native* candidates; the `fzstd` rung still imports the real package, so every
 * test that suppresses both natives runs the production fallback rather than a
 * rehearsal of it.
 *
 * The fakes for the native rungs decode through `fzstd` too, deliberately: a
 * hand-rolled decoder would have to special-case the 17-byte canary to be
 * accepted at all, which duplicates a constant from the file under test and
 * makes the fake pass the probe by construction rather than by decoding. These
 * are real decoders that differ from each other only in whether they abort on a
 * bound — which is not a ranking the resolver makes, but IS the one observable
 * that names the rung which served a capped read (#580) — and in the label they
 * append to `decodeLog`, which is how each test reads off which rung actually
 * served the call.
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
   * the property that separates `node:zlib` from every other implementation.
   * The resolver does not rank on it (nothing below `node:zlib` can take the
   * option, so a ranking would have nothing to promote); it is modelled here
   * because it is the observable that names which rung served a capped read.
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

/** Run `attempt` and hand back the error it threw, or `undefined` when it succeeded. */
async function failureOf(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt();
    return undefined;
  } catch (e) {
    return e;
  }
}

/** The `code` a native `node:zlib` decode of `frame` failed with, or `undefined` when it did not fail. */
function nativeFailureCode(frame: Uint8Array): unknown {
  try {
    zstdDecompressSync(frame);
    return undefined;
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
}

/**
 * The real `node:zlib`, snapshotted at load before anything replaces it.
 *
 * Kept as a plain object rather than the live namespace on purpose: once
 * `mock.module('node:zlib', …)` has run, what an import of that specifier
 * yields is the replacement, so a restore that re-read the namespace would
 * reinstall the suppression it is undoing.
 */
const REAL_NODE_ZLIB = { ...nodeZlibModule };

/**
 * Start every test from a known resolution, not from whatever the previous one
 * left — and "the previous one" includes the previous *file*.
 *
 * `Compression.ts` memoises the resolved zstd decoder at module scope, and bun
 * runs the whole tree in one process, so a suite that decompressed anything
 * before this file leaves that memo warm and pointing at the native rung.  The
 * cleanup below then runs too late to help the first test here: it fires after
 * it.  In the default order the first test happened not to care; under
 * `bun test --randomize` the case that needs the native rungs suppressed can be
 * first, and it resolves against the inherited memo instead of its own override
 * (#1422).
 */
beforeEach(() => {
  setNativeZstdDecompressCandidatesOverride(null);
  resetCompressionCache();
});

afterEach(() => {
  // Either call clears the override; both are here so this stays correct if
  // `resetCompressionCache` ever stops doing it. bun runs every test file in
  // one process, and a leaked suppression would quietly move unrelated suites
  // onto the pure-JS read path.
  setNativeZstdDecompressCandidatesOverride(null);
  // The last block replaces `node:zlib` itself, which is process-wide and
  // worse than the override: an unrestored module mock takes zstd away from
  // every suite that runs after this file.
  //
  // `mock.restore()` does NOT undo `mock.module()` — this file used to say it
  // did, in a comment, and nothing checked.  It does not fail in the default
  // order because the suppressing block happens to run after everything that
  // would notice; `bun test --randomize` is red on every seed, and three cases
  // in `tests/unit/persistence/DecompressCap.test.ts` then assert the native
  // "aborted before the output was allocated" cap while actually exercising the
  // fzstd rung, which allocates first and checks afterwards (#1422).
  //
  // So the restore is an explicit re-install of the snapshot above, and
  // `mock.restore()` stays for the function mocks it does cover.
  mock.module('node:zlib', () => REAL_NODE_ZLIB);
  mock.restore();
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

    // The same fact stated where another suite can read it. `decodeLog` below
    // observes the rung only through an injected fake, and the message tails
    // above observe it only through a property this file is trying to
    // establish; a suite that merely CONSUMES the ladder has neither, which is
    // how three cap tests came to assert the allocation-time bound while
    // running on a rung that has none (#1422).
    expect(await zstdDecompressorRung()).toBe('fzstd');
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

  test('a runtime global that throws is skipped too, and fzstd catches that fall as well', async () => {
    // The second rung's canary probe, which nothing above reaches: the tests
    // that put a decoder in `bunGlobal` all supply a working one, so dropping
    // `decodesZstdCanary` there for a presence check leaves every one of them
    // green. Deno is the runtime this models on the *upper* rung; a Bun whose
    // global was present but broken is the same failure one rung down, and the
    // resolver's promise is that a candidate is accepted by being CALLED.
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({
      bunGlobal: () => { throw new TypeError('binding.ZstdDecompress is not a constructor'); },
    });

    expect(await compressorFor('zstd').decompress(frame)).toEqual(PAYLOAD);
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });

  test('resetCompressionCache drops the override, not just the memoised resolution', async () => {
    // `resetCompressionCache` clears the override as well as the lazies, and
    // nothing above notices if it stops: this file's own `afterEach` also calls
    // `setNativeZstdDecompressCandidatesOverride(null)` explicitly, so a
    // suppression that outlived the reset would leak into other FILES rather
    // than fail here. This test is the one place the reset stands alone.
    const decodeLog: string[] = [];
    const frame = await nativeZstdFrame();
    setNativeZstdDecompressCandidatesOverride({
      nodeZlib: fakeNativeDecoder(decodeLog, { label: 'node:zlib', enforcesCap: false }),
    });
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
    const callsBeforeReset = decodeLog.length;
    expect(callsBeforeReset).toBeGreaterThan(0);

    resetCompressionCache();

    // Real detection is back, so the read is served by a decoder that takes the
    // bound — two independent readings of that: the wording flips to the
    // allocation-time one, and the fake is never called again.
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(ABORTED_BEFORE_ALLOCATION);
    expect(
      decodeLog.length,
      'the substituted decoder ran again, so the override outlived resetCompressionCache',
    ).toBe(callsBeforeReset);
  });
});

/**
 * The block above proves the fzstd rung is REACHED, and in the right place.  It
 * cannot tell what the rung's body IS: replacing `fzstd.decompress(i)` with a
 * plain unbounded `zstdDecompressSync(i)` — the real package still imported,
 * still unused — leaves every one of those tests green, because both decode a
 * well-formed frame to the same bytes and neither takes a bound.  A refactor
 * that quietly swapped the body would keep every gate in this repository green
 * while removing the only zstd read path a runtime without native zstd has.
 *
 * So these two tests ask a question only the real package answers.  Both
 * discriminators are properties of the IMPLEMENTATIONS rather than of the
 * fixtures — the same bytes go to whichever decoder the rung holds, and the
 * answers differ:
 *
 *   - fzstd walks past the frame's optional 4-byte content checksum without
 *     ever hashing what it decoded (`bt = st.b + st.c * 4`), so a frame whose
 *     checksum is wrong decodes cleanly.  Both native decoders verify it and
 *     refuse — measured on Bun 1.4 and Node 24, `ZSTD_error_checksum_wrong`
 *     from `node:zlib` and `ERR_ZSTD` from `Bun.zstdDecompressSync`.
 *   - fzstd reports a truncated frame in its own error vocabulary, the
 *     `ZstdErrorCode` enum it exports.  No native decoder can produce one:
 *     measured on the same runtimes, Bun's `node:zlib` returns zero bytes for
 *     those bytes, Node's throws `Z_BUF_ERROR`, and Bun's global throws
 *     `ERR_ZSTD`.
 */
describe('zstd read resolution — the fzstd rung is the real peer, not just the right position (#780)', () => {
  test('the fzstd rung decodes a frame whose content checksum is wrong — no native decoder does', async () => {
    // `Compression.ts`'s own compress path never sets the checksum flag, so the
    // fixture goes around it to `node:zlib`.  That is the honest shape anyway:
    // fzstd cannot write, so every frame this rung reads was written by some
    // other zstd, and a checksummed frame is one of the things another zstd
    // writes.
    const plainFrame = zstdCompressSync(PAYLOAD);
    const checksummedFrame = zstdCompressSync(PAYLOAD, {
      params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
    });
    expect(
      checksummedFrame.length - plainFrame.length,
      'the fixture discriminates only while the encoder really appends a checksum',
    ).toBe(4);

    const corruptedFrame = Uint8Array.from(checksummedFrame);
    corruptedFrame[corruptedFrame.length - 1] ^= 0xff;
    expect(
      () => zstdDecompressSync(corruptedFrame),
      'a native decoder accepted a wrong content checksum, so these bytes discriminate nothing',
    ).toThrow();

    setNativeZstdDecompressCandidatesOverride({});
    expect(
      await compressorFor('zstd').decompress(corruptedFrame),
      'the rung refused a frame fzstd accepts, so its body is not fzstd',
    ).toEqual(PAYLOAD);
  });

  test('a truncated frame comes back through the fzstd rung in fzstd\'s own error vocabulary', async () => {
    const frame = await nativeZstdFrame();
    const truncatedFrame = frame.subarray(0, frame.length - 3);
    expect(
      nativeFailureCode(truncatedFrame),
      "a native decoder produced fzstd's own error code, so the code identifies nothing",
    ).not.toBe(ZstdErrorCode.UnexpectedEOF);

    setNativeZstdDecompressCandidatesOverride({});
    const failure = await failureOf(() => compressorFor('zstd').decompress(truncatedFrame));
    expect(failure).toBeInstanceOf(Error);
    expect(
      (failure as { code?: unknown }).code,
      'the rung reported in some other decoder\'s vocabulary, so its body is not fzstd',
    ).toBe(ZstdErrorCode.UnexpectedEOF);
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
    expect(await zstdDecompressorRung()).toBe('node-zlib');
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
    expect(await zstdDecompressorRung()).toBe('bun-global');
    // No options parameter to carry a bound, so this rung is a post-mortem too.
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });

  test('a node:zlib that decodes but ignores the bound still serves the read', async () => {
    // This test used to be named for a ranking — "loses its priority, not its
    // place" — that the resolver did not have. A second probe did rank
    // candidates on whether they abort on `maxOutputLength`, but nothing below
    // `node:zlib` can take the option, so it had no capped candidate to promote
    // and never moved a read; deleting it changed no test in the repository,
    // while its early `return` masked the rung order this very block gates
    // (#780). What holds, and is what this now says, is the plain ladder: the
    // first rung that decodes serves the read, capped or not, and an uncapped
    // one is bounded afterwards by `decompressWithinCap` instead.
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

/**
 * The rung-order block above reaches the Bun rung through the override, which
 * means it never exercises the LINE that puts a decoder there:
 * `loadNativeZstdDecompressCandidates` reads `globalThis.Bun.zstdDecompress-
 * Sync`, and the override returns early before it.  Replace that read with
 * `return { nodeZlib }` and every test in this file stays green, because on
 * Bun and on Node `node:zlib` wins the canary and the second rung is never
 * consulted at all.
 *
 * That is not a hypothetical rung.  It is the only zstd read path on a Bun
 * whose `node:zlib` lacks zstd — a configuration
 * `docs/…/persistence/object-storage/compression.mdx` names explicitly — and
 * with the read gone such a runtime falls to the pure-JS `fzstd` peer, which
 * is a peer dependency nothing installs by default.  The failure is "object
 * storage cannot read its own compressed bodies", and it arrives on a runtime
 * upgrade rather than on a code change.
 *
 * So this block suppresses `node:zlib` **without** the override, by replacing
 * the module the resolver imports.  What is left is the real runtime: the
 * candidates function runs, reads the real `Bun` global, and the real global
 * serves the read.  `mock.restore()` in `afterEach` puts `node:zlib` back —
 * an unrestored mock here would take zstd away from every suite that runs
 * after this file.
 *
 * Which rung answered is read off the same two package properties the block
 * above uses, in the opposite direction: a native decoder refuses a wrong
 * content checksum and reports a truncated frame in its own vocabulary, and
 * `fzstd` does neither.  So "Bun's global served it" and "fzstd served it"
 * are told apart by the answer rather than by a label a fake appended.
 */
describe('zstd read resolution — the runtime read behind the Bun rung (#780)', () => {
  /** `node:zlib` with its zstd decoder taken away — a Bun that predates it. */
  const suppressNodeZlibZstd = (): void => {
    mock.module('node:zlib', () => ({
      ...REAL_NODE_ZLIB,
      zstdDecompressSync: () => {
        throw new TypeError('binding.ZstdDecompress is not a constructor');
      },
    }));
    // Resolution is memoised, and the memo may already hold the real one.
    resetCompressionCache();
  };

  test('the Bun global is what this runtime actually offers', () => {
    // The premise of the two tests below, asserted rather than assumed: they
    // would pass vacuously on a runtime with no `Bun` global, because there
    // the fzstd rung is the correct answer and this file already covers it.
    const bun = (globalThis as { Bun?: { zstdDecompressSync?: unknown } }).Bun;
    expect(typeof bun?.zstdDecompressSync).toBe('function');
  });

  test("Bun's own global serves the read when node:zlib has no zstd decoder", async () => {
    const frame = await nativeZstdFrame();
    suppressNodeZlibZstd();

    expect(await compressorFor('zstd').decompress(frame)).toEqual(PAYLOAD);
    // Native, not fzstd: fzstd reports a truncated frame in the
    // `ZstdErrorCode` vocabulary it exports, and no native decoder can.
    const truncated = frame.subarray(0, frame.length - 3);
    const failure = await failureOf(() => compressorFor('zstd').decompress(truncated));
    expect(failure).toBeInstanceOf(Error);
    expect(
      (failure as { code?: unknown }).code,
      'the read fell through to fzstd, so nothing read the Bun global',
    ).not.toBe(ZstdErrorCode.UnexpectedEOF);
    // No options parameter to carry a bound, so this rung is a post-mortem.
    await expect(compressorFor('zstd').decompress(frame, 16))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });

  test('and it verifies the content checksum, which the pure-JS fallback does not', async () => {
    // The second discriminator, and the one that makes the first assertion
    // above about the DECODER rather than about zstd working: fzstd walks past
    // the frame's optional checksum without hashing what it decoded, so these
    // bytes are the difference between the two rungs.
    const checksummedFrame = zstdCompressSync(PAYLOAD, {
      params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
    });
    const corruptedFrame = Uint8Array.from(checksummedFrame);
    corruptedFrame[corruptedFrame.length - 1] ^= 0xff;
    expect(
      fzstdDecompress(corruptedFrame),
      'fzstd refused these bytes, so they no longer separate the two rungs',
    ).toEqual(PAYLOAD);

    suppressNodeZlibZstd();
    await expect(compressorFor('zstd').decompress(corruptedFrame)).rejects.toThrow();
  });
});
