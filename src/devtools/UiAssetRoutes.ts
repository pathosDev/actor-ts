/**
 * Serve the DevTools UI from assets embedded in the compiled module,
 * rather than from files on disk.
 *
 * Why embedded: `bunx tsc` copies no static files, `files: ["dist/"]`
 * would need a separate copy step to publish them, resolving a path
 * relative to the compiled module breaks the moment a consumer bundles
 * their server (or runs `deno compile`), and Deno would additionally
 * need a read permission for the package directory.  Strings in a
 * module flow through the normal build, ship automatically, and need no
 * filesystem access at all.
 *
 * The build script pre-compresses every asset and hashes its content,
 * so the runtime cost here is a map lookup: a gzip-capable client gets
 * the stored bytes verbatim with no CPU spent, and the strong ETag is
 * stable across installs (an mtime-based one is not — npm rewrites
 * mtimes, which would invalidate every cache on every install).
 */
import { gunzipSync } from 'node:zlib';
import { complete, concat, get, path, Status, type Route } from '../http/index.js';
import type { HttpRequest, HttpResponse } from '../http/types.js';

/** One build-time-compressed UI file. */
export interface UiAsset {
  /** Path relative to the UI root, e.g. `index.html`, `assets/main.js`. */
  readonly path: string;
  readonly contentType: string;
  /** Uncompressed byte length. */
  readonly size: number;
  /** Strong ETag derived from the content hash — stable across installs. */
  readonly etag: string;
  /** gzip-compressed content, base64-encoded. */
  readonly gzipBase64: string;
}

/** Entry point the UI shell is served from. */
const INDEX_PATH = 'index.html';

/**
 * Build the routes serving `assets`.
 *
 * The UI is a hash-router single page, so there is deliberately no
 * SPA fallback: every real navigation target is `#/...` on the index,
 * and a request for a missing file is a genuine 404 rather than an
 * index page pretending to be a JavaScript bundle.
 */
export function uiAssetRoutes(assets: ReadonlyArray<UiAsset>): Route {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const identityCache = new Map<string, Uint8Array>();
  const gzipCache = new Map<string, Uint8Array>();

  const serve = (assetPath: string, request: HttpRequest): HttpResponse => {
    const asset = byPath.get(assetPath);
    if (asset === undefined) return complete(Status.NotFound, `no such DevTools asset: ${assetPath}`);

    // Revalidation rather than immutable caching: the assets are served
    // from localhost, so a conditional request is essentially free, and
    // it rules out a stale shell loading a mismatched panel chunk.
    if (request.headers['if-none-match'] === asset.etag) {
      return { status: Status.NotModified, headers: cacheHeaders(asset) };
    }

    if (acceptsGzip(request)) {
      return {
        status: Status.OK,
        headers: { ...cacheHeaders(asset), 'content-encoding': 'gzip' },
        contentType: asset.contentType,
        body: compressedBytes(asset, gzipCache),
      };
    }
    return {
      status: Status.OK,
      headers: cacheHeaders(asset),
      contentType: asset.contentType,
      body: identityBytes(asset, identityCache, gzipCache),
    };
  };

  return concat(
    get((request) => serveIndex(request, serve)),
    path('*', get((request) => serve(request.params['*'] ?? INDEX_PATH, request))),
  );
}

/**
 * Serve the shell, first making sure the document URL ends in a slash.
 *
 * `index.html` references its bundle relatively so DevTools works both
 * at the server root and under a mount prefix.  Relative resolution
 * only lands in the right directory when the document URL has a
 * trailing slash, so `/devtools` has to become `/devtools/` before the
 * page can load `assets/main.js`.
 */
function serveIndex(
  request: HttpRequest,
  serve: (assetPath: string, request: HttpRequest) => HttpResponse,
): HttpResponse {
  if (!request.path.endsWith('/')) {
    return { status: Status.MovedPermanently, headers: { location: `${request.path}/` } };
  }
  return serve(INDEX_PATH, request);
}

function cacheHeaders(asset: UiAsset): Record<string, string> {
  return { etag: asset.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' };
}

function acceptsGzip(request: HttpRequest): boolean {
  const accept = request.headers['accept-encoding'];
  return accept !== undefined && accept.toLowerCase().includes('gzip');
}

/** Stored bytes, decoded from base64 once and kept. */
function compressedBytes(asset: UiAsset, cache: Map<string, Uint8Array>): Uint8Array {
  const cached = cache.get(asset.path);
  if (cached !== undefined) return cached;
  const bytes = base64ToBytes(asset.gzipBase64);
  cache.set(asset.path, bytes);
  return bytes;
}

/** Decompressed bytes for the rare client that cannot take gzip. */
function identityBytes(
  asset: UiAsset,
  cache: Map<string, Uint8Array>,
  gzipCache: Map<string, Uint8Array>,
): Uint8Array {
  const cached = cache.get(asset.path);
  if (cached !== undefined) return cached;
  const bytes = new Uint8Array(gunzipSync(compressedBytes(asset, gzipCache)));
  cache.set(asset.path, bytes);
  return bytes;
}

function base64ToBytes(base64: string): Uint8Array {
  // `atob` is the one base64 decoder present on Bun, Node and Deno
  // without importing a runtime-specific Buffer.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
