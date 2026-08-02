/**
 * The one place the project's options precedence — *explicit options >
 * HOCON > built-in defaults* — is implemented.  `OptionsBuilder` and
 * `OptionsValidator` both describe their own role in terms of this merge, so
 * it lives in `util/` rather than inside whichever subsystem happened to need
 * it first (the broker actors, historically; cluster sharding since #834).
 */

/**
 * Merge options in the documented precedence order:
 *   1. explicit options  (highest — constructor args / builder / plain object)
 *   2. HOCON config
 *   3. built-in defaults  (lowest)
 *
 * `undefined` from a higher layer doesn't shadow a lower one — it means
 * "not set", not "explicitly clear".  Without that rule an options object
 * carrying a field it never assigned (a spread of a partial, a destructured
 * default) would silently blank out the config file underneath it.
 */
export function mergeOptions<S extends object>(
  builtInDefaultOptions: Partial<S>,
  fromConfig: Partial<S>,
  fromExplicit: Partial<S>,
): S {
  return {
    ...builtInDefaultOptions,
    ...stripUndefined(fromConfig),
    ...stripUndefined(fromExplicit),
  } as S;
}

/** Drop keys whose value is `undefined`, so a spread of the result can't shadow. */
export function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
