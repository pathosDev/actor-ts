/**
 * Theme selection.
 *
 * Dark is the default and does NOT follow `prefers-color-scheme`: this
 * is a developer tool that lives beside an editor, and a system set to
 * light for everyday browsing is a poor signal for that context.  The
 * toggle is explicit and remembered.
 */
import { signal, type ReadonlySignal } from './signal.js';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'actor-ts.devtools.theme';

const theme = signal<Theme>(readStoredTheme());
apply(theme.get());
theme.subscribe(apply);

/** The active theme. */
export const currentTheme: ReadonlySignal<Theme> = { get: theme.get, subscribe: theme.subscribe };

/** Flip between dark and light, remembering the choice. */
export function toggleTheme(): void {
  theme.set(theme.get() === 'dark' ? 'light' : 'dark');
}

function apply(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next);
  // `localStorage` throws in a sandboxed / cookie-blocked context; the
  // theme still works for the session, so never let it break boot.
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* preference is session-only */
  }
}

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
