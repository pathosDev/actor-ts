/**
 * Path-traversal defence for the static-file directives — the security
 * core.  The URL remainder is fully decoded (peeling every encoding layer)
 * BEFORE validation, every segment is checked, and the joined path is
 * confined to the root.  Mirrors the rules in
 * `src/persistence/storage/KeyValidator.ts` (kept local to avoid a
 * src/http → src/persistence layering dependency).
 */
import { join, resolve, sep } from 'node:path';

export type StaticPathResult = { readonly ok: true; readonly fsPath: string } | { readonly ok: false };

const REJECT: StaticPathResult = { ok: false };

/** Peel up to a few URL-encoding layers so validation sees the real value. */
function fullyDecode(input: string): string {
  let current = input;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(current); } catch { return current; } // malformed % → keep as-is
    if (next === current) return current;
    current = next;
  }
  return current;
}

function isUnsafeSegment(segment: string, allowDotfiles: boolean): boolean {
  if (segment === '' || segment === '.' || segment === '..') return true;
  if (segment.includes('\0')) return true;
  if (segment.includes('/') || segment.includes('\\')) return true; // defensive (post-split)
  if (segment.includes(':')) return true; // Windows drive / NTFS alternate data stream
  if (!allowDotfiles && segment.startsWith('.')) return true;
  return false;
}

/**
 * Resolve a URL remainder to a filesystem path under `root`, or reject.
 * Rejections are uniform (the caller answers 404, no existence leak).
 */
export function resolveStaticPath(
  root: string,
  rawRest: string,
  opts: { readonly dotfiles: 'deny' | 'allow' },
): StaticPathResult {
  const decoded = fullyDecode(rawRest);
  if (decoded.includes('\0')) return REJECT;
  // Absolute forms (POSIX root, Windows drive) never come from a rest-path.
  if (decoded.startsWith('/') || decoded.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(decoded)) return REJECT;

  const trimmed = decoded.replace(/\/+$/, ''); // tolerate one trailing slash (directory marker)
  const segments = trimmed.length === 0 ? [] : trimmed.split(/[/\\]/);
  const allowDotfiles = opts.dotfiles === 'allow';
  for (const segment of segments) {
    if (isUnsafeSegment(segment, allowDotfiles)) return REJECT;
  }

  const fsPath = join(root, ...segments);
  // Confinement: the resolved path must be the root itself or beneath it.
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(fsPath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) return REJECT;

  return { ok: true, fsPath };
}
