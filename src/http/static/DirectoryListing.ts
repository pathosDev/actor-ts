/**
 * Minimal HTML directory listing.  Entry names are HTML-escaped in text
 * and URL-encoded in hrefs, so a filename like `<script>x</script>` can
 * neither break out of the markup nor the attribute (XSS defence).
 */
import { escapeHtml } from '../Html.js';

export interface ListingEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtime: Date;
}

export interface ListingInput {
  /** Request path, for the heading (escaped). */
  readonly urlPath: string;
  /** Omit the `../` parent link at the mount root. */
  readonly atMountRoot: boolean;
  readonly entries: readonly ListingEntry[];
}

function formatMtime(d: Date): string {
  // YYYY-MM-DD HH:mm (UTC) — deterministic across runtimes.
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Render a directory listing as a self-contained HTML document. */
export function renderDirectoryListing(input: ListingInput): string {
  const sorted = [...input.entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; // directories first
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  const rows: string[] = [];
  if (!input.atMountRoot) rows.push('<tr><td><a href="../">../</a></td><td></td><td></td></tr>');
  for (const e of sorted) {
    const suffix = e.isDirectory ? '/' : '';
    const href = `${encodeURIComponent(e.name)}${suffix}`;
    const label = `${escapeHtml(e.name)}${suffix}`;
    const size = e.isDirectory ? '&ndash;' : String(e.size);
    rows.push(`<tr><td><a href="${href}">${label}</a></td><td>${size}</td><td>${formatMtime(e.mtime)}</td></tr>`);
  }

  const title = `Index of ${escapeHtml(input.urlPath)}`;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title}</title>`
    + '<style>body{font-family:system-ui,sans-serif;margin:2rem}'
    + 'table{border-collapse:collapse;width:100%}'
    + 'td{padding:.25rem .75rem;border-bottom:1px solid #ddd;font-family:monospace}</style>'
    + `</head><body><h1>${title}</h1><table><tbody>${rows.join('')}</tbody></table></body></html>`;
}
