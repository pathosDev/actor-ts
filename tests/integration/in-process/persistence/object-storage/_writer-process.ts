/**
 * Test fixture — performs a single `put` against the filesystem object
 * storage backend and exits with a status code that lets the parent
 * test count outcomes:
 *
 *   exit 0   → the put succeeded; stdout has the JSON `{ ok: true, etag }`.
 *   exit 2   → the put failed with `ObjectStorageConcurrencyError`
 *              (i.e. lost the CAS race); stdout has `{ ok: false, cas: true }`.
 *   exit 1   → any other failure; stdout has `{ ok: false, error }`.
 *
 * Used by the multi-process test to spawn N concurrent Bun processes
 * that all hit the same key — the per-key file lock plus disk-canonical
 * etag must keep the directory consistent regardless of process count.
 *
 * Usage:
 *   bun _writer-process.ts <dir> <key> <body> <mode>
 *
 * where `<mode>` is either `create-only` (use `ifNoneMatch: '*'`) or
 * `unconditional`.
 */
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageConcurrencyError } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';

const [, , dir, key, body, mode] = process.argv;

if (!dir || !key || body === undefined || !mode) {
  process.stderr.write('usage: writer-process <dir> <key> <body> <mode>\n');
  process.exit(64);
}

const backendOptions = FilesystemObjectStorageOptions.create()
  .withDir(dir);
const backend = new FilesystemObjectStorageBackend(backendOptions);
const opts = mode === 'create-only' ? { ifNoneMatch: '*' as const } : {};

try {
  const { etag } = await backend.put(key, new TextEncoder().encode(body), opts);
  process.stdout.write(JSON.stringify({ ok: true, etag, body }) + '\n');
  process.exit(0);
} catch (e) {
  if (e instanceof ObjectStorageConcurrencyError) {
    process.stdout.write(JSON.stringify({ ok: false, cas: true }) + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + '\n');
  process.exit(1);
}
