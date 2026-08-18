/**
 * Static file serving directives — the backend-agnostic replacement for
 * reaching into `@fastify/static`.  Path handling is
 * decode-once-then-validate with root confinement (see
 * {@link resolveStaticPath}).
 *
 * **How much of a file is held in memory.**  By default a body is buffered,
 * bounded by `maxFileSize` (larger → 413) — except that a `Range` now reads
 * only the requested window instead of the whole file (#969).  Set
 * `streamThreshold` and a body at or above it is a `ReadableStream` read in
 * fixed chunks, which is what makes a file larger than memory servable at
 * all; that also retires the 413, because with the threshold enforced at or
 * below `maxFileSize` nothing can buffer past it.
 *
 * **Why streaming is opt-in and not the default (#465).**  A stream body is
 * one-shot and two first-party middlewares still mishandle one: `cached()` /
 * `idempotent()` serialise a body by testing for `Uint8Array` and store a
 * stream as `{}` (#674), and `ExpressBackend` pipes it with no error handler
 * (#979).  Turning streaming on by default would make both live for the
 * out-of-the-box static route rather than latent.  The default stays buffered
 * until those land; flipping it is then a one-line change here.
 */
import { basename, join, sep } from 'node:path';
import { concat, get, path, redirect, type Route } from '../Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../Types.js';
import { contentTypeFor } from '../MimeTypes.js';
import { readDirectory, readFileBytes, readFileRange, readFileStream, realPath, statPath, type FileStat } from './FsAccess.js';
import { resolveStaticPath } from './StaticPath.js';
import { renderDirectoryListing, type ListingEntry } from './DirectoryListing.js';
import { stripSurrounding } from '../../util/StripCharacters.js';
import {
  resolveStaticOptions,
  type ResolvedStaticOptions,
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
  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

function weakEtag(stat: FileStat): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** If-None-Match (weak compare, `*`) takes precedence over If-Modified-Since. */
function isNotModified(request: HttpRequest, etag: string | undefined, mtimeMs: number, lastModified: boolean): boolean {
  const inm = request.headers['if-none-match'];
  if (etag && inm !== undefined) {
    if (inm.trim() === '*') return true;
    const strip = (t: string): string => t.trim().replace(/^W\//, '');
    return inm.split(',').some((t) => strip(t) === strip(etag));
  }
  const ims = request.headers['if-modified-since'];
  if (lastModified && ims !== undefined) {
    const since = Date.parse(ims);
    // second-granularity comparison (Last-Modified has no sub-second part)
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

type ParsedRange = { readonly start: number; readonly end: number } | 'unsatisfiable' | null;

function parseRange(header: string, size: number): ParsedRange {
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!rangeMatch) return null; // multi-range or non-bytes unit → ignore, serve full 200
  const [, startStr, endStr] = rangeMatch;
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

/** Is a body of `byteLength` streamed rather than read into one buffer? */
function streamsAt(settings: ResolvedStaticOptions, byteLength: number): boolean {
  return settings.streamThreshold !== undefined && byteLength >= settings.streamThreshold;
}

/** Build the response for a resolved, confirmed-regular file. */
async function serveResolvedFile(
  fsPath: string,
  stat: FileStat,
  request: HttpRequest,
  settings: ResolvedStaticOptions,
  servedName: string,
): Promise<HttpResponse> {
  // `maxFileSize` bounds what is read into memory, so it only says anything
  // about a *buffered* body.  Once `streamThreshold` is set the validator has
  // already rejected a threshold above the cap, so no response can buffer more
  // than the threshold and this refusal is unreachable — skipping it drops no
  // bound.  Leaving it in would instead refuse exactly the large files
  // streaming exists to serve.
  if (settings.streamThreshold === undefined && stat.size > settings.maxFileSize) return tooLarge();
  const isHead = request.method === 'HEAD';
  const etag = settings.etag ? weakEtag(stat) : undefined;
  const lastModified = settings.lastModified ? new Date(stat.mtimeMs).toUTCString() : undefined;

  // The content-type goes on the response's `contentType` field, not a
  // header — otherwise the backends' Uint8Array path overrides it with
  // application/octet-stream (they gate the default on `contentType`).
  const contentType = settings.contentType ?? contentTypeFor(servedName, settings.contentTypes);
  // `nosniff` is not optional here: the content-type above is derived from a
  // file *name*, so an upload endpoint that stores `evil.html` under an
  // image extension would otherwise let the browser sniff the bytes, decide
  // they are HTML, and execute them in this origin (#127).  The directory
  // listing next door has always sent it; a served file is the far more
  // exposed of the two.
  const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
  if (settings.cacheControl) headers['cache-control'] = settings.cacheControl;
  if (etag) headers['etag'] = etag;
  if (lastModified) headers['last-modified'] = lastModified;
  if (settings.ranges) headers['accept-ranges'] = 'bytes';

  if (isNotModified(request, etag, stat.mtimeMs, settings.lastModified)) {
    return { status: Status.NotModified, headers, contentType, body: null };
  }

  const rangeHeader = settings.ranges ? request.headers['range'] : undefined;
  if (rangeHeader !== undefined) {
    const ifRange = request.headers['if-range'];
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
        // Only the requested window, never the whole file: reading everything
        // and handing back a `subarray` pinned the entire `ArrayBuffer` behind
        // the view for the life of the response, so `bytes=0-0` on a 50 MiB
        // file cost 50 MiB per in-flight request (#969).
        const partial = streamsAt(settings, length)
          ? readFileStream(fsPath, parsed.start, length)
          : await readFileRange(fsPath, parsed.start, length);
        return { status: 206, headers: rangeHeaders, contentType, body: partial };
      }
    }
  }

  if (isHead) return { status: Status.OK, headers: { ...headers, 'content-length': String(stat.size) }, contentType, body: null };
  if (streamsAt(settings, stat.size)) {
    // `content-length` has to be stated here.  Every backend derives it from a
    // `Uint8Array` body and has nothing to measure on a stream, so without it
    // each streamed download silently becomes chunked — no progress bar, and a
    // client cannot tell a truncated transfer from a complete one.  All three
    // apply `response.headers` before they touch the body, so this survives.
    const streamHeaders = { ...headers, 'content-length': String(stat.size) };
    return { status: Status.OK, headers: streamHeaders, contentType, body: readFileStream(fsPath, 0, stat.size) };
  }
  return { status: Status.OK, headers, contentType, body: await readFileBytes(fsPath) };
}

/**
 * `within-root` confinement for one filesystem hop: the canonicalised
 * candidate must be `realRoot` itself or sit beneath it.  The root arrives
 * already canonicalised because a single request checks several candidates
 * — the resolved path, a directory's index file, and every listing entry
 * are separate hops, and a `realpath` on one says nothing about the next
 * (#575).
 */
async function isWithinRoot(candidate: string, realRoot: string): Promise<boolean> {
  const realCandidate = await realPath(candidate);
  if (realCandidate === null) return false;
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}

async function renderListing(
  fsPath: string,
  request: HttpRequest,
  atMountRoot: boolean,
  settings: ResolvedStaticOptions,
  realRoot: string | null,
): Promise<HttpResponse> {
  const entries: ListingEntry[] = [];
  for (const name of await readDirectory(fsPath)) {
    if (settings.dotfiles === 'deny' && name.startsWith('.')) continue;
    const entryPath = join(fsPath, name);
    const stat = await statPath(entryPath);
    if (!stat || (!stat.isFile && !stat.isDirectory)) continue; // skip broken symlinks / specials
    // An out-of-root entry is omitted rather than listed: its name, size and
    // mtime are exactly the metadata `within-root` exists to withhold, and
    // clicking it would 404 anyway.  Every entry is canonicalised, not just
    // the ones a dirent flags as links — `readdir` type flags are false on a
    // filesystem answering DT_UNKNOWN, which would turn this check off
    // silently on the network mounts that need it most.
    if (realRoot !== null && !(await isWithinRoot(entryPath, realRoot))) continue;
    // `isDirectory` comes from the followed stat, not from a dirent: an
    // in-root link to a directory behaves as a directory everywhere else in
    // this module, so the listing links it with a trailing slash too.
    entries.push({ name, isDirectory: stat.isDirectory, size: stat.size, mtime: new Date(stat.mtimeMs) });
  }
  const html = renderDirectoryListing({ urlPath: request.path, atMountRoot, entries });
  return {
    status: Status.OK,
    contentType: 'text/html; charset=utf-8',
    headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
    body: request.method === 'HEAD' ? null : html,
  };
}

async function serveFromDirectory(root: string, rawRest: string, request: HttpRequest, settings: ResolvedStaticOptions): Promise<HttpResponse> {
  const resolved = resolveStaticPath(root, rawRest, { dotfiles: settings.dotfiles });
  if (!resolved.ok) return notFound();

  const stat = await statPath(resolved.fsPath);
  if (!stat) return notFound();

  // Canonical root for the `within-root` policy, resolved once and reused by
  // every later hop of this request; null means the policy is off
  // (`symlinks: 'follow'`) and nothing is confined.
  let realRoot: string | null = null;
  if (settings.symlinks === 'within-root') {
    realRoot = await realPath(root);
    if (realRoot === null || !(await isWithinRoot(resolved.fsPath, realRoot))) return notFound();
  }

  if (stat.isDirectory) {
    if (!request.path.endsWith('/')) return redirect(`${request.path}/${queryString(request.query)}`, Status.MovedPermanently);
    for (const index of settings.indexFiles) {
      const indexPath = join(resolved.fsPath, index);
      const indexStat = await statPath(indexPath);
      if (!indexStat || !indexStat.isFile) continue;
      // The index file is a hop of its own: `<dir>/index.html` can be a link
      // out of the tree even when `<dir>` canonicalises inside it, and
      // `statPath` follows the link, so `isFile` says nothing about where the
      // bytes live.  An escapee counts as absent — the next index name is
      // tried, then the listing or a 404 (#575).
      if (realRoot !== null && !(await isWithinRoot(indexPath, realRoot))) continue;
      return serveResolvedFile(indexPath, indexStat, request, settings, index);
    }
    const atMountRoot = stripSurrounding(rawRest, '/') === '';
    if (settings.browse) return renderListing(resolved.fsPath, request, atMountRoot, settings, realRoot);
    return notFound();
  }

  if (!stat.isFile) return notFound(); // device files (NUL, CON, …) stat as non-files
  return serveResolvedFile(resolved.fsPath, stat, request, settings, basename(resolved.fsPath));
}

/**
 * Serve a single file at `filePath` with the correct content-type.
 *
 * No `within-root` check here, and none is missing: the caller names one
 * exact file instead of a tree, so there is no root to be confined to and
 * following a link is the whole point of naming it.  `symlinks` only has
 * meaning for {@link getFromDirectory}.
 */
export function getFromFile(filePath: string, options?: StaticFilesOptions): Route {
  const settings = resolveStaticOptions(options);
  return get(async (request) => {
    const stat = await statPath(filePath);
    if (!stat || !stat.isFile) return notFound();
    return serveResolvedFile(filePath, stat, request, settings, basename(filePath));
  });
}

/** Serve files from a directory tree.  With `routePrefix`, mounts under it. */
export function getFromDirectory(fsRoot: string, options?: StaticFilesOptions): Route;
export function getFromDirectory(routePrefix: string, fsRoot: string, options?: StaticFilesOptions): Route;
export function getFromDirectory(a: string, b?: string | StaticFilesOptions, c?: StaticFilesOptions): Route {
  const routePrefix = typeof b === 'string' ? a : undefined;
  const fsRoot = typeof b === 'string' ? b : a;
  const options = typeof b === 'string' ? c : b;
  const settings = resolveStaticOptions(options);
  const inner = concat(
    get((request) => serveFromDirectory(fsRoot, '', request, settings)),
    path('*', get((request) => serveFromDirectory(fsRoot, request.params['*'] ?? '', request, settings))),
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
