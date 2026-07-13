/**
 * A small, dependency-free MIME-type registry — the response-side sibling
 * of request marshalling.  Maps a file extension to a content-type for the
 * static-file directives (and anyone building file responses by hand).
 */

/** Extension (lowercase, no dot) → content-type (no charset). */
export const DEFAULT_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  apng: 'image/apng',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
});

/** Non-`text/*` types that are still text and should carry a UTF-8 charset. */
const CHARSET_TYPES = new Set([
  'application/json',
  'application/manifest+json',
  'application/xml',
  'application/xhtml+xml',
  'application/yaml',
  'image/svg+xml',
]);

/** Last-segment, last-dot extension, lowercased.  Accepts a path or a bare ext. */
function extensionOf(pathOrExt: string): string {
  const segment = pathOrExt.split(/[\\/]/).pop() ?? '';
  const dot = segment.lastIndexOf('.');
  return (dot < 0 ? segment : segment.slice(dot + 1)).toLowerCase();
}

function needsCharset(type: string): boolean {
  return type.startsWith('text/') || CHARSET_TYPES.has(type);
}

/**
 * Resolve a content-type from a path or bare extension.  Text-ish types
 * get `; charset=utf-8`; unknown extensions fall back to
 * `application/octet-stream`.  `overrides` (ext → full content-type, taken
 * verbatim) win over the defaults.
 */
export function contentTypeFor(pathOrExt: string, overrides?: Readonly<Record<string, string>>): string {
  const ext = extensionOf(pathOrExt);
  const override = overrides?.[ext];
  if (override) return override;
  const base = DEFAULT_MIME_TYPES[ext];
  if (!base) return 'application/octet-stream';
  return needsCharset(base) ? `${base}; charset=utf-8` : base;
}
