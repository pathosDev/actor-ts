import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { FilesystemObjectStorageSettings } from './FilesystemObjectStorageBackend.js';

/**
 * Fluent builder for {@link FilesystemObjectStorageSettings}.  `dir` is
 * required by the backend:
 *
 *     new FilesystemObjectStorageBackend(
 *       FilesystemObjectStorageOptions.create().withDir('/var/lib/actor-ts'),
 *     )
 */
export class FilesystemObjectStorageOptions extends OptionsBuilder<FilesystemObjectStorageSettings> {
  /** Start a fresh builder.  Equivalent to `new FilesystemObjectStorageOptions()`. */
  static create(): FilesystemObjectStorageOptions {
    return new FilesystemObjectStorageOptions();
  }

  /** Root directory.  Created recursively if it doesn't exist. */
  withDir(dir: string): this {
    return this.set('dir', dir);
  }

  /** How long to contend for a per-key write lock before giving up.  Default 5_000 ms. */
  withLockTimeoutMs(lockTimeoutMs: number): this {
    return this.set('lockTimeoutMs', lockTimeoutMs);
  }

  /** Lock files older than this are treated as stale and forcibly removed.  Default 30_000 ms. */
  withStaleLockMs(staleLockMs: number): this {
    return this.set('staleLockMs', staleLockMs);
  }
}
