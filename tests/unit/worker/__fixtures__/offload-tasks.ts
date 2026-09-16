/**
 * The task module of the offload suites (#1558): pure functions a worker
 * imports by URL.  Nothing here reaches the framework — a task is a function,
 * and that is the point.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export async function asyncDouble(value: number): Promise<number> {
  await Promise.resolve();
  return value * 2;
}

export function boom(message: string): never {
  throw new RangeError(message);
}

/** Never settles: what a task that hangs looks like to the pool. */
export function hang(): Promise<never> {
  return new Promise<never>(() => { /* forever */ });
}

export function sumBytes(bytes: Uint8Array): number {
  let total = 0;
  for (const byte of bytes) total += byte;
  return total;
}

export const NOT_A_FUNCTION = 42;

/** Throws a value that is not an Error — what the worker's error frame has to say about it. */
export function throwsPlain(): never {
  throw 'not an error object';
}
