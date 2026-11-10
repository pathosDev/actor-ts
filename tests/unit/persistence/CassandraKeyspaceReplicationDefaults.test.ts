import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CASSANDRA_REPLICATION_CLASS,
  DEFAULT_CASSANDRA_REPLICATION_FACTOR,
} from '../../../src/persistence/Constants.js';
import { keyspaceDdl } from '../../../src/persistence/journals/CassandraClient.js';

/**
 * The replication `keyspaceDdl` creates a keyspace with, when the connection
 * names none, is the replication the named defaults state (#1490).
 *
 * `CassandraDdl.test.ts` pins the whole default statement by its literal text;
 * these cases pin that the class and the factor in it follow their constants,
 * so a published leaf has one value to agree with and a moved constant cannot
 * leave a stale literal in force.  Each default is read in isolation — the
 * factor through an explicit `SimpleStrategy` — because a moved class takes
 * the statement to the other branch, where no single factor is written at all.
 */
describe('keyspaceDdl — the replication it applies when the connection names none', () => {
  test('no replication class creates the keyspace under the named class', () => {
    const ddl = keyspaceDdl({ contactPoints: ['h'], keyspace: 'app' });
    expect(ddl).toContain(`'class': '${DEFAULT_CASSANDRA_REPLICATION_CLASS}'`);
    // The value the bare literal at the read site carried before it was named.
    expect(DEFAULT_CASSANDRA_REPLICATION_CLASS).toBe('SimpleStrategy');
  });

  test('a SimpleStrategy keyspace with no factor is created at the named factor', () => {
    const ddl = keyspaceDdl({ contactPoints: ['h'], keyspace: 'app', replication: { class: 'SimpleStrategy' } });
    expect(ddl).toContain(`'replication_factor': ${DEFAULT_CASSANDRA_REPLICATION_FACTOR} }`);
    expect(DEFAULT_CASSANDRA_REPLICATION_FACTOR).toBe(1);
  });

  test('a stated factor is created as stated, not replaced by the default', () => {
    const ddl = keyspaceDdl({
      contactPoints: ['h'],
      keyspace: 'app',
      replication: { class: 'SimpleStrategy', replicationFactor: 3 },
    });
    expect(ddl).toContain(`'replication_factor': 3 }`);
  });

  test('a stated class is created as stated, not replaced by the default', () => {
    const ddl = keyspaceDdl({
      contactPoints: ['h'],
      keyspace: 'app',
      replication: { class: 'NetworkTopologyStrategy', dataCenters: { dc1: 3 } },
    });
    expect(ddl).toBe(
      `CREATE KEYSPACE IF NOT EXISTS app WITH replication = { 'class': 'NetworkTopologyStrategy', 'dc1': 3 }`,
    );
  });
});
