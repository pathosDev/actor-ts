/**
 * Tiny statistics helpers for benchmark reporting — mean, stddev, and
 * percentiles over a pre-sorted array of numbers.
 */

/* ----------------------------- ANSI colors ------------------------------- */

/**
 * Simple ANSI colouring — respects NO_COLOR and skips codes when stdout
 * is not a TTY (e.g. when piped to a file).  Keeps the benchmark output
 * readable everywhere but colourful in a real terminal.
 */
const useColor = ((): boolean => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === '1') return true;
  return !!process.stdout.isTTY;
})();

function wrap(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const ansi = {
  bold:   (s: string): string => wrap('1', s),
  dim:    (s: string): string => wrap('2', s),
  red:    (s: string): string => wrap('31', s),
  green:  (s: string): string => wrap('32', s),
  yellow: (s: string): string => wrap('33', s),
  cyan:   (s: string): string => wrap('36', s),
  // Use an explicit 256-colour palette gray (244 ≈ medium gray) rather
  // than `\x1b[90m` "bright black" — the latter is an intensity-modified
  // colour and renders inconsistently on Windows Terminal (especially on
  // the first char of a line or right after a bold sequence).
  gray:   (s: string): string => wrap('38;5;244', s),
} as const;

/** Line-start sentinel — emits a full SGR reset so the terminal is in a
 *  known state before the next colour code, which is what actually
 *  causes Windows Terminal to render the leading border chars correctly. */
export const ansiResetLine: string = useColor ? '\x1b[0m' : '';

export interface BenchStats {
  readonly mean: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export function statsOf(samples: ReadonlyArray<number>): BenchStats {
  if (samples.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const pick = (p: number): number => sorted[Math.min(n - 1, Math.floor(n * p))]!;
  return {
    mean,
    stddev,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  };
}

/** Format a number of nanoseconds as a human-friendly string. */
export function formatNs(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

/**
 * Format a per-second rate with thousands separators and a named unit —
 * produces human-friendly output like "1,234,567 msg/s" or "842 req/s".
 *
 * For rates ≥ 100 we round to a whole number (the trailing decimals carry no
 * real information at that scale); for smaller rates we keep two decimals so
 * very slow operations still resolve.
 */
export function formatRate(perSec: number, unit: string = 'op'): string {
  if (!Number.isFinite(perSec)) return `— ${unit}/s`;
  const rounded = perSec >= 100 ? Math.round(perSec) : Math.round(perSec * 100) / 100;
  return `${rounded.toLocaleString('en-US')} ${unit}/s`;
}

/** Format a byte count as KB / MB / GB. */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const b = Math.abs(bytes);
  if (b < 1024) return `${sign}${b.toFixed(0)} B`;
  if (b < 1024 * 1024) return `${sign}${(b / 1024).toFixed(2)} KB`;
  if (b < 1024 * 1024 * 1024) return `${sign}${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${sign}${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Format a memory delta with an explicit sign so it reads as a change
 * rather than an absolute value — e.g. "+12.50 MB" when the benchmark
 * allocated, "-2.33 MB" when the process got smaller, "0 B" when no
 * measurable change.  Used in benchmark output where the "memory"
 * column shows how much ΔRSS the measured work produced.
 */
export function formatMemoryDelta(bytes: number): string {
  if (bytes === 0) return '0 B';
  const abs = formatBytes(Math.abs(bytes));
  return bytes > 0 ? `+${abs}` : `-${abs}`;
}
