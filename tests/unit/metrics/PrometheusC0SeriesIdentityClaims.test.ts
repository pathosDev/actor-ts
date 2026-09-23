import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DefaultMetricsRegistry } from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';

/**
 * **The C0 strip does not merge two series, and the surfaces said it did**
 * (#1414, #784).
 *
 * The strip removes every C0 control but TAB and LF from a label value — at
 * *render* time, inside `escapeLabelValue`.  The registry mints a child under
 * `seriesKey` over the value **as it was passed**, which the strip never
 * reaches.  So two values differing only in stripped controls are two
 * children that render to one identity: the body carries the same series
 * twice, two rows with a byte-identical name and label set and different
 * values.
 *
 * Measured at this commit — `counter('m_total', { msg: 'ab' }).inc(1)` beside
 * `counter('m_total', { msg: 'a\x1fb' }).inc(2)` — the registry holds 2
 * series and `exportPrometheus` returns a body whose two rows are both
 * `m_total{msg="ab"}`, carrying 1 and 2.  It is reachable by construction:
 * #784's own migration note tells users to move request-derived data out of a
 * metric name and into a label value.
 *
 * ## Why this file is a pair of assertions and not one
 *
 * Prose has no gate of its own, and a corrected sentence rots the same way
 * the wrong one shipped.  So the **measurement drives the pin**: one test
 * reads the outcome out of a real exposition body, and the others require
 * every surface this lane owns to describe *that* outcome.  The two halves
 * fail in opposite directions, which is the point — when the value is
 * normalised before the series key is computed (the open half of #1414,
 * which lives in `DefaultMetricsRegistry`'s mint path, one layer below the
 * exporter), the reproduction reads `merged`, the first test goes red, and
 * the three surfaces cannot be left describing a duplicate that no longer
 * happens.  Neither reading can become the silent one.
 *
 * This is the shape `tests/unit/http/cache/RateLimitEvictionClaims.test.ts`
 * uses for the same class of defect: a released sentence that was false, a
 * reproduction that keeps the replacement a measured fact, and a guard that
 * fails on a revert in either direction.
 *
 * ## What it catches, measured, and the ceiling it stops at
 *
 * Attacked rather than asserted.  Restoring the shipped sentence at any one
 * of the three sites fails that site alone; keeping the corrected phrase only
 * in a `//` comment while the claim returns above it fails on the claim; a
 * claim site whose path stops naming a file throws; a `stale` pattern
 * rewritten so it can never fire fails the non-vacuity test; and a German
 * sentence retranslated away from the pinned wording fails on the missing
 * half.  Two edits stay green **by design** — a pure reflow of the JSDoc
 * comment, and a page rewritten with LF endings — which is what the unwrap
 * below is for.
 *
 * The ceiling is the same one the rate-limit guard names: a *new* merge
 * claim, phrased so it misses these substrings, passes if the corrected
 * sentence is left standing beside it.  Measured — "two label values that
 * differ only in control characters end up as one series" added above the
 * corrected paragraph is not caught.  Broadening the pattern far enough to
 * catch it also catches this lane's own sentence about what normalising the
 * value *would* produce, so the substring set stays the wording that actually
 * shipped, and the reproduction above is what keeps the corrected wording
 * anchored to a fact rather than to a reviewer's memory.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/** What the exposition does with two tuples that differ only in stripped controls. */
type StripOutcome = 'duplicated' | 'merged';

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
  const identities = identitiesOf(body);
  return {
    outcome: identities.length === new Set(identities).size ? 'merged' : 'duplicated',
    body,
    seriesHeldByRegistry: registry.collect().length,
  };
}

/**
 * The surfaces this lane owns, each pairing the wording that must not come
 * back with the wording the corrected text has to carry.
 *
 * The `[Unreleased]` CHANGELOG entry for #1414 says the same wrong thing and
 * is deliberately absent: that file is rendered by the release process from
 * the structured entries a change reports, so it is corrected there rather
 * than by a hand edit a test demands.
 */
const CLAIM_SITES: ReadonlyArray<
  readonly [label: string, path: string, stale: RegExp, corrected: RegExp]
> = [
  [
    'escapeLabelValue JSDoc',
    'src/metrics/PrometheusExporter.ts',
    /(?:render as|become) the same series/,
    /carries the same series twice/,
  ],
  [
    'prometheus-exporter page (English)',
    'docs/src/content/docs/observability/metrics/prometheus-exporter.mdx',
    /(?:render as|become) the same series/,
    /carries the same series twice/,
  ],
  [
    'prometheus-exporter page (German)',
    'docs/src/content/docs/de/observability/metrics/prometheus-exporter.mdx',
    /werden zur selben Serie/,
    /trägt dieselbe Serie dann zweimal/,
  ],
] as const;

/**
 * The exact sentences that shipped, one per site, so the `stale` patterns are
 * shown to match something rather than merely to match nothing.  A pattern
 * that can never fire passes over every file in the repository, which is the
 * failure mode this phase exists to stop.
 */
const STALE_SENTENCES: ReadonlyArray<string> = [
  'two\nvalues differing only in stripped controls now render as the same series,\n'
  + 'where before they differed by an unprintable byte.',
  'two label values that differ only in control characters become the same\n'
  + 'series, so strip or replace them at the source rather than relying on\nthis.',
  'Zwei Label-Werte, die sich nur in Steuerzeichen\nunterscheiden, werden zur selben '
  + 'Serie — entferne oder ersetze sie\ndeshalb an der Quelle, statt dich hierauf zu verlassen.',
];

/**
 * Read a surface with its hard wrapping undone.
 *
 * Both pages and the JSDoc wrap mid-sentence, and the wording that shipped
 * spans a line break on every one of them — "become the same / series" was
 * split exactly there — so a line-wise match would find nothing and report a
 * clean file.  `core.autocrlf` is on in this repository's usual checkout, so
 * the CRLF pass is not optional either.
 *
 * A JSDoc gutter asterisk goes with the line break, because otherwise a
 * reflow of the comment — an edit that changes no word — would split a pinned
 * phrase around a literal `*` and turn this guard red for nothing.  It is
 * dropped only when a space or the line end follows it, which is what a
 * gutter looks like and what an MDX bold marker (`**`) never does.
 */
function unwrapped(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]*\n[ \t]*(?:\*(?=[ \t]|\n|$))?[ \t]*/g, ' ');
}

function readSurface(relativePath: string): string {
  return unwrapped(readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8'));
}

describe('the C0 strip produces a duplicate series, and every surface says so (#1414)', () => {
  test('two tuples differing only in a stripped control render one identity twice', () => {
    const { outcome, body, seriesHeldByRegistry } = stripReproduction();

    // Asserted first, and not a licence for the duplicate — this is the
    // anchor the three surfaces below are pinned to, so its message is the one
    // a reader needs when the behaviour changes under them.  Normalising the
    // value before the series key is computed makes this read 'merged', and
    // the surfaces then move in the same commit or this file stays red.
    expect(
      outcome,
      'the exposition now merges the two tuples: move CLAIM_SITES and STALE_SENTENCES '
      + 'to the merged wording in the same commit that normalised the value',
    ).toBe('duplicated');
    expect(seriesHeldByRegistry, 'the registry stopped keeping the two tuples apart').toBe(2);
    expect(body).toBe(
      '# TYPE m_total counter\n'
      + 'm_total{msg="ab"} 1\n'
      + 'm_total{msg="ab"} 2\n',
    );
  });

  test('a gauge and a histogram reach the same duplicate, so it is not a counter quirk', () => {
    const gauges = new DefaultMetricsRegistry();
    gauges.gauge('d', { q: 'ab' }).set(1);
    gauges.gauge('d', { q: 'a\x00b' }).set(2);
    expect(identitiesOf(exportPrometheus(gauges))).toEqual(['d{q="ab"}', 'd{q="ab"}']);

    const histograms = new DefaultMetricsRegistry();
    histograms.histogram('h_seconds', { q: 'ab' }, { buckets: [1] }).observe(0.5);
    histograms.histogram('h_seconds', { q: 'a\x01b' }, { buckets: [1] }).observe(2);
    const identities = identitiesOf(exportPrometheus(histograms));
    // Every row of the second series repeats an identity the first already
    // used, `_sum` and `_count` included.
    expect(identities).toHaveLength(8);
    expect(new Set(identities).size).toBe(4);
  });

  test.each(CLAIM_SITES)(
    '%s describes the outcome the exporter actually produces',
    (label, path, stale, corrected) => {
      const text = readSurface(path);
      // A mistyped path reads '' and would satisfy every `not` assertion in
      // this file at once.
      expect(text.length, `${label}: nothing was read from ${path}`).toBeGreaterThan(500);
      expect(stale.test(text), `${label} still claims the strip merges two series`).toBe(false);
      expect(
        corrected.test(text),
        `${label} does not state that the body carries the same series twice`,
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
