import { describe, expect, test } from 'bun:test';
import {
  MariaDbDurableStateStoreOptions,
  MariaDbJournalOptions,
  MariaDbSnapshotStoreOptions,
  MsSqlDurableStateStoreOptions,
  MsSqlJournalOptions,
  MsSqlSnapshotStoreOptions,
  PostgresDurableStateStoreOptions,
  PostgresJournalOptions,
  PostgresSnapshotStoreOptions,
} from '../../../src/persistence/index.js';
import { OptionsBuilder } from '../../../src/util/OptionsBuilder.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * Every `withX` on the nine SQL store builders — Postgres, MariaDB and SQL
 * Server, each a journal, a snapshot store and a durable-state store — writes
 * the field it names, and nothing else (#1490).
 *
 * The typed connection setters (`withMaxPoolSize` … `withCaFile`, 42 across
 * the nine) were exercised by nothing: `SqlDriverLeaves` hands the connection
 * fields to the pool builders as plain objects, so a setter wired to its
 * neighbour — `withIdleTimeoutMs` writing `connectTimeoutMs` — or one that sets
 * nothing at all — `withCaFile`, the code route to a CA — type-checks and
 * passes every persistence and config suite.  A builder is its settings, so
 * each setter is called here on a fresh builder and the whole bag is read back
 * as exact own keys.  The last case per builder holds the table to the
 * builder's prototype chain, so a setter added without a row fails here too.
 */

/** A builder's public setters, as the compiler sees them. */
type Setter<B> = Extract<keyof B, `with${string}`>;

/** One call: the setter, the field it must write, and the value it is handed. */
type Row<B> = readonly [setter: Setter<B>, field: string, value: unknown];

type BuilderTable = {
  readonly name: string;
  readonly create: () => object;
  readonly rows: ReadonlyArray<readonly [setter: string, field: string, value: unknown]>;
};

/** Ties a table's setter names to the builder `create` returns, so a misspelt one is a compile error. */
function builderTable<B extends object>(name: string, create: () => B, rows: ReadonlyArray<NoInfer<Row<B>>>): BuilderTable {
  return { name, create, rows };
}

/** A stand-in for each driver's pool, compared by identity: one pool shared across three stores is the point of `withPool`. */
const POSTGRES_POOL = { name: 'postgres pool stand-in' };
const MARIADB_POOL = { name: 'mariadb pool stand-in' };
const MSSQL_POOL = { name: 'mssql pool stand-in' };
/** A stand-in serializer — the builders only carry it to the store. */
const SERIALIZER = { id: 'stand-in-serializer' };

/** The setters each family shares across its journal, snapshot and durable-state builder. */
const POSTGRES_CONNECTION = [
  ['withUrl', 'url', 'postgres://db.internal/app'],
  ['withPoolConfig', 'poolConfig', { application_name: 'ledger' }],
  ['withPool', 'pool', POSTGRES_POOL],
  ['withMaxPoolSize', 'maxPoolSize', 11],
  ['withIdleTimeoutMs', 'idleTimeoutMs', 22_000],
  ['withConnectTimeoutMs', 'connectTimeoutMs', 3_300],
  ['withCaFile', 'caFile', '/etc/ssl/postgres-ca.pem'],
  ['withSerializer', 'serializer', SERIALIZER],
] as const;

const MARIADB_CONNECTION = [
  ['withUrl', 'url', 'mariadb://db.internal/app'],
  ['withPoolConfig', 'poolConfig', { connectionLimit: 7 }],
  ['withPool', 'pool', MARIADB_POOL],
  ['withMaxPoolSize', 'maxPoolSize', 12],
  ['withAcquireTimeoutMs', 'acquireTimeoutMs', 4_400],
  ['withIdleTimeoutMs', 'idleTimeoutMs', 23_000],
  ['withConnectTimeoutMs', 'connectTimeoutMs', 3_400],
  ['withCaFile', 'caFile', '/etc/ssl/mariadb-ca.pem'],
  ['withSerializer', 'serializer', SERIALIZER],
] as const;

const MSSQL_CONNECTION = [
  ['withUrl', 'url', 'Server=db.internal;Database=app'],
  ['withPoolConfig', 'poolConfig', { options: { encrypt: true } }],
  ['withPool', 'pool', MSSQL_POOL],
  ['withMaxPoolSize', 'maxPoolSize', 13],
  ['withIdleTimeoutMs', 'idleTimeoutMs', 24_000],
  ['withConnectTimeoutMs', 'connectTimeoutMs', 3_500],
  ['withRequestTimeoutMs', 'requestTimeoutMs', 5_500],
  ['withCaFile', 'caFile', '/etc/ssl/mssql-ca.pem'],
  ['withSerializer', 'serializer', SERIALIZER],
] as const;

const JOURNAL_TABLES = [
  ['withEventsTable', 'eventsTable', 'journal_events'],
  ['withTagsTable', 'tagsTable', 'journal_tags'],
  ['withAutoCreateTables', 'autoCreateTables', false],
] as const;

const SNAPSHOT_TABLES = [
  ['withSnapshotsTable', 'snapshotsTable', 'snapshot_rows'],
  ['withKeepN', 'keepN', 3],
  ['withAutoCreateTables', 'autoCreateTables', false],
] as const;

const DURABLE_STATE_TABLES = [
  ['withTable', 'table', 'state_rows'],
  ['withAutoCreateTables', 'autoCreateTables', false],
] as const;

const BUILDERS: ReadonlyArray<BuilderTable> = [
  builderTable('PostgresJournalOptions', () => PostgresJournalOptions.create(), [...POSTGRES_CONNECTION, ...JOURNAL_TABLES]),
  builderTable('PostgresSnapshotStoreOptions', () => PostgresSnapshotStoreOptions.create(), [...POSTGRES_CONNECTION, ...SNAPSHOT_TABLES]),
  builderTable(
    'PostgresDurableStateStoreOptions',
    () => PostgresDurableStateStoreOptions.create(),
    [...POSTGRES_CONNECTION, ...DURABLE_STATE_TABLES],
  ),
  builderTable('MariaDbJournalOptions', () => MariaDbJournalOptions.create(), [...MARIADB_CONNECTION, ...JOURNAL_TABLES]),
  builderTable('MariaDbSnapshotStoreOptions', () => MariaDbSnapshotStoreOptions.create(), [...MARIADB_CONNECTION, ...SNAPSHOT_TABLES]),
  builderTable(
    'MariaDbDurableStateStoreOptions',
    () => MariaDbDurableStateStoreOptions.create(),
    [...MARIADB_CONNECTION, ...DURABLE_STATE_TABLES],
  ),
  builderTable('MsSqlJournalOptions', () => MsSqlJournalOptions.create(), [...MSSQL_CONNECTION, ...JOURNAL_TABLES]),
  builderTable('MsSqlSnapshotStoreOptions', () => MsSqlSnapshotStoreOptions.create(), [...MSSQL_CONNECTION, ...SNAPSHOT_TABLES]),
  builderTable(
    'MsSqlDurableStateStoreOptions',
    () => MsSqlDurableStateStoreOptions.create(),
    [...MSSQL_CONNECTION, ...DURABLE_STATE_TABLES],
  ),
];

/** The fields a builder holds — its own enumerable properties, which is all a spread copies. */
const fieldsOf = (builder: object): Record<string, unknown> => ({ ...builder });

/** Every `with…` method on the builder's prototype chain, above the shared mechanics. */
function setterNamesOf(builder: object): string[] {
  const names: string[] = [];
  for (
    let prototype: object | null = Object.getPrototypeOf(builder) as object | null;
    prototype !== null && prototype !== OptionsBuilder.prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null
  ) {
    names.push(...Object.getOwnPropertyNames(prototype).filter((name) => name.startsWith('with')));
  }
  return names.sort();
}

describe('the SQL store builders — every withX writes its own field and nothing else', () => {
  for (const { name, create, rows } of BUILDERS) {
    for (const [setter, field, value] of rows) {
      test(`${name}.${setter} sets ${field} alone, and returns the builder`, () => {
        const builder = create();
        const method: unknown = Reflect.get(builder, setter);
        expect(typeof method, `${name} has no ${setter}`).toBe('function');

        expect(Reflect.apply(method as (argument: unknown) => unknown, builder, [value])).toBe(builder);
        expectExactOptions(fieldsOf(builder), { [field]: value });
        if (typeof value === 'object' && value !== null) expect(fieldsOf(builder)[field]).toBe(value);
      });
    }

    test(`${name}: the table names every setter the builder has`, () => {
      expect(setterNamesOf(create())).toEqual(rows.map(([setter]) => setter).sort());
    });
  }
});
