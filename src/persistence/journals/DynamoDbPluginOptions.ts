import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import type { DynamoDbOperations } from './DynamoDbClient.js';
import type { DynamoDbJournalOptions } from './DynamoDbJournalOptions.js';
import type { DynamoDbSnapshotStoreOptions } from '../snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import type { DynamoDbDurableStateStoreOptions } from '../durable-state-stores/DynamoDbDurableStateStoreOptions.js';

export type RegisterDynamoDbPluginsOptionsType = {
  /**
   * Shared operations façade injected into all three stores — the usual case,
   * since one `DynamoDBClient` pools connections for every table.  When omitted,
   * each store lazily builds its own from `region` / `endpoint`.
   */
  readonly operations?: DynamoDbOperations;
  /** AWS region applied to every store that does not set its own. */
  readonly region?: string;
  /** Endpoint override applied to every store that does not set its own. */
  readonly endpoint?: string;
  /** `DynamoDBClient` config applied to every store that does not set its own. */
  readonly clientConfig?: Record<string, unknown>;
  /** Shared payload serializer applied to every store that does not set its own. */
  readonly serializer?: Serializer;
  /** Journal-specific options (table name). */
  readonly journal?: DynamoDbJournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: DynamoDbSnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: DynamoDbDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterDynamoDbPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterDynamoDbPluginsOptions.create()
 *       .withRegion('eu-central-1')
 *       .withSnapshotStore(DynamoDbSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerDynamoDbPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerDynamoDbPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterDynamoDbPluginsOptionsBuilder
  extends OptionsBuilder<RegisterDynamoDbPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterDynamoDbPluginsOptionsBuilder()`. */
  static create(): RegisterDynamoDbPluginsOptionsBuilder {
    return new RegisterDynamoDbPluginsOptionsBuilder();
  }

  /** Shared operations façade injected into all three stores. */
  withOperations(operations: DynamoDbOperations): this {
    return this.set('operations', operations);
  }

  /** Shared payload serializer applied to every store that does not set its own. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** AWS region applied to every store that does not set its own. */
  withRegion(region: string): this {
    return this.set('region', region);
  }

  /** Endpoint override applied to every store that does not set its own. */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint', endpoint);
  }

  /** `DynamoDBClient` config applied to every store that does not set its own. */
  withClientConfig(clientConfig: Record<string, unknown>): this {
    return this.set('clientConfig', clientConfig);
  }

  /** Journal-specific options (table name). */
  withJournal(journal: DynamoDbJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: DynamoDbSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: DynamoDbDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerDynamoDbPlugins`: the fluent
 * {@link RegisterDynamoDbPluginsOptionsBuilder} OR a plain
 * {@link RegisterDynamoDbPluginsOptionsType} object.
 */
export type RegisterDynamoDbPluginsOptions =
  | RegisterDynamoDbPluginsOptionsBuilder
  | Partial<RegisterDynamoDbPluginsOptionsType>;
/** Value alias so `RegisterDynamoDbPluginsOptions.create()` resolves to the builder. */
export const RegisterDynamoDbPluginsOptions = RegisterDynamoDbPluginsOptionsBuilder;
