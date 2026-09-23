import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DefaultMetricsRegistry } from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';

/**
 * **The C0 strip merges two series, and every surface has to say so**
 * (#1414, #784).
 *
 * The strip removes every C0 control but TAB and LF from a label value.  It
 * used to run at *render* time only, inside `escapeLabelValue`, while the
 * registry minted a child under `seriesKey` over the value as it was passed —
 * so two values differing only in stripped controls were two children that
 * rendered to one identity, and the body carried the same series twice.  A
 * Prometheus scrape rejects a body with a duplicated series **wholesale**, so
 * one label value carrying a unit separator took every other family in the
 * exposition down with it.
 *
 * `seriesKey` now applies the same strip before it encodes a tuple, so the two
 * are one series and the counter sums.  Measured at this commit —
 * `counter('m_total', { msg: 'ab' }).inc(1)` beside
 * `counter('m_total', { msg: 'a\x1fb' }).inc(2)` — the registry holds 1 series
 * and `exportPrometheus` returns the single row `m_total{msg="ab"} 3`.
 *
 * ## Why this file is a pair of assertions and not one
 *
 * Prose has no gate of its own, and a corrected sentence rots the same way the
 * wrong one shipped.  So the **measurement drives the pin**: one test reads the
 * outcome out of a real exposition body, and the others require every surface
 * this lane owns to describe *that* outcome.  The two halves fail in opposite
 * directions, which is the point — remove the mint-time strip and the
 * reproduction reads `duplicated`, the first test goes red, and the three
 * surfaces cannot be left describing a merge that no longer happens; leave the
 * behaviour alone and revert a sentence, and that sentence's own row goes red.
 * Neither reading can become the silent one.
 *
 * This is the shape `tests/unit/http/cache/RateLimitEvictionClaims.test.ts`
 * uses for the same class of defect: a released sentence that was false, a
 * reproduction that keeps the replacement a measured fact, and a guard that
 * fails on a revert in either direction.
 *
 * ## What it catches, measured, and the ceiling it stops at
 *
 * Attacked rather than asserted.  Restoring the shipped sentence at any one of
 * the three sites fails that site alone; keeping the corrected phrase only in a
 * `//` comment while the claim returns above it fails on the claim; a claim
 * site whose path stops naming a file throws; a `stale` pattern rewritten so it
 * can never fire fails the non-vacuity test; and a German sentence retranslated
 * away from the pinned wording fails on the missing half.  Two edits stay green
 * **by design** — a pure reflow of the JSDoc comment, and a page rewritten with
 * LF endings — which is what the unwrap below is for.
 *
 * The outcome is three-way rather than two-way, because "merged" and "not
 * duplicated" are not the same fact.  A strip that stopped applying at *render*
 * time while the mint kept it would emit two rows with two different
 * identities: no duplicate, and no merge either.  That reads `distinct` here
 * and fails, where a boolean would have called it a pass.
 *
 * The ceiling is the same one the rate-limit guard names: a *new* duplicate
 * claim, phrased so it misses these substrings, passes if the corrected
 * sentence is left standing beside it.  Measured — "two label values that
 * differ only in control characters end up as two rows" added above the
 * corrected paragraph is not caught.  Broadening the pattern far enough to
 * catch it also catches this lane's own sentence about what the duplicate
 * *used* to produce, so the substring set stays the wording that actually
 * shipped, and the reproduction above is what keeps the corrected wording
 * anchored to a fact rather than to a reviewer's memory.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * What the exposition does with two tuples that differ only in stripped
 * controls.
 *
 * `merged` is one row; `duplicated` is two rows a scrape rejects as one series
 * twice; `distinct` is two rows that are honestly two series, which happens
 * only if the strip stops reaching the rendered bytes.  All three are
 * different facts and the surfaces describe exactly one of them.
 */
type StripOutcome = 'duplicated' | 'merged' | 'distinct';

/**
 * The identity half of an exposition row — everything left of the value.
 *
 * Two rows sharing one identity is what "the same series twice" means, and it
 * is a property of the emitted bytes rather than of any reader, so no claim
 * about what a Go parser then does is smuggled in here.
 */
function identitiesOf(body: string): ReadonlyArray<string> {
  return body
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.slice(0, line.lastIndexOf(' ')));
}

/** Classify a body's rows the three ways they can come out. */
function outcomeOf(identities: ReadonlyArray<string>): StripOutcome {
  if (identities.length !== new Set(identities).size) return 'duplicated';
  return identities.length === 1 ? 'merged' : 'distinct';
}

/** Run the reproduction and report what the body actually contains. */
function stripReproduction(): {
  outcome: StripOutcome;
  body: string;
  seriesHeldByRegistry: number;
} {
  const registry = new DefaultMetricsRegistry();
  registry.counter('m_total', { msg: 'ab' }).inc(1);
  registry.counter('m_total', { msg: 'a\x1fb' }).inc(2);
  const body = exportPrometheus(registry);
  return {
    outcome: outcomeOf(identitiesOf(body)),
    body,
    seriesHeldByRegistry: registry.collect().length,
  };
}

/**
 * The surfaces this lane owns, each pairing the wording that must not come
 * back with the wording the corrected text has to carry.
 *
 * The `[Unreleased]` CHANGELOG entry for #1414 says the same thing the stale
 * patterns below refuse and is deliberately absent: that file is rendered by
 * the release process from the structured entries a change reports, so it is
 * corrected there rather than by a hand edit a test demands.
 */
const CLAIM_SITES: ReadonlyArray<
  readonly [label: string, path: string, stale: RegExp, corrected: RegExp]
> = [
  [
    'escapeLabelValue JSDoc',
    'src/metrics/PrometheusExporter.ts',
    /carries the same series twice/,
    /one series whose counter sums/,
  ],
  [
    'prometheus-exporter page (English)',
    'docs/src/content/docs/observability/metrics/prometheus-exporter.mdx',
    /carries the same series twice/,
    /one series whose counter sums/,
  ],
  [
    'prometheus-exporter page (German)',
    'docs/src/content/docs/de/observability/metrics/prometheus-exporter.mdx',
    /trägt dieselbe Serie dann zweimal/,
    /eine Serie, deren Counter summiert/,
  ],
] as const;

/**
 * The exact sentences that shipped, one per site, so the `stale` patterns are
 * shown to match something rather than merely to match nothing.  A pattern that
 * can never fire passes over every file in the repository, which is the failure
 * mode this phase exists to stop.
 */
const STALE_SENTENCES: ReadonlyArray<string> = [
  'they stay two children, and the body\nthen carries the same series twice — two rows '
  + 'whose name and label set are\nbyte-identical, carrying different values.',
  'values that differ only in control characters stay two series — and the\n'
  + 'body then carries the same series twice: two rows whose metric name and\n'
  + 'label set are byte-identical, carrying different values.',
  'zwei Werte, die sich nur in Steuerzeichen unterscheiden, bleiben\ndeshalb zwei Serien '
  + '— und der Body trägt dieselbe Serie dann zweimal:\nzwei Zeilen, deren Metrikname und '
  + 'Label-Menge Byte für Byte gleich sind.',
];

/**
 * Read a surface with its hard wrapping undone.
 *
 * Both pages and the JSDoc wrap mid-sentence, and the wording that shipped
 * spans a line break on every one of them — "the body / then carries" was split
 * exactly there — so a line-wise match would find nothing and report a clean
 * file.  `core.autocrlf` is on in this repository's usual checkout, so the CRLF
 * pass is not optional either.
 *
 * A JSDoc gutter asterisk goes with the line break, because otherwise a reflow
 * of the comment — an edit that changes no word — would split a pinned phrase
 * around a literal `*` and turn this guard red for nothing.  It is dropped only
 * when a space or the line end follows it, which is what a gutter looks like
 * and what an MDX bold marker (`**`) never does.
 */
function unwrapped(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]*\n[ \t]*(?:\*(?=[ \t]|\n|$))?[ \t]*/g, ' ');
}

function readSurface(relativePath: string): string {
  return unwrapped(readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8'));
}

describe('the C0 strip merges two tuples into one series, and every surface says so (#1414)', () => {
  test('two tuples differing only in a stripped control become one row that sums', () => {
    const { outcome, body, seriesHeldByRegistry } = stripReproduction();

    // Asserted first — this is the anchor the three surfaces below are pinned
    // to, so its message is the one a reader needs when the behaviour changes
    // under them. Removing the strip from the mint path makes this read
    // 'duplicated', and the surfaces then move in the same commit or this file
    // stays red.
    expect(
      outcome,
      'the exposition stopped merging the two tuples: move CLAIM_SITES and '
      + 'STALE_SENTENCES back to the duplicate wording in the same commit that '
      + 'changed the mint path',
    ).toBe('merged');
    expect(seriesHeldByRegistry, 'the registry went back to keeping the two tuples apart').toBe(1);
    expect(body).toBe(
      '# TYPE m_total counter\n'
      + 'm_total{msg="ab"} 3\n',
    );
  });

  test('a gauge and a histogram reach the same merge, so it is not a counter quirk', () => {
    const gauges = new DefaultMetricsRegistry();
    gauges.gauge('d', { q: 'ab' }).set(1);
    gauges.gauge('d', { q: 'a\x00b' }).set(2);
    // A gauge has no addition to lose; what it has is a second write landing
    // on the series the first one minted, so the last write wins.
    expect(identitiesOf(exportPrometheus(gauges))).toEqual(['d{q="ab"}']);
    expect(exportPrometheus(gauges)).toContain('d{q="ab"} 2');

    const histograms = new DefaultMetricsRegistry();
    histograms.histogram('h_seconds', { q: 'ab' }, { buckets: [1] }).observe(0.5);
    histograms.histogram('h_seconds', { q: 'a\x01b' }, { buckets: [1] }).observe(2);
    const identities = identitiesOf(exportPrometheus(histograms));
    // Four rows over four identities — `le="1"`, `le="+Inf"`, `_sum`, `_count`
    // — where the duplicate emitted eight over those same four, which is four
    // duplicated series in one body rather than one.
    expect(identities).toHaveLength(4);
    expect(new Set(identities).size).toBe(4);
    expect(exportPrometheus(histograms)).toContain('h_seconds_count{q="ab"} 2');
  });

  test('the outcome classifier tells the three apart, so the anchor is not a boolean', () => {
    // The guard on the guard: `outcomeOf` reporting 'merged' for everything
    // would make the anchor above green whatever the exporter did.
    expect(outcomeOf(['m{a="x"}'])).toBe('merged');
    expect(outcomeOf(['m{a="x"}', 'm{a="x"}'])).toBe('duplicated');
    expect(outcomeOf(['m{a="x"}', 'm{a="y"}'])).toBe('distinct');
  });

  test.each(CLAIM_SITES)(
    '%s describes the outcome the exporter actually produces',
    (label, path, stale, corrected) => {
      const text = readSurface(path);
      // A mistyped path reads '' and would satisfy every `not` assertion in
      // this file at once.
      expect(text.length, `${label}: nothing was read from ${path}`).toBeGreaterThan(500);
      expect(stale.test(text), `${label} still claims the strip duplicates a series`).toBe(false);
      expect(
        corrected.test(text),
        `${label} does not state that the two tuples become one series whose counter sums`,
      ).toBe(true);
    },
  );

  test('the stale patterns match the sentences that shipped, and the corrected ones do not', () => {
    expect(STALE_SENTENCES).toHaveLength(CLAIM_SITES.length);
    for (let i = 0; i < CLAIM_SITES.length; i++) {
      const [label, , stale, corrected] = CLAIM_SITES[i]!;
      const shipped = unwrapped(STALE_SENTENCES[i]!);
      expect(stale.test(shipped), `${label}: the stale pattern matches nothing`).toBe(true);
      expect(
        corrected.test(shipped),
        `${label}: the corrected pattern is satisfied by the wording it replaces`,
      ).toBe(false);
    }
  });
});
