import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptD1Client, buildD1Client } from '../journals/D1Client.js';
import {
  D1DurableStateStoreOptionsValidator,
  type D1DurableStateStoreOptions,
  type D1DurableStateStoreOptionsType,
} from './D1DurableStateStoreOptions.js';

/**
 * DurableStateStore backed by Cloudflare D1.
 *
 * Behaviour lives in `RelationalDurableStateStore`; the SQLite dialect's
 * revision-0 insert carries `ON CONFLICT DO NOTHING`, so a collision reads back
 * as zero affected rows — which D1 reports as `meta.changes = 0`.  Unlike the
 * journal, durable state needs no multi-statement atomicity at all, so the
 * transport's lack of transactions costs it nothing.
 */
export class D1DurableStateStore extends RelationalDurableStateStore {
  constructor(options: D1DurableStateStoreOptions = {}) {
    const resolvedOptions = (options as D1DurableStateStoreOptionsType);
    new D1DurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'D1DurableStateStore',
      dialect: sqliteDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.client === undefined,
      openPool: async () => adaptD1Client(buildD1Client(resolvedOptions)),
    });
  }
}
