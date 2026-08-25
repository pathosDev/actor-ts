import { Lazy } from '../../util/Lazy.js';
import { none, some, type Option } from '../../util/Option.js';
import { randomId } from '../../util/RandomString.js';
import { wrapError } from '../../util/WrapError.js';
import { makeKeyValidator, ObjectStorageWriteKeyRules } from '../storage/KeyValidator.js';
import {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
  type ObjectFetched,
  type ObjectInfo,
  type ObjectStorageBackend,
  type PutOptions,
} from './ObjectStorageBackend.js';
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  FilesystemObjectStorageOptionsValidator,
} from './FilesystemObjectStorageOptions.js';
import type { FilesystemObjectStorageOptions, FilesystemObjectStorageOptionsType } from './FilesystemObjectStorageOptions.js';

/**
 * Filesystem-backed `ObjectStorageBackend` — stores each object as a file
 * under a root directory, with the storage key mapped 1:1 to a relative
 * path.  Suitable for unit tests, local development, and "S3-API parity
 * without the cloud", and **safe for concurrent multi-process writers**:
 * every `put` / `delete` acquires a per-key advisory file lock (atomic
 * `O_EXCL` create) so the CAS check + write block is serialized at the
 * filesystem layer, and writes use a temp-file + rename so concurrent
 * readers never observe a half-written object.
 *
 * The backend lazy-imports `node:fs/promises` and `node:path` so this
 * module is harmless to include on Bun / Deno where those built-ins
 * already exist (Node-compat layer) — only the actual operations touch
 * them.
 *
 * Implementation notes:
 *
 *  - **Disk is canonical.**  Etags are content-derived
 *    ({@link computeEtag} — deterministic FNV-1a + length).  No in-memory
 *    map; the file content alone determines the etag, so a fresh process
 *    sees the exact same etags every other process does.  Same key, same
 *    bytes → same etag, regardless of who wrote them or when.
 *  - **Per-key advisory lock.**  The lock file lives next to the target
 *    file as `<key>.lock`.  Acquisition uses
 *    `fs.writeFile(lockPath, ..., { flag: 'wx' })`, which is
 *    atomic-create-only on every POSIX and NTFS filesystem the framework
 *    targets.
 *  - **Stale-lock recovery.**  Lock files older than {@link staleLockMs}
 *    (default 30 s) are assumed to be left behind by a crashed writer
 *    and forcibly removed; one final acquisition retry is then made.
 *    This keeps the pathological "process died holding a lock" case from
 *    blocking the directory forever, at the cost of being technically
 *    incorrect if a real writer is taking longer than `staleLockMs` for a
 *    single `put` — which shouldn't happen for the small payloads this
 *    backend targets.
 *  - **Prefix-scoped `list`.**  A listing reads only the directory its
 *    prefix names — everything up to the prefix's last `/` — so its cost
 *    tracks the matched subtree rather than the number of objects in the
 *    store.  Walking from the root and filtering afterwards made a snapshot
 *    `loadLatest` read every *other* entity's directory, turning an O(1)
 *    lookup into O(N) in the entity count (#746).  A positive `limit` stops
 *    the walk rather than trimming a finished array.
 *  - **Atomic body writes.**  `put` writes to a per-process tmp file
 *    (`<key>.tmp.<pid>.<random>`), then renames over the target.  On
 *    POSIX `rename(2)` is atomic on the same filesystem; on Windows
 *    `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` provides equivalent
 *    behaviour.  Concurrent readers always see either the old body or
 *    the new body, never a truncated buffer.
 */

/**
 * Reject keys that would escape the root directory via path-traversal
 * (`../`, `\..\`, etc.), absolute-path injection, or NUL-byte tricks.
 *
 * **Exploit walkthrough (pre-fix):** the previous code did
 * `path.join(root, key)` directly.  An attacker controlling `key`
 * (e.g., a poorly-sanitised `persistenceId` flowing through the
 * snapshot-store layer) could pass `'../../etc/passwd'` and read
 * arbitrary files on the host, or `'/etc/passwd'` (absolute-path,
 * Node's `path.join` interprets it as a full path and effectively
 * ignores the root prefix on POSIX).
 *
 * This helper is the front-line syntactic check; {@link assertWithin
 * Root} below is the defense-in-depth post-resolve check.
 */
/**
 * Filesystem key-validation rules for the **read** paths — `get`, `delete`,
 * `list`.  Same checks the pre-refactor `assertSafeKey` enforced.
 *
 * See `src/persistence/storage/KeyValidator.ts` for the factory.
 */
const FilesystemKeyRules = {
  errorClass: ObjectStorageBackendError,
  errorPrefix: 'invalid key',
  rejectNul: true,
  rejectAbsolutePaths: true,
  rejectRelativeTraversal: true,
} as const;

/**
 * Filesystem key-validation rules for `put`, i.e. {@link FilesystemKeyRules}
 * plus `rejectControlChars` (#747).
 *
 * POSIX filenames may legally contain 0x01–0x1F, so before this rule the
 * backend wrote such a key without complaint — while the master-key rotation
 * sweep, which validates with `rejectControlChars` on, refused it on the way
 * back out.  That gap is the actual defect: the framework could write a key
 * its own rotation tool would not process, so those bodies stayed under the
 * retired key while the sweep reported success.  (NTFS rejects the same range
 * outright, which is why the gap only ever opened on POSIX.)
 *
 * Write path only.  `get` and `delete` keep the looser set on purpose:
 * tightening them would not reject a new bad key, it would strand an object
 * already on disk — unreadable and undeletable through this backend — for a
 * key the previous version wrote happily.
 */
const FilesystemWriteKeyRules = {
  ...FilesystemKeyRules,
  ...ObjectStorageWriteKeyRules,
} as const;

const assertSafeKey = makeKeyValidator(FilesystemKeyRules);
const assertSafeWriteKey = makeKeyValidator(FilesystemWriteKeyRules);

/**
 * Defense-in-depth post-`path.resolve` check that the computed
 * absolute path stays under the configured root.  Catches edge cases
 * the syntactic {@link assertSafeKey} might miss (e.g., URL-encoded
 * traversal, symlinks resolved at OS level).
 */
function assertWithinRoot(
  pathMod: { resolve: (...p: string[]) => string; readonly sep: string },
  root: string,
  fullPath: string,
): void {
  const normRoot = pathMod.resolve(root);
  const normFull = pathMod.resolve(fullPath);
  if (normFull !== normRoot && !normFull.startsWith(normRoot + pathMod.sep)) {
    throw new ObjectStorageBackendError(
      `path-traversal blocked: resolved path "${normFull}" escapes root "${normRoot}"`,
    );
  }
}

export class FilesystemObjectStorageBackend implements ObjectStorageBackend {
  private readonly dir: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(options: FilesystemObjectStorageOptions) {
    const resolvedOptions = (options as FilesystemObjectStorageOptionsType);
    new FilesystemObjectStorageOptionsValidator().validate(resolvedOptions);
    this.dir           = resolvedOptions.dir;
    this.lockTimeoutMs = resolvedOptions.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs   = resolvedOptions.staleLockMs   ?? DEFAULT_STALE_LOCK_MS;
  }

  async put(key: string, body: Uint8Array, options: PutOptions = {}): Promise<{ etag: string }> {
    assertSafeWriteKey(key);
    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.dir, key);
    assertWithinRoot(path, this.dir, fullPath);
    const lockPath = fullPath + '.lock';

    // Parent directory must exist before lock acquisition (the lock file
    // lives there).  `mkdir(recursive)` is idempotent across processes,
    // so concurrent puts to a fresh dir don't race here.
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const release = await acquireLock(fs, lockPath, this.lockTimeoutMs, this.staleLockMs);
    try {
      // Read current state from disk — disk is canonical, no in-memory
      // shadow that could disagree with another process's writes.
      let currentEtag: string | undefined;
      try {
        const existing = new Uint8Array(await fs.readFile(fullPath));
        currentEtag = computeEtag(existing);
      } catch (e) {
        if ((e as { code?: string })?.code !== 'ENOENT') {
          throw new ObjectStorageBackendError(
            `filesystem put-read-current failed for ${key}`, e,
          );
        }
        // ENOENT → object doesn't exist yet; currentEtag stays undefined.
      }

      // Validate CAS preconditions.
      if (options.ifNoneMatch === '*' && currentEtag !== undefined) {
        throw new ObjectStorageConcurrencyError(
          key, `key ${key} already exists; ifNoneMatch=* rejected`,
        );
      }
      if (options.ifMatch !== undefined && currentEtag !== options.ifMatch) {
        throw new ObjectStorageConcurrencyError(
          key,
          `etag mismatch on ${key}: expected ${options.ifMatch}, actual ${currentEtag ?? '<absent>'}`,
        );
      }

      // Atomic write: write to a per-process temp file, then rename.
      //
      // The suffix was `${Date.now()}.${Math.floor(Math.random() * 1e9)}`.  Both
      // halves are guessable — the clock is observable and `Math.random()` is
      // not a CSPRNG — and a predictable temp path in a shared directory is the
      // classic setup for a local race: pre-create it, or drop a symlink there,
      // and the write lands somewhere else.  `randomId` is what every other
      // generated identifier in the framework draws from.
      const tmpPath = `${fullPath}.tmp.${process.pid}.${randomId(12)}`;
      try {
        await fs.writeFile(tmpPath, body);
        await fs.rename(tmpPath, fullPath);
      } catch (e) {
        try { await fs.unlink(tmpPath); } catch { /* may not exist */ }
        throw wrapError(e, ObjectStorageBackendError, `filesystem put-write failed for ${key}`);
      }

      // Metadata sidecar.  Best-effort — a crash between rename(body) and
      // writeFile(meta) leaves the body without metadata, which `get`
      // tolerates by treating the sidecar as optional.
      if (options.contentEncoding || options.contentType) {
        const meta = JSON.stringify({
          contentEncoding: options.contentEncoding,
          contentType: options.contentType,
        });
        try { await fs.writeFile(fullPath + '.meta.json', meta); }
        catch (e) {
          throw wrapError(e, ObjectStorageBackendError, `filesystem put-meta failed for ${key}`);
        }
      }

      return { etag: computeEtag(body) };
    } finally {
      await release();
    }
  }

  async get(key: string): Promise<Option<ObjectFetched>> {
    assertSafeKey(key);
    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.dir, key);
    assertWithinRoot(path, this.dir, fullPath);
    let body: Uint8Array;
    let stat;
    try {
      body = new Uint8Array(await fs.readFile(fullPath));
      stat = await fs.stat(fullPath);
    } catch (e) {
      if ((e as { code?: string })?.code === 'ENOENT') return none;
      throw wrapError(e, ObjectStorageBackendError, `filesystem get failed for ${key}`);
    }
    let contentEncoding: string | undefined;
    let contentType: string | undefined;
    try {
      const metaRaw = await fs.readFile(fullPath + '.meta.json', 'utf8');
      const meta = JSON.parse(metaRaw) as { contentEncoding?: string; contentType?: string };
      contentEncoding = meta.contentEncoding;
      contentType = meta.contentType;
    } catch { /* no metadata sidecar → leave undefined */ }
    return some({
      body,
      etag: computeEtag(body),
      lastModified: stat.mtime,
      contentEncoding,
      contentType,
    });
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.dir, key);
    assertWithinRoot(path, this.dir, fullPath);
    const lockPath = fullPath + '.lock';

    // Lock so a concurrent put doesn't see a half-deleted state mid-CAS.
    // We may be deleting a never-written key (idempotent), but the
    // serialization vs. concurrent puts still matters.
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const release = await acquireLock(fs, lockPath, this.lockTimeoutMs, this.staleLockMs);
    try {
      try { await fs.unlink(fullPath); }
      catch (e) {
        if ((e as { code?: string })?.code === 'ENOENT') { /* idempotent */ }
        else throw wrapError(e, ObjectStorageBackendError, `filesystem delete failed for ${key}`);
      }
      try { await fs.unlink(fullPath + '.meta.json'); } catch { /* sidecar may not exist */ }
    } finally {
      await release();
    }
  }

  async list(options: { prefix: string; limit?: number }): Promise<ObjectInfo[]> {
    // Empty prefix means "everything" — that's the standard list-all
    // semantic and is safe.  Non-empty prefix has to obey the same
    // key-shape rules as put/get/delete (no `..`, no absolute paths,
    // no NUL bytes) — list otherwise could enumerate outside the root.
    if (options.prefix !== '') assertSafeKey(options.prefix);
    const { fs, path } = await fsLazy.get();
    const root = this.dir;
    // The prefix's directory portion — see `listStartDirectory` below for why
    // the split is at the last `/`.  Starting the walk there rather than at
    // the root is the whole of #746.
    const startDirectory = listStartDirectory(options.prefix);
    // Same defense-in-depth check `put` / `get` / `delete` run.  It is new
    // here because until the walk was seeded from the prefix, `list` never
    // joined caller-supplied text into a path at all.
    if (startDirectory !== '') {
      assertWithinRoot(path, root, path.join(root, startDirectory));
    }
    // Only a positive limit can prune the walk.  `0` and negatives keep
    // whatever the `slice` below has always done with them.
    const stopAt = options.limit !== undefined && options.limit > 0 ? options.limit : undefined;
    const out: ObjectInfo[] = [];
    const walk = async (rel: string): Promise<void> => {
      const full = path.join(root, rel);
      let entries: DirectoryEntry[];
      try { entries = await fs.readdir(full, { withFileTypes: true }); }
      catch (e) {
        const code = (e as { code?: string })?.code;
        // A prefix naming a directory nothing ever wrote to is an empty
        // listing, not a fault — reachable only now that the walk starts at
        // that directory instead of at the always-present root.  ENOTDIR is
        // the same case one level up: a prefix whose directory portion is an
        // ordinary file, which the root-anchored walk used to drop silently
        // via the `startsWith` filter.
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        throw e;
      }
      // Ordering only matters when the walk may stop early: the early exit
      // keeps whichever entries it reached first, so depth-first order has to
      // agree with the ascending-by-key order the contract promises.  Without
      // a limit the walk is exhaustive and the sort below is authoritative,
      // so we skip the per-directory sort entirely.
      const ordered = stopAt === undefined ? entries : sortEntriesByKeyOrder(entries, rel);
      for (const ent of ordered) {
        if (stopAt !== undefined && out.length >= stopAt) return;
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(childRel);
        } else if (ent.isFile() && childRel.startsWith(options.prefix)) {
          if (childRel.endsWith('.meta.json')) continue;        // metadata sidecar
          if (childRel.endsWith('.lock')) continue;             // per-key write lock
          // Crash-leftover temp file — a body `put` never got to rename into
          // place, so it is partial and was never a committed object.
          if (TMP_FILE_RE.test(childRel) || LEGACY_TMP_FILE_RE.test(childRel)) continue;
          const stat = await fs.stat(path.join(root, childRel));
          out.push({ key: childRel, size: stat.size, lastModified: stat.mtime });
        }
      }
    };
    await walk(startDirectory);
    out.sort((a, b) => a.key.localeCompare(b.key));
    return options.limit ? out.slice(0, options.limit) : out;
  }

  async close(): Promise<void> {
    /* No in-memory state to clear — disk is canonical. */
  }
}

/* ----------------------------- internals -------------------------------- */

/** The subset of `node:fs`'s `Dirent` that `list`'s directory walk consumes. */
export interface DirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export type FsModule = {
  fs: {
    mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
    writeFile(
      p: string,
      body: Uint8Array | string,
      options?: { flag?: string; encoding?: string },
    ): Promise<void>;
    readFile(p: string): Promise<Buffer>;
    readFile(p: string, encoding: 'utf8'): Promise<string>;
    stat(p: string): Promise<{ size: number; mtime: Date }>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<DirectoryEntry[]>;
    unlink(p: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
  };
  path: {
    join(...parts: string[]): string;
    dirname(p: string): string;
    resolve(...parts: string[]): string;
    readonly sep: string;
  };
};

interface Buffer extends Uint8Array {}

/**
 * The backend's single route to `node:fs/promises` / `node:path`, memoised
 * for the process lifetime.
 *
 * Exported — but deliberately *not* re-exported from `src/persistence/index.ts`
 * — so a test can seed it via `Lazy.setOverride` with a counting wrapper.  The
 * property #746 is about is how many directories a prefixed `list` reads, and
 * that is invisible in the value `list` returns: two implementations with
 * wildly different cost hand back byte-identical arrays.  Counting the reads
 * is the only way to assert it, and `mock.module('node:fs/promises', …)` is not
 * an option — replacing that module out from under Bun's own test runner hangs
 * the run before the first test reports.  Same seam shape as
 * `websocketClientConstructor` in `src/http/websocket/WebsocketConstructor.ts`.
 */
export const fsLazy: Lazy<Promise<FsModule>> = Lazy.of(async () => {
  const fsName = 'node:fs/promises';
  const pathName = 'node:path';
  const fs = (await import(fsName)) as FsModule['fs'];
  const path = (await import(pathName)) as FsModule['path'];
  return { fs, path };
});

/**
 * The deepest directory guaranteed to hold every key `prefix` can match —
 * the prefix up to its last `/`, as canonical path segments.
 *
 * Seeding `list`'s walk here instead of at the storage root is the whole of
 * #746: the listing then costs the subtree the prefix names rather than the
 * entire store, which is what took a snapshot `loadLatest` from O(1) in the
 * entity count to O(N) — every other entity's directory got read to answer a
 * question about one.
 *
 * The split is at the **last** `/` because the trailing piece is a *partial*
 * segment, not a directory: `mine/e` still has to match `mine/e0/…` and
 * `mine/e10/…` alike, so `mine` is the deepest safe entry point and the
 * `startsWith` filter in the walk remains the correctness backstop.
 *
 * Empty and `.` segments are dropped so the relative paths the walk builds
 * stay canonical — the single-slash form a root-anchored walk produced, and
 * the form every key already on disk was written under.  A prefix carrying
 * either can match no such key anyway (`a//b` would need a `//` in the key),
 * so narrowing past it only skips work that could never yield a hit.  `..`
 * never reaches here — {@link assertSafeKey} rejects it first.
 */
function listStartDirectory(prefix: string): string {
  const lastSlash = prefix.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return prefix
    .slice(0, lastSlash)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/**
 * Order one directory's entries so a depth-first walk emits keys in the same
 * ascending order `list` sorts by — the precondition the early exit under
 * `limit` needs, since it keeps whichever entries the walk reached first.
 *
 * A directory sorts under its own name plus a trailing `/`, because it stands
 * for every key beneath it and those all carry that separator.  Without it the
 * order is wrong wherever a directory and a file share a stem: raw names put
 * `d` before `d.txt`, while the keys `d/x` and `d.txt` sort the other way
 * round (`.` precedes `/`), so a `limit: 1` would have returned `d/x` where
 * the full listing starts with `d.txt`.
 */
function sortEntriesByKeyOrder(entries: DirectoryEntry[], rel: string): DirectoryEntry[] {
  const keyed = entries.map((entry) => {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    return { entry, sortKey: entry.isDirectory() ? `${childRel}/` : childRel };
  });
  keyed.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return keyed.map((k) => k.entry);
}

/**
 * Pattern emitted by `put`'s temp-file scheme — recognised by `list` to skip.
 *
 * Must be kept in lockstep with the `tmpPath` template in `put`: the suffix
 * moved to `randomId` when the predictable `Math.random()` one was replaced,
 * and this pattern did not follow, so for one release window `list` reported a
 * crashed writer's partial file as a real object (#909).
 */
const TMP_FILE_RE = /\.tmp\.\d+\.[0-9a-f]+$/;

/**
 * The pre-`randomId` shape, `.tmp.<pid>.<Date.now()>.<Math.random()*1e9>`.
 * Still skipped: a directory written by an older version can hold leftovers in
 * that form, and an upgrade must not start surfacing them as objects.
 */
const LEGACY_TMP_FILE_RE = /\.tmp\.\d+\.\d+\.\d+$/;

/**
 * Acquire a per-key advisory lock by atomically creating `lockPath` with
 * `O_EXCL`.  Retries with exponential backoff while the lock is held; on
 * total timeout, falls through to a stale-lock check (lock files older
 * than `staleLockMs` are forcibly removed, then one final retry is made).
 *
 * Returns an async release function that unlinks the lock file.  Callers
 * must invoke it in a `finally` block; the OS won't auto-release on
 * process exit (stale-lock detection covers that pathology).
 */
async function acquireLock(
  fs: FsModule['fs'],
  lockPath: string,
  totalTimeoutMs: number,
  staleLockMs: number,
): Promise<() => Promise<void>> {
  const start = Date.now();
  let backoffMs = 5;
  // Bounded loop — termination is via either successful acquisition,
  // throw on non-EEXIST error, or throw on total-timeout-exhausted.
  for (;;) {
    try {
      await fs.writeFile(
        lockPath,
        `${process.pid} ${new Date().toISOString()}\n`,
        { flag: 'wx' },
      );
      return async () => {
        try { await fs.unlink(lockPath); } catch { /* swallow — release is best-effort */ }
      };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // POSIX returns `EEXIST` for `O_EXCL` collisions; Windows can also
      // return `EPERM` when the lock file is in a transitional state
      // (e.g. another writer just unlinked it but NTFS hasn't fully freed
      // the directory entry yet — FILE_DISPOSITION_INFO pending), and
      // `EBUSY` if the file is held open by another handle.  Both are
      // benign retry signals; only genuinely unexpected codes (EROFS,
      // ENOSPC, …) should bubble out as a backend error.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
        throw new ObjectStorageBackendError(
          `failed to acquire lock ${lockPath} (code=${code ?? '<none>'})`, e,
        );
      }
      const elapsed = Date.now() - start;
      if (elapsed >= totalTimeoutMs) {
        // Total timeout exhausted — last-ditch stale-lock check.  If the
        // lock file is older than `staleLockMs`, the holder almost
        // certainly crashed; remove it and retry one more time.  If the
        // lock disappears between EEXIST and stat (winner finished mid-
        // check), `continue` lets us retake it normally.
        let stale = false;
        try {
          const stat = await fs.stat(lockPath);
          stale = Date.now() - stat.mtime.getTime() > staleLockMs;
        } catch {
          continue; // lock vanished — try to acquire it on the next loop
        }
        if (stale) {
          try { await fs.unlink(lockPath); } catch { /* race with another reclaimer is fine */ }
          continue;
        }
        throw new ObjectStorageBackendError(
          `timed out acquiring lock ${lockPath} after ${totalTimeoutMs}ms`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(100, backoffMs * 2);
    }
  }
}

/** Cheap content-derived ETag — FNV-1a hex + length suffix. */
function computeEtag(body: Uint8Array): string {
  // Sync, deterministic approximation good enough for FS:
  // 32-bit FNV-1a over the bytes, hex-prefixed.  Real S3 uses MD5/sha256;
  // for our CAS purposes the only invariant required is "same bytes →
  // same etag, different bytes → different etag with very high probability".
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body[i]!;
    hash = (hash * 0x01000193) >>> 0;
  }
  // Mix in length so empty vs single-zero-byte differ trivially.
  hash ^= body.length;
  return `"fs-${(hash >>> 0).toString(16).padStart(8, '0')}-${body.length}"`;
}
