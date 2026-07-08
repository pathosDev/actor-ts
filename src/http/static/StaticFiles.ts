/**
 * Static file serving directives — the backend-agnostic replacement for
 * reaching into `@fastify/static`.  Bodies are buffered into memory
 * (bounded by `maxFileSize`); path handling is decode-once-then-validate
 * with root confinement (see {@link resolveStaticPath}).
 */
import { basename, join, sep } from 'node:path';
import { concat, get, path, redirect, type Route } from '../Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../types.js';
import { contentTypeFor } from '../MimeTypes.js';
import { readDirectory, readFileBytes, realPath, statPath, type FileStat } from './fsAccess.js';
import { resolveStaticPath } from './staticPath.js';
import { renderDirectoryListing, type ListingEntry } from './DirectoryListing.js';
import {
  resolveStaticSettings,
  type ResolvedStaticSettings,
  type StaticFilesOptions,
  type StaticFilesOptionsType,
} from './StaticFilesOptions.js';

const notFound = (): HttpResponse => ({ status: Status.NotFound, body: { error: 'not found' } });
const tooLarge = (): HttpResponse => ({ status: 413, body: { error: 'file too large' } });

function queryString(query: HttpRequest['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else params.append(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function weakEtag(stat: FileStat): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** If-None-Match (weak compare, `*`) takes precedence over If-Modified-Since. */
function isNotModified(req: HttpRequest, etag: string | undefined, mtimeMs: number, lastModified: boolean): boolean {
  const inm = req.headers['if-none-match'];
  if (etag && inm !== undefined) {
    if (inm.trim() === '*') return true;
    const strip = (t: string): string => t.trim().replace(/^W\//, '');
    return inm.split(',').some((t) => strip(t) === strip(etag));
  }
  const ims = req.headers['if-modified-since'];
  if (lastModified && ims !== undefined) {
    const since = Date.parse(ims);
    // second-granularity comparison (Last-Modified has no sub-second part)
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

type ParsedRange = { readonly start: number; readonly end: number } | 'unsatisfiable' | null;

function parseRange(header: string, size: number): ParsedRange {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or non-bytes unit → ignore, serve full 200
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;
  let start: number;
  let end: number;
  if (startStr === '') {
    const suffix = parseInt(endStr!, 10);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr!, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
  }
  if (start > end || start >= size) return 'unsatisfiable';
  if (end >= size) end = size - 1;
  return { start, end };
}

/** Build the response for a resolved, confirmed-regular file. */
async function serveResolvedFile(
  fsPath: string,
  stat: FileStat,
  req: HttpRequest,
  settings: ResolvedStaticSettings,
  servedName: string,
): Promise<HttpResponse> {
  if (stat.size > settings.maxFileSize) return tooLarge();
  const isHead = req.method === 'HEAD';
  const etag = settings.etag ? weakEtag(stat) : undefined;
  const lastModified = settings.lastModified ? new Date(stat.mtimeMs).toUTCString() : undefined;

  // The content-type goes on the response's `contentType` field, not a
  // header — otherwise the backends' Uint8Array path overrides it with
  // application/octet-stream (they gate the default on `contentType`).
  const contentType = settings.contentType ?? contentTypeFor(servedName, settings.contentTypes);
  const headers: Record<string, string> = {};
  if (settings.cacheControl) headers['cache-control'] = settings.cacheControl;
  if (etag) headers['etag'] = etag;
  if (lastModified) headers['last-modified'] = lastModified;
  if (settings.ranges) headers['accept-ranges'] = 'bytes';

  if (isNotModified(req, etag, stat.mtimeMs, settings.lastModified)) {
    return { status: Status.NotModified, headers, contentType, body: null };
  }

  const rangeHeader = settings.ranges ? req.headers['range'] : undefined;
  if (rangeHeader !== undefined) {
    const ifRange = req.headers['if-range'];
    // A weak ETag can never satisfy If-Range; only an exact Last-Modified match does.
    const honourRange = ifRange === undefined || ifRange === lastModified;
    if (honourRange) {
      const parsed = parseRange(rangeHeader, stat.size);
      if (parsed === 'unsatisfiable') {
        return { status: 416, headers: { ...headers, 'content-range': `bytes */${stat.size}` }, contentType, body: null };
      }
      if (parsed) {
        const length = parsed.end - parsed.start + 1;
        const rangeHeaders = {
          ...headers,
          'content-range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
          'content-length': String(length),
        };
        if (isHead) return { status: 206, headers: rangeHeaders, contentType, body: null };
        const bytes = await readFileBytes(fsPath);
        return { status: 206, headers: rangeHeaders, contentType, body: bytes.subarray(parsed.start, parsed.end + 1) };
      }
    }
  }

  if (isHead) return { status: Status.OK, headers: { ...headers, 'content-length': String(stat.size) }, contentType, body: null };
  return { status: Status.OK, headers, contentType, body: await readFileBytes(fsPath) };
}

async function renderListing(fsPath: string, req: HttpRequest, atMountRoot: boolean, settings: ResolvedStaticSettings): Promise<HttpResponse> {
  const entries: ListingEntry[] = [];
  for (const entry of await readDirectory(fsPath)) {
    if (settings.dotfiles === 'deny' && entry.name.startsWith('.')) continue;
    const s = await statPath(join(fsPath, entry.name));
    if (!s || (!s.isFile && !s.isDirectory)) continue; // skip broken symlinks / specials
    entries.push({ name: entry.name, isDirectory: entry.isDirectory, size: s.size, mtime: new Date(s.mtimeMs) });
  }
  const html = renderDirectoryListing({ urlPath: req.path, atMountRoot, entries });
  return {
    status: Status.OK,
    contentType: 'text/html; charset=utf-8',
    headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    body: req.method === 'HEAD' ? null : html,
  };
}

async function serveFromDirectory(root: string, rawRest: string, req: HttpRequest, settings: ResolvedStaticSettings): Promise<HttpResponse> {
  const resolved = resolveStaticPath(root, rawRest, { dotfiles: settings.dotfiles });
  if (!resolved.ok) return notFound();

  const stat = await statPath(resolved.fsPath);
  if (!stat) return notFound();

  if (settings.symlinks === 'within-root') {
    const [realFile, realRoot] = await Promise.all([realPath(resolved.fsPath), realPath(root)]);
    if (!realFile || !realRoot || (realFile !== realRoot && !realFile.startsWith(realRoot + sep))) return notFound();
  }

  if (stat.isDirectory) {
    if (!req.path.endsWith('/')) return redirect(`${req.path}/${queryString(req.query)}`, Status.MovedPermanently);
    for (const index of settings.indexFiles) {
      const indexPath = join(resolved.fsPath, index);
      const indexStat = await statPath(indexPath);
      if (indexStat && indexStat.isFile) return serveResolvedFile(indexPath, indexStat, req, settings, index);
    }
    const atMountRoot = rawRest.replace(/^\/+|\/+$/g, '') === '';
    if (settings.browse) return renderListing(resolved.fsPath, req, atMountRoot, settings);
    return notFound();
  }

  if (!stat.isFile) return notFound(); // device files (NUL, CON, …) stat as non-files
  return serveResolvedFile(resolved.fsPath, stat, req, settings, basename(resolved.fsPath));
}

/** Serve a single file at `filePath` with the correct content-type. */
export function getFromFile(filePath: string, options?: StaticFilesOptions): Route {
  const settings = resolveStaticSettings(options);
  return get(async (req) => {
    const stat = await statPath(filePath);
    if (!stat || !stat.isFile) return notFound();
    return serveResolvedFile(filePath, stat, req, settings, basename(filePath));
  });
}

/** Serve files from a directory tree.  With `routePrefix`, mounts under it. */
export function getFromDirectory(fsRoot: string, options?: StaticFilesOptions): Route;
export function getFromDirectory(routePrefix: string, fsRoot: string, options?: StaticFilesOptions): Route;
export function getFromDirectory(a: string, b?: string | StaticFilesOptions, c?: StaticFilesOptions): Route {
  const routePrefix = typeof b === 'string' ? a : undefined;
  const fsRoot = typeof b === 'string' ? b : a;
  const options = typeof b === 'string' ? c : b;
  const settings = resolveStaticSettings(options);
  const inner = concat(
    get((req) => serveFromDirectory(fsRoot, '', req, settings)),
    path('*', get((req) => serveFromDirectory(fsRoot, req.params['*'] ?? '', req, settings))),
  );
  return routePrefix !== undefined ? path(routePrefix, inner) : inner;
}

/** getFromDirectory with directory browsing forced on. */
export function getFromBrowseableDirectory(fsRoot: string, options?: StaticFilesOptions): Route;
export function getFromBrowseableDirectory(routePrefix: string, fsRoot: string, options?: StaticFilesOptions): Route;
export function getFromBrowseableDirectory(a: string, b?: string | StaticFilesOptions, c?: StaticFilesOptions): Route {
  if (typeof b === 'string') {
    const base = (c ?? {}) as Partial<StaticFilesOptionsType>;
    return getFromDirectory(a, b, { ...base, browse: true });
  }
  const base = (b ?? {}) as Partial<StaticFilesOptionsType>;
  return getFromDirectory(a, { ...base, browse: true });
}
