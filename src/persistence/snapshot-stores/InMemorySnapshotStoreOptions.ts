import { OptionsBuilder } from '../../util/OptionsBuilder.js';

export type InMemorySnapshotStoreOptionsType = {
  /**
   * Maximum snapshots retained per persistenceId; older ones are pruned on
   * save.  `<= 0` keeps every snapshot, matching the rest of the family.
   *
   * **Unset means keep everything**, which is where this store deliberately
   * parts company with its siblings — every persistent store defaults to
   * `3`.  The reason is that this is the store `PersistenceExtension` wires
   * up when nothing else is configured, so a default bound would silently
   * start discarding snapshots for every test and every getting-started
   * app in the repo the moment it landed.  Retention that only shows up as
   * a missing snapshot much later is a poor thing to opt users into; make
   * it explicit instead.
   *
   * The bound is deliberately NOT validated, for the same reason
   * `SqliteSnapshotStoreOptions` does not validate it: the shared contract
   * suite treats any `keepN <= 0` as "keep everything", so a zero or
   * negative value is supported input rather than a mistake.
   */
  readonly keepN?: number;
};

/**
 * Fluent builder for {@link InMemorySnapshotStoreOptionsType}:
 *
 *     new InMemorySnapshotStore(InMemorySnapshotStoreOptions.create().withKeepN(3))
 */
export class InMemorySnapshotStoreOptionsBuilder extends OptionsBuilder<InMemorySnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new InMemorySnapshotStoreOptionsBuilder()`. */
  static create(): InMemorySnapshotStoreOptionsBuilder {
    return new InMemorySnapshotStoreOptionsBuilder();
  }

  /** Maximum snapshots retained per persistenceId; `<= 0` keeps every one. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }
}

/**
 * Accepted input for the in-memory snapshot-store constructor: the fluent
 * {@link InMemorySnapshotStoreOptionsBuilder} OR a plain
 * {@link InMemorySnapshotStoreOptionsType} object.
 */
export type InMemorySnapshotStoreOptions =
  | InMemorySnapshotStoreOptionsBuilder
  | Partial<InMemorySnapshotStoreOptionsType>;
/** Value alias so `InMemorySnapshotStoreOptions.create()` resolves to the builder. */
export const InMemorySnapshotStoreOptions = InMemorySnapshotStoreOptionsBuilder;
