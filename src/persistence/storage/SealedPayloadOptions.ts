import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from './StoreSerializerOptions.js';

/**
 * The read policy shared by every SQL snapshot and durable-state store that
 * honours the per-actor persistence hooks (#1802) — see `SealedPayload.ts`.
 *
 * Not a HOCON key, deliberately: it opens a migration window on a security
 * control, so it belongs beside the code that turned the hook on and comes out
 * with it, not in a config file that outlives the migration.  The
 * object-storage stores' `allowUntaggedBodies` is the precedent.
 */
export type SealedPayloadOptionsBase = StoreSerializerOptionsBase & {
  /**
   * Re-admit rows that lack the protection an actor's `encryption()` /
   * `integrity()` asks for: plaintext JSON written before the hook was turned
   * on, and frames written without encryption or without a tag.  For the
   * read-then-write migration only — a durable-state row is rewritten sealed
   * on its next `upsert`, a snapshot is superseded by the next save — and
   * dropped once every row is rewritten.  Default `false`: "not encrypted" is
   * a claim made by bytes anyone with write access to the table controls
   * (#965).
   */
  readonly allowPlaintextRows?: boolean;
};

/**
 * Builder half — one `withAllowPlaintextRows` for all twelve SQL store
 * builders.  Same generic-cast pattern as {@link StoreSerializerOptionsBuilder}.
 */
export abstract class SealedPayloadOptionsBuilder<
  T extends SealedPayloadOptionsBase,
> extends StoreSerializerOptionsBuilder<T> {
  /** Re-admit unprotected rows for the hook-migration window (#1802).  Default `false`. */
  withAllowPlaintextRows(allowPlaintextRows: boolean): this {
    return this.set('allowPlaintextRows' as keyof T, allowPlaintextRows as T[keyof T]);
  }
}
