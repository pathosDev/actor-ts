import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CASSANDRA_LOCAL_DATA_CENTER,
  DEFAULT_CASSANDRA_PORT,
} from '../../../src/persistence/journals/CassandraClient.js';

/**
 * A Cassandra store that builds its own client builds it with the port and
 * local data center the named defaults state (#1491).
 *
 * `reference.conf` publishes both, and two suites pin the published values to
 * `DEFAULT_CASSANDRA_PORT` and `DEFAULT_CASSANDRA_LOCAL_DATA_CENTER` — while
 * `createCassandraClient` spelled `9042` and `'datacenter1'` on its own, so
 * moving a constant moved the documented default and its tests and left the
 * applied one where it was.  These cases close the loop where the value takes
 * effect: the option bag the driver's `Client` is constructed with, for each
 * of the three stores that build one.
 *
 * Observed in a child process through a stand-in driver; the fixture's header
 * says why it cannot be done in this one.  A literal of the same value passes
 * here as well — what is pinned is that the applied value follows the
 * constant.
 */

type BuiltOptions = {
  readonly localDataCenter?: unknown;
  readonly protocolOptions?: { readonly port?: unknown };
};

let report: ReadonlyMap<string, BuiltOptions> | undefined;

/** Run the fixture once and index the bags it printed by case. */
function fixtureReport(): ReadonlyMap<string, BuiltOptions> {
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
  const bags = new Map<string, BuiltOptions>();
  for (const line of (child.stdout ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) bags.set(line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as BuiltOptions);
  }
  report = bags;
  return bags;
}

describe('createCassandraClient — the connection a store builds its own client with', () => {
  for (const store of ['journal', 'snapshot-store', 'remember-entities']) {
    test(`${store}: no port and no data center build the client with the named defaults`, () => {
      const built = fixtureReport().get(store);
      expect(built, `the fixture reported no client for the ${store}`).toBeDefined();
      expect(built?.localDataCenter).toBe(DEFAULT_CASSANDRA_LOCAL_DATA_CENTER);
      expect(built?.protocolOptions?.port).toBe(DEFAULT_CASSANDRA_PORT);
    }, 45_000);
  }

  test('a stated port and data center build the client instead of the defaults', () => {
    const built = fixtureReport().get('journal-stated');
    expect(built, 'the fixture reported no client for the stated journal').toBeDefined();
    expect(built?.localDataCenter).toBe('eu-west');
    expect(built?.protocolOptions?.port).toBe(9142);
  }, 45_000);

  test('no store binds the client it builds to its keyspace', () => {
    // The driver's own `keyspace` option is the other way a client gets bound:
    // it issues the `USE` on every connection.  The stores name the keyspace in
    // every statement instead, and `autoCreateKeyspace` may have to create it
    // before anything could use it.
    for (const store of ['journal', 'snapshot-store', 'remember-entities', 'journal-stated']) {
      const built = fixtureReport().get(store);
      expect(built, `the fixture reported no client for the ${store}`).toBeDefined();
      expect(Object.keys(built ?? {}), `the ${store} bound its client to a keyspace`).not.toContain('keyspace');
    }
  }, 45_000);

  test('the defaults are the values the literals carried before they were read', () => {
    expect(DEFAULT_CASSANDRA_PORT).toBe(9042);
    expect(DEFAULT_CASSANDRA_LOCAL_DATA_CENTER).toBe('datacenter1');
  });
});
