import {
  seriesKey,
  stripExpositionControlCharacters,
  type Labels,
  type MetricSample,
  type MetricsRegistry,
} from './Metrics.js';

/**
 * Prometheus 0.0.4 text-format exposition.
 *
 *   const text = exportPrometheus(registry);
 *   // → "# HELP actor_messages_delivered_total ...
 *   //    # TYPE actor_messages_delivered_total counter
 *   //    actor_messages_delivered_total{node=\"n-1\"} 42
 *   //    ..."
 *
 * Output is suitable for `Content-Type: text/plain; version=0.0.4`.
 * The {@link prometheusHandler} convenience returns a request handler
 * suitable for `Bun.serve` (and any framework that accepts the same
 * `(req: Request) => Response` shape — Hono, vanilla `Deno.serve`, …).
 */

/**
 * Render the registry's current state as Prometheus text format.
 *
 * **This registry's samples only.**  A system running a worker mesh has more
 * to export than its own registry holds — the workers' snapshots reach the
 * main thread through `MetricsExtension.collectAll` (#1570), and the
 * management route renders that merged list with
 * {@link renderPrometheusSamples}.  Manual wiring through this function or
 * {@link prometheusHandler} renders the main thread alone, which is the right
 * answer for a single-threaded system and a documented half for a mesh.
 */
export function exportPrometheus(registry: MetricsRegistry): string {
  return renderPrometheusSamples(registry.collect());
}

/**
 * Render a sample list as Prometheus text format.
 *
 * Family names and label keys are interpolated **raw**, because the format
 * offers no escaping for either position — they are the grammar itself.  What
 * makes that safe is the registry refusing anything outside the grammar at
 * registration (`PROMETHEUS_METRIC_NAME_PATTERN` /
 * `PROMETHEUS_LABEL_NAME_PATTERN`, #784), so a name reaching this function has
 * already been checked.  A `MetricsRegistry` implemented outside this package
 * owes the same guarantee, and so does anything that hands this function a
 * list it did not collect itself — the worker-mesh relay re-checks every
 * relayed name and key against the same two patterns before they get here.
 * `samples` is trusted, one layer past the point where a forged series can
 * still be told from a real one.
 *
 * Grouping is by family name, so a list that concatenates several registries'
 * samples renders one `# HELP` / `# TYPE` per family however many threads
 * contributed rows to it.
 */
export function renderPrometheusSamples(samples: ReadonlyArray<MetricSample>): string {
  // Group by family name so we emit `# HELP` / `# TYPE` once per family.
  const byName = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    let arr = byName.get(sample.name);
    if (!arr) { arr = []; byName.set(sample.name, arr); }
    arr.push(sample);
  }
  const out: string[] = [];
  for (const [name, group] of byName) {
    if (group.length === 0) continue;
    const head = group[0]!;
    if (head.help) out.push(`# HELP ${name} ${escapeHelp(head.help)}`);
    out.push(`# TYPE ${name} ${head.kind}`);
    if (head.kind === 'histogram') {
      // Histogram emission: bucket rows, then _sum and _count.
      // Layout per series: all bucket rows for one label set, then _sum + _count
      // for that label set.  We separate by series key first — the registry's
      // own, not a second copy of it (#1513): two tuples the registry keeps
      // apart have to stay apart here, or their rows interleave.
      const byLabel = new Map<string, MetricSample[]>();
      for (const sample of group) {
        const key = seriesKey(sample.labels);
        let arr = byLabel.get(key);
        if (!arr) { arr = []; byLabel.set(key, arr); }
        arr.push(sample);
      }
      for (const groupSamples of byLabel.values()) {
        for (const sample of groupSamples) {
          if (sample.bucket !== undefined) {
            const le = sample.bucket === Number.POSITIVE_INFINITY ? '+Inf' : String(sample.bucket);
            const labels = renderLabels({ ...sample.labels, le });
            out.push(`${name}_bucket${labels} ${formatNumber(sample.value)}`);
          }
        }
        // sum + count come after the buckets.
        for (const sample of groupSamples) {
          if (sample.sum !== undefined && sample.count !== undefined) {
            const labels = renderLabels(sample.labels);
            out.push(`${name}_sum${labels} ${formatNumber(sample.sum)}`);
            out.push(`${name}_count${labels} ${formatNumber(sample.count)}`);
          }
        }
      }
    } else {
      // Counter / Gauge — one row per labeled series.  Counter family
      // names traditionally end in `_total`; the user is responsible
      // for that naming convention.
      for (const sample of group) {
        out.push(`${name}${renderLabels(sample.labels)} ${formatNumber(sample.value)}`);
      }
    }
  }
  // Trailing newline per text-format spec.
  return out.join('\n') + (out.length > 0 ? '\n' : '');
}

/**
 * Build a `(req: Request) => Response` handler that returns the
 * current registry state in Prometheus text format.  Plug into your
 * server:
 *
 *   Bun.serve({
 *     port: 9090,
 *     fetch: prometheusHandler(system.metrics),
 *   });
 */
export function prometheusHandler(
  registry: MetricsRegistry,
): (req: Request) => Response {
  return (_req) => new Response(exportPrometheus(registry), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}

/* ------------------------------ helpers --------------------------------- */

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const inner = keys
    .map((key) => `${key}="${escapeLabelValue(String(labels[key]))}"`)
    .join(',');
  return `{${inner}}`;
}

/**
 * Escape a label value for the quoted position `key="…"`.
 *
 * The backslash pass runs first, so the backslashes the later passes
 * introduce are not escaped a second time.  The control strip runs ahead of
 * all of them and commutes with them: the escape passes only ever insert
 * `\`, `n` and `"`, none of which the strip matches.
 *
 * **The escape table has exactly three entries — `\\`, `\n` and `"` — and a
 * character outside it cannot be escaped, only removed** (#1414).  #784
 * emitted `\r` for a carriage return, on the reasoning that a bare CR reaches
 * a scraper's line handling as "the same line-splitting primitive `\n` is".
 * It does not, for either Go reader: both accept a raw CR inside a quoted
 * value — the classic parser rejects only a raw LF and writes every other
 * byte, and the scrape lexer's value class `[^\\"]` includes CR — so nothing
 * was being split for them.  What the escape *did* do is hand
 * prometheus/common's classic parser an escape it does not define, which it
 * treats as a syntax error for the **whole body**: one label value with a CR
 * in it, and the entire scrape is rejected by Pushgateway, the node_exporter
 * textfile collector and `promtool check metrics` alike.
 *
 * Removing the byte keeps the half of #784 that was real — a reader that
 * splits lines on a lone CR (a Python `splitlines`-style scraper) no longer
 * sees a value end a line.
 *
 * **The strip is not only a rendering rule, and the whole point is that it is
 * the same strip on both sides.**  {@link stripExpositionControlCharacters}
 * also runs one layer down, inside `seriesKey`, before a series is minted —
 * so two values differing only in stripped controls are **one series whose
 * counter sums**, not two children that render alike.  Measured:
 * `counter('m_total', { msg: 'ab' }).inc(1)` beside
 * `counter('m_total', { msg: 'a\x1fb' }).inc(2)` leaves the registry holding
 * one child and renders the single row `m_total{msg="ab"} 3`.
 *
 * That it merges rather than duplicates is the correctness property, not a
 * convenience: the duplicate this replaced put two rows with a byte-identical
 * name and label set into one body, and a Prometheus scrape rejects a body
 * with a duplicated series **wholesale** — so one label value carrying a unit
 * separator took every other family down with it.  A control character in a
 * label value is still a bug at its source; strip or replace it there rather
 * than relying on this.
 */
function escapeLabelValue(value: string): string {
  return stripExpositionControlCharacters(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/**
 * Escape a `# HELP` string.  Unquoted and terminated by the end of the line,
 * so it needs the line feed neutralised and the backslash that carries it,
 * but not the double quote.
 *
 * Same control policy as {@link escapeLabelValue}, for the same measured
 * reason one field over: the classic parser reads a HELP string through the
 * identical escape table, so the `\r` #784 emitted here rejected the body
 * just as surely (#1414).  A help string is family-wide rather than
 * series-forming, so the mint-time half has nothing to do here — the strip is
 * the same call, its consequence is only the bytes.
 */
function escapeHelp(value: string): string {
  return stripExpositionControlCharacters(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return '+Inf';
  if (n === Number.NEGATIVE_INFINITY) return '-Inf';
  // Integer-typed counters / counts should render without `.0`.
  return Number.isInteger(n) ? n.toFixed(0) : String(n);
}
