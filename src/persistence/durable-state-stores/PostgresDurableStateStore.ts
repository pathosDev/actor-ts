import { postgresDialect } from '../relational/PostgresDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptPgPool, buildPgPool } from '../journals/PostgresClient.js';
import type { PostgresDurableStateStoreOptions, PostgresDurableStateStoreOptionsType } from './PostgresDurableStateStoreOptions.js';

/**
 * DurableStateStore backed by PostgreSQL (`pg`) — the first SQL-based
 * durable-state store (SQLite and Cassandra ship journal + snapshot only).
 *
 * Behaviour lives in `RelationalDurableStateStore`; this class supplies the
 * Postgres dialect, whose revision-0 insert carries `ON CONFLICT DO NOTHING`
 * so a collision shows up as zero affected rows rather than a thrown error.
 */
export class PostgresDurableStateStore extends RelationalDurableStateStore {
  constructor(options: PostgresDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as PostgresDurableStateStoreOptionsType);
    super({
      storeName: 'PostgresDurableStateStore',
      dialect: postgresDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptPgPool(await buildPgPool(resolvedOptions)),
    });
  }
}
