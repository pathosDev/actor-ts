import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  ISSUE_TITLE_PREFIX,
  buildReport,
  isGreen,
  parseSummaryArgument,
  readSummary,
} from '../../../scripts/nightly-flake-report.mjs';

/**
 * The nightly measurement has to reach somebody.
 *
 * `nightly-flakes.yml` has measured this suite every night for months and the
 * result reached nobody: both jobs were `continue-on-error`, the verdict went
 * into a step summary and a run annotation, and the workflow said so about
 * itself — *"Nothing accumulates the streak. It is counted by a human reading
 * these annotations, which is the same failure that made the quarantine
 * permanent in the first place."*
 *
 * That was not hypothetical. The exit criterion for the #538 quarantine was
 * fourteen consecutive green nights; it stood at twenty-one before anyone
 * looked, and one of the three suites it was hiding turned out to be a product
 * defect rather than a runner problem (#839).
 *
 * So the report has to get two things right, and this file is about the second
 * one: a green night must not raise an alarm, and **a night that produced no
 * verdict must not read as a green one**.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), 'nightly-report-'));

const green = {
  runs: 5,
  greenRuns: 5,
  runsTimedOut: [],
  runsWithoutReport: [],
  runsRedWithoutFailures: [],
  unexplainedRedRuns: [],
  totalExecuted: 58_480,
  totalFailures: 0,
  flaky: [],
  consistent: [],
};

const summaryFile = (body: unknown): string => {
  const path = join(scratch(), 'summary.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
};

describe('a night is green only when nothing at all went wrong', () => {
  test('all runs green, no anomalies', () => {
    expect(isGreen(green)).toBe(true);
  });

  test.each([
    ['a failing run', { greenRuns: 4 }],
    ['a run that never exited', { runsTimedOut: [2] }],
    ['a run that wrote no report', { runsWithoutReport: [3] }],
    ['a non-zero exit with no failing test', { runsRedWithoutFailures: [1] }],
    ['a red run no offender explains', { unexplainedRedRuns: [4] }],
  ])('%s is not green', (_label, override) => {
    expect(isGreen({ ...green, ...override })).toBe(false);
  });

  test('a summary that does not exist is not green', () => {
    // The failure this whole report exists for: "the job produced no verdict"
    // and "the job was green" are opposite facts, and the first two nights of
    // this workflow uploaded no artifact at all while nobody noticed.
    expect(isGreen(readSummary(join(scratch(), 'absent.json')))).toBe(false);
  });

  test('a summary that is not JSON is not green either', () => {
    const path = join(scratch(), 'summary.json');
    writeFileSync(path, 'not json at all', 'utf8');
    expect(isGreen(readSummary(path))).toBe(false);
  });
});

describe('the report says which job and why', () => {
  test('an all-green night is not red and says so', () => {
    const report = buildReport([
      { label: 'whole suite', summary: green },
      { label: 'worker suites', summary: green },
    ]);
    expect(report.red).toBe(false);
    expect(report.title).toBe(`${ISSUE_TITLE_PREFIX} all green`);
    expect(report.body).toContain('Every nightly flake job was green.');
  });

  test('a red night names the failing job in the title', () => {
    const report = buildReport([
      { label: 'whole suite', summary: { ...green, greenRuns: 3 } },
      { label: 'worker suites', summary: green },
    ]);
    expect(report.red).toBe(true);
    expect(report.title).toBe(`${ISSUE_TITLE_PREFIX} whole suite`);
  });

  test('offenders are listed with how often they failed, worst first', () => {
    const report = buildReport([{
      label: 'whole suite',
      summary: {
        ...green,
        greenRuns: 1,
        totalFailures: 6,
        flaky: [{ identity: 'A :: sometimes', failedRuns: [1, 2] }],
        consistent: [{ identity: 'B :: always', failedRuns: [1, 2, 3, 4, 5] }],
      },
    }]);
    expect(report.body).toContain('**Failed in every run — broken rather than flaky:**');
    expect(report.body).toContain('`B :: always` — failed 5 of 5');
    expect(report.body).toContain('**Failed in some runs — flaky:**');
    expect(report.body).toContain('`A :: sometimes` — failed 2 of 5');
  });

  test('a long offender list is capped rather than pasted whole', () => {
    const many = Array.from({ length: 30 }, (_unused, index) => ({
      identity: `T${index}`, failedRuns: [1],
    }));
    const report = buildReport([{
      label: 'whole suite', summary: { ...green, greenRuns: 4, flaky: many },
    }]);
    expect(report.body).toContain('…and 10 more, in the uploaded report.');
  });

  test('a hang is reported as its own thing, not as a failing test', () => {
    // "The suite stopped making progress" and "a test failed" are different
    // facts, and only one of them names something to go and look at.
    const report = buildReport([{
      label: 'worker suites', summary: { ...green, greenRuns: 2, runsTimedOut: [3] },
    }]);
    expect(report.body).toContain('1 run(s) never exited');
    expect(report.body).toContain('stopped making progress');
  });

  test('a missing summary is reported as harder than a red run, not softer', () => {
    const report = buildReport([
      { label: 'whole suite', summary: readSummary(join(scratch(), 'absent.json')) },
    ]);
    expect(report.red).toBe(true);
    expect(report.body).toContain('**No summary was produced.**');
  });

  test('the run link and bun version are carried when given', () => {
    const report = buildReport(
      [{ label: 'whole suite', summary: green }],
      { runUrl: 'https://example.invalid/run/1', bunVersion: '1.4.0' },
    );
    expect(report.body).toContain('[Run and artifacts](https://example.invalid/run/1)');
    expect(report.body).toContain('bun 1.4.0');
  });

  test('the body keeps the blank lines Markdown needs between blocks', () => {
    // The first version filtered every empty string out of the assembled array,
    // which also removed Markdown's block separators — headings ran straight
    // into the paragraph below them and the list never rendered as one.
    const report = buildReport([{
      label: 'whole suite',
      summary: { ...green, greenRuns: 1, flaky: [{ identity: 'A', failedRuns: [1] }] },
    }]);
    const blank = '\n\n';
    expect(report.body).toContain(`### whole suite${blank}- runs:`);
    expect(report.body).toContain(`${blank}**Failed in some runs`);
  });

  test('every report points at the question to ask first', () => {
    // The lesson #839 cost thirteen nights: a repeatedly red suite is a product
    // defect until shown otherwise, not a runner problem.
    const report = buildReport([{ label: 'whole suite', summary: { ...green, greenRuns: 0 } }]);
    expect(report.body).toContain('whether it is a product defect');
  });
});

describe('summary arguments', () => {
  test('label and path are split on the first colon only', () => {
    expect(parseSummaryArgument('whole suite:C:/tmp/summary.json'))
      .toEqual({ label: 'whole suite', path: 'C:/tmp/summary.json' });
  });

  test('a value with no label is refused rather than guessed at', () => {
    expect(() => parseSummaryArgument(':/tmp/summary.json')).toThrow(/label:path/);
  });

  test('a well-formed summary round-trips', () => {
    expect(readSummary(summaryFile(green))).toEqual(green);
  });
});
