import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * A repo-file invariant over the live-broker persistence runners: a backend
 * that **has** a `PersistenceQuery` implementation must hand it to the shared
 * contract, or the query-side scenarios never touch the real server.
 *
 * **Why this needs a gate and not review.**  `makeQuery` is optional on
 * `SqlPersistenceContext` for a good reason — DynamoDB, libSQL and SQL Server
 * have no query class today, and the query-side scenarios have to *skip* for
 * them rather than pass vacuously.  But nothing distinguishes "this backend
 * cannot answer a tag query" from "someone forgot the line", and the skip is
 * not merely quiet.  `runScenarios` counts a scenario whose `run` resolved as a
 * pass, while the skip inside `adapt` is a `console.log` and a bare `return` —
 * so the log reads:
 *
 * ```text
 * [runner] SKIP journal — a deleted event is invisible to currentEventsByTag: backend has no query implementation
 * [runner] PASS journal — a deleted event is invisible to currentEventsByTag (0ms)
 * ```
 *
 * A `PASS` line for a scenario that asserted nothing, inside a green job.
 * Measured on `integration-brokers` run 32097756965 (nightly, 2026-08-18,
 * `develop` at `292f19cd`, conclusion `success`): the PostgreSQL and MongoDB
 * jobs both logged exactly that pair, while MariaDB logged a real
 * `PASS … (6ms)`.  #391 landed `PostgresQuery` with the live PostgreSQL suite
 * still skipping it, and the commit that wired the other runners recorded the
 * job as finished — which is the failure this file exists to make impossible.
 * The `0ms` is the only other tell, and nobody reads durations in a green log.
 *
 * **Source text, not execution.**  Every runner calls `main()` at module scope
 * and requires its container's environment variables, so importing one to
 * inspect its context is not an option.
 *
 * **Both halves are derived, not listed.**  The requirement comes from
 * `src/persistence/query/`, and the obligated files come from whoever builds an
 * `SqlPersistenceContext` — so a query class that does not exist yet (the #532
 * backends) will oblige its own runner on the first `bun test` after it lands,
 * with no edit here.
 *
 * Sibling repo-file guards: `tests/unit/ci/WorkflowHygiene.test.ts`,
 * `tests/unit/ci/AwaitConditionBudgets.test.ts`,
 * `tests/unit/config/NoDeadConfigKeys.test.ts`.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const QUERY_DIRECTORY = join(REPOSITORY_ROOT, 'src', 'persistence', 'query');
const BROKERS_DIRECTORY = join(REPOSITORY_ROOT, 'tests', 'integration', 'brokers');

/** Repo-relative and forward-slashed, so a failure message reads the same on either OS. */
function repositoryPath(absolute: string): string {
  return relative(REPOSITORY_ROOT, absolute).split('\\').join('/');
}

function typeScriptFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptFilesUnder(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * A **backend** query is one whose constructor names a specific journal class.
 *
 * That single condition excludes both non-backends without naming them:
 * `InMemoryQuery` takes the `Journal` interface, because it is the oracle every
 * indexed backend is measured against rather than an index reader — a runner
 * wiring it would satisfy this gate and prove nothing — and `RelationalQuery`
 * takes its base plus an error name, two parameters, which no runner
 * constructs directly.  Neither is spelled out below on purpose: a third
 * shared base should fall out the same way.
 */
function backendQueryClassesByJournal(): Map<string, string> {
  const byJournal = new Map<string, string>();
  for (const file of typeScriptFilesUnder(QUERY_DIRECTORY)) {
    const text = readFileSync(file, 'utf8');
    const declaration = /export class (\w+Query)\b/.exec(text);
    const construction = /constructor\(\s*(?:(?:private|protected|public|readonly)\s+)*\w+:\s*(\w+Journal)\s*\)/
      .exec(text);
    if (declaration === null || construction === null) continue;
    byJournal.set(construction[1]!, declaration[1]!);
  }
  return byJournal;
}

type PersistenceRunner = {
  /** Repo-relative path, used verbatim in the failure message. */
  readonly path: string;
  readonly text: string;
  /** Journal classes the runner constructs — normally exactly one. */
  readonly journalClasses: readonly string[];
};

/** Every file that builds an `SqlPersistenceContext`, wherever it lives. */
function persistenceRunners(): PersistenceRunner[] {
  const runners: PersistenceRunner[] = [];
  for (const file of typeScriptFilesUnder(BROKERS_DIRECTORY)) {
    const text = readFileSync(file, 'utf8');
    if (!/:\s*SqlPersistenceContext\s*=\s*\{/.test(text)) continue;
    const journalClasses = [...new Set([...text.matchAll(/new (\w+Journal)\(/g)].map((m) => m[1]!))];
    runners.push({ path: repositoryPath(file), text, journalClasses });
  }
  return runners;
}

type QueryWiringViolation = {
  readonly runner: string;
  readonly journalClass: string;
  readonly reason: string;
};

/**
 * Pure over `(runner, requirement)` so the discrimination test below can feed it
 * a mutated copy of a real runner and watch it complain — the gate proving it
 * would have caught the thing it was written for, rather than being believed.
 *
 * Three separate conditions, because each is a different way to get the wiring
 * wrong: the property missing entirely (what #391 shipped), the property
 * present but constructing some other backend's query (a copy-paste between two
 * runners that differ only in prefix), and the class named but never imported
 * (which `typecheck:dev` would also catch, and is asserted here so the failure
 * names the runner instead of a module).
 */
function queryWiringViolations(
  runner: PersistenceRunner,
  queryClassesByJournal: ReadonlyMap<string, string>,
): QueryWiringViolation[] {
  const violations: QueryWiringViolation[] = [];
  for (const journalClass of runner.journalClasses) {
    const queryClass = queryClassesByJournal.get(journalClass);
    if (queryClass === undefined) continue;
    const flag = (reason: string): void => {
      violations.push({ runner: runner.path, journalClass, reason });
    };
    if (!/^\s*makeQuery[:(]/m.test(runner.text)) {
      flag(`sets no makeQuery, so every query-side contract scenario logs "SKIP … backend has no `
        + `query implementation" and is then reported as a pass — wire ${queryClass}`);
      continue;
    }
    if (!runner.text.includes(`new ${queryClass}(`)) {
      flag(`sets makeQuery but never constructs ${queryClass}, so the live suite exercises some `
        + `other backend's read side`);
      continue;
    }
    if (!new RegExp(`import\\s*\\{[^}]*\\b${queryClass}\\b[^}]*\\}\\s*from\\s*'[^']*query/${queryClass}\\.js'`)
      .test(runner.text)) {
      flag(`does not import ${queryClass} from src/persistence/query/${queryClass}.js`);
    }
  }
  return violations;
}

const queryClassesByJournal = backendQueryClassesByJournal();
const runners = persistenceRunners();
const obligatedRunners = runners.filter(
  (runner) => runner.journalClasses.some((journalClass) => queryClassesByJournal.has(journalClass)),
);

describe('live-broker query wiring', () => {
  test('both halves of the invariant actually parsed', () => {
    // Guards the guard: a path change or a regex regression that yielded an
    // empty map or an empty file list would make the assertion below pass
    // without checking anything, which is the exact failure mode it exists to
    // stop. Membership plus a floor, never an exact set — a new query class
    // must flow into the gate on its own, not wait for this list.
    expect([...queryClassesByJournal.entries()].sort()).toEqual(
      expect.arrayContaining([
        ['CassandraJournal', 'CassandraQuery'],
        ['MariaDbJournal', 'MariaDbQuery'],
        ['MongoJournal', 'MongoQuery'],
        ['PostgresJournal', 'PostgresQuery'],
        ['SqliteJournal', 'SqliteQuery'],
      ]),
    );
    // The two shared bases must stay out: `InMemoryQuery` would let a runner
    // satisfy the gate with the oracle, and `RelationalQuery` is not a backend.
    expect(queryClassesByJournal.has('Journal')).toBe(false);
    expect(queryClassesByJournal.has('RelationalJournal')).toBe(false);

    expect(runners.map((runner) => runner.path)).toEqual(
      expect.arrayContaining([
        'tests/integration/brokers/lib/PgWireRunner.ts',
        'tests/integration/brokers/mariadb/Runner.ts',
        'tests/integration/brokers/mongodb/Runner.ts',
        'tests/integration/brokers/postgres/Runner.ts',
      ]),
    );
    for (const runner of runners) {
      expect(runner.journalClasses.length, `${runner.path} builds no journal`).toBe(1);
    }
    // The requirement has to discriminate, not apply to everyone: at least one
    // runner drives a backend with no query class and is legitimately exempt.
    expect(obligatedRunners.length).toBeGreaterThanOrEqual(4);
    expect(runners.length).toBeGreaterThan(obligatedRunners.length);
  });

  test('every runner whose backend has a query class wires it into the contract', () => {
    const violations = runners.flatMap((runner) => queryWiringViolations(runner, queryClassesByJournal));
    expect(
      violations.map((violation) => `${violation.runner} (${violation.journalClass}): ${violation.reason}`),
      'A live-broker runner is skipping the query-side persistence contract. The scenarios it '
      + 'skips are the only ones that check a tag index against a real server — and a skip is '
      + 'logged as a PASS, so the job stays green while proving nothing (#391).',
    ).toEqual([]);
  });

  test('the check fails when the wiring is removed', () => {
    // Prove the gate discriminates instead of trusting that it does: strip the
    // real `makeQuery` line out of a real runner and confirm it is reported.
    // Without this, a regex that matched nothing would look identical to a tree
    // that is correctly wired.
    const postgres = runners.find((runner) => runner.path.endsWith('postgres/Runner.ts'));
    expect(postgres).toBeDefined();
    const unwired: PersistenceRunner = {
      ...postgres!,
      text: postgres!.text.split(/\r?\n/).filter((line) => !/^\s*makeQuery[:(]/.test(line)).join('\n'),
    };
    expect(unwired.text).not.toBe(postgres!.text);
    const violations = queryWiringViolations(unwired, queryClassesByJournal);
    expect(violations.map((violation) => violation.journalClass)).toEqual(['PostgresJournal']);
    expect(violations[0]!.reason).toContain('PostgresQuery');
    // …and that it is not a blanket complaint: the same runner as it stands is clean.
    expect(queryWiringViolations(postgres!, queryClassesByJournal)).toEqual([]);
  });

  test('the check fails when a runner wires another backend query class', () => {
    // The second failure mode: two runners differing only in prefix, one
    // copied from the other. `makeQuery` is present, so the previous check
    // passes, and the live suite silently exercises the wrong read side.
    const mariaDb = runners.find((runner) => runner.path.endsWith('mariadb/Runner.ts'));
    expect(mariaDb).toBeDefined();
    const crossWired: PersistenceRunner = {
      ...mariaDb!,
      text: mariaDb!.text.split('MariaDbQuery').join('PostgresQuery'),
    };
    const violations = queryWiringViolations(crossWired, queryClassesByJournal);
    expect(violations.map((violation) => violation.reason)).toEqual([
      expect.stringContaining('never constructs MariaDbQuery'),
    ]);
  });
});
