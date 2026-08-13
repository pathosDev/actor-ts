import { describe, expect, test } from 'bun:test';
import { keyspaceDdl, tagIndexDdl } from '../../../src/persistence/journals/CassandraClient.js';

// security audit #616 — the exported DDL helpers run BEFORE the stores' own
// `qualified()` guard (both journal and snapshot store call keyspaceDdl from
// doStart() ahead of ensureTables()), so an unguarded keyspace would reach the
// cluster inside one CREATE KEYSPACE before anything rejected it.
describe('keyspaceDdl validates its identifiers (#616)', () => {
  test('accepts a plain keyspace', () => {
    expect(keyspaceDdl({ contactPoints: ['h'], keyspace: 'my_app' }))
      .toBe(`CREATE KEYSPACE IF NOT EXISTS my_app WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 }`);
  });

  test('rejects an injected keyspace', () => {
    for (const bad of [
      'app WITH durable_writes = false --',
      'a;DROP KEYSPACE x',
      'a b',
      'a-b',
      '',
    ]) {
      expect(() => keyspaceDdl({ contactPoints: ['h'], keyspace: bad })).toThrow(/identifier/);
    }
  });
});

describe('keyspaceDdl escapes data-center names as CQL string literals (#616)', () => {
  test('keeps hyphenated Ec2Snitch-style names working', () => {
    const ddl = keyspaceDdl({
      contactPoints: ['h'],
      keyspace: 'app',
      replication: { class: 'NetworkTopologyStrategy', dataCenters: { 'us-east': 3, 'eu-west-1': 2 } },
    });
    expect(ddl).toContain(`'us-east': 3`);
    expect(ddl).toContain(`'eu-west-1': 2`);
  });

  test('doubles a single quote instead of letting it close the literal', () => {
    const ddl = keyspaceDdl({
      contactPoints: ['h'],
      keyspace: 'app',
      replication: { class: 'NetworkTopologyStrategy', dataCenters: { "dc1', 'evil": 1 } },
    });
    expect(ddl).toContain(`'dc1'', ''evil': 1`);
    // The payload never becomes a second map entry: one colon per DC pair.
    expect(ddl.split(':').length).toBe(3); // 'class' + the single DC pair
  });
});

describe('keyspaceDdl narrows replication factors to integers (#616)', () => {
  test('rejects a non-integer replicationFactor', () => {
    for (const bad of ['1 } AND durable_writes = false --', 1.5, Number.NaN, -1]) {
      expect(() => keyspaceDdl({
        contactPoints: ['h'],
        keyspace: 'app',
        replication: { replicationFactor: bad as number },
      })).toThrow(/non-negative integer/);
    }
  });

  test('rejects a non-integer per-data-center factor but allows zero replicas', () => {
    expect(() => keyspaceDdl({
      contactPoints: ['h'],
      keyspace: 'app',
      replication: { class: 'NetworkTopologyStrategy', dataCenters: { dc1: '3 } --' as unknown as number } },
    })).toThrow(/non-negative integer/);
    expect(keyspaceDdl({
      contactPoints: ['h'],
      keyspace: 'app',
      replication: { class: 'NetworkTopologyStrategy', dataCenters: { dc1: 3, dc2: 0 } },
    })).toContain(`'dc2': 0`);
  });
});

describe('tagIndexDdl validates its identifiers (#616)', () => {
  test('accepts the documented benign shape', () => {
    expect(tagIndexDdl({ keyspace: 'app' })).toContain('CREATE TABLE IF NOT EXISTS app.events_by_tag (');
  });

  test('rejects an injected keyspace or table name', () => {
    expect(() => tagIndexDdl({ keyspace: 'app;DROP TABLE x' })).toThrow(/identifier/);
    expect(() => tagIndexDdl({ keyspace: 'app', tagIndexTable: 't) WITH x --' })).toThrow(/identifier/);
  });
});
