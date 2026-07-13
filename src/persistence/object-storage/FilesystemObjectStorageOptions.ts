import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

export interface FilesystemObjectStorageOptionsType {
  /** Root directory.  Will be created (recursively) if it doesn't exist. */
  readonly dir: string;
  /**
   * How long to wait when contending for a per-key write lock before
   * giving up with `ObjectStorageBackendError`.  Default 5_000 ms — long
   * enough that legitimate contenders complete first, short enough that
   * a stuck holder gets surfaced quickly.
   */
  readonly lockTimeoutMs?: number;
  /**
   * Lock files older than this are assumed stale (left behind by a
   * crashed writer) and forcibly removed.  Default 30_000 ms — well
   * above the expected duration of any single `put`, so legitimate
   * writers never get their lock yanked.
   */
  readonly staleLockMs?: number;
}

/**
 * Fluent builder for {@link FilesystemObjectStorageOptionsType}.  `dir` is
 * required by the backend:
 *
 *     new FilesystemObjectStorageBackend(
 *       FilesystemObjectStorageOptions.create().withDir('/var/lib/actor-ts'),
 *     )
 */
export class FilesystemObjectStorageOptionsBuilder extends OptionsBuilder<FilesystemObjectStorageOptionsType> {
  /** Start a fresh builder.  Equivalent to `new FilesystemObjectStorageOptionsBuilder()`. */
  static create(): FilesystemObjectStorageOptionsBuilder {
    return new FilesystemObjectStorageOptionsBuilder();
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

/** Validates resolved {@link FilesystemObjectStorageOptionsType} settings. */
export class FilesystemObjectStorageOptionsValidator extends OptionsValidator<FilesystemObjectStorageOptionsType> {
  constructor() {
    super('FilesystemObjectStorageOptions');
  }
  protected rules(s: Partial<FilesystemObjectStorageOptionsType>): void {
    if (s.dir === undefined) this.fail('dir', 'is required (call withDir())');
    this.nonEmptyString('dir');
    this.positiveNumber('lockTimeoutMs');
    this.positiveNumber('staleLockMs');
  }
}

/**
 * Accepted input for the filesystem object-storage backend constructor: the fluent
 * {@link FilesystemObjectStorageOptionsBuilder} OR a plain {@link FilesystemObjectStorageOptionsType} object.
 */
export type FilesystemObjectStorageOptions = FilesystemObjectStorageOptionsBuilder | Partial<FilesystemObjectStorageOptionsType>;
/** Value alias so `FilesystemObjectStorageOptions.create()` / `new FilesystemObjectStorageOptions()` resolve to the builder. */
export const FilesystemObjectStorageOptions = FilesystemObjectStorageOptionsBuilder;
