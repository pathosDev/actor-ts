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
 *   - COMPRESS (write): native only — Bun (`Bun.zstdCompressSync`) or
 *     Node ≥22.15 (`zlib.zstdCompressSync`).  There is NO pure-JS
 *     fallback for writing: `fzstd` is decompress-only (it exposes no
 *     `compress`).  Selecting `zstd` on a runtime without native support
 *     throws a clear error — eagerly at plugin-init via
 *     `probeCompressionAvailability`, not cryptically on first write.
 *   - DECOMPRESS (read): native first, then the optional `fzstd` peer-dep
 *     so a non-native runtime can still READ zstd bodies written
 *     elsewhere.  `fzstd` caps the back-reference window at 2^25 (32 MB)
 *     and may reject ultra-level (≥20) frames.
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
   * decompressed size to defeat a decompression bomb (SECURITY_AUDIT.md #3):
   * gzip enforces it at allocation time via zlib's `maxOutputLength`; the
   * other paths assert the size once decoded.  Exceeding it throws.
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
      zlib.gunzipSync(
        input,
        maxOutputBytes !== undefined && Number.isFinite(maxOutputBytes)
          ? { maxOutputLength: maxOutputBytes }
          : undefined,
      ),
  };
});

const gzipCompressor: Compressor = {
  async compress(input, level) { return (await gzipLazy.get()).gzip(input, level); },
  async decompress(input, maxOutputBytes) {
    const out = await (await gzipLazy.get()).gunzip(input, maxOutputBytes);
    // `maxOutputLength` already aborts allocation on Node; the assertion is a
    // portable backstop in case a runtime's zlib ignores the option (#3).
    assertWithinCap(out.length, maxOutputBytes, 'gzip');
    return out;
  },
};

/* ------------------------------- zstd ----------------------------------- */

type ZstdCompressFn = (input: Uint8Array, level?: number) => Promise<Uint8Array>;
type ZstdDecompressFn = (input: Uint8Array) => Promise<Uint8Array>;

/**
 * zstd COMPRESS resolution — native only.  Bun (`Bun.zstdCompressSync`)
 * then Node ≥22.15 (`zlib.zstdCompressSync`).  Deliberately NO `fzstd`
 * fallback: fzstd is decompress-only (exposes no `compress`), so a
 * runtime without native zstd cannot WRITE zstd — we throw a clear error
 * here instead of the cryptic `fzstd.compress is not a function` the
 * combined resolver used to produce on first write.
 *
 * Level spelling differs by runtime — Bun takes `{ level }`, Node takes
 * `{ params: { [ZSTD_c_compressionLevel]: N } }` — but the 1..22 scale
 * (default 3) is the same.
 */
const zstdCompressLazy: Lazy<Promise<ZstdCompressFn>> = Lazy.of<Promise<ZstdCompressFn>>(async () => {
  const bun = (globalThis as { Bun?: {
    zstdCompressSync?: (input: Uint8Array, opts?: { level?: number }) => Uint8Array;
  } }).Bun;
  if (bun?.zstdCompressSync) {
    const compressFn = bun.zstdCompressSync;
    return async (i: Uint8Array, level?: number): Promise<Uint8Array> =>
      compressFn(i, level !== undefined ? { level: clampZstdLevel(level) } : undefined);
  }

  try {
    const zlibName = 'node:zlib';
    const zlib = (await import(zlibName)) as {
      zstdCompressSync?: (input: Uint8Array, opts?: { params?: Record<number, number> }) => Uint8Array;
      constants?: { ZSTD_c_compressionLevel?: number };
    };
    if (zlib.zstdCompressSync) {
      const compressFn = zlib.zstdCompressSync;
      const levelParam = zlib.constants?.ZSTD_c_compressionLevel;
      return async (i: Uint8Array, level?: number): Promise<Uint8Array> =>
        level !== undefined && levelParam !== undefined
          ? compressFn(i, { params: { [levelParam]: clampZstdLevel(level) } })
          : compressFn(i);
    }
  } catch { /* node:zlib unavailable — fall through to the error */ }

  throw new Error(
    'zstd compression requires native runtime support — Bun (zstdCompressSync) '
    + 'or Node ≥22.15 (zlib.zstdCompressSync).  The optional `fzstd` peer '
    + 'dependency can only DECOMPRESS, so it cannot write zstd bodies.  '
    + "Either run on a native-zstd runtime, or use compression: { algorithm: "
    + "'gzip' } which works everywhere.",
  );
});

/**
 * zstd DECOMPRESS resolution — native first (Bun, Node ≥22.15), then the
 * pure-JS `fzstd` peer-dep so a runtime without native zstd can still
 * READ zstd bodies written elsewhere.  Note fzstd caps the back-reference
 * window at 2^25 (32 MB) and may fail on ultra-level (≥20) frames — see
 * `CompressionConfig.level`.
 */
const zstdDecompressLazy: Lazy<Promise<ZstdDecompressFn>> = Lazy.of<Promise<ZstdDecompressFn>>(async () => {
  const bun = (globalThis as { Bun?: {
    zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
  } }).Bun;
  if (bun?.zstdDecompressSync) {
    const decompressFn = bun.zstdDecompressSync;
    return async (i: Uint8Array): Promise<Uint8Array> => decompressFn(i);
  }

  try {
    const zlibName = 'node:zlib';
    const zlib = (await import(zlibName)) as {
      zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
    };
    if (zlib.zstdDecompressSync) {
      const decompressFn = zlib.zstdDecompressSync;
      return async (i: Uint8Array): Promise<Uint8Array> => decompressFn(i);
    }
  } catch { /* node:zlib unavailable — fall through to fzstd */ }

  try {
    const fzstdName = 'fzstd';
    const fzstd = (await import(fzstdName)) as {
      decompress: (input: Uint8Array) => Uint8Array;
    };
    return async (i: Uint8Array): Promise<Uint8Array> => fzstd.decompress(i);
  } catch (e) {
    throw new Error(
      'No zstd decompressor available.  Either upgrade to Bun 1.1+ / '
      + 'Node 22.15+, or install the `fzstd` peer dependency: '
      + '`npm install fzstd`.\nOriginal error: '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
});

const zstdCompressor: Compressor = {
  async compress(input, level) { return (await zstdCompressLazy.get())(input, level); },
  async decompress(input, maxOutputBytes) {
    // No portable allocation-time cap across the zstd impls (Bun native /
    // Node native / fzstd), so assert the decoded size (SECURITY_AUDIT.md #3).
    const out = await (await zstdDecompressLazy.get())(input);
    assertWithinCap(out.length, maxOutputBytes, 'zstd');
    return out;
  },
};

/* ------------------------------- public --------------------------------- */

/** Throw when a decoded size exceeds a finite `maxOutputBytes` cap (#3). */
function assertWithinCap(size: number, maxOutputBytes: number | undefined, algo: string): void {
  if (maxOutputBytes !== undefined && Number.isFinite(maxOutputBytes) && size > maxOutputBytes) {
    throw new Error(`${algo} decompression exceeded maxOutputBytes=${maxOutputBytes} (got ${size})`);
  }
}

const noneCompressor: Compressor = {
  async compress(input) { return input; },
  async decompress(input, maxOutputBytes) {
    assertWithinCap(input.length, maxOutputBytes, 'stored');
    return input;
  },
};

/** Get a `Compressor` for the requested algorithm.  Cached per-algorithm. */
export function compressorFor(algo: CompressionAlgo): Compressor {
  // Exhaustive — adding a new CompressionAlgo variant forces this site.
  return match(algo)
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
export async function probeCompressionAvailability(algo: CompressionAlgo): Promise<void> {
  await match(algo)
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

/** Test hook — clear cached lazy implementations. */
export function resetCompressionCache(): void {
  gzipLazy.reset();
  zstdCompressLazy.reset();
  zstdDecompressLazy.reset();
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
