import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * A Cassandra store that builds its own client never binds it to the keyspace
 * with a `USE` (#1491).
 *
 * The stores name the keyspace in every statement instead, and
 * `autoCreateKeyspace` may have to create it before anything could use it —
 * the promise the `keyspace` JSDoc and the #1491 entry make.  Two routes would
 * break it.  The driver's own `keyspace` option issues the `USE` on every
 * connection, and `CassandraClientConnectionDefaults` holds the option bag to
 * that.  A `USE` sent after connect gets past that check, and past
 * `CassandraStatementsNameTheirKeyspace` too, which reads what the stores
 * issue on an injected client — one `createCassandraClient` never builds.  So
 * it is held here, on what each store-built client was asked to run, recorded
 * by the stand-in driver in the fixture's process.
 */

/** The fixture's cases: the three stores that build a client, and the journal again with a stated port and data center. */
const CASES = ['journal', 'snapshot-store', 'remember-entities', 'journal-stated'] as const;

const STATEMENTS_SUFFIX = '.statements=';

let report: ReadonlyMap<string, ReadonlyArray<string>> | undefined;

/** Run the fixture once and index the statement lists it printed by case. */
function statementsByCase(): ReadonlyMap<string, ReadonlyArray<string>> {
  if (report !== undefined) return report;
  const fixture = join(import.meta.dir, 'CassandraClientConnectionDefaults.fixture.ts');
  const child = spawnSync(process.execPath, ['run', fixture], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    // Four store starts against a stand-in driver: process start plus
    // milliseconds.  A run that reaches this limit is a hang, not a slow machine.
    timeout: 30_000,
  });
  expect(child.signal, `the fixture had to be killed; stderr: ${child.stderr ?? ''}`).toBeNull();
  expect(child.status, `the fixture exited non-zero; stderr: ${child.stderr ?? ''}`).toBe(0);
  const statements = new Map<string, ReadonlyArray<string>>();
  for (const line of (child.stdout ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(STATEMENTS_SUFFIX);
    if (separator > 0) {
      statements.set(line.slice(0, separator), JSON.parse(line.slice(separator + STATEMENTS_SUFFIX.length)) as string[]);
    }
  }
  report = statements;
  return statements;
}

/** Whether `statement` is a `USE`, in any case and behind any leading comment or whitespace. */
function isUse(statement: string): boolean {
  const body = statement.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*)*/, '');
  return /^USE\b/i.test(body);
}

describe('a client a Cassandra store builds itself is never bound to its keyspace with USE', () => {
  test('the check recognises a USE however it is written, and nothing else', () => {
    for (const statement of ['USE app', 'use app', '  USE "app"', '\nUSE app;', '/* session */ USE app', '-- bind\nUSE app']) {
      expect(isUse(statement), statement).toBe(true);
    }
    for (const statement of ['CREATE TABLE IF NOT EXISTS app.events ( persistence_id text )', 'SELECT used FROM app.usage']) {
      expect(isUse(statement), statement).toBe(false);
    }
  });

  for (const store of CASES) {
    test(`${store}: no statement its client runs is a USE`, () => {
      const statements = statementsByCase().get(store);
      expect(statements, `the fixture reported no statements for the ${store}`).toBeDefined();
      // An empty list would pass the check below while proving nothing: the
      // start runs the table DDL through this same client.
      expect(statements?.length ?? 0).toBeGreaterThan(0);
      expect((statements ?? []).filter(isUse), `the ${store} bound its client to a keyspace`).toEqual([]);
    }, 45_000);
  }
});
