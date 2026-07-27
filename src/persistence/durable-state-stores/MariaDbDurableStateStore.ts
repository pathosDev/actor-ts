import { mariaDbDialect } from '../relational/MariaDbDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptMariaDbPool, buildMariaDbPool } from '../journals/MariaDbClient.js';
import type { MariaDbDurableStateStoreOptions, MariaDbDurableStateStoreOptionsType } from './MariaDbDurableStateStoreOptions.js';

/**
 * DurableStateStore backed by MariaDB / MySQL (`mariadb`).
 *
 * Behaviour lives in `RelationalDurableStateStore`; this class supplies the
 * MariaDB dialect, whose revision-0 insert is unguarded, so a collision
 * arrives as a duplicate-key error (1062) rather than zero affected rows.
 * Adding `IGNORE` to make it match Postgres would swallow unrelated errors
 * too, which is why the dialect declares the signal instead.
 */
export class MariaDbDurableStateStore extends RelationalDurableStateStore {
  constructor(options: MariaDbDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as MariaDbDurableStateStoreOptionsType);
    super({
      storeName: 'MariaDbDurableStateStore',
      dialect: mariaDbDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptMariaDbPool(await buildMariaDbPool(resolvedOptions)),
    });
  }
}
