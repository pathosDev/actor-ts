import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { D1ClientLike } from './D1Client.js';
import type { D1JournalOptions } from './D1JournalOptions.js';
import type { D1SnapshotStoreOptions } from '../snapshot-stores/D1SnapshotStoreOptions.js';
import type { D1DurableStateStoreOptions } from '../durable-state-stores/D1DurableStateStoreOptions.js';

export interface RegisterD1PluginsOptionsType {
  /**
   * Shared transport injected into all three stores — the usual case, since they
   * address the same database and `fetch` pools connections underneath.
   */
  readonly client?: D1ClientLike;
  /** Cloudflare account id applied to every store that does not set its own. */
  readonly accountId?: string;
  /** D1 database id applied to every store that does not set its own. */
  readonly databaseId?: string;
  /** API token applied to every store that does not set its own. */
  readonly apiToken?: string;
  /** API base URL applied to every store that does not set its own. */
  readonly baseUrl?: string;
  /** Journal-specific options (table names, autoCreate). */
  readonly journal?: D1JournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: D1SnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: D1DurableStateStoreOptions;
}

/**
 * Fluent builder for {@link RegisterD1PluginsOptionsType}:
 *
 *     const pluginOptions = RegisterD1PluginsOptions.create()
 *       .withAccountId(process.env.CLOUDFLARE_ACCOUNT_ID)
 *       .withDatabaseId(process.env.D1_DATABASE_ID)
 *       .withApiToken(process.env.CLOUDFLARE_API_TOKEN);
 *     const handles = registerD1Plugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerD1Plugins`, so a leaf carries only its store-specific fields.
 */
export class RegisterD1PluginsOptionsBuilder extends OptionsBuilder<RegisterD1PluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterD1PluginsOptionsBuilder()`. */
  static create(): RegisterD1PluginsOptionsBuilder {
    return new RegisterD1PluginsOptionsBuilder();
  }

  /** Shared transport injected into all three stores. */
  withClient(client: D1ClientLike): this {
    return this.set('client', client);
  }

  /** Cloudflare account id applied to every store that does not set its own. */
  withAccountId(accountId: string): this {
    return this.set('accountId', accountId);
  }

  /** D1 database id applied to every store that does not set its own. */
  withDatabaseId(databaseId: string): this {
    return this.set('databaseId', databaseId);
  }

  /** API token applied to every store that does not set its own. */
  withApiToken(apiToken: string): this {
    return this.set('apiToken', apiToken);
  }

  /** API base URL applied to every store that does not set its own. */
  withBaseUrl(baseUrl: string): this {
    return this.set('baseUrl', baseUrl);
  }

  /** Journal-specific options (table names, autoCreate). */
  withJournal(journal: D1JournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: D1SnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: D1DurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerD1Plugins`: the fluent
 * {@link RegisterD1PluginsOptionsBuilder} OR a plain
 * {@link RegisterD1PluginsOptionsType} object.
 */
export type RegisterD1PluginsOptions =
  | RegisterD1PluginsOptionsBuilder
  | Partial<RegisterD1PluginsOptionsType>;
/** Value alias so `RegisterD1PluginsOptions.create()` resolves to the builder. */
export const RegisterD1PluginsOptions = RegisterD1PluginsOptionsBuilder;
