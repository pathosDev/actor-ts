import { Lazy } from '../../util/Lazy.js';

/**
 * Per-snapshot compression.  Three modes:
 *   - `none` — store raw bytes.  Right choice for already-compressed payloads
 *     or very small ones where overhead beats savings.
 *   - `gzip` — `node:zlib` everywhere (Bun, Node, Deno).  No extra deps.
 *   - `zstd` — preferred for large state blobs.  Tries native runtime
 *     support first (Node ≥22.15 or Bun); falls back to the optional
 *     `fzstd` peer dependency.  If neither is available and the user
 *     selected `zstd`, the very first compress / decompress call throws
 *     a clear "install fzstd" error.
 */

export type CompressionAlgo = 'none' | 'gzip' | 'zstd';

export interface Compressor {
  compress(input: Uint8Array): Promise<Uint8Array>;
  decompress(input: Uint8Array): Promise<Uint8Array>;
}

/* ------------------------------- gzip ----------------------------------- */

const gzipLazy: Lazy<Promise<{
  gzip: (input: Uint8Array) => Promise<Uint8Array>;
  gunzip: (input: Uint8Array) => Promise<Uint8Array>;
}>> = Lazy.of(async () => {
  const name = 'node:zlib';
  const zlib = (await import(name)) as {
    gzipSync(input: Uint8Array): Uint8Array;
    gunzipSync(input: Uint8Array): Uint8Array;
  };
  return {
    gzip: async (input: Uint8Array): Promise<Uint8Array> => zlib.gzipSync(input),
    gunzip: async (input: Uint8Array): Promise<Uint8Array> => zlib.gunzipSync(input),
  };
});

const gzipCompressor: Compressor = {
  async compress(input) { return (await gzipLazy.get()).gzip(input); },
  async decompress(input) { return (await gzipLazy.get()).gunzip(input); },
};

/* ------------------------------- zstd ----------------------------------- */

interface ZstdImpl {
  compress(input: Uint8Array): Promise<Uint8Array>;
  decompress(input: Uint8Array): Promise<Uint8Array>;
  source: 'node-zlib' | 'bun-native' | 'fzstd';
}

const zstdLazy: Lazy<Promise<ZstdImpl>> = Lazy.of<Promise<ZstdImpl>>(async () => {
  // 1. Bun: `Bun.zstdCompressSync` / `zstdDecompressSync` (added in Bun 1.1).
  const bun = (globalThis as { Bun?: {
    zstdCompressSync?: (input: Uint8Array) => Uint8Array;
    zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
  } }).Bun;
  if (bun?.zstdCompressSync && bun.zstdDecompressSync) {
    const compressFn = bun.zstdCompressSync;
    const decompressFn = bun.zstdDecompressSync;
    return {
      compress: async (i: Uint8Array): Promise<Uint8Array> => compressFn(i),
      decompress: async (i: Uint8Array): Promise<Uint8Array> => decompressFn(i),
      source: 'bun-native',
    };
  }

  // 2. Node 22.15+: `zlib.zstdCompressSync` / `zstdDecompressSync`.
  try {
    const zlibName = 'node:zlib';
    const zlib = (await import(zlibName)) as {
      zstdCompressSync?: (input: Uint8Array) => Uint8Array;
      zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
    };
    if (zlib.zstdCompressSync && zlib.zstdDecompressSync) {
      const compressFn = zlib.zstdCompressSync;
      const decompressFn = zlib.zstdDecompressSync;
      return {
        compress: async (i: Uint8Array): Promise<Uint8Array> => compressFn(i),
        decompress: async (i: Uint8Array): Promise<Uint8Array> => decompressFn(i),
        source: 'node-zlib',
      };
    }
  } catch { /* node:zlib unavailable — fall through to fzstd */ }

  // 3. fzstd peer-dep — pure JS, cross-runtime, ~14 KB.
  try {
    const fzstdName = 'fzstd';
    const fzstd = (await import(fzstdName)) as {
      compress: (input: Uint8Array) => Uint8Array;
      decompress: (input: Uint8Array) => Uint8Array;
    };
    return {
      compress: async (i: Uint8Array): Promise<Uint8Array> => fzstd.compress(i),
      decompress: async (i: Uint8Array): Promise<Uint8Array> => fzstd.decompress(i),
      source: 'fzstd',
    };
  } catch (e) {
    throw new Error(
      'No zstd implementation available.  Either upgrade to Bun 1.1+ / '
      + 'Node 22.15+, or install the `fzstd` peer dependency: '
      + '`npm install fzstd`.\nOriginal error: '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
});

const zstdCompressor: Compressor = {
  async compress(input) { return (await zstdLazy.get()).compress(input); },
  async decompress(input) { return (await zstdLazy.get()).decompress(input); },
};

/* ------------------------------- public --------------------------------- */

const noneCompressor: Compressor = {
  async compress(input) { return input; },
  async decompress(input) { return input; },
};

/** Get a `Compressor` for the requested algorithm.  Cached per-algorithm. */
export function compressorFor(algo: CompressionAlgo): Compressor {
  switch (algo) {
    case 'none': return noneCompressor;
    case 'gzip': return gzipCompressor;
    case 'zstd': return zstdCompressor;
  }
}

/** Test hook — clear cached lazy implementations. */
export function resetCompressionCache(): void {
  gzipLazy.reset();
  zstdLazy.reset();
}
