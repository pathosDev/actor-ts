import type { CassandraClientLike, CassandraConnection } from '../../persistence/journals/CassandraClient.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/**
 * Plain settings-object shape consumed by {@link CassandraRememberEntitiesStore}
 * — the shared {@link CassandraConnection} fields plus the store-specific
 * `table` / `autoCreateTables` / `client`.
 */
export interface CassandraRememberEntitiesStoreOptionsType extends CassandraConnection {
  /** Table for the remember-entities state.  Default: `remember_entities`. */
  readonly table?: string;
  /** Auto-create the table on first use.  Default: `true`. */
  readonly autoCreateTables?: boolean;
  /**
   * Inject a pre-built CQL client.  When omitted, the store
   * instantiates its own (via `cassandra-driver`) — but typical
   * deployments share one client across journal + snapshot store +
   * remember-entities, so passing the existing one in is the
   * recommended pattern.
   */
  readonly client?: CassandraClientLike;
}

/**
 * Fluent builder for {@link CassandraRememberEntitiesStoreOptionsType}.
 * Carries `withX` methods for the shared {@link CassandraConnection}
 * fields too — the connection mixin is not built on its own; the store
 * exposes its connection surface directly (same pattern as
 * `CassandraJournalOptions`).
 */
export class CassandraRememberEntitiesStoreOptionsBuilder
  extends OptionsBuilder<CassandraRememberEntitiesStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new CassandraRememberEntitiesStoreOptionsBuilder()`. */
  static create(): CassandraRememberEntitiesStoreOptionsBuilder {
    return new CassandraRememberEntitiesStoreOptionsBuilder();
  }

  /* --- shared CassandraConnection fields --- */

  /** Node(s) to seed the cluster topology from. */
  withContactPoints(contactPoints: ReadonlyArray<string>): this {
    return this.set('contactPoints', contactPoints);
  }

  /** Local DC — required for DCAwareRoundRobinPolicy.  Defaults to `datacenter1`. */
  withLocalDataCenter(localDataCenter: string): this {
    return this.set('localDataCenter', localDataCenter);
  }

  /** Keyspace to `USE` after connect.  Must already exist, or pass `withAutoCreateKeyspace(true)`. */
  withKeyspace(keyspace: string): this {
    return this.set('keyspace', keyspace);
  }

  /** Username/password for PLAIN auth. */
  withCredentials(username: string, password: string): this {
    return this.set('credentials', { username, password });
  }

  /** Port — defaults to 9042. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** If true, create the keyspace on startup (simple strategy, rf=1). */
  withAutoCreateKeyspace(autoCreateKeyspace = true): this {
    return this.set('autoCreateKeyspace', autoCreateKeyspace);
  }

  /** Replication settings used by autoCreateKeyspace.  Ignored otherwise. */
  withReplication(replication: NonNullable<CassandraConnection['replication']>): this {
    return this.set('replication', replication);
  }

  /** CQL consistency level for all reads and writes.  Default `LOCAL_QUORUM` (6). */
  withConsistency(consistency: number): this {
    return this.set('consistency', consistency);
  }

  /* --- store-specific fields --- */

  /** Table for the remember-entities state.  Default: `remember_entities`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Auto-create the table on first use.  Default: `true`. */
  withAutoCreateTables(autoCreateTables = true): this {
    return this.set('autoCreateTables', autoCreateTables);
  }

  /** Inject a pre-built CQL client instead of letting the store instantiate its own. */
  withClient(client: CassandraClientLike): this {
    return this.set('client', client);
  }
}

/**
 * Accepted input for a {@link CassandraRememberEntitiesStore}: the fluent
 * {@link CassandraRememberEntitiesStoreOptionsBuilder} OR a plain (partial)
 * {@link CassandraRememberEntitiesStoreOptionsType} object.
 */
export type CassandraRememberEntitiesStoreOptions =
  | CassandraRememberEntitiesStoreOptionsBuilder
  | Partial<CassandraRememberEntitiesStoreOptionsType>;
/** Value alias so `CassandraRememberEntitiesStoreOptions.create()` resolves to the builder. */
export const CassandraRememberEntitiesStoreOptions = CassandraRememberEntitiesStoreOptionsBuilder;
