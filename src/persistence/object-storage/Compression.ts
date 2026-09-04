import { match } from 'ts-pattern';
import { Lazy } from '../../util/Lazy.js';

/**
 * Per-body compression.  Three modes:
 *   - `none` — store raw bytes.  Right choice for already-compressed payloads
 *     or very small ones where overhead beats savings.
 *   - `gzip` — `node:zlib` everywhere (Bun, Node, Deno).  No extra deps.
 *     Optional level 0–9 (default 6).
 *   - `zstd` — preferred for large state blobs.  Optional level 1–22
 *     (default 3).
 *
 * Runtime support differs by DIRECTION:
 *   - COMPRESS (write): native only — Bun (`Bun.zstdCompressSync`) then
 *     Node (`zlib.zstdCompressSync`; every supported Node ships it).  The
 *     order is free here: neither takes an output bound, and only reads
 *     need one.  There is NO pure-JS
 *     fallback for writing: `fzstd` is decompress-only (it exposes no
 *     `compress`).  Selecting `zstd` on a runtime without native support
 *     throws a clear error — eagerly at plugin-init via
 *     `probeCompressionAvailability`, not cryptically on first write.
 *   - DECOMPRESS (read): `node:zlib` first — it is the only implementation
 *     that takes an allocation-time output bound (#580) — then Bun's
 *     global, then the optional `fzstd` peer-dep so a non-native runtime
 *     can still READ zstd bodies written elsewhere.  `fzstd` caps the
 *     back-reference window at 2^25 (32 MB) and may reject ultra-level
 *     (≥20) frames.
 *
 * Both resolvers pick by CALLING a candidate, never by testing that the
 * symbol exists — see {@link decodesZstdCanary}.
 *
 * The level is an encoder-only setting — it never travels on the wire and
 * decompression doesn't need it, so changing it requires no migration.
 */

export type CompressionAlgo = 'none' | 'gzip' | 'zstd';

export interface Compressor {
  /** `level` is algorithm-specific and clamped; `undefined` → impl default.  Ignored by `none`. */
  compress(input: Uint8Array, level?: number): Promise<Uint8Array>;
  /**
   * Decompress `input`.  `maxOutputBytes`, when set and finite, bounds the
   * decompressed size to defeat a decompression bomb (security audit #3).
   *
   * gzip and zstd both enforce it at ALLOCATION time via zlib's
   * `maxOutputLength`, so the bomb never gets the memory it was built to
   * claim; a post-decode assertion backs that up for the paths that cannot
   * express a bound (Bun's zstd global, `fzstd`) and for a zlib that
   * ignores the option.  Either way exceeding the cap throws with the same
   * `maxOutputBytes=…` wording — see {@link decompressWithinCap}.
   *
   * The bound is on the OUTPUT buffer, not on the decoder's internal
   * window: a frame declaring a large back-reference window can still cost
   * that window's worth of memory even when the cap trips on the first
   * block.  That residue is bounded by the window the frame header
   * declares and is not amplified by the frame's declared content size —
   * which is the unbounded quantity a decompression bomb is built around.
   */
  decompress(input: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array>;
}

/* ------------------------------- gzip ----------------------------------- */

const gzipLazy: Lazy<Promise<{
  gzip: (input: Uint8Array, level?: number) => Promise<Uint8Array>;
  gunzip: (input: Uint8Array, maxOutputBytes?: number) => Promise<Uint8Array>;
}>> = Lazy.of(async () => {
  const name = 'node:zlib';
  const zlib = (await import(name)) as {
    gzipSync(input: Uint8Array, opts?: { level?: number }): Uint8Array;
    gunzipSync(input: Uint8Array, opts?: { maxOutputLength?: number }): Uint8Array;
  };
  return {
    gzip: async (input: Uint8Array, level?: number): Promise<Uint8Array> =>
      zlib.gzipSync(input, level !== undefined ? { level: clampGzipLevel(level) } : undefined),
    // `maxOutputLength` makes zlib abort (RangeError) BEFORE allocating past
    // the cap — real protection against a gzip bomb, not just a post-check.
    gunzip: async (input: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array> =>
      zlib.gunzipSync(input, capApplies(maxOutputBytes) ? { maxOutputLength: maxOutputBytes } : undefined),
  };
});

const gzipCompressor: Compressor = {
  async compress(input, level) { return (await gzipLazy.get()).gzip(input, level); },
  async decompress(input, maxOutputBytes) {
    // `maxOutputLength` already aborts allocation; the post-decode assertion
    // inside `decompressWithinCap` is a portable backstop in case a
    // runtime's zlib ignores the option (#3).
    return decompressWithinCap('gzip', maxOutputBytes, async () =>
      (await gzipLazy.get()).gunzip(input, maxOutputBytes));
  },
};

/* ------------------------------- zstd ----------------------------------- */

type ZstdCompressFunction = (input: Uint8Array, level?: number) => Promise<Uint8Array>;
/**
 * `maxOutputBytes` is an ALLOCATION-time bound, honoured by the resolved
 * implementation when it can express one (`node:zlib`'s `maxOutputLength`)
 * and ignored by the ones that cannot (Bun's global takes no options at
 * all, `fzstd` decodes into a buffer it sizes itself).  A caller must
 * therefore still check the returned length — `decompressWithinCap` does.
 */
type ZstdDecompressFunction = (input: Uint8Array, maxOutputBytes?: number) => Promise<Uint8Array>;

/**
 * A 17-byte zstd frame whose single raw block holds the 8 ASCII bytes
 * `ATS1zstd`.  Both native encoders produce these exact bytes for that
 * input, and it is the smallest frame that exercises a real decode.
 *
 * It exists because "is the symbol there?" and "does it work?" are
 * different questions on some runtimes: Deno's `node:zlib` exports a
 * `zstdDecompressSync` whose native binding is absent, so a presence check
 * accepts it and every zstd read then dies on
 * `binding.ZstdDecompress is not a constructor` — with the documented
 * `fzstd` fallback sitting unreachable underneath.  Resolution therefore
 * CALLS each candidate against this frame.  The cost is one 17-byte decode
 * per process, memoised by `Lazy` along with the implementation it picked.
 */
const ZSTD_CANARY_FRAME = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x08, 0x41, 0x00, 0x00,
  0x41, 0x54, 0x53, 0x31, 0x7a, 0x73, 0x74, 0x64,
]);

/** The 8 bytes {@link ZSTD_CANARY_FRAME} decodes to — its raw block, verbatim (copied, not aliased). */
const ZSTD_CANARY_PLAINTEXT = ZSTD_CANARY_FRAME.slice(9);

/** zstd's frame magic — the first four bytes of any frame, {@link ZSTD_CANARY_FRAME} included. */
const ZSTD_MAGIC = ZSTD_CANARY_FRAME.slice(0, 4);

/** True when `decode` really decodes — see {@link ZSTD_CANARY_FRAME} for why this is a call. */
function decodesZstdCanary(decode: (input: Uint8Array) => Uint8Array): boolean {
  try {
    return bytesEqual(decode(ZSTD_CANARY_FRAME), ZSTD_CANARY_PLAINTEXT);
  } catch {
    return false;
  }
}

/**
 * True when `decode` ABORTS on a `maxOutputLength` below the frame's output
 * size — the property that makes an implementation bomb-safe (#580) rather
 * than merely correct.  Accepting the option is not evidence of enforcing
 * it: one that quietly ignored it would decode the canary perfectly and
 * still hand a bomb all the memory it asked for.
 */
function enforcesZstdOutputCap(
  decode: (input: Uint8Array, options: { maxOutputLength: number }) => Uint8Array,
): boolean {
  try {
    decode(ZSTD_CANARY_FRAME, { maxOutputLength: 1 });
    return false;
  } catch {
    return true;
  }
}

/** True when `encode` produces a real zstd frame rather than throwing — the compress-side canary. */
function encodesZstdCanary(encode: (input: Uint8Array) => Uint8Array): boolean {
  try {
    return bytesEqual(encode(ZSTD_CANARY_PLAINTEXT).subarray(0, ZSTD_MAGIC.length), ZSTD_MAGIC);
  } catch {
    return false;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && right.every((byte, index) => left[index] === byte);
}

/**
 * zstd COMPRESS resolution — native only.  Bun (`Bun.zstdCompressSync`)
 * then Node (`zlib.zstdCompressSync`).  Deliberately NO `fzstd`
 * fallback: fzstd is decompress-only (exposes no `compress`), so a
 * runtime without native zstd cannot WRITE zstd — we throw a clear error
 * here instead of the cryptic `fzstd.compress is not a function` the
 * combined resolver used to produce on first write.
 *
 * Each candidate is accepted only once it has ENCODED the canary, for the
 * same reason the decompress side does (#321's guarantee — a clear error,
 * never a cryptic native one — otherwise regresses on Deno, whose
 * `zlib.zstdCompressSync` is present and throws
 * `binding.ZstdCompress is not a constructor` on first use, downstream of
 * the `probeCompressionAvailability` call that exists to catch exactly
 * this at plugin-init).
 *
 * Level spelling differs by runtime — Bun takes `{ level }`, Node takes
 * `{ params: { [ZSTD_c_compressionLevel]: N } }` — but the 1..22 scale
 * (default 3) is the same.
 */
const zstdCompressLazy: Lazy<Promise<ZstdCompressFunction>> = Lazy.of<Promise<ZstdCompressFunction>>(async () => {
  const bun = (globalThis as { Bun?: {
    zstdCompressSync?: (input: Uint8Array, opts?: { level?: number }) => Uint8Array;
  } }).Bun;
  const bunCompress = bun?.zstdCompressSync;
  if (bunCompress && encodesZstdCanary((i) => bunCompress(i))) {
    return async (i: Uint8Array, level?: number): Promise<Uint8Array> =>
      bunCompress(i, level !== undefined ? { level: clampZstdLevel(level) } : undefined);
  }

  try {
    const zlibName = 'node:zlib';
    const zlib = (await import(zlibName)) as {
      zstdCompressSync?: (input: Uint8Array, opts?: { params?: Record<number, number> }) => Uint8Array;
      constants?: { ZSTD_c_compressionLevel?: number };
    };
    const compressFunction = zlib.zstdCompressSync;
    if (compressFunction && encodesZstdCanary((i) => compressFunction(i))) {
      const levelParam = zlib.constants?.ZSTD_c_compressionLevel;
      return async (i: Uint8Array, level?: number): Promise<Uint8Array> =>
        level !== undefined && levelParam !== undefined
          ? compressFunction(i, { params: { [levelParam]: clampZstdLevel(level) } })
          : compressFunction(i);
    }
  } catch { /* node:zlib unavailable — fall through to the error */ }

  throw new Error(
    'zstd compression requires native runtime support — Bun (zstdCompressSync) '
    + 'or Node (zlib.zstdCompressSync).  The optional `fzstd` peer '
    + 'dependency can only DECOMPRESS, so it cannot write zstd bodies.  '
    + "Either run on a native-zstd runtime, or use compression: { algorithm: "
    + "'gzip' } which works everywhere.",
  );
});

/**
 * The two NATIVE zstd decoders the read path probes before falling through to
 * `fzstd`, each `undefined` on a runtime that does not carry it.  Reading both
 * through one value is what gives the fallback arm a seam — see
 * {@link setNativeZstdDecompressCandidatesOverride}.
 */
type NativeZstdDecompressCandidates = {
  /**
   * `zlib.zstdDecompressSync`.  The only candidate that takes an
   * allocation-time bound, which is why it is probed first (#580).
   */
  readonly nodeZlib?: (input: Uint8Array, options?: { maxOutputLength?: number }) => Uint8Array;
  /** `Bun.zstdDecompressSync`.  Takes no options, so it can carry no bound. */
  readonly bunGlobal?: (input: Uint8Array) => Uint8Array;
};

let nativeZstdDecompressCandidatesOverride: NativeZstdDecompressCandidates | null = null;

/**
 * @internal Test-only seam: force what the zstd read resolver sees as this
 * runtime's native decoders, or `null` to restore real detection.  Pass `{}`
 * to model a runtime with no native zstd at all.
 *
 * That is the only way to reach the `fzstd` arm below from a test, and the arm
 * needs reaching: it is the ONLY zstd read path on a runtime without native
 * zstd, which AGENTS.md lists as supported, yet on both Bun and Node
 * `node:zlib` decodes the canary and enforces the bound, so resolution returns
 * two tiers above it.  A `return` added higher up, or a reordering, would
 * therefore break zstd object-storage reads on such a runtime with `bun test`,
 * the smoke matrix and the coverage badge all green (#780).
 *
 * The seam SUPPRESSES candidates and never supplies a decoder of its own — the
 * `fzstd` arm still imports the real package — so a test drives the production
 * path rather than a rehearsal of it.
 *
 * Deliberately not re-exported from any barrel, exactly like
 * `setRuntimeOverride`: it is an internal seam, and suppressing `node:zlib` in
 * production would give up the allocation-time bound that preferring it exists
 * to buy.  {@link resetCompressionCache} clears it, and the memoised
 * resolution has to be dropped along with it for either to take effect.
 */
export function setNativeZstdDecompressCandidatesOverride(
  candidates: NativeZstdDecompressCandidates | null,
): void {
  nativeZstdDecompressCandidatesOverride = candidates;
}

/** Read both native candidates out of the runtime — or out of the test override. */
async function loadNativeZstdDecompressCandidates(): Promise<NativeZstdDecompressCandidates> {
  if (nativeZstdDecompressCandidatesOverride !== null) return nativeZstdDecompressCandidatesOverride;
  let nodeZlib: NativeZstdDecompressCandidates['nodeZlib'];
  try {
    const zlibName = 'node:zlib';
    const zlib = (await import(zlibName)) as {
      zstdDecompressSync?: (input: Uint8Array, options?: { maxOutputLength?: number }) => Uint8Array;
    };
    nodeZlib = zlib.zstdDecompressSync;
  } catch { /* node:zlib unavailable — leave it unset and let Bun's global answer */ }
  const bun = (globalThis as { Bun?: {
    zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
  } }).Bun;
  return { nodeZlib, bunGlobal: bun?.zstdDecompressSync };
}

/**
 * zstd DECOMPRESS resolution — `node:zlib` first, then Bun's global, then
 * the pure-JS `fzstd` peer-dep so a runtime without native zstd can still
 * READ zstd bodies written elsewhere.  Note fzstd caps the back-reference
 * window at 2^25 (32 MB) and may fail on ultra-level (≥20) frames — see
 * `CompressionConfig.level`.
 *
 * **`node:zlib` outranks Bun's own global on Bun, and that ordering is the
 * security control (#580).**  `Bun.zstdDecompressSync` takes no options at
 * all: it materialises the frame's full output and returns it, so a cap
 * checked afterwards is a post-mortem, not a defence.  Measured on Bun
 * 1.3.1 against a 9,619-byte frame declaring 300 MB of output — the Bun
 * global returned all 314,572,800 bytes for a 317 MB resident-set growth,
 * while `zlib.zstdDecompressSync(frame, { maxOutputLength: 1024 })` threw
 * `ERR_BUFFER_TOO_LARGE` and grew the resident set by 0 MB.  Bun's
 * `node:zlib` shim honours the bound exactly as Node's does, so preferring
 * it costs nothing and closes the hole on both native runtimes.
 *
 * A candidate has to prove BOTH properties by being called — that it
 * decodes at all ({@link decodesZstdCanary}) and that it enforces the
 * bound ({@link enforcesZstdOutputCap}).  One that decodes but ignores the
 * bound is not rejected outright, it just loses its priority: falling
 * through to an equally uncapped implementation would trade a working
 * decoder for nothing.
 */
const zstdDecompressLazy: Lazy<Promise<ZstdDecompressFunction>> = Lazy.of<Promise<ZstdDecompressFunction>>(async () => {
  const candidates = await loadNativeZstdDecompressCandidates();
  let uncappedFallback: ZstdDecompressFunction | undefined;

  const nodeZlibDecompress = candidates.nodeZlib;
  if (nodeZlibDecompress && decodesZstdCanary((i) => nodeZlibDecompress(i))) {
    const capped = async (i: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array> =>
      nodeZlibDecompress(i, capApplies(maxOutputBytes) ? { maxOutputLength: maxOutputBytes } : undefined);
    if (enforcesZstdOutputCap(nodeZlibDecompress)) return capped;
    uncappedFallback = capped;
  }

  const bunDecompress = candidates.bunGlobal;
  if (bunDecompress && decodesZstdCanary(bunDecompress)) {
    // No options parameter to pass a bound through, so `maxOutputBytes` is
    // dropped here and only the post-decode assertion remains.
    uncappedFallback ??= async (i: Uint8Array): Promise<Uint8Array> => bunDecompress(i);
  }
  if (uncappedFallback) return uncappedFallback;

  try {
    const fzstdName = 'fzstd';
    const fzstd = (await import(fzstdName)) as {
      decompress: (input: Uint8Array) => Uint8Array;
    };
    // Not canary-checked: fzstd is pure JS with no native binding to be
    // missing, so a successful import already answers "does it work?".  It
    // sizes its own output buffer and takes no bound, so this branch too
    // rests on the post-decode assertion.
    //
    // That shortcut is an assumption about the PACKAGE, not about this code,
    // and it is checked directly now that fzstd is a devDependency (#676 —
    // it had none before, so nothing here was ever installed):
    // `tests/unit/ci/OptionalPeerModuleShapes.test.ts` decodes both the
    // canary frame above and a frame this file's own compress path wrote,
    // which is the interoperability the fallback actually promises.
    //
    // Reaching this BRANCH was the separate problem, and the seam it needed is
    // `setNativeZstdDecompressCandidatesOverride`: on Bun and Node `node:zlib`
    // wins the canary, so nothing but suppressing the native candidates gets
    // the resolver down here.  `ZstdDecompressResolution.test.ts` does that and
    // reads a natively-written frame back through the real package (#780).
    return async (i: Uint8Array): Promise<Uint8Array> => fzstd.decompress(i);
  } catch (e) {
    throw new Error(
      'No zstd decompressor available.  Either run on Bun / Node, '
      + 'or install the `fzstd` peer dependency: '
      + '`npm install fzstd`.\nOriginal error: '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
});

const zstdCompressor: Compressor = {
  async compress(input, level) { return (await zstdCompressLazy.get())(input, level); },
  async decompress(input, maxOutputBytes) {
    // The bound goes INTO the decoder now, so an over-cap frame is refused
    // before its output is allocated rather than measured afterwards
    // (#580).  `decompressWithinCap` keeps the post-decode assertion for
    // the implementations that cannot take it.
    return decompressWithinCap('zstd', maxOutputBytes, async () =>
      (await zstdDecompressLazy.get())(input, maxOutputBytes));
  },
};

/* ------------------------------- public --------------------------------- */

/** A cap binds only when it is set and finite — `Infinity` is the documented opt-out. */
function capApplies(maxOutputBytes: number | undefined): maxOutputBytes is number {
  return maxOutputBytes !== undefined && Number.isFinite(maxOutputBytes);
}

/** Throw when a decoded size exceeds a finite `maxOutputBytes` cap (#3). */
function assertWithinCap(size: number, maxOutputBytes: number | undefined, algorithm: string): void {
  if (capApplies(maxOutputBytes) && size > maxOutputBytes) {
    throw new Error(`${algorithm} decompression exceeded maxOutputBytes=${maxOutputBytes} (got ${size})`);
  }
}

/**
 * Run `decode` under the `maxOutputBytes` cap and report a violation the
 * same way no matter which of the two mechanisms caught it.
 *
 * zlib aborts an over-cap decode with `RangeError [ERR_BUFFER_TOO_LARGE]`,
 * whose message names a byte count and nothing else — not the algorithm,
 * not that a cap the operator configured is what stopped the read.  That
 * wording travels: `ObjectStorageSnapshotStore` surfaces a decode failure
 * as-is and `ObjectStorageDurableStateStore` wraps it in a `JournalError`
 * whose own message says "integrity / decode failure", so the inner text is
 * the only thing that tells an operator to look at `maxDecompressedBytes`.
 * Translating here keeps ONE wording across all three algorithms and both
 * mechanisms, which is also what lets a test tell them apart: an
 * allocation-time abort and a post-decode assertion differ in the tail of
 * the message, never in whether they throw.
 */
async function decompressWithinCap(
  algorithm: string,
  maxOutputBytes: number | undefined,
  decode: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  let out: Uint8Array;
  try {
    out = await decode();
  } catch (e) {
    // Only when a cap was actually passed down: with no cap, zlib's own
    // ceiling is `buffer.kMaxLength`, and hitting THAT is a genuine
    // "too big for a Buffer" that must not be relabelled as a cap hit.
    if (capApplies(maxOutputBytes) && (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `${algorithm} decompression exceeded maxOutputBytes=${maxOutputBytes} `
        + '(aborted before the output was allocated)',
      );
    }
    throw e;
  }
  assertWithinCap(out.length, maxOutputBytes, algorithm);
  return out;
}

const noneCompressor: Compressor = {
  async compress(input) { return input; },
  async decompress(input, maxOutputBytes) {
    assertWithinCap(input.length, maxOutputBytes, 'stored');
    return input;
  },
};

/** Get a `Compressor` for the requested algorithm.  Cached per-algorithm. */
export function compressorFor(algorithm: CompressionAlgo): Compressor {
  // Exhaustive — adding a new CompressionAlgo variant forces this site.
  return match(algorithm)
    .with('none', () => noneCompressor)
    .with('gzip', () => gzipCompressor)
    .with('zstd', () => zstdCompressor)
    .exhaustive();
}

/**
 * Probe whether the runtime / peer-dep needed by `algo` is loadable.
 * Resolves on success, throws with a clear "install X" message on
 * failure.  Idempotent — under the hood this just kicks the same lazy
 * `compressorFor()` would use, so the result is cached.
 *
 * Used by `registerObjectStoragePlugins` to surface peer-dep failures
 * at plugin-init time rather than on the first persist call (#18, #59).
 */
export async function probeCompressionAvailability(algorithm: CompressionAlgo): Promise<void> {
  await match(algorithm)
    .with('none', async () => undefined)
    .with('gzip', async () => { await gzipLazy.get(); })
    // Probe the COMPRESS path: configuring `zstd` expresses write intent,
    // and compress is the strictly stronger capability (a runtime that can
    // compress can always decompress; an fzstd-only runtime can decompress
    // but NOT write).  Probing compress surfaces "selected zstd but can't
    // write it here" eagerly at plugin-init rather than on first persist.
    .with('zstd', async () => { await zstdCompressLazy.get(); })
    .exhaustive();
}

/**
 * Test hook — clear cached lazy implementations.
 *
 * Also drops any {@link setNativeZstdDecompressCandidatesOverride}, mirroring
 * `Lazy.reset()`, which clears its own override for the same reason: bun runs
 * every test file in one process, so a suppressed `node:zlib` left behind here
 * would silently move an unrelated suite onto the pure-JS read path.
 */
export function resetCompressionCache(): void {
  gzipLazy.reset();
  zstdCompressLazy.reset();
  zstdDecompressLazy.reset();
  nativeZstdDecompressCandidatesOverride = null;
}

/* ------------------------------- levels --------------------------------- */

/** Clamp a gzip level into zlib's valid 0–9 range; non-finite → default 6. */
function clampGzipLevel(level: number): number {
  if (!Number.isFinite(level)) return 6;
  return Math.max(0, Math.min(9, Math.trunc(level)));
}

/**
 * Clamp a zstd level into the portable 1–22 range; non-finite → default 3.
 * (Node also accepts negative "fast" levels, but Bun's floor is 1 — we
 * pin the public range to the intersection so a config is portable across
 * runtimes.)
 */
function clampZstdLevel(level: number): number {
  if (!Number.isFinite(level)) return 3;
  return Math.max(1, Math.min(22, Math.trunc(level)));
}
