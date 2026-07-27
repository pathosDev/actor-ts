/**
 * Fold a `register*Plugins` composite's shared connection settings into one
 * leaf store's options.
 *
 * The composites let a caller configure the connection once and have the
 * journal, snapshot and durable-state stores share it.  Spelling that out per
 * leaf meant three near-identical lines per backend, each carrying the same
 * subtleties: a leaf may be a builder rather than a plain object, a *missing*
 * leaf must still receive the shared settings, and `undefined` must never
 * overwrite anything.
 *
 * The two directions are deliberately distinct, because the two kinds of shared
 * setting mean different things:
 *
 *   - **`overrides`** — a pre-built pool or client, i.e. one object the stores
 *     are meant to share.  Stating it at the composite level is the more
 *     specific instruction, so it wins over a leaf's own.  (Sharing also
 *     decides ownership: no store closes an injected pool, so the caller
 *     closes it.)
 *   - **`defaults`** — a URL or credential, i.e. a convenience for not
 *     repeating the connection three times.  A leaf that names its own keeps
 *     it.
 */
export function mergeLeafOptions<TOptions extends object>(
  leaf: unknown,
  overrides: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>> = {},
): TOptions {
  const merged = { ...((leaf ?? {}) as object) } as Record<string, unknown>;
  for (const [field, value] of Object.entries(defaults)) {
    if (value !== undefined && merged[field] === undefined) merged[field] = value;
  }
  for (const [field, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[field] = value;
  }
  return merged as TOptions;
}
