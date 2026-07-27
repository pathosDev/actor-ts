/**
 * Field-level diff between two reconstructed states.
 *
 * Computed in the browser so the server stays a read-only data source
 * that only ever hands back whole states — one less thing that can be
 * wrong on the side you cannot easily inspect.
 */

/** How one path changed between the two states. */
export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** One leaf of the comparison. */
export interface DiffEntry {
  /** Dotted path, e.g. `items.0.price`; `''` for a scalar root. */
  readonly path: string;
  readonly kind: DiffKind;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * Compare two values leaf by leaf.
 *
 * Objects and arrays are walked; anything else is compared whole, so a
 * changed array element reports as one entry rather than a cascade.
 * Unchanged leaves are included — the panel offers to hide them, and
 * "nothing changed here" is itself an answer worth being able to see.
 */
export function diffStates(before: unknown, after: unknown): ReadonlyArray<DiffEntry> {
  const out: DiffEntry[] = [];

  const walk = (left: unknown, right: unknown, path: string): void => {
    if (isWalkable(left) && isWalkable(right)) {
      for (const key of unionOfKeys(left, right)) {
        const nestedPath = path === '' ? key : `${path}.${key}`;
        const leftHas = Object.hasOwn(left, key);
        const rightHas = Object.hasOwn(right, key);
        if (!leftHas) {
          out.push({ path: nestedPath, kind: 'added', before: undefined, after: read(right, key) });
        } else if (!rightHas) {
          out.push({ path: nestedPath, kind: 'removed', before: read(left, key), after: undefined });
        } else {
          walk(read(left, key), read(right, key), nestedPath);
        }
      }
      return;
    }
    out.push({
      path,
      kind: sameValue(left, right) ? 'unchanged' : 'changed',
      before: left,
      after: right,
    });
  };

  walk(before, after, '');
  return out;
}

/** Entries that actually differ, in the order they were produced. */
export function changedOnly(entries: ReadonlyArray<DiffEntry>): ReadonlyArray<DiffEntry> {
  return entries.filter((entry) => entry.kind !== 'unchanged');
}

function isWalkable(value: unknown): value is Record<string, unknown> {
  // `null` is typeof 'object' but has no keys to walk; treat it as a
  // scalar so `null` → `{}` reads as one change, not a pile of adds.
  return typeof value === 'object' && value !== null;
}

function read(container: Record<string, unknown>, key: string): unknown {
  return container[key];
}

/** Keys of both sides, left's order first, then right's extras. */
function unionOfKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = Object.keys(left);
  for (const key of Object.keys(right)) if (!Object.hasOwn(left, key)) keys.push(key);
  return keys;
}

/** Structural equality for leaves; `NaN` equals itself here. */
function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}
