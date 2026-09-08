/**
 * Turn a night's `summary.json` files into a report somebody will actually read.
 *
 * ## Why this exists
 *
 * `nightly-flakes.yml` has measured the suite every night for months, and the
 * measurement reached nobody.  Both jobs were `continue-on-error`, the verdict
 * went into a step-summary table and a run annotation, and the workflow said so
 * about itself: *"Nothing accumulates the streak.  It is counted by a human
 * reading these annotations, which is the same failure that made the quarantine
 * permanent in the first place."*
 *
 * It was not a hypothetical.  The exit criterion for the #538 quarantine —
 * fourteen consecutive green nights — had been met at twenty-one before anybody
 * looked, and the third suite in that quarantine was not a runner problem at
 * all but a product defect the quarantine was hiding rather than measuring
 * (#839).
 *
 * So a red night now becomes an **issue**, which has an owner, a history and a
 * notification, and a green night closes it.  That is the whole idea: the
 * report is not more measurement, it is the part that makes measurement land.
 *
 * ## Shape
 *
 *     node scripts/nightly-flake-report.mjs \
 *       --summary=whole-suite:.artifacts/stress/summary.json \
 *       --summary=worker-suites:.artifacts/worker/summary.json \
 *       --run-url=https://github.com/owner/repo/actions/runs/123 \
 *       --out=body.md
 *
 * Each `--summary` is `label:path`.  A path that does not exist is **not**
 * silently skipped: a job that died before writing its summary is exactly the
 * failure mode most worth reporting, and treating it as "nothing to say" is how
 * the first two nights of this workflow uploaded no artifact at all and nobody
 * noticed.
 *
 * Writes the Markdown body to `--out` and prints `red=true|false` on stdout for
 * the workflow to branch on.  Exit status is 0 either way: whether a red night
 * fails the job is the workflow's decision, not this script's.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Marker in every issue title, so the workflow can find the open one. */
export const ISSUE_TITLE_PREFIX = '[Nightly] Flaky tests:';

/**
 * A summary that could not be read at all.
 *
 * Rendered as an offender in its own right rather than dropped, because "the
 * job produced no verdict" and "the job's verdict was green" are opposite facts
 * and only one of them is good news.
 */
const MISSING = Symbol('missing summary');

/** Parse `label:path` pairs, keeping the label's colons out of the path. */
export function parseSummaryArgument(value) {
  const separator = value.indexOf(':');
  if (separator <= 0) {
    throw new Error(`--summary expects "label:path", got "${value}"`);
  }
  return { label: value.slice(0, separator), path: value.slice(separator + 1) };
}

/** Read one summary, or {@link MISSING} when it is not there or not JSON. */
export function readSummary(path) {
  if (!existsSync(path)) return MISSING;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return MISSING;
  }
}

/**
 * Is this summary a clean night?
 *
 * Deliberately stricter than `greenRuns === runs`, and each extra term is a
 * failure this harness has actually produced: a run that never exited, one that
 * wrote no report, one that exited non-zero with no failing test, and one whose
 * failures no offender explains (#1359).  Any of them means the night cannot be
 * called green, whatever the pass count says.
 */
export function isGreen(summary) {
  if (summary === MISSING) return false;
  return summary.greenRuns === summary.runs
    && (summary.runsTimedOut?.length ?? 0) === 0
    && (summary.runsWithoutReport?.length ?? 0) === 0
    && (summary.runsRedWithoutFailures?.length ?? 0) === 0
    && (summary.unexplainedRedRuns?.length ?? 0) === 0;
}

/** `identity — failed N of M runs`, worst first, capped so an issue stays readable. */
function offenderLines(entries, runs, limit = 20) {
  const shown = entries.slice(0, limit).map(
    (entry) => `- \`${entry.identity}\` — failed ${entry.failedRuns.length} of ${runs}`,
  );
  if (entries.length > limit) {
    shown.push(`- …and ${entries.length - limit} more, in the uploaded report.`);
  }
  return shown;
}

/** One job's section of the report. */
function sectionFor(label, summary) {
  if (summary === MISSING) {
    return [
      `### ${label}`,
      '',
      '**No summary was produced.** The job died before writing one, or its',
      'artifact never uploaded. That is a harder failure than a red run, not a',
      'softer one: nothing at all is known about tonight for this job.',
    ];
  }

  const lines = [`### ${label}`, ''];
  lines.push(`- runs: **${summary.greenRuns} of ${summary.runs} green**`);
  lines.push(`- test executions: ${summary.totalExecuted}, failures: ${summary.totalFailures}`);

  if (summary.runsTimedOut?.length) {
    lines.push(
      `- **${summary.runsTimedOut.length} run(s) never exited** (${summary.runsTimedOut.join(', ')}) —`
      + ' the suite stopped making progress, so nothing can be said about its tests.',
    );
  }
  if (summary.runsWithoutReport?.length) {
    lines.push(`- ${summary.runsWithoutReport.length} run(s) wrote no report (${summary.runsWithoutReport.join(', ')}).`);
  }
  if (summary.runsRedWithoutFailures?.length) {
    lines.push(
      `- ${summary.runsRedWithoutFailures.length} run(s) exited non-zero with no failing test`
      + ` (${summary.runsRedWithoutFailures.join(', ')}) — an unreleased handle, a crash in teardown,`
      + ' or a bun-level error.',
    );
  }
  if (summary.unexplainedRedRuns?.length) {
    lines.push(
      `- ${summary.unexplainedRedRuns.length} red run(s) that no offender explains`
      + ` (${summary.unexplainedRedRuns.join(', ')}) — the #1359 shape, one level up.`,
    );
  }

  if (summary.consistent?.length) {
    lines.push('', '**Failed in every run — broken rather than flaky:**', ...offenderLines(summary.consistent, summary.runs));
  }
  if (summary.flaky?.length) {
    lines.push('', '**Failed in some runs — flaky:**', ...offenderLines(summary.flaky, summary.runs));
  }
  if (!summary.consistent?.length && !summary.flaky?.length && summary.greenRuns !== summary.runs) {
    lines.push('', 'No test was named by any run, which is why the terms above matter.');
  }
  return lines;
}

/** The whole report: `{ red, title, body }`. */
export function buildReport(sections, { runUrl = '', bunVersion = '' } = {}) {
  const red = sections.some(({ summary }) => !isGreen(summary));
  const failing = sections.filter(({ summary }) => !isGreen(summary)).map(({ label }) => label);

  const title = red
    ? `${ISSUE_TITLE_PREFIX} ${failing.join(', ')}`
    : `${ISSUE_TITLE_PREFIX} all green`;

  // Built by pushing rather than filtering blanks out of a literal: the blank
  // lines here are Markdown's block separators, and a `.filter(l => l !== '')`
  // over the whole thing runs every heading into the paragraph below it.
  const lines = [
    red
      ? 'A nightly flake run was not green. The detail below is tonight\'s;'
        + ' earlier nights are in this issue\'s comments.'
      : 'Every nightly flake job was green.',
    '',
  ];
  for (const { label, summary } of sections) lines.push(...sectionFor(label, summary), '');
  if (runUrl) lines.push(`[Run and artifacts](${runUrl})`, '');
  if (bunVersion) lines.push(`bun ${bunVersion}`, '');
  lines.push(
    '---',
    '',
    'A test that failed in **every** run is broken rather than flaky and wants a',
    'fix, not a catalogue entry. One that failed in *some* runs belongs in',
    '`docs/…/testing/diagnosing-flakes.mdx` once its cause is known — and the',
    'first question to ask is whether it is a product defect, because the last',
    'time this workflow reported one for thirteen nights running, it was (#839).',
  );
  const body = lines.join('\n');

  return { red, title, body };
}

/* ------------------------------------------------------------------ main --- */

function main(argv) {
  const summaries = [];
  let out = '';
  let runUrl = '';
  let bunVersion = '';
  for (const argument of argv) {
    if (argument.startsWith('--summary=')) summaries.push(parseSummaryArgument(argument.slice(10)));
    else if (argument.startsWith('--out=')) out = argument.slice(6);
    else if (argument.startsWith('--run-url=')) runUrl = argument.slice(10);
    else if (argument.startsWith('--bun-version=')) bunVersion = argument.slice(14);
  }
  if (summaries.length === 0) throw new Error('nightly-flake-report: at least one --summary is required');

  const sections = summaries.map(({ label, path }) => ({ label, summary: readSummary(path) }));
  const report = buildReport(sections, { runUrl, bunVersion });
  if (out) writeFileSync(out, `${report.body}\n`, 'utf8');
  process.stdout.write(`red=${report.red}\ntitle=${report.title}\n`);
}

// `import.meta.main`, like the two sibling scripts: a test imports the exported
// functions and must not have the driver run underneath it.
if (import.meta.main) main(process.argv.slice(2));
