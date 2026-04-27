import { Lazy } from '../../util/Lazy.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
  type ObjectFetched,
  type ObjectInfo,
  type ObjectStorageBackend,
  type PutOptions,
} from './ObjectStorageBackend.js';

/**
 * Filesystem-backed `ObjectStorageBackend` — stores each object as a file
 * under a root directory, with the storage key mapped 1:1 to a relative
 * path.  Intended for unit tests, local development, and "S3-API parity
 * without the cloud".  **Not** safe for multi-process concurrent use:
 * the ETag map that backs `ifMatch` / `ifNoneMatch` is in-memory.
 *
 * The backend lazy-imports `node:fs/promises` and `node:path` so this
 * module is harmless to include on Bun / Deno where those built-ins
 * already exist (Node-compat layer) — only the `open()` method actually
 * touches them.
 */

export interface FilesystemObjectStorageOptions {
  /** Root directory.  Will be created (recursively) if it doesn't exist. */
  readonly dir: string;
}

export class FilesystemObjectStorageBackend implements ObjectStorageBackend {
  private readonly etags = new Map<string, string>();

  constructor(private readonly options: FilesystemObjectStorageOptions) {}

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    // CAS check + claim must be atomic w.r.t. other JS-microtasks — once we
    // `await` for fs work below, another concurrent `put` could otherwise
    // observe the same "free slot" and both succeed.  We therefore (1) read
    // the current etag, (2) validate the CAS preconditions, (3) compute the
    // new etag deterministically from the body, and (4) write the new etag
    // into the map BEFORE any await.  Failure paths roll the map back.
    const currentEtag = this.etags.get(key);
    if (opts.ifNoneMatch === '*' && currentEtag !== undefined) {
      throw new ObjectStorageConcurrencyError(
        key, `key ${key} already exists; ifNoneMatch=* rejected`,
      );
    }
    if (opts.ifMatch !== undefined && currentEtag !== opts.ifMatch) {
      throw new ObjectStorageConcurrencyError(
        key, `etag mismatch on ${key}: expected ${opts.ifMatch}, actual ${currentEtag ?? '<absent>'}`,
      );
    }
    const newEtag = computeEtag(body);
    this.etags.set(key, newEtag);  // claim NOW — before yielding for fs work

    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.options.dir, key);
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, body);
    } catch (e) {
      // Roll back the etag claim so a retry can succeed.
      if (currentEtag === undefined) this.etags.delete(key);
      else this.etags.set(key, currentEtag);
      throw new ObjectStorageBackendError(`filesystem put failed for ${key}`, e);
    }

    if (opts.contentEncoding || opts.contentType) {
      const meta = JSON.stringify({
        contentEncoding: opts.contentEncoding,
        contentType: opts.contentType,
      });
      try { await fs.writeFile(fullPath + '.meta.json', meta); }
      catch (e) { throw new ObjectStorageBackendError(`filesystem put-meta failed for ${key}`, e); }
    }
    return { etag: newEtag };
  }

  async get(key: string): Promise<Option<ObjectFetched>> {
    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.options.dir, key);
    let body: Uint8Array;
    let stat;
    try {
      body = new Uint8Array(await fs.readFile(fullPath));
      stat = await fs.stat(fullPath);
    } catch (e) {
      if ((e as { code?: string })?.code === 'ENOENT') return none;
      throw new ObjectStorageBackendError(`filesystem get failed for ${key}`, e);
    }
    let contentEncoding: string | undefined;
    let contentType: string | undefined;
    try {
      const metaRaw = await fs.readFile(fullPath + '.meta.json', 'utf8');
      const meta = JSON.parse(metaRaw) as { contentEncoding?: string; contentType?: string };
      contentEncoding = meta.contentEncoding;
      contentType = meta.contentType;
    } catch { /* no metadata sidecar → leave undefined */ }
    const etag = this.etags.get(key) ?? computeEtag(body);
    this.etags.set(key, etag);
    return some({ body, etag, lastModified: stat.mtime, contentEncoding, contentType });
  }

  async delete(key: string): Promise<void> {
    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.options.dir, key);
    try { await fs.unlink(fullPath); }
    catch (e) {
      if ((e as { code?: string })?.code === 'ENOENT') { /* idempotent */ }
      else throw new ObjectStorageBackendError(`filesystem delete failed for ${key}`, e);
    }
    try { await fs.unlink(fullPath + '.meta.json'); } catch { /* sidecar may not exist */ }
    this.etags.delete(key);
  }

  async list(opts: { prefix: string; limit?: number }): Promise<ObjectInfo[]> {
    const { fs, path } = await fsLazy.get();
    const root = this.options.dir;
    // Prefix may include a directory portion.  We walk from root and filter.
    const out: ObjectInfo[] = [];
    const walk = async (rel: string): Promise<void> => {
      const full = path.join(root, rel);
      let entries;
      try { entries = await fs.readdir(full, { withFileTypes: true }); }
      catch (e) {
        if ((e as { code?: string })?.code === 'ENOENT') return;
        throw e;
      }
      for (const ent of entries) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(childRel);
        } else if (ent.isFile() && childRel.startsWith(opts.prefix)) {
          if (childRel.endsWith('.meta.json')) continue; // skip sidecar metadata
          const stat = await fs.stat(path.join(root, childRel));
          out.push({ key: childRel, size: stat.size, lastModified: stat.mtime });
        }
      }
    };
    await walk('');
    out.sort((a, b) => a.key.localeCompare(b.key));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async close(): Promise<void> {
    this.etags.clear();
  }

  /** Test hook — clear the in-memory etag map without touching disk. */
  resetEtagsForTest(): void { this.etags.clear(); }
}

/* ----------------------------- internals -------------------------------- */

interface FsModule {
  fs: {
    mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
    writeFile(p: string, body: Uint8Array | string, encoding?: string): Promise<void>;
    readFile(p: string): Promise<Buffer>;
    readFile(p: string, encoding: 'utf8'): Promise<string>;
    stat(p: string): Promise<{ size: number; mtime: Date }>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<Array<{
      name: string; isFile(): boolean; isDirectory(): boolean;
    }>>;
    unlink(p: string): Promise<void>;
  };
  path: {
    join(...parts: string[]): string;
    dirname(p: string): string;
  };
}

interface Buffer extends Uint8Array {}

const fsLazy: Lazy<Promise<FsModule>> = Lazy.of(async () => {
  const fsName = 'node:fs/promises';
  const pathName = 'node:path';
  const fs = (await import(fsName)) as FsModule['fs'];
  const path = (await import(pathName)) as FsModule['path'];
  return { fs, path };
});

/** Cheap content-derived ETag — SHA-1 hex via WebCrypto subtle. */
function computeEtag(body: Uint8Array): string {
  // Sync, deterministic approximation good enough for FS:
  // 32-bit FNV-1a over the bytes, hex-prefixed.  Real S3 uses MD5/sha256;
  // for our CAS purposes the only invariant required is "same bytes →
  // same etag, different bytes → different etag with very high probability".
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body[i]!;
    h = (h * 0x01000193) >>> 0;
  }
  // Mix in length so empty vs single-zero-byte differ trivially.
  h ^= body.length;
  return `"fs-${(h >>> 0).toString(16).padStart(8, '0')}-${body.length}"`;
}
