import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Every metric the docs query is one the framework emits (#992).
 *
 * The operations runbook is the page an on-call engineer opens when something
 * is wrong, and its PromQL queries named families nothing in `src/` ever
 * created — `cluster_unreachable_duration_ms`, `sharding_shards_hosted`,
 * `persistence_recovery_duration_ms`.  Against a real process such a query
 * returns an empty result, which in a dashboard and in an alert rule reads
 * exactly like "healthy".  Nothing tied the pages to the instrumentation, so
 * the drift survived three rounds of review.
 *
 * Two checks, over every page in both languages:
 *
 * - **PromQL fences.**  Every series a `promql` fence selects is a family the
 *   source mints — a histogram's `_bucket` / `_count` / `_sum` series count as
 *   their family.  A fence is a query the reader pastes; a user-registered
 *   metric has no business in one without the registration beside it.
 * - **Framework-prefixed names.**  A metric-shaped identifier under one of the
 *   stock prefixes (`actor_`, `cluster_`, `persistence_`, …) anywhere on a
 *   page is a claim that the framework emits it, unless the same line
 *   registers it (`metrics.counter('cluster_unreachable_total', …)` in a
 *   user-side sample).
 *
 * The emitted set is read out of `src/` the way
 * `tests/unit/metrics/StockMetrics.test.ts` reads it: every `.counter(` /
 * `.gauge(` / `.histogram(` call outside a comment, and its literal first
 * argument.  A JSDoc example such as `http_requests_total` is therefore not
 * emitted, which is the point.
 *
 * What this cannot see: prose that describes a metric's meaning wrongly, and
 * a user-registered name without a stock prefix outside a PromQL fence.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

/** The registry implementations define the accessors; they mint no family. */
const NOT_EMITTERS: ReadonlySet<string> = new Set(['metrics/Metrics.ts', 'metrics/PromClientAdapter.ts']);

function filesUnder(directory: string, accept: (name: string) => boolean, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(join(directory, entry.name), accept, relative));
    else if (accept(entry.name)) out.push(relative);
  }
  return out;
}

function readNormalised(path: string): string {
  return readFileSync(path, 'utf8').split(/\r?\n/).join('\n');
}

function emittedFamilies(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const file of filesUnder(SOURCE_ROOT, (name) => name.endsWith('.ts'))) {
    if (NOT_EMITTERS.has(file)) continue;
    const text = readNormalised(join(SOURCE_ROOT, file));
    for (const match of text.matchAll(/\.(?:counter|gauge|histogram)\(\s*'([a-z0-9_]+)'/g)) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const before = text.slice(lineStart, match.index);
      if (/^\s*\*/.test(before) || before.includes('//')) continue;
      out.add(match[1]!);
    }
  }
  return out;
}

/** PromQL functions and keywords that carry an underscore — not series names. */
const PROMQL_WORDS: ReadonlySet<string> = new Set([
  'histogram_quantile', 'label_replace', 'label_join', 'count_values',
  'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time',
  'count_over_time', 'quantile_over_time', 'last_over_time', 'present_over_time',
  'absent_over_time', 'stddev_over_time', 'stdvar_over_time', 'group_left', 'group_right',
]);

const HISTOGRAM_SERIES_SUFFIX = /_(?:bucket|count|sum)$/;

function familyOf(series: string, emitted: ReadonlySet<string>): string {
  if (emitted.has(series)) return series;
  const stripped = series.replace(HISTOGRAM_SERIES_SUFFIX, '');
  return stripped;
}

/** `promql` fences, indented ones included (a fence inside a list item). */
function promqlFences(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/^([ \t]*)```promql[^\n]*\n([\s\S]*?)^\1```/gm)) out.push(match[2]!);
  return out;
}

function seriesSelectedBy(query: string): string[] {
  const code = query
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n')
    .replace(/"[^"]*"/g, '""')
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '');
  return [...code.matchAll(/\b[a-z_][a-z0-9_]*\b/g)]
    .map((m) => m[0])
    .filter((word) => word.includes('_') && !PROMQL_WORDS.has(word));
}

const STOCK_PREFIXED_METRIC = new RegExp(
  // `actor_ts_` prefixes the stores' table names, never a metric.
  '\\b(?:actor(?!_ts_)|cluster|sharding|persistence|migration|distributed_data|router|offload|worker_mesh|websocket_client)'
  + '_[a-z0-9_]*_(?:total|seconds|ms|bucket|count|sum|size|depth|up|state|stalled|pending|hosted)\\b',
  'g',
);

type Finding = { readonly page: string; readonly name: string };

function documentationPages(): string[] {
  return filesUnder(DOCUMENTATION_ROOT, (name) => name.endsWith('.md') || name.endsWith('.mdx'));
}

function unemittedPromqlSeries(pages: ReadonlyArray<string>, emitted: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  for (const page of pages) {
    for (const fence of promqlFences(readNormalised(join(DOCUMENTATION_ROOT, page)))) {
      for (const series of seriesSelectedBy(fence)) {
        if (!emitted.has(familyOf(series, emitted))) out.push({ page, name: series });
      }
    }
  }
  return out;
}

function unemittedStockNames(pages: ReadonlyArray<string>, emitted: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  for (const page of pages) {
    for (const line of readNormalised(join(DOCUMENTATION_ROOT, page)).split('\n')) {
      for (const match of line.matchAll(STOCK_PREFIXED_METRIC)) {
        const name = match[0];
        if (emitted.has(familyOf(name, emitted))) continue;
        if (new RegExp(`\\.(?:counter|gauge|histogram)\\(\\s*['"]${name}['"]`).test(line)) continue;
        out.push({ page, name });
      }
    }
  }
  return out;
}

describe('documented metric names (#992)', () => {
  const emitted = emittedFamilies();
  const pages = documentationPages();

  test('the scans are not vacuous', () => {
    expect(emitted.size).toBeGreaterThanOrEqual(30);
    expect(emitted.has('cluster_members_up')).toBe(true);
    expect(emitted.has('http_requests_total')).toBe(false);
    const fences = pages.flatMap((page) => promqlFences(readNormalised(join(DOCUMENTATION_ROOT, page))));
    expect(fences.length).toBeGreaterThanOrEqual(8);
  });

  test('every series a promql fence selects is a family src/ emits', () => {
    expect(unemittedPromqlSeries(pages, emitted)).toEqual([]);
  });

  test('every framework-prefixed metric name on a page is emitted, or registered on that line', () => {
    expect(unemittedStockNames(pages, emitted)).toEqual([]);
  });

  test('the troubleshooting runbook queries metrics in both languages', () => {
    // The runbook is the page the guard exists for; a rewrite that dropped
    // every query would leave the checks above green over nothing.
    for (const page of ['operations/troubleshooting.mdx', 'de/operations/troubleshooting.mdx']) {
      const fences = promqlFences(readNormalised(join(DOCUMENTATION_ROOT, page)));
      expect(fences.length).toBeGreaterThanOrEqual(5);
    }
  });
});
