import { expect } from 'bun:test';

/**
 * Exact-object assertions for what a config reader returns (#1447, #1450).
 *
 * Every `read…FromConfig` promises the same thing: a leaf nobody configured is
 * **omitted**, not written as an explicit `undefined`.  That is what lets a
 * consumer spread the result over the layer beneath it — an own `undefined`
 * shadows that layer, an omitted key falls through to it.  `toEqual` cannot
 * tell the two apart: it ignores a property whose value is `undefined`, at
 * every depth, and bun's also ignores an `undefined` list item.  So a reader
 * rewritten from `if (hasPath) out.x = read()` to
 * `out.x = hasPath ? read() : undefined` passes every `toEqual` written
 * against it — including the ones named `an absent block yields nothing at
 * all, not a bag of undefined`.  Measured, not assumed: that rewrite left the
 * object-storage suite green at 20/0 (#873), and a harness that punched the
 * same holes into every reader of the `*ConfigDefaults` family left some
 * seventy exact-object assertions green, `LeaseConfigDefaults` end to end.
 *
 * `toStrictEqual` sees the hole too, but it also compares prototypes, so it
 * refuses a builder — which *is* its options bag — against a plain literal.
 * The own keys are the property the contract is about, and nothing else.
 */

/** A value whose own keys are part of its shape: a plain object or a list. */
function isNestedData(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathOf(prefix: string, key: string, container: object): string {
  if (Array.isArray(container)) return `${prefix}[${key}]`;
  return prefix === '' ? key : `${prefix}.${key}`;
}

/**
 * Walk `actual` and `expected` side by side, collecting each one's own key
 * paths.  It descends only where *both* hold nested data, so an asymmetric
 * matcher or a class instance on either side stays a leaf and is left to the
 * value comparison — `expect.objectContaining(…)` must not be read as a block
 * whose keys the actual value has to repeat.
 */
function collectKeyPaths(
  actual: unknown,
  expected: unknown,
  prefix: string,
  actualPaths: string[],
  expectedPaths: string[],
): void {
  if (typeof actual !== 'object' || actual === null) return;
  if (typeof expected !== 'object' || expected === null) return;
  const expectedKeys = new Set(Object.keys(expected));
  for (const key of expectedKeys) expectedPaths.push(pathOf(prefix, key, expected));
  for (const key of Object.keys(actual)) {
    const path = pathOf(prefix, key, actual);
    actualPaths.push(path);
    if (!expectedKeys.has(key)) continue;
    const actualChild: unknown = (actual as Record<string, unknown>)[key];
    const expectedChild: unknown = (expected as Record<string, unknown>)[key];
    if (isNestedData(actualChild) && isNestedData(expectedChild)) {
      collectKeyPaths(actualChild, expectedChild, path, actualPaths, expectedPaths);
    }
  }
}

/**
 * Every own enumerable key of `value` as a sorted list of paths, descending
 * into plain objects and lists: `failureDetector.downAfterMs`, `seeds[0]`.
 *
 * The top level is enumerated whatever its prototype, so a builder's own
 * fields count and its `withX` methods do not.  A class instance *below* the
 * top is a leaf — reader results nest only plain data, and a provider such as
 * a downing strategy is a value, not a block.
 */
export function ownKeyPaths(value: unknown): string[] {
  const paths: string[] = [];
  collectKeyPaths(value, value, '', paths, []);
  return paths.sort();
}

/**
 * `expect(actual).toEqual(expected)`, plus the half it cannot see: `actual`
 * must carry exactly the own keys `expected` does, at every depth.  An own
 * `undefined` the reader punched in fails, and so does an expected own
 * `undefined` the reader omitted.  Key order is not compared — a reader writes
 * its fields in its own order, and the contract is about presence.
 *
 * Typed like `toEqual`: `expected` is checked against the reader's result type,
 * so a misspelt field in the expected literal is a compile error.
 */
export function expectExactOptions<T>(actual: T, expected: NoInfer<T>): void {
  expect(actual).toEqual(expected);
  const actualPaths: string[] = [];
  const expectedPaths: string[] = [];
  collectKeyPaths(actual, expected, '', actualPaths, expectedPaths);
  expect(actualPaths.sort(), 'own keys differ: a key present as undefined is not an omitted one')
    .toEqual(expectedPaths.sort());
}
