import { Lazy } from '../util/Lazy.js';

/**
 * The little bit of filesystem the file sink needs, behind one lazy
 * `node:fs/promises` import.
 *
 * **Why no per-runtime adapter.**  Everything here — `open` with the append
 * flag, `readdir`, `unlink` — is covered by Bun's and Deno's Node
 * compatibility layers, so a single module serves all three runtimes.  The
 * abstractions in `src/runtime/` exist for primitives where that is *not*
 * true (HTTP servers, workers, SQLite); adding one here would be three
 * copies of the same code.
 *
 * **Why not the object-storage backend's `FsModule`.**  That one buffers
 * whole files and has no `open`.  A log file is the opposite case: one
 * handle held open for the life of a rotation period, appended to record by
 * record.  This is the first long-lived file handle in the codebase.
 */

type FileHandleLike = {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
};

type FsModule = {
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
    open(path: string, flags: string): Promise<FileHandleLike>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
  };
  path: {
    join(...parts: string[]): string;
  };
};

const fsLazy: Lazy<Promise<FsModule>> = Lazy.of(async () => {
  // Module names in consts so a bundler's static analysis does not try to
  // follow them into a browser build.
  const fsName = 'node:fs/promises';
  const pathName = 'node:path';
  const fs = (await import(fsName)) as FsModule['fs'];
  const path = (await import(pathName)) as FsModule['path'];
  return { fs, path };
});

/**
 * Errors Windows raises when another process — a virus scanner, an editor,
 * a tail — has the file open for a moment.  They clear on their own, so a
 * short retry turns a spurious failure into a pause nobody notices.  The
 * object-storage backend treats the same three the same way.
 */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [5, 20, 50];

/**
 * A file opened for appending, held open across many writes.
 *
 * **Single writer by contract.**  `FileSink` drains its queue
 * sequentially, so there is never more than one `write` in flight; the
 * class does not serialise for itself.  Two concurrent writers would
 * interleave partial records, which is exactly the corruption the
 * write-until-complete loop below exists to prevent within one record.
 */
export class AppendOnlyFile {
  private constructor(
    readonly path: string,
    private readonly handle: FileHandleLike,
    private written: number,
  ) {}

  /** Open (creating if needed) for appending.  The directory must exist. */
  static async open(path: string): Promise<AppendOnlyFile> {
    const { fs } = await fsLazy.get();
    const handle = await withRetry(() => fs.open(path, 'a'));
    return new AppendOnlyFile(path, handle, 0);
  }

  /** Bytes this handle has written — what size-based rotation counts. */
  get bytesWritten(): number {
    return this.written;
  }

  /**
   * Write every byte, looping until the buffer is exhausted.
   *
   * A single `write` is not guaranteed to take the whole buffer — the
   * underlying syscall may write fewer bytes, and both Node and Deno
   * document that.  Treating one call as complete is how a log file ends
   * up with half a line in it.
   */
  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await this.handle.write(bytes.subarray(offset));
      if (bytesWritten <= 0) {
        throw new Error(`AppendOnlyFile: write to ${this.path} made no progress`);
      }
      offset += bytesWritten;
      this.written += bytesWritten;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

/** Create a directory and its parents.  A directory that exists is fine. */
export async function ensureDirectory(path: string): Promise<void> {
  const { fs } = await fsLazy.get();
  await withRetry(() => fs.mkdir(path, { recursive: true }));
}

/** File names directly inside `path`, unsorted. */
export async function listDirectory(path: string): Promise<string[]> {
  const { fs } = await fsLazy.get();
  return fs.readdir(path);
}

/** Delete a file.  A file that is already gone is not an error. */
export async function deleteFile(path: string): Promise<void> {
  const { fs } = await fsLazy.get();
  try {
    await withRetry(() => fs.unlink(path));
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

/** Read a whole file — used to compress a rotated one. */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const { fs } = await fsLazy.get();
  return fs.readFile(path);
}

/** Write a whole file — used to place a compressed rotated one. */
export async function writeFileBytes(path: string, data: Uint8Array): Promise<void> {
  const { fs } = await fsLazy.get();
  await withRetry(() => fs.writeFile(path, data));
}

/** Join path segments with the platform separator. */
export async function joinPath(...parts: string[]): Promise<string> {
  const { path } = await fsLazy.get();
  return path.join(...parts);
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !TRANSIENT_CODES.has(codeOf(error) ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
