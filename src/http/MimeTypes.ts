/**
 * A small, dependency-free MIME-type registry — the response-side sibling
 * of request marshalling.  Maps a file extension to a content-type for the
 * static-file directives (and anyone building file responses by hand).
 */

/**
 * Extension (lowercase, no dot) → content-type (no charset).
 *
 * The table has a **null prototype**, not merely a freeze.  `Object.freeze`
 * blocks writes and says nothing about reads, and this map is indexed by an
 * attacker-controlled file extension: with `Object.prototype` still in the
 * chain, `DEFAULT_MIME_TYPES['constructor']` answered with the `Object`
 * function and `['__proto__']` with `Object.prototype`.  Those two are the
 * whole exposure — every other inherited member is mixed-case and cannot
 * survive the lowercasing in `extensionOf`.
 *
 * Reads inside this module are guarded independently (`readOwnContentType`),
 * so the null prototype is not the fix; it is here for everyone else.  The map
 * is public API, and a downstream `DEFAULT_MIME_TYPES[ext]` is the very same
 * defect in someone else's file.
 *
 * `satisfies` is load-bearing: `Object.setPrototypeOf` is typed to return
 * `any`, so without it the entries below would go unchecked and the outer
 * annotation would be the only surviving type.
 */
export const DEFAULT_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze(
  Object.setPrototypeOf(
    {
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
    } satisfies Record<string, string>,
    null,
  ) as Record<string, string>,
);

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
 * Read one content-type out of `table`, or `undefined` when the table does not
 * declare that extension **itself**.
 *
 * The guard is positive — `Object.hasOwn` — rather than a list of member names
 * to refuse, for the reason #589 settled in the config parser: a blocklist can
 * never enumerate a prototype chain, which engine and host additions keep
 * extending.  Stating it positively also keeps an *own* key working, so a
 * caller who deliberately maps `constructor` in an override map still gets it
 * back, exactly like any other extension.
 *
 * The `typeof` narrowing is what makes `contentTypeFor`'s `string` return type
 * true rather than merely declared.  `overrides` comes from the caller, so its
 * values are strings only on TypeScript's word — an untyped or deserialized map
 * carries whatever it carries, and a non-string reaching `needsCharset` threw
 * `type.startsWith is not a function` out of a lookup whose documented answer is
 * `application/octet-stream`.  An empty string is treated as absent for the same
 * reason the old truthiness check did: it is not a content-type.
 */
function readOwnContentType(
  table: Readonly<Record<string, string>> | undefined,
  extension: string,
): string | undefined {
  if (table === undefined || !Object.hasOwn(table, extension)) return undefined;
  // Deliberately `unknown`: the declared value type is exactly what is in doubt.
  const value: unknown = table[extension];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve a content-type from a path or bare extension.  Text-ish types
 * get `; charset=utf-8`; unknown extensions fall back to
 * `application/octet-stream`.  `overrides` (ext → full content-type, taken
 * verbatim) win over the defaults.
 *
 * "Unknown" means *not an own key* of either map — see `readOwnContentType`.
 * The extension comes off a request path, so a lookup that resolved through
 * the prototype chain answered `report.constructor` with a function.
 */
export function contentTypeFor(pathOrExt: string, overrides?: Readonly<Record<string, string>>): string {
  const extension = extensionOf(pathOrExt);
  const override = readOwnContentType(overrides, extension);
  if (override !== undefined) return override;
  const base = readOwnContentType(DEFAULT_MIME_TYPES, extension);
  if (base === undefined) return 'application/octet-stream';
  return needsCharset(base) ? `${base}; charset=utf-8` : base;
}
