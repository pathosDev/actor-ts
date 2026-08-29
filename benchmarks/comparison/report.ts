/**
 * Turns `results/*.json` into `RESULTS.md`, and refuses to do so when the
 * results do not hold together (#27).
 *
 *   bun run bench:compare:report
 *
 * The rendering is the boring half.  The half that matters is the validation,
 * because a comparison table is the most persuasive and least verifiable
 * artefact this repository produces: every row is a number with a framework
 * name next to it, and nothing about the format tells a reader whether the
 * work behind it happened.  So this generator refuses rather than renders:
 *
 *  - **A row whose completed work does not match what was requested is fatal.**
 *    That is the #1027 failure — a published figure roughly 10x too high
 *    because 90 % of the messages were dropped and the harness counted the
 *    request.  The JavaScript arms already throw on the spot (`js/arm.ts`);
 *    this check is what covers the hand-mirrored cross-language runners,
 *    where that guarantee does not reach.
 *  - **A batch size that disagrees with `js/workload.ts` is fatal.**  The
 *    cross-language runners mirror those constants as literals, so drift is
 *    not hypothetical — and a drifted constant leaves every individual row
 *    looking entirely plausible while the table as a whole compares two
 *    different benchmarks.
 *  - **An unrecognised `schemaVersion` is fatal**, rather than being read
 *    with absent fields defaulting to zero.  A zero in a throughput column
 *    reads as a measurement.
 *
 * Every failure names the file, so the fix is obvious rather than a hunt.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ansi, formatNs, formatRate } from '../lib/stats.js';
import { RESULT_SCHEMA_VERSION, type ComparisonResultFile, type ScenarioResult } from './js/result-file.js';
import { WORKLOAD, type ScenarioName } from './js/workload.js';

const COMPARISON_ROOT = resolve(import.meta.dirname ?? '.', '.');
const RESULTS_DIRECTORY = join(COMPARISON_ROOT, 'results');
const RESULTS_MARKDOWN = join(COMPARISON_ROOT, 'RESULTS.md');

/**
 * Runtimes whose rows may share a table.  Everything else is another virtual
 * machine measured by a mirrored harness, and belongs in its own section —
 * see fairness rule 7 in README.md.
 */
const JAVASCRIPT_RUNTIMES: ReadonlySet<string> = new Set(['bun', 'node', 'deno']);

/** What each scenario actually measures, in one line, for the reader. */
const SCENARIO_DESCRIPTIONS: Readonly<Record<ScenarioName, string>> = {
  'spawn': 'Create a batch of actors and take them through their full lifecycle — '
    + 'spawn, confirmed start, stop, confirmed stop.',
  'tell-throughput': 'Fire-and-forget messages into one actor and read back how many it handled.',
  'ask-round-trip': 'Sequential request/response round trips, depth 1 — a latency measurement, '
    + 'so the percentiles are the point and throughput is derived.',
  'ping-pong': 'Two actors volleying — the scheduler with nothing else in the way.',
};

type LoadedResult = {
  readonly fileName: string;
  readonly content: ComparisonResultFile;
};

function loadResults(): LoadedResult[] {
  let entries: string[];
  try {
    entries = readdirSync(RESULTS_DIRECTORY).filter((f) => f.endsWith('.json')).sort();
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    console.error(
      `No result files in ${RESULTS_DIRECTORY}.\n`
      + '  Measure something first:  bun run bench:compare',
    );
    process.exit(1);
  }
  return entries.map((fileName) => ({
    fileName,
    content: JSON.parse(readFileSync(join(RESULTS_DIRECTORY, fileName), 'utf8')) as ComparisonResultFile,
  }));
}

/**
 * Every reason these results may not be published, collected rather than
 * thrown one at a time — a run that fixes one problem should not have to
 * discover the next one on the next attempt.
 */
function validate(results: ReadonlyArray<LoadedResult>): string[] {
  const problems: string[] = [];

  for (const { fileName, content } of results) {
    if (content.schemaVersion !== RESULT_SCHEMA_VERSION) {
      problems.push(
        `${fileName}: schemaVersion ${content.schemaVersion}, expected ${RESULT_SCHEMA_VERSION}. `
        + 'Re-run the arm rather than reading it with the current reader.',
      );
      continue;
    }

    for (const scenario of content.scenarios) {
      const label = `${fileName}: ${scenario.scenario}/${scenario.case}`;

      if (scenario.completedOperations !== scenario.expectedOperations) {
        problems.push(
          `${label}: completed ${scenario.completedOperations} of `
          + `${scenario.expectedOperations} operations — a row may not be published for `
          + 'work that did not happen (#1027).',
        );
      }

      const canonical = WORKLOAD.find(
        (w) => w.scenario === scenario.scenario && w.case === scenario.case,
      );
      if (canonical === undefined) {
        problems.push(
          `${label}: not a case in js/workload.ts. Either the workload moved and this `
          + 'result is stale, or the arm invented a row nothing else measured.',
        );
        continue;
      }
      if (canonical.opsPerIteration !== scenario.opsPerIteration) {
        problems.push(
          `${label}: opsPerIteration ${scenario.opsPerIteration}, but js/workload.ts says `
          + `${canonical.opsPerIteration}. The arms are not running the same benchmark.`,
        );
      }
      if (canonical.warmupIterations !== scenario.warmupIterations) {
        problems.push(
          `${label}: warmupIterations ${scenario.warmupIterations}, but js/workload.ts says `
          + `${canonical.warmupIterations}. An arm measured mid-compilation is not comparable.`,
        );
      }
      if (canonical.iterations !== scenario.iterations) {
        problems.push(
          `${label}: iterations ${scenario.iterations}, but js/workload.ts says `
          + `${canonical.iterations}. The arms are not running the same benchmark.`,
        );
      }
    }
  }

  return problems;
}

/* ------------------------------- rendering -------------------------------- */

function formatMemory(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  const sign = megabytes >= 0 ? '+' : '−';
  return `${sign}${Math.abs(megabytes).toFixed(1)} MB`;
}

/**
 * The spread of the rounds behind a figure, as a percentage of it.
 *
 * A throughput number with no idea of its own variance invites being read to
 * three significant figures; `± 12 %` says plainly that the last two of them
 * are noise.
 */
function formatSpread(scenario: ScenarioResult): string {
  const stddev = scenario.opsPerSecondStddev;
  if (stddev === undefined || scenario.opsPerSecond === 0) return '—';
  return `± ${((stddev / scenario.opsPerSecond) * 100).toFixed(1)} %`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

type FootnoteRegistry = {
  readonly markers: Map<string, number>;
  readonly texts: string[];
};

function footnoteMarker(registry: FootnoteRegistry, note: string): string {
  const existing = registry.markers.get(note);
  if (existing !== undefined) return `[^${existing}]`;
  const index = registry.texts.length + 1;
  registry.markers.set(note, index);
  registry.texts.push(note);
  return `[^${index}]`;
}

function scenarioRow(
  result: LoadedResult,
  scenario: ScenarioResult,
  registry: FootnoteRegistry,
): string {
  const marker = scenario.notes === undefined ? '' : ` ${footnoteMarker(registry, scenario.notes)}`;
  const memory = scenario.rssDeltaBytes === undefined ? '—' : formatMemory(scenario.rssDeltaBytes);
  return `| ${result.content.framework.name}${marker} `
    + `| ${result.content.runtime.name} ${result.content.runtime.version} `
    + `| ${formatRate(scenario.opsPerSecond, scenario.unit)} `
    + `| ${formatSpread(scenario)} `
    + `| ${formatNs(scenario.perOperationNs)} `
    + `| ${formatNs(scenario.p50Ns)} `
    + `| ${formatNs(scenario.p99Ns)} `
    + `| ${memory} |`;
}

function scenarioSection(
  scenario: ScenarioName,
  results: ReadonlyArray<LoadedResult>,
  registry: FootnoteRegistry,
): string {
  const cases = WORKLOAD.filter((w) => w.scenario === scenario);
  const lines: string[] = [`## ${scenario}`, '', SCENARIO_DESCRIPTIONS[scenario], ''];

  for (const workloadCase of cases) {
    lines.push(`### ${workloadCase.case}`, '');
    lines.push(
      `${formatCount(workloadCase.iterations)} measured iterations of `
      + `${formatCount(workloadCase.opsPerIteration)} ${workloadCase.unit}(s) each — `
      + `${formatCount(workloadCase.iterations * workloadCase.opsPerIteration)} operations per arm, `
      + 'every one of them completion-verified.',
      '',
    );

    const groups: ReadonlyArray<readonly [string, ReadonlyArray<LoadedResult>]> = [
      ['JavaScript — same machine, same harness',
        results.filter((r) => JAVASCRIPT_RUNTIMES.has(r.content.runtime.name))],
      ['Cross-language — different virtual machine, mirrored harness',
        results.filter((r) => !JAVASCRIPT_RUNTIMES.has(r.content.runtime.name))],
    ];

    for (const [heading, groupResults] of groups) {
      const rows = groupResults
        .map((result) => {
          const measured = result.content.scenarios.find(
            (s) => s.scenario === scenario && s.case === workloadCase.case,
          );
          return measured === undefined ? null : scenarioRow(result, measured, registry);
        })
        .filter((row): row is string => row !== null);

      if (rows.length === 0) continue;

      lines.push(`**${heading}**`, '');
      lines.push('| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |');
      lines.push('| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |');
      lines.push(...rows);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function environmentSection(results: ReadonlyArray<LoadedResult>): string {
  const lines = [
    '## Environment',
    '',
    'One row per arm, because they are not required to have been measured together —',
    'and a row taken three months earlier on other hardware should be visible as',
    'exactly that rather than averaged in silently.',
    '',
    '| arm | measured | actor-ts | commit | CPU | cores | RAM | OS |',
    '| --- | -------- | -------- | ------ | --- | ----- | --- | -- |',
  ];
  for (const { content } of results) {
    const environment = content.environment;
    lines.push(
      `| ${content.framework.name} (${content.runtime.name}) `
      + `| ${environment.date} `
      + `| ${environment.actorTsVersion} `
      + `| \`${environment.actorTsCommit}\` `
      + `| ${environment.cpuModel} `
      + `| ${environment.logicalCores} `
      + `| ${(environment.memoryBytes / 1024 ** 3).toFixed(1)} GiB `
      + `| ${environment.os} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function armsSection(results: ReadonlyArray<LoadedResult>): string {
  const lines = [
    '## Arms',
    '',
    '`rounds` is how many interleaved measurements each published row averages.',
    'A single round is not a measurement on a machine that is not otherwise',
    'idle — see the spread column in the tables below.',
    '',
    '| framework | version | language | licence | runtime | rounds |',
    '| --------- | ------- | -------- | ------- | ------- | ------ |',
  ];
  for (const { content } of results) {
    lines.push(
      `| ${content.framework.name} | ${content.framework.version} | ${content.framework.language} `
      + `| ${content.framework.license} | ${content.runtime.name} ${content.runtime.version} `
      + `| ${content.rounds ?? 1} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function skippedSection(results: ReadonlyArray<LoadedResult>): string {
  const rows = results.flatMap(({ content }) =>
    content.skippedScenarios.map((skipped) =>
      `| ${content.framework.name} | ${skipped.scenario}${skipped.case === undefined ? '' : `/${skipped.case}`} `
      + `| ${skipped.reason} |`));

  if (rows.length === 0) return '';

  return [
    '## Not measured',
    '',
    'A scenario a framework cannot express is recorded here rather than filled in',
    'with the nearest available thing and published as a number.',
    '',
    '| framework | scenario | why |',
    '| --------- | -------- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function renderMarkdown(results: ReadonlyArray<LoadedResult>): string {
  const registry: FootnoteRegistry = { markers: new Map(), texts: [] };
  const scenarioNames = [...new Set(WORKLOAD.map((w) => w.scenario))];
  const sections = scenarioNames.map((scenario) => scenarioSection(scenario, results, registry));

  const header = [
    '# Framework comparison — measured results',
    '',
    '<!-- GENERATED FILE — do not edit by hand. -->',
    '',
    '> Regenerate with `bun run bench:compare:report` after a measurement run',
    '> (`bun run bench:compare`).  Hand edits are lost on the next run, and a',
    '> hand-edited benchmark table is worth nothing anyway.',
    '',
    '## How to read this',
    '',
    'These are **ratios, not absolutes**.  Single-machine measurements say nothing',
    'about a production deployment on real hardware with real networks, so compare',
    'columns and treat the last digit of every figure as fiction.',
    '',
    'How much fiction: across five consecutive rounds on an ordinary desktop, the',
    'ask rate varied by 2 % on one arm, 15 % on another and 34 % on a third — while',
    'the *ordering* of the three was identical in every round.  That is the shape of',
    'the noise here, and it is why each row below is the mean of several',
    'interleaved rounds rather than one run — and why every throughput figure',
    'carries the spread of the rounds it averages.  Read a gap smaller than',
    'that spread as "about the same".',
    '',
    'Two rules govern what is in here, both from `README.md`:',
    '',
    '- Every row is **completion-verified**: the arm reported what the system',
    '  actually did, not what it was asked to do, and this file refuses to render',
    '  a row where those disagree (#1027).',
    '- Same-runtime and cross-language rows are **never in one table**.  Two',
    '  JavaScript frameworks on one machine through one harness is a measurement;',
    '  a framework on another virtual machine through a mirrored harness is a',
    '  weaker claim, and mixing them into a single ranking would hide that.',
    '',
  ].join('\n');

  const footer = [
    '## Known gaps',
    '',
    'Stated because a comparison that only lists what it measured reads as a',
    'comparison of everything:',
    '',
    '- **No sharding or clustering row.** A known throughput regression is open',
    '  against sharding (#529); publishing a sharded comparison now would bake it',
    '  into the first number anyone sees.',
    '- **No persistence row.** The persistence benchmarks cover in-memory and',
    '  SQLite only (#1177), so the comparable arm would be a storage-engine',
    '  comparison wearing a framework label.',
    '- **No stored baselines and no regression gate.** Nothing here fails when a',
    '  number moves between releases (#528).',
    '- **The main benchmark suite still publishes no numbers**, and its cluster',
    '  suites never leave the process (#1177).',
    '',
  ].join('\n');

  const footnotes = registry.texts.length === 0
    ? ''
    : ['## Notes', '', ...registry.texts.map((text, index) => `[^${index + 1}]: ${text}`), ''].join('\n');

  return [
    header,
    environmentSection(results),
    armsSection(results),
    ...sections,
    skippedSection(results),
    footnotes,
    footer,
  ].filter((section) => section.length > 0).join('\n');
}

/* --------------------------------- main ----------------------------------- */

function main(): void {
  const results = loadResults();
  const problems = validate(results);

  if (problems.length > 0) {
    console.error(ansi.red(`\n  ✗ ${problems.length} problem(s) — RESULTS.md not written:\n`));
    for (const problem of problems) console.error(`      ${problem}`);
    console.error();
    process.exit(1);
  }

  writeFileSync(RESULTS_MARKDOWN, renderMarkdown(results), 'utf8');

  console.log(`\n  ${ansi.green('✓')} ${results.length} arm(s) validated — wrote ${RESULTS_MARKDOWN}`);
  console.log(ansi.gray('    every row completion-verified against js/workload.ts\n'));

  // The headline table, so the README and docs excerpts are copied rather than
  // retyped.  A retyped benchmark figure is a typo waiting to be published.
  const headline = WORKLOAD.filter((w) => w.case === 'batch=10k' || w.case === 'sequential');
  for (const workloadCase of headline) {
    console.log(`  ${ansi.bold(`${workloadCase.scenario} · ${workloadCase.case}`)}`);
    for (const { content } of results) {
      const measured = content.scenarios.find(
        (s) => s.scenario === workloadCase.scenario && s.case === workloadCase.case,
      );
      if (measured === undefined) continue;
      console.log(
        `      ${content.framework.name.padEnd(12)} ${content.runtime.name.padEnd(5)} `
        + `${formatRate(measured.opsPerSecond, measured.unit).padStart(20)}`
        + `   p50 ${formatNs(measured.p50Ns).padStart(10)}`,
      );
    }
    console.log();
  }
}

main();
