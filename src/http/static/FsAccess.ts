/**
 * Cross-runtime filesystem access for static serving.  `node:fs/promises`
 * is lazy-imported (cached) and works on Bun, Node, and Deno via their
 * node-compat layers — no per-runtime adapter needed while bodies are
 * buffered (a future streaming path could add one behind this module).
 */

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
