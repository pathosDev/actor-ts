/**
 * HTML escaping primitives — the `SafeHtml` brand, the `html` tagged
 * template, and the character escaper they share.
 *
 * Scope: neutralise untrusted values in **HTML element content** and
 * **quoted attribute values**.  This is deliberately NOT a sanitizer for
 * untrusted *markup* (see the built-in sanitizer, tracked in #355) — and
 * escaping does not make a value safe inside `<script>`, CSS, or URL
 * contexts.  For untrusted rich HTML use a dedicated sanitizer.
 *
 * These live in `util/` rather than beside the HTTP response helpers
 * because two subsystems now produce HTML: `http` (responses) and
 * `io/broker` (the HTML body of an outgoing mail, via `EmailTemplate`).
 * `util/` has no outward import, so both may depend on it without
 * coupling them to each other.  `completeHtml` stays in `http/Html.ts` —
 * it builds an `HttpResponse` and is not a primitive.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;', // legacy IE treats backtick as an attribute-value delimiter
};
const ESCAPE_RE = /[&<>"'`]/g;

/**
 * Escape the HTML-significant characters (`& < > " '` and the backtick).
 * Safe for HTML element content and quoted attribute values; it does NOT
 * cover JS-string, CSS, or URL contexts, which need their own encoding.
 */
export function escapeHtml(s: string): string {
  return s.replace(ESCAPE_RE, (c) => ESCAPES[c]!);
}

/**
 * A string already known to be safe HTML — the brand the {@link html}
 * tagged template produces and interpolates verbatim.  Treat constructing
 * one directly (or via {@link rawHtml}) as asserting "I have made this
 * safe": the brand is an anti-accident guard, not an anti-malice one.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Render one interpolated value: SafeHtml verbatim, arrays recursively, nullish empty, everything else escaped. */
function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(typeof value === 'string' ? value : String(value));
}

/**
 * Tagged template that escapes every interpolation by default, so the
 * common case is safe without thinking about it:
 *
 *     html`<li class="${cls}">${userName}</li>`
 *
 * A {@link SafeHtml} value (e.g. a nested `html\`\`` fragment, or the
 * output of the sanitizer) is inserted verbatim; arrays are rendered
 * item-by-item and joined; `null`/`undefined` become the empty string;
 * everything else is coerced to a string and escaped.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/**
 * Escape hatch: wrap a string you have ALREADY made safe (e.g. a trusted
 * template you built yourself) so it interpolates verbatim.  Never pass
 * untrusted input here — that reintroduces the XSS the escaping prevents.
 */
export function rawHtml(s: string): SafeHtml {
  return new SafeHtml(s);
}
