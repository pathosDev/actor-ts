/**
 * Theme selection.
 *
 * Dark is the default and does NOT follow `prefers-color-scheme`: this is a
 * developer tool that lives beside an editor, and a system set to light for
 * everyday browsing is a poor signal for that context.  The toggle is explicit
 * and remembered.
 *
 * A module-level Angular signal rather than a service, because it is read from
 * places that are not in an injection context — the canvas painters read it to
 * decide when to repaint, and `themeColor()` is a plain function.  Angular
 * signals work anywhere; only `inject()` needs a context.
 */
import { signal, type Signal } from '@angular/core';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'actor-ts.devtools.theme';

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next);
  // `localStorage` throws in a sandboxed / cookie-blocked context; the theme
  // still works for the session, so never let it break boot.
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* preference is session-only */
  }
}

const theme = signal<Theme>(readStoredTheme());
apply(theme());

/** The active theme. */
export const currentTheme: Signal<Theme> = theme.asReadonly();

/** Flip between dark and light, remembering the choice. */
export function toggleTheme(): void {
  const next: Theme = theme() === 'dark' ? 'light' : 'dark';
  theme.set(next);
  apply(next);
}
