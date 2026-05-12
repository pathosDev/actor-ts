/**
 * Uniform helper for wrapping caught exceptions in a typed framework
 * error class with a contextual message.
 *
 * Before:
 *
 *   try {
 *     await client.foo(key);
 *   } catch (e) {
 *     throw new CacheError(
 *       `RedisCache.foo failed for key '${key}': ${(e as Error).message}`,
 *       e,
 *     );
 *   }
 *
 * After:
 *
 *   try {
 *     await client.foo(key);
 *   } catch (e) {
 *     throw wrapError(e, CacheError, `RedisCache.foo failed for key '${key}'`);
 *   }
 *
 * Two behavioural improvements over the raw `new XxxError(msg, cause)`
 * pattern:
 *
 *   1. **Cause preserved** without inlining the cause's message into
 *      the wrapped message string.  Consumers read the chain via
 *      `.cause` (modern Error standard); double-encoding adds noise
 *      to stack traces.
 *
 *   2. **No double-wrapping**: if `e` is already the same `ErrorClass`,
 *      return it unchanged.  Catches the case where lower layers
 *      already wrapped (e.g., a Journal calls a backend; the backend
 *      wraps in `JournalError`; the journal would otherwise wrap
 *      again in another `JournalError`).
 *
 * Type-parameter `E` is inferred from the `ErrorClass` constructor
 * argument so the return type is the right subclass.
 */

export function wrapError<E extends Error>(
  e: unknown,
  ErrorClass: new (message: string, cause?: unknown) => E,
  message: string,
): E {
  if (e instanceof ErrorClass) return e;
  return new ErrorClass(message, e);
}
