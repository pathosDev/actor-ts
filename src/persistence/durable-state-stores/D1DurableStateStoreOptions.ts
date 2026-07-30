import {
  D1OptionsBuilderBase,
  D1OptionsValidatorBase,
  type D1OptionsBaseType,
} from '../journals/D1OptionsBase.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';

export type D1DurableStateStoreOptionsType = D1OptionsBaseType & {
  /** Durable-state table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
};

/**
 * Fluent builder for {@link D1DurableStateStoreOptionsType}:
 *
 *     new D1DurableStateStore(D1DurableStateStoreOptions.create()
 *       .withClient(sharedTransport))
 */
export class D1DurableStateStoreOptionsBuilder
  extends D1OptionsBuilderBase<D1DurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new D1DurableStateStoreOptionsBuilder()`. */
  static create(): D1DurableStateStoreOptionsBuilder {
    return new D1DurableStateStoreOptionsBuilder();
  }

  /** Durable-state table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any D1 durable-state constructor: the fluent
 * {@link D1DurableStateStoreOptionsBuilder} OR a plain
 * {@link D1DurableStateStoreOptionsType} object.
 */
export type D1DurableStateStoreOptions =
  | D1DurableStateStoreOptionsBuilder
  | Partial<D1DurableStateStoreOptionsType>;
/** Value alias so `D1DurableStateStoreOptions.create()` resolves to the builder. */
export const D1DurableStateStoreOptions = D1DurableStateStoreOptionsBuilder;

/** Connection rules plus the table name. */
export class D1DurableStateStoreOptionsValidator
  extends D1OptionsValidatorBase<D1DurableStateStoreOptionsType> {
  constructor() { super('D1DurableStateStoreOptions'); }

  protected rules(s: Partial<D1DurableStateStoreOptionsType>): void {
    this.checkConnection(s);
    if (s.table !== undefined) assertSafeIdentifier(s.table, 'durable-state table');
  }
}
