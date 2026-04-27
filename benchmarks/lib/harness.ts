import { highResNow } from '../../src/runtime/detect.js';
import { ansi, ansiResetLine, formatMemoryDelta, formatNs, formatRate, statsOf, type BenchStats } from './stats.js';

/** User-provided benchmark — runs a single "operation" per call to `run`. */
export interface BenchmarkSpec {
  readonly name: string;
  /** Short label printed in the summary — grouping, tags, etc. */
  readonly group?: string;
  /** Unit label for the measured operation — "msg", "event", "req", "swap", etc.  Default "op". */
  readonly unit?: string;
  /** Optional setup run once before the benchmark proper. */
  setup?(): Promise<void> | void;
  /** Optional teardown run after every measured iteration (kept empty by default). */
  teardown?(): Promise<void> | void;
  /** The unit of work.  Called many times; one "op" = one invocation. */
  run(): Promise<void> | void;
  /** How many ops per measured iteration (batch size).  Default 1. */
  readonly opsPerIteration?: number;
  /** Warmup iterations (not measured).  Default: min(100, iterations / 10). */
  readonly warmupIterations?: number;
  /** Target measured iteration count.  Default 1000. */
  readonly iterations?: number;
}

/** Raw measurement + derived stats for a single benchmark. */
export interface BenchmarkResult {
  readonly name: string;
  readonly group: string;
  readonly unit: string;
  readonly iterations: number;
  readonly opsPerIteration: number;
  readonly totalNs: number;
  readonly totalOps: number;
  readonly opsPerSec: number;
  readonly perOpNs: number;
  readonly iterationStats: BenchStats;
  readonly rssDeltaBytes: number;
}

/**
 * Run a single benchmark.  Returns timing stats and a rough memory delta
 * (process.memoryUsage().rss before vs. after).  Runs one warmup phase,
 * then measures each iteration with `Bun.nanoseconds()` for ns resolution.
 */
export async function runBenchmark(spec: BenchmarkSpec): Promise<BenchmarkResult> {
  const iterations = spec.iterations ?? 1_000;
  const opsPerIteration = spec.opsPerIteration ?? 1;
  const warmup = spec.warmupIterations ?? Math.max(1, Math.min(100, Math.floor(iterations / 10)));

  await spec.setup?.();

  // Warmup — prime JIT, caches, allocations.
  for (let i = 0; i < warmup; i++) {
    await spec.run();
    await spec.teardown?.();
  }

  // Force a fresh GC snapshot if possible (Bun exposes gc() under --expose-gc only).
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const rssBefore = process.memoryUsage().rss;

  const samples = new Float64Array(iterations);
  const totalStart = highResNow();
  for (let i = 0; i < iterations; i++) {
    const t0 = highResNow();
    await spec.run();
    samples[i] = highResNow() - t0;
    await spec.teardown?.();
  }
  const totalNs = highResNow() - totalStart;

  gc?.();
  const rssAfter = process.memoryUsage().rss;

  const totalOps = iterations * opsPerIteration;
  const perOpNs = totalNs / totalOps;
  const opsPerSec = 1e9 / perOpNs;
  const iterationStats = statsOf(Array.from(samples));

  return {
    name: spec.name,
    group: spec.group ?? 'benchmark',
    unit: spec.unit ?? 'op',
    iterations,
    opsPerIteration,
    totalNs,
    totalOps,
    opsPerSec,
    perOpNs,
    iterationStats,
    rssDeltaBytes: rssAfter - rssBefore,
  };
}

/* =============================== Table helpers ============================= */

interface TableColumn {
  readonly header: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

/**
 * Minimal unicode-box table renderer.  Prints top border + column headers +
 * separator on `start()`, one row per `row()`, bottom border on `end()`.
 * Colours are applied via `ansi.*` so they disappear cleanly when NO_COLOR
 * is set or stdout is not a TTY.
 */
class Table {
  constructor(
    private readonly title: string,
    private readonly columns: ReadonlyArray<TableColumn>,
  ) {}

  private get totalLineWidth(): number {
    // Each column contributes: 1 space + width + 1 space = width + 2.
    // Plus one `│` between columns, plus two outer `│`.
    return this.columns.reduce((n, c) => n + c.width + 2, 0) + this.columns.length + 1;
  }

  start(): void {
    const prefix = '── ';
    const suffix = ' ';
    const dashFill = Math.max(
      2,
      this.totalLineWidth - 2 - prefix.length - this.title.length - suffix.length,
    );
    // Top border: ┌── Title ────────────────────┐
    //   [gray ┌── ] [bold Title] [gray  ─────┐]
    // Only the title *text* is bold — the leading "── " and trailing
    // dashes belong to the frame and stay gray.
    console.log(
      ansiResetLine
      + ansi.gray('┌' + prefix)
      + ansi.bold(this.title)
      + ansi.gray(suffix + '─'.repeat(dashFill) + '┐'),
    );

    // Column header row.
    const headerCells = this.columns.map((c) => this.renderCell(c.header, c, true));
    console.log(ansiResetLine + ansi.gray('│') + headerCells.join(ansi.gray('│')) + ansi.gray('│'));

    // Separator ├─┼─┼─┤ aligned with the columns below.
    const segs = this.columns.map((c) => '─'.repeat(c.width + 2));
    console.log(ansiResetLine + ansi.gray('├' + segs.join('┼') + '┤'));
  }

  row(values: ReadonlyArray<string>, tint?: (cell: string, colIndex: number) => string): void {
    const cells = this.columns.map((c, i) => {
      const raw = values[i] ?? '';
      const padded = this.renderCell(raw, c, false);
      return tint ? tint(padded, i) : padded;
    });
    console.log(ansiResetLine + ansi.gray('│') + cells.join(ansi.gray('│')) + ansi.gray('│'));
  }

  end(): void {
    const segs = this.columns.map((c) => '─'.repeat(c.width + 2));
    console.log(ansiResetLine + ansi.gray('└' + segs.join('┴') + '┘'));
  }

  private renderCell(content: string, col: TableColumn, isHeader: boolean): string {
    const padded = padVisible(content, col.width, col.align ?? 'left');
    const cell = ` ${padded} `;
    return isHeader ? ansi.bold(cell) : cell;
  }
}

function padVisible(s: string, width: number, align: 'left' | 'right'): string {
  if (s.length > width) return s.slice(0, Math.max(1, width - 1)) + '…';
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}

/**
 * Tint a memory-delta cell based on the magnitude of growth: yellow for
 * "noticeable" (10 MB+) and red for "big" (100 MB+) so readers can spot
 * leaky or allocation-heavy cases at a glance.  Negative/zero growth
 * stays neutral.
 */
function tintMemory(cell: string): string {
  const s = cell.trim();
  if (!s.startsWith('+')) return cell;
  const gb = s.endsWith('GB');
  const mb = s.endsWith('MB');
  if (!gb && !mb) return cell;
  const value = parseFloat(s.slice(1)) * (gb ? 1024 : 1);
  if (value >= 100) return ansi.red(cell);
  if (value >= 10)  return ansi.yellow(cell);
  return cell;
}

/* ------------------------------ runGroup --------------------------------- */

const BENCH_COLUMNS: ReadonlyArray<TableColumn> = [
  { header: 'case',       width: 38,                 },
  { header: 'throughput', width: 18, align: 'right'  },
  { header: 'perOp',      width: 11, align: 'right'  },
  { header: 'p50',        width: 10, align: 'right'  },
  { header: 'p99',        width: 10, align: 'right'  },
  { header: 'memory',     width: 12, align: 'right'  },
];

/**
 * Run a named group of benchmarks sequentially, rendering them as one
 * bordered table with a header row and per-benchmark result rows.  The
 * throughput column is tinted green (the "headline" metric); memory
 * deltas are tinted yellow/red when they exceed 10 MB / 100 MB.
 */
export async function runGroup(label: string, specs: ReadonlyArray<BenchmarkSpec>): Promise<BenchmarkResult[]> {
  // eslint-disable-next-line no-console
  console.log();
  const table = new Table(label, BENCH_COLUMNS);
  table.start();

  const out: BenchmarkResult[] = [];
  for (const spec of specs) {
    const r = await runBenchmark({ ...spec, group: spec.group ?? label });
    table.row(
      [
        r.name,
        formatRate(r.opsPerSec, r.unit),
        formatNs(r.perOpNs),
        formatNs(r.iterationStats.p50),
        formatNs(r.iterationStats.p99),
        formatMemoryDelta(r.rssDeltaBytes),
      ],
      (cell, i) => {
        if (i === 1) return ansi.green(cell);
        if (i === 5) return tintMemory(cell);
        return cell;
      },
    );
    out.push(r);
  }

  table.end();
  return out;
}

/**
 * Back-compat: render a single benchmark result in the same table format
 * (used by any callers that drive `runBenchmark` directly).  New code
 * should prefer `runGroup`.
 */
export function printResult(r: BenchmarkResult): void {
  const table = new Table(r.group, BENCH_COLUMNS);
  table.start();
  table.row(
    [
      r.name,
      formatRate(r.opsPerSec, r.unit),
      formatNs(r.perOpNs),
      formatNs(r.iterationStats.p50),
      formatNs(r.iterationStats.p99),
      formatMemoryDelta(r.rssDeltaBytes),
    ],
    (cell, i) => i === 1 ? ansi.green(cell) : i === 5 ? tintMemory(cell) : cell,
  );
  table.end();
}

/* ------------------------------ memoryGroup ------------------------------ */

const MEMORY_COLUMNS: ReadonlyArray<TableColumn> = [
  { header: 'case',   width: 42                },
  { header: 'memory', width: 14, align: 'right' },
  { header: 'heap',   width: 14, align: 'right' },
];

export interface MemoryMeasurement {
  readonly label: string;
  readonly deltaRss: number;
  readonly deltaHeap: number;
}

export interface MemoryGroup {
  measure(label: string, allocate: () => Promise<void> | void): Promise<MemoryMeasurement>;
  end(): void;
}

/**
 * Pretty-print helper for memory-only benchmarks: a three-column table
 * with a `case | memory | heap` layout.  Each `measure(...)` call
 * renders one row.  Call `end()` to close the table.
 */
export function memoryGroup(title: string): MemoryGroup {
  // eslint-disable-next-line no-console
  console.log();
  const table = new Table(title, MEMORY_COLUMNS);
  table.start();

  return {
    async measure(label: string, allocate: () => Promise<void> | void): Promise<MemoryMeasurement> {
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      const before = process.memoryUsage();
      await allocate();
      gc?.();
      const after = process.memoryUsage();
      const deltaRss = after.rss - before.rss;
      const deltaHeap = after.heapUsed - before.heapUsed;
      table.row(
        [label, formatMemoryDelta(deltaRss), formatMemoryDelta(deltaHeap)],
        (cell, i) => (i === 1 || i === 2) ? tintMemory(cell) : cell,
      );
      return { label, deltaRss, deltaHeap };
    },
    end(): void { table.end(); },
  };
}

/**
 * One-off memory measurement — kept for compatibility with benchmarks
 * that do not drive a memoryGroup themselves.  Prefer `memoryGroup` in
 * new code.
 */
export async function measureMemory(label: string, allocate: () => Promise<void> | void): Promise<MemoryMeasurement> {
  const group = memoryGroup(label);
  const result = await group.measure(label, allocate);
  group.end();
  return result;
}
