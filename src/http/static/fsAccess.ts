/**
 * Cross-runtime filesystem access for static serving.  `node:fs/promises`
 * is lazy-imported (cached) and works on Bun, Node, and Deno via their
 * node-compat layers — no per-runtime adapter needed while bodies are
 * buffered (a future streaming path could add one behind this module).
 */

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

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

/** Directory entries with a file/dir flag. */
export async function readDirectory(path: string): Promise<DirEntry[]> {
  const entries = await (await fsp()).readdir(path, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
}

/** Read the whole file into a Uint8Array (bounded by the caller's maxFileSize). */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buf = await (await fsp()).readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
