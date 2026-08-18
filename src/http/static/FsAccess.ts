/**
 * Cross-runtime filesystem access for static serving — the one module the
 * static directives read files through.  `node:fs/promises` is lazy-imported
 * (cached) and works on Bun, Node, and Deno via their node-compat layers.
 *
 * **Why no `src/runtime/` adapter.**  The abstractions there exist for
 * primitives the three runtimes genuinely disagree about (HTTP servers,
 * sockets, workers, SQLite).  Everything used here — `stat`, `realpath`,
 * `readdir`, `readFile`, and `open` plus positional `FileHandle.read` — is
 * covered identically by all three node-compat layers, verified by executing
 * the same script on each; a per-runtime adapter would be three copies of one
 * file.  `src/logging/AppendOnlyFile.ts:3-18` makes the same argument for the
 * same reason.
 *
 * What is deliberately *not* used is the obvious streaming shortcut:
 * `FileHandle.readableWebStream`, `fs.createReadStream`, `Bun.file()` and
 * `Deno.open()` are each missing or differently shaped on at least one of the
 * three, so {@link readFileStream} builds the `ReadableStream` by hand over
 * positional reads instead.  That is the portable intersection.
 */
import { STATIC_FILE_READ_CHUNK_BYTES } from '../Constants.js';

export type FileStat = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
};

let fsPromises: typeof import('node:fs/promises') | undefined;
async function fsp(): Promise<typeof import('node:fs/promises')> {
  if (!fsPromises) fsPromises = await import('node:fs/promises');
  return fsPromises;
}

/** stat, mapped to our minimal shape; null on any error (ENOENT, ENOTDIR, …). */
export async function statPath(path: string): Promise<FileStat | null> {
  try {
    const stat = await (await fsp()).stat(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

/** Canonicalised real path (follows symlinks); null on error. */
export async function realPath(path: string): Promise<string | null> {
  try {
    return await (await fsp()).realpath(path);
  } catch {
    return null;
  }
}

/**
 * Entry names in a directory.  Names only, deliberately: the dirent's own
 * type is unreliable as a classification (a filesystem that answers
 * `DT_UNKNOWN` — network mounts, some FUSE layers — makes every `isX()`
 * false, and a link to a directory is a plain link to a dirent), so the
 * caller classifies each entry with a followed {@link statPath} instead.
 */
export async function readDirectory(path: string): Promise<string[]> {
  return await (await fsp()).readdir(path);
}

/** Read the whole file into a Uint8Array (bounded by the caller's maxFileSize). */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buffer = await (await fsp()).readFile(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * The slice of a `FileHandle` the two windowed readers below use.  Structural
 * rather than the imported `FileHandle` type so this module states exactly
 * which two calls it depends on being uniform across the runtimes — the
 * positional `read(buffer, offset, length, position)` overload and `close`.
 */
type FileHandleLike = {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
};

async function openForReading(path: string): Promise<FileHandleLike> {
  return await (await fsp()).open(path, 'r');
}

/**
 * Read the `length` bytes starting at `start` into a buffer of exactly that
 * size — the bounded alternative to reading the whole file and returning a
 * `subarray` view of it.
 *
 * The view is why this exists: a `subarray` keeps the whole `ArrayBuffer`
 * alive, so answering `bytes=0-0` on a 50 MiB file used to pin 50 MiB for as
 * long as the response lived, once per in-flight request (#969).  The buffer
 * handed back here is the response's own and nothing larger is ever allocated.
 *
 * A single `read` may return fewer bytes than asked for, so the loop runs
 * until the window is full or the file ends.  A file truncated between the
 * caller's `stat` and this read yields a short result rather than an error,
 * which is what the whole-file read did too.
 */
export async function readFileRange(path: string, start: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  const handle = await openForReading(path);
  try {
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead <= 0) break; // end of file — the file shrank under us
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/**
 * A `ReadableStream` over the `length` bytes at `start`, read in
 * {@link STATIC_FILE_READ_CHUNK_BYTES} chunks — the source behind a streamed
 * static response, so a large file costs one chunk of memory instead of its
 * whole size.
 *
 * **The handle opens on the first `pull`, not in `start`.**  A response object
 * is not a promise that it will be written: a route can be composed, replaced
 * by middleware, or dropped when the client vanishes before the body is
 * touched.  Opening lazily means a stream nobody reads holds no file handle at
 * all, so the only way to leak one is an abandoned *partially-read* stream —
 * and the stream closes its handle on all three of its own exits (last chunk,
 * read error, `cancel`).
 *
 * `pull` is never re-entered before the previous call settles, so `handle`,
 * `position` and `remaining` need no synchronisation.
 */
export function readFileStream(path: string, start: number, length: number): ReadableStream<Uint8Array> {
  let handle: FileHandleLike | undefined;
  let position = start;
  let remaining = length;
  // Idempotent: `cancel` can arrive while the last `pull` is still settling,
  // and closing a handle twice is an error on Node.
  const releaseHandle = async (): Promise<void> => {
    const open = handle;
    handle = undefined;
    if (open) await open.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        await releaseHandle();
        controller.close();
        return;
      }
      try {
        handle ??= await openForReading(path);
        const chunk = new Uint8Array(Math.min(STATIC_FILE_READ_CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead <= 0) {
          // Truncated under us.  Ending the body short beats erroring: the
          // content-length is already on the wire either way.
          remaining = 0;
          await releaseHandle();
          controller.close();
          return;
        }
        position += bytesRead;
        remaining -= bytesRead;
        controller.enqueue(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
        if (remaining <= 0) {
          await releaseHandle();
          controller.close();
        }
      } catch (error) {
        await releaseHandle();
        controller.error(error);
      }
    },
    async cancel() {
      remaining = 0;
      await releaseHandle();
    },
  });
}
