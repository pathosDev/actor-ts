/**
 * Hash-based routing.
 *
 * The hash is what lets the UI be a single embedded `index.html` with
 * no server-side fallback: every navigation target is `#/panel/...`,
 * so a request for a path that is not an asset is a genuine 404
 * instead of an index page pretending to be a JavaScript bundle.
 */
import { signal, type ReadonlySignal } from './signal.js';

/** A parsed location. */
export interface UiRoute {
  /** First hash segment — the panel id.  `'dashboard'` at the root. */
  readonly panel: string;
  /** Remaining segments, panel-specific (e.g. a selected actor path). */
  readonly rest: ReadonlyArray<string>;
}

const route = signal<UiRoute>(parse(window.location.hash));
window.addEventListener('hashchange', () => route.set(parse(window.location.hash)));

/** The current location. */
export const currentRoute: ReadonlySignal<UiRoute> = {
  get: route.get,
  subscribe: route.subscribe,
};

/** Link target for a panel — used as an `href`, so back/forward work. */
export function panelHref(panel: string, ...rest: ReadonlyArray<string>): string {
  return `#/${[panel, ...rest].map(encodeURIComponent).join('/')}`;
}

/** Navigate programmatically. */
export function navigate(panel: string, ...rest: ReadonlyArray<string>): void {
  window.location.hash = panelHref(panel, ...rest);
}

function parse(hash: string): UiRoute {
  const segments = hash.replace(/^#\/?/, '').split('/').filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  return { panel: segments[0] ?? 'dashboard', rest: segments.slice(1) };
}
