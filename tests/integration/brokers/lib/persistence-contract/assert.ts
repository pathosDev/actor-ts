/**
 * Assertion helpers for the persistence contract scenarios.
 *
 * Deliberately dependency-free (no `bun:test`): the same scenario modules
 * run inside the Docker integration runners, which execute as plain
 * scripts under `bun <runner>.ts` with no test framework loaded.
 */

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`assertion failed: ${message} — expected ${b}, got ${a}`);
}

/**
 * Assert that `fn` rejects with an error whose `name` is `name`.  Matching on
 * the name rather than `instanceof` keeps the scenarios usable from the Docker
 * runners, where a store may have been loaded through a different module
 * instance than the error class the assertion imports.
 */
export async function expectThrows(
  fn: () => Promise<unknown>,
  name: string,
  what: string,
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    if ((e as Error).name === name) return e as Error;
    throw new Error(`${what}: expected ${name}, got ${(e as Error).name}: ${(e as Error).message}`);
  }
  throw new Error(`${what}: expected ${name} to be thrown, but nothing was`);
}
