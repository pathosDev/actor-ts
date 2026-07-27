/**
 * Display formatters.  Pure functions, unit-tested — the layout code
 * around them is not, so anything with a rule goes here.
 */

/** Human-readable duration: `920 ms`, `4.3 s`, `12 min`, `3 h 05 min`. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Thousands-separated integer: `1 204`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US').replace(/,/g, ' ');
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
