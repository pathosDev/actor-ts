/**
 * Display formatters.  Pure functions, unit-tested — the layout code
 * around them is not, so anything with a rule goes here.
 */

/** Human-readable duration: `920 ms`, `4.3 s`, `12 min`, `3 h 05 min`. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  // A tenth of a second is noise in an uptime; it only ever draws the
  // eye to a digit that changes on its own.
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * Thousands-separated integer: `1 204`.
 *
 * Grouped by hand rather than through `toLocaleString`, which is not the
 * same function on every host: the separator comes from the runtime's ICU
 * data, so `'en-US'` yields a comma under Bun and a THIN SPACE (U+2009)
 * under the Node that runs the Vitest suite.  Rewriting `,` therefore left
 * one host with a character no test expected, and the UI grouped its
 * numbers differently depending on where it ran.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Local wall-clock time: `14:03:21`. */
export function formatTime(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toLocaleTimeString('en-GB', { hour12: false });
}

/** Last segment of an actor path, for tables too narrow for the whole thing. */
export function shortActorPath(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}
