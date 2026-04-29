import type { Labels, MetricSample, MetricsRegistry } from './Metrics.js';

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
 */
export function exportPrometheus(registry: MetricsRegistry): string {
  const samples = registry.collect();
  // Group by family name so we emit `# HELP` / `# TYPE` once per family.
  const byName = new Map<string, MetricSample[]>();
  for (const s of samples) {
    let arr = byName.get(s.name);
    if (!arr) { arr = []; byName.set(s.name, arr); }
    arr.push(s);
  }
  const out: string[] = [];
  for (const [name, group] of byName) {
    if (group.length === 0) continue;
    const head = group[0]!;
    if (head.help) out.push(`# HELP ${name} ${escapeHelp(head.help)}`);
    out.push(`# TYPE ${name} ${head.type}`);
    if (head.type === 'histogram') {
      // Histogram emission: bucket rows, then _sum and _count.
      // Layout per series: all bucket rows for one label set, then _sum + _count
      // for that label set.  We separate by labelKey first.
      const byLabel = new Map<string, MetricSample[]>();
      for (const s of group) {
        const k = labelKey(s.labels);
        let arr = byLabel.get(k);
        if (!arr) { arr = []; byLabel.set(k, arr); }
        arr.push(s);
      }
      for (const groupSamples of byLabel.values()) {
        for (const s of groupSamples) {
          if (s.bucket !== undefined) {
            const le = s.bucket === Number.POSITIVE_INFINITY ? '+Inf' : String(s.bucket);
            const labels = renderLabels({ ...s.labels, le });
            out.push(`${name}_bucket${labels} ${formatNumber(s.value)}`);
          }
        }
        // sum + count come after the buckets.
        for (const s of groupSamples) {
          if (s.sum !== undefined && s.count !== undefined) {
            const labels = renderLabels(s.labels);
            out.push(`${name}_sum${labels} ${formatNumber(s.sum)}`);
            out.push(`${name}_count${labels} ${formatNumber(s.count)}`);
          }
        }
      }
    } else {
      // Counter / Gauge — one row per labeled series.  Counter family
      // names traditionally end in `_total`; the user is responsible
      // for that naming convention.
      for (const s of group) {
        out.push(`${name}${renderLabels(s.labels)} ${formatNumber(s.value)}`);
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
    .map((k) => `${k}="${escapeLabelValue(String(labels[k]))}"`)
    .join(',');
  return `{${inner}}`;
}

function labelKey(labels: Labels): string {
  return Object.keys(labels).sort()
    .map((k) => `${k}=${String(labels[k])}`).join('\x1f');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return '+Inf';
  if (n === Number.NEGATIVE_INFINITY) return '-Inf';
  // Integer-typed counters / counts should render without `.0`.
  return Number.isInteger(n) ? n.toFixed(0) : String(n);
}
