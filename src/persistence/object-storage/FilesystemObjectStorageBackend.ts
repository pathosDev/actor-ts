import { Lazy } from '../../util/Lazy.js';
import { none, some, type Option } from '../../util/Option.js';
import { randomId } from '../../util/RandomString.js';
import { wrapError } from '../../util/WrapError.js';
import { makeKeyValidator, ObjectStorageWriteKeyRules } from '../storage/KeyValidator.js';
import {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
  resolveObjectStorageIdentity,
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
import type { StorageLocality } from '../StorageLocality.js';

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
 *    ({@link computeEtag} — deterministic truncated SHA-256 + length).  No
 *    in-memory map; the file content alone determines the etag, so a fresh
 *    process sees the exact same etags every other process does.  Same key,
 *    same bytes → same etag, regardless of who wrote them or when.  The
 *    digest is the CAS token and is sized as one — see {@link computeEtag}
 *    for why a cheap non-cryptographic hash is the wrong primitive here
 *    (#786).
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
 *  - **Containment is checked twice, at two different layers.**
 *    {@link assertSafeKey} and {@link assertWithinRoot} are string work and
 *    cannot see a symlink; {@link realPathWithinRoot} canonicalises through
 *    the OS and is what actually confines an operation to the root.  The
 *    guarantee it gives is bounded — see its JSDoc — and the bound is stated
 *    there rather than glossed over, because a confinement comment that
 *    overclaims is what #748 was about.
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
 * This helper is the front-line syntactic check.  {@link assertWithinRoot}
 * below is the lexical backstop for the same class of input, and
 * {@link realPathWithinRoot} is the filesystem-level one — the only of the
 * three that can see a symlink.
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
 * Lexical containment: does `candidate` normalise to `root` itself, or to
 * something beneath it?
 *
 * Shared by both containment call sites so the comparison cannot drift
 * between them — the pre-write lexical check in {@link assertWithinRoot} and
 * the post-`realpath` check in {@link realPathWithinRoot}.
 */
function isWithinRoot(pathMod: FsModule['path'], root: string, candidate: string): boolean {
  const normalizedRoot = pathMod.resolve(root);
  const normalizedCandidate = pathMod.resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot + pathMod.sep);
}

/**
 * Lexical containment check on `path.join(dir, key)`, run before any write.
 *
 * **What it does not do.**  This JSDoc used to claim the check "catches edge
 * cases the syntactic `assertSafeKey` might miss (e.g., URL-encoded
 * traversal, symlinks resolved at OS level)".  Both examples were false, and
 * saying so is the substance of #748: `path.resolve` is a pure string
 * operation.  It collapses `.` and `..` textually and makes the path
 * absolute, and that is all — it does not URL-decode (measured:
 * `path.posix.resolve('/root', '%2e%2e/secret')` is `'/root/%2e%2e/secret'`),
 * and it never opens anything, so it cannot dereference a link.  Everything
 * the filesystem resolves at open time is {@link realPathWithinRoot}'s job.
 *
 * **And it cannot currently fire at all.**  {@link assertSafeKey} (and its
 * strict superset {@link assertSafeWriteKey}) already reject the complete set
 * of inputs that could make `path.join(dir, key)` leave `dir` — absolute
 * paths, drive-letter prefixes, and `..` segments — and `path.join` cannot
 * escape without one of them.  So the `/path-traversal/` rejections in the
 * suite are satisfied by the key validator, whose message carries the same
 * phrase, and say nothing about this function.  It stays as a structural
 * backstop for the day those rules are relaxed or a new caller reaches
 * `path.join` without them; it is not load-bearing today, and the previous
 * text implying otherwise is exactly what stopped anyone from adding the
 * check that is.
 */
function assertWithinRoot(pathMod: FsModule['path'], root: string, fullPath: string): void {
  if (!isWithinRoot(pathMod, root, fullPath)) {
    throw new ObjectStorageBackendError(
      `path-traversal blocked: resolved path "${pathMod.resolve(fullPath)}" ` +
      `escapes root "${pathMod.resolve(root)}"`,
    );
  }
}

/**
 * Canonicalise `candidate` — every component dereferenced by the OS — or
 * `null` when there is nothing at that name.
 *
 * Only `ENOENT` and `ENOTDIR` become `null`.  Those two mean the path, or a
 * component of it, is genuinely absent, which every caller here already
 * treats as "no object stored under this name" (a dangling link lands here
 * too, and reads as absent for the same reason `readFile` would have).
 * Anything else — `EACCES`, `ELOOP`, `EIO` — is surfaced, because a
 * containment check that reads an unreadable path as "absent" has quietly
 * turned itself off.
 */
async function realPathOrNull(
  fs: FsModule['fs'],
  candidate: string,
  key: string,
): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw wrapError(e, ObjectStorageBackendError, `filesystem realpath failed for ${key}`);
  }
}

/**
 * Filesystem-level containment for one hop: `candidate` is resolved through
 * the OS — every component, including a link at the final one — and the
 * result must be `realRoot` or sit beneath it.  Returns the canonical path,
 * or `null` when `candidate` does not resolve at all.
 *
 * This is the check the lexical one cannot be.  A link planted at any segment
 * of a key — `<root>/snapshots/tenant-1` pointing at `/home/app/.ssh` — moves
 * the write out of the root while every string comparison still says it is
 * inside, and `mkdir(recursive)` traverses such a link happily.  `realpath`
 * is what sees it.
 *
 * Two bounds on the claim, both deliberate:
 *
 *  - **It narrows the race, it does not close it.**  A link can be planted
 *    between this call and the `rename` or `readFile` that follows.  Closing
 *    that needs `O_NOFOLLOW` or `openat`; `node:fs/promises` exposes neither
 *    portably, and `O_NOFOLLOW` does not exist on Windows at all.  So the
 *    guarantee is "a link already in place is refused", not "a link can never
 *    win".
 *  - **`realRoot` must already be canonical.**  A root that is itself a
 *    symlink is legitimate and common (`/var/lib/app -> /mnt/data`), so the
 *    comparison is against the *resolved* root; comparing against the
 *    configured spelling would reject every write into such a root.
 */
async function realPathWithinRoot(
  fs: FsModule['fs'],
  pathMod: FsModule['path'],
  realRoot: string,
  candidate: string,
  key: string,
): Promise<string | null> {
  const realCandidate = await realPathOrNull(fs, candidate, key);
  if (realCandidate === null) return null;
  if (!isWithinRoot(pathMod, realRoot, realCandidate)) {
    throw new ObjectStorageBackendError(
      `path-traversal blocked for key ${key}: "${candidate}" resolves to ` +
      `"${realCandidate}", outside root "${realRoot}"`,
    );
  }
  return realCandidate;
}

export class FilesystemObjectStorageBackend implements ObjectStorageBackend {
  /**
   * A directory on this machine's disk — `'node-local'` by default.  The
   * multi-process safety above is per-machine (advisory file locks); a
   * genuinely shared mount may declare `'shared'` after construction, the
   * same escape hatch the in-memory stores carry (#1356).
   */
  storageLocality: StorageLocality = 'node-local';
  private mintedStorageIdentity: string | null = null;
  private readonly dir: string;

  /** Identity of the directory — every store over this backend shares it (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.mintedStorageIdentity === null) {
      this.mintedStorageIdentity = await resolveObjectStorageIdentity(this);
    }
    return this.mintedStorageIdentity;
  }
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
    const parentDirectory = path.dirname(fullPath);

    // Parent directory must exist before lock acquisition (the lock file
    // lives there).  `mkdir(recursive)` is idempotent across processes,
    // so concurrent puts to a fresh dir don't race here.
    await fs.mkdir(parentDirectory, { recursive: true });

    // …and it must be the directory it claims to be.  Placed before the lock
    // is taken, so a refused key never leaves a `<key>.lock` outside the root
    // either — that would be an arbitrary-file *create* even though no body
    // ever lands.
    //
    // One residual, written down rather than left for the next reader to
    // discover: `mkdir(recursive)` has already run by this point, so a link
    // planted at a key segment can still cause *empty directories* to appear
    // under its target before the write is refused.  Checking first instead
    // would not remove it — the deepest existing ancestor is what a check can
    // canonicalise, and `mkdir` creates everything below it either way.
    const realRoot = await this.requireCanonicalRoot(fs, key, 'put');
    await realPathWithinRoot(fs, path, realRoot, parentDirectory, key);

    const release = await acquireLock(fs, lockPath, this.lockTimeoutMs, this.staleLockMs);
    try {
      // `<key>` itself is a second hop, and the parent's canonical path does
      // not cover it — the two checks answer different questions and neither
      // subsumes the other.  The parent governs where the body *lands*:
      // `rename` replaces the destination entry and never follows a link
      // sitting at it, so the write goes wherever the parent really is.  This
      // one governs what the CAS read below *opens*, and `readFile` does
      // follow a link at the final component, exactly as it does in `get`.
      // Without it a link planted at `<key>` and pointing out of the root was
      // read and hashed, and the mismatch message handed the caller the
      // target's exact byte length and its content digest — an oracle for a
      // file this backend is documented as unable to reach.  `ifNoneMatch:
      // '*'` leaked the coarser half of the same fact.
      //
      // **Inside the lock, unlike the parent check, and that is load-bearing
      // on Windows.**  Canonicalising a path opens a handle to it, and
      // `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` refuses with `EPERM` while
      // another handle is open on the destination.  Run before the lock, this
      // hop is one every contending writer performs on the *same* name the
      // lock winner is about to rename over — so the winner's own `put` starts
      // failing with `filesystem put-write failed … EPERM`, on a key with no
      // link anywhere near it.  Measured on this file's 10-way CAS race, 60
      // attempts per variant: 0/60 before the hop existed, 8/60 with it before
      // the lock, 0/60 with it here.
      //
      // Under the lock it is also the *narrower* check, not merely the
      // survivable one: the window this class of guard cannot close is the gap
      // between canonicalising and opening, and here that gap is two
      // statements rather than a lock acquisition — up to `lockTimeoutMs`.
      // What the parent check needs from its own position is unchanged: it is
      // what makes `<key>.lock` provably land inside the root, so it has to
      // precede the file that proves it.
      //
      // `null` is the ordinary first write: nothing at that name to
      // canonicalise, and nothing for `readFile` to open either.  Note this
      // resolves against the *resolved* root, not the configured spelling — a
      // root that is itself a link is legitimate, and comparing against the
      // spelling would pass every first write and refuse every overwrite.
      await realPathWithinRoot(fs, path, realRoot, fullPath, key);

      // Read current state from disk — disk is canonical, no in-memory
      // shadow that could disagree with another process's writes.
      let existing: Uint8Array | undefined;
      try {
        existing = new Uint8Array(await fs.readFile(fullPath));
      } catch (e) {
        if ((e as { code?: string })?.code !== 'ENOENT') {
          throw new ObjectStorageBackendError(
            `filesystem put-read-current failed for ${key}`, e,
          );
        }
        // ENOENT → object doesn't exist yet; `existing` stays undefined, and
        // so does the `currentEtag` derived from it below.
      }
      // Digest outside the `try`, deliberately.  Only `readFile` is the read
      // this branch is reporting on; a `computeEtag` failure is a WebCrypto
      // fault and would otherwise be relabelled "put-read-current failed",
      // pointing at the disk for a problem that is not there.
      const currentEtag = existing === undefined ? undefined : await computeEtag(existing);

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
      // the sidecar's own rename leaves the body without metadata, which
      // `get` tolerates by treating the sidecar as optional.
      //
      // Written through the same temp+rename as the body, and for the second
      // of that pattern's two reasons rather than the first: this name is
      // fully deterministic, so unlike the CSPRNG temp path it *can* be
      // pre-planted as a symlink, and `writeFile`'s default `'w'` flag
      // (`O_CREAT|O_TRUNC`) follows one and truncates its target.  `rename`
      // replaces the destination entry itself and never follows a link
      // sitting there, so a planted link is overwritten instead.  `{ flag:
      // 'wx' }` — what #748 originally suggested — cannot be used here:
      // `get` reads this exact name back, so a re-put of the same key must
      // legitimately replace it, and an exclusive create would fail every
      // time.
      if (options.contentEncoding || options.contentType) {
        const meta = JSON.stringify({
          contentEncoding: options.contentEncoding,
          contentType: options.contentType,
        });
        const metaPath = fullPath + '.meta.json';
        const metaTmpPath = `${metaPath}.tmp.${process.pid}.${randomId(12)}`;
        try {
          await fs.writeFile(metaTmpPath, meta);
          await fs.rename(metaTmpPath, metaPath);
        } catch (e) {
          try { await fs.unlink(metaTmpPath); } catch { /* may not exist */ }
          throw wrapError(e, ObjectStorageBackendError, `filesystem put-meta failed for ${key}`);
        }
      }

      return { etag: await computeEtag(body) };
    } finally {
      await release();
    }
  }

  async get(key: string): Promise<Option<ObjectFetched>> {
    assertSafeKey(key);
    const { fs, path } = await fsLazy.get();
    const fullPath = path.join(this.dir, key);
    assertWithinRoot(path, this.dir, fullPath);
    // The read path needs the same containment as the write path, and one
    // hop more: `readFile` follows a link at the *final* component, so
    // `<key>` itself being a link out of the root leaks the target's bytes.
    // Resolving `fullPath` covers that and the linked-parent case in one
    // call, since `realpath` walks every component.  An unresolvable root
    // means nothing is stored at all — the same `none` the missing-file
    // branch below returns.
    const realRoot = await realPathOrNull(fs, this.dir, key);
    if (realRoot === null) return none;
    if ((await realPathWithinRoot(fs, path, realRoot, fullPath, key)) === null) return none;
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
    // The sidecar is a hop of its own: `<key>` can canonicalise inside the
    // root while `<key>.meta.json` is a link out of it.  An escaping sidecar
    // is refused rather than skipped — a planted link inside the storage root
    // is a compromise indicator, not a missing-metadata case, and swallowing
    // it here would leave the only symptom in a `catch {}`.
    const metaPath = fullPath + '.meta.json';
    if ((await realPathWithinRoot(fs, path, realRoot, metaPath, key)) !== null) {
      try {
        const metaRaw = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw) as { contentEncoding?: string; contentType?: string };
        contentEncoding = meta.contentEncoding;
        contentType = meta.contentType;
      } catch { /* unreadable or malformed sidecar → leave undefined */ }
    }
    return some({
      body,
      etag: await computeEtag(body),
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
    const parentDirectory = path.dirname(fullPath);

    // Lock so a concurrent put doesn't see a half-deleted state mid-CAS.
    // We may be deleting a never-written key (idempotent), but the
    // serialization vs. concurrent puts still matters.
    await fs.mkdir(parentDirectory, { recursive: true });
    // Only the parent needs canonicalising here: `unlink` does not follow a
    // link at the final component, so `delete('<key>')` where `<key>` is a
    // link removes the link and leaves its target alone.  A linked *parent*
    // is the reachable half, and would unlink a file outside the root.
    const realRoot = await this.requireCanonicalRoot(fs, key, 'delete');
    await realPathWithinRoot(fs, path, realRoot, parentDirectory, key);
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
    //
    // The seed is also the one hop of this walk a symlink can move, so it
    // gets the filesystem-level check too (#748): `readdir` resolves the
    // directory it is handed, links included, so a prefix naming a linked
    // segment would enumerate the link's target — names, sizes and mtimes
    // from outside the root.  Before the walk was seeded from the prefix
    // that was unreachable, which is why the check arrives with the seed.
    //
    // Nothing *below* the seed needs one.  A `withFileTypes` dirent describes
    // the entry itself and not what it points at — for a symlink `isFile()`
    // and `isDirectory()` are both false — so a linked subdirectory is never
    // descended into and a linked file is never `stat`ed.  That also fails
    // closed on a filesystem answering `DT_UNKNOWN` (some network and FUSE
    // mounts), where every `isX()` is false and entries drop out of the
    // listing rather than being followed.
    if (startDirectory !== '') {
      assertWithinRoot(path, root, path.join(root, startDirectory));
      const realRoot = await realPathOrNull(fs, root, `list prefix ${options.prefix}`);
      // An unresolvable root has nothing to list — the same empty answer the
      // walk's own ENOENT branch gives.
      if (realRoot === null) return [];
      await realPathWithinRoot(
        fs, path, realRoot, path.join(root, startDirectory), `list prefix ${options.prefix}`,
      );
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

  /**
   * The configured root with every symlink dereferenced, for a caller that
   * has just guaranteed the root exists (`put` and `delete` both `mkdir` the
   * key's parent, which creates the root on the way).  A `null` from
   * {@link realPathOrNull} therefore means the root was removed underneath
   * the operation, and writing blind into whatever now sits at that name is
   * exactly what the containment check exists to prevent — so it is refused
   * rather than skipped.
   *
   * `get` and `list` do not use this: for a read, an absent root simply means
   * nothing is stored, so they take the `null` and answer empty.
   */
  private async requireCanonicalRoot(
    fs: FsModule['fs'],
    key: string,
    operation: string,
  ): Promise<string> {
    const realRoot = await realPathOrNull(fs, this.dir, key);
    if (realRoot === null) {
      throw new ObjectStorageBackendError(
        `filesystem ${operation} failed for ${key}: root "${this.dir}" does not resolve`,
      );
    }
    return realRoot;
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
    /**
     * `stat` without dereferencing a final-component link.  The lock
     * reclaim in {@link acquireLock} is the only caller, and it needs the
     * two things `stat` cannot give it: the age of the *entry* rather than
     * of whatever it points at, and whether the entry is a regular file.
     */
    lstat(p: string): Promise<{ mtime: Date; isFile(): boolean; isSymbolicLink(): boolean }>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<DirectoryEntry[]>;
    unlink(p: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    realpath(p: string): Promise<string>;
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
 *
 * Standing in a directory for its subtree this way assumes the comparator is
 * prefix-monotone — that `D/` sorting before a sibling file `F` implies every
 * `D/…` beneath it does too.  `localeCompare` is not lexicographic and does
 * not guarantee that in general: a name holding a character that collates
 * *primary-equal* to `/`, such as U+FF0F FULLWIDTH SOLIDUS, makes `D/` a
 * collation-prefix of `F` and the two orders can then disagree.  Measured over
 * every printable-ASCII sibling pair (~70k comparisons) there is no such
 * disagreement, so the exit is exact for any key a caller is plausibly using;
 * the exotic case still returns the right *number* of entries, correctly
 * sorted, just not necessarily the same subset the unlimited listing starts
 * with.  Making it exact everywhere would mean changing the comparator `list`
 * sorts by — a contract-wide ordering decision affecting the S3 backend too,
 * not something this walk may settle on its own.
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
 *
 * It covers *both* temp writes, and that is why the metadata sidecar's temp
 * name is `<key>.meta.json.tmp.<pid>.<random>` and not some third shape: the
 * `.meta.json` suffix rule alone would not match it, this rule does, and one
 * pattern that both writers satisfy is one fewer thing to keep in lockstep.
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
 *
 * **The reclaim is the part that needs care, not the acquire** (#1360).
 * Creating the lock is safe by construction: POSIX specifies that an
 * `O_CREAT|O_EXCL` open fails with `EEXIST` when the final component is a
 * symbolic link, whatever it points at, so `{ flag: 'wx' }` never follows one.
 * The reclaim then has to decide, about a name someone else may have planted,
 * both *how old it is* and *whether it is ours to remove* — and `stat` answers
 * the first question about the link's target instead of about the link.  See
 * the branch itself for what each check buys.
 */
async function acquireLock(
  fs: FsModule['fs'],
  lockPath: string,
  totalTimeoutMs: number,
  staleLockMs: number,
): Promise<() => Promise<void>> {
  const start = Date.now();
  let backoffMs = 5;
  // One reclaim round, which the JSDoc above has always promised ("one final
  // retry") but the code did not enforce.  It is load-bearing rather than
  // tidiness: the reclaim branch is only reachable once the timeout is already
  // exhausted, and both of its `continue`s skip the backoff — so any entry that
  // keeps producing the same answer spins a core with no way out.  A dangling
  // link at `<key>.lock` was exactly such an entry before this function used
  // `lstat`: `wx` refused it with `EEXIST` while `stat` followed it to nothing
  // and threw `ENOENT`, and the two disagreed forever.  `lstat` closes that
  // particular disagreement; the bound closes the shape.
  let reclaimAttempted = false;
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
        // lock disappears between EEXIST and lstat (winner finished mid-
        // check), `continue` lets us retake it normally.
        if (reclaimAttempted) {
          throw new ObjectStorageBackendError(
            `timed out acquiring lock ${lockPath} after ${totalTimeoutMs}ms`,
          );
        }
        reclaimAttempted = true;
        let entry: { mtime: Date; isFile(): boolean; isSymbolicLink(): boolean };
        try {
          // `lstat`, never `stat`.  A link planted at `<key>.lock` is aimed at
          // an old file precisely so the age test below says "stale": `stat`
          // reports the *target's* mtime, which lets whoever planted the link
          // choose the answer.  `lstat` reports the link's own, which is by
          // definition as young as the moment it was planted.
          entry = await fs.lstat(lockPath);
        } catch {
          continue; // lock vanished — try to acquire it on the next loop
        }
        if (!entry.isFile()) {
          // Refuse rather than remove.  This function only ever creates a
          // regular file here, so anything else is a name someone else owns,
          // and unlinking it would make the reclaim a delete primitive aimed
          // at a path this backend never chose.
          //
          // What that is *not*: `unlink` does not follow a final-component
          // link — it removes the link and leaves the target alone, the same
          // POSIX rule `delete` relies on above — so the pre-fix code never
          // deleted the target.  The reachable damage was narrower and still
          // real: the staleness question was answered by the target, and a
          // planted link turned the reclaim into a spin (see `reclaimAttempted`).
          throw new ObjectStorageBackendError(
            `refusing to reclaim lock ${lockPath}: not a regular file `
            + `(${entry.isSymbolicLink() ? 'symbolic link' : 'directory or special file'})`,
          );
        }
        if (Date.now() - entry.mtime.getTime() > staleLockMs) {
          // A window stays open between `lstat` and `unlink`, and closing it
          // needs `unlinkat`/`O_NOFOLLOW`, which `node:fs/promises` does not
          // expose portably — the same bound `realPathWithinRoot` records for
          // its own hop.  It is narrower here than it looks: `unlink` cannot
          // follow a link, so the worst a winner of that race gets is our own
          // lock file removed, which is the outcome of an ordinary
          // two-reclaimer race anyway.
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

/**
 * Width of the SHA-256 digest an etag carries, in bytes — 16, rendered as
 * 32 hex characters.
 *
 * Same truncation the integrity tag next door uses, for the same reason
 * `Integrity.ts` gives for its `HMAC_TAG_LENGTH`: 128 bits sits well above
 * any practical forgery threshold while keeping the token a fixed, readable
 * length.  It stays in this file rather than moving to
 * `src/persistence/Constants.ts` because it is not a tuned bound — it is a
 * size fixed by the primitive chosen here and baked into the etag's own
 * string format, the same category as `Encryption.ts`'s `IV_LENGTH`.
 */
const ETAG_DIGEST_BYTES = 16;

/**
 * Content-derived ETag — `"fs-<32 hex chars>-<byte length>"`, where the hex
 * is SHA-256 over the body truncated to {@link ETAG_DIGEST_BYTES}.
 *
 * **This is the compare-and-swap token, not a cache validator**, which is the
 * whole of #786.  `put` re-derives it from disk and compares it against
 * `options.ifMatch` to decide whether the caller's read is still current, and
 * `ObjectStorageDurableStateStore` builds that `ifMatch` from the etag it
 * cached — so equality here *is* the durable-state concurrency check.
 *
 * It used to be a 32-bit FNV-1a xor'd with the length, and the comment here
 * scoped its invariant to "different bytes → different etag with very high
 * probability".  That is an accidental-collision claim, and it was true: a
 * chance collision needs ~65k distinct same-length bodies at one key, which no
 * durable-state record produces.  The claim a CAS token actually has to make
 * is the adversarial one, and FNV-1a makes none — it is trivially invertible
 * by construction, so a stale writer who drives the plaintext can *compute* a
 * body matching an etag they still hold rather than search for one, and win a
 * CAS check they should lose.
 *
 * **Be precise about how live that is.**  Nobody constructed the collision,
 * the preconditions stack (this backend rather than S3, an attacker who both
 * drives the plaintext and holds write access, and a body whose *length* also
 * matches since the length is a literal component of the string), and the
 * per-key `O_EXCL` lock in {@link acquireLock} already removes the ordinary
 * race — it just cannot make the comparison itself sound, because a colliding
 * body passes it whether or not it was taken under the lock.  The S3 backend
 * was never affected: it forwards `IfMatch` to the service and returns S3's
 * own ETag.  So the defensible statement is the hygiene one — a
 * security-relevant equality check should not rest on a four-byte
 * non-cryptographic hash — not that there is an exploit in the field.
 *
 * **No cheap fallback, deliberately.**  `Integrity.ts` and `Encryption.ts`
 * next door resolve `SubtleCrypto` the same way and throw when it is absent;
 * this follows them rather than `IdempotencyKey.ts`, which degrades to FNV-1a
 * for exotic runtimes.  A silent downgrade path would reinstate exactly the
 * defect above on whichever runtime took it, and no runtime this backend can
 * even load on needs one: it already hard-depends on `node:fs/promises`, and
 * every runtime the framework supports that has that also exposes WebCrypto
 * as a global (Bun, Node ≥ 24, Deno).
 */
async function computeEtag(body: Uint8Array): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) {
    throw new ObjectStorageBackendError(
      'SubtleCrypto is not available in this runtime.  The filesystem '
      + 'object-storage backend derives its compare-and-swap ETag from '
      + 'SHA-256 and so requires WebCrypto — Node, Bun, or Deno.',
    );
  }
  // Cast through BufferSource — TS 5.7+'s DOM types tighten the
  // `BufferSource` constraint in a way that doesn't match
  // `Uint8Array<ArrayBufferLike>` cleanly.  Same cast, same reason, as
  // `computeRequestFingerprint` in `src/http/cache/IdempotencyKey.ts`.
  const digest = await subtle.digest('SHA-256', body as unknown as BufferSource);
  const truncated = new Uint8Array(digest).subarray(0, ETAG_DIGEST_BYTES);
  const hex = Array.from(truncated, (byte) => byte.toString(16).padStart(2, '0')).join('');
  // The length stays in the string.  It buys nothing against an adversary now
  // that the digest carries the weight, but it is part of the format callers
  // and fixtures already match on, and it keeps a mismatch message legible.
  return `"fs-${hex}-${body.length}"`;
}
