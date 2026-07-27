/**
 * Merge a `register*Plugins` composite's shared `pool` onto one leaf's options.
 *
 * The composites let a caller set the pool once and have the journal, snapshot
 * and durable-state stores share it — which is what makes them close-safe,
 * since a shared pool is caller-owned and no single store ends it.  Spelling
 * that merge out per leaf meant six near-identical lines per backend, each
 * carrying the same two subtleties: a leaf may be a builder rather than a
 * plain object, and a *missing* leaf must still receive the shared pool.
 *
 * A leaf's own `pool`, if it sets one, loses to the shared pool — an explicit
 * composite-level pool is the more specific instruction.
 */
export function withSharedPool<TOptions extends object, TPool>(
  leaf: unknown,
  pool: TPool | undefined,
): TOptions {
  return {
    ...((leaf ?? {}) as object),
    ...(pool === undefined ? {} : { pool }),
  } as TOptions;
}
