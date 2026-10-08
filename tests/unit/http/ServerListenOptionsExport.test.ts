import { describe, expect, test } from 'bun:test';
import type { HttpServerBackend, ServerListenOptions } from '../../../src/http/index.js';

/**
 * The options type `HttpServerBackend.listen()` names is reachable from the
 * http barrel — the `actor-ts/http` door — and is exactly the type that
 * method takes (#1487).
 *
 * A backend written outside the repository implements that interface, so it
 * has to be able to name its third parameter's type.  A type-only export is
 * erased at runtime, which leaves `tests/unit/ExportSurface.test.ts` blind to
 * it: what checks it is the import above under `bun run typecheck:dev`, and
 * the assertion below, which stops compiling if the barrel hands out a
 * different type under the name.
 */

/** `true` exactly when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compiles only for `true`. */
type Assert<Condition extends true> = Condition;

export type ServerListenOptionsIsWhatListenTakes = Assert<
  Equals<ServerListenOptions, NonNullable<Parameters<HttpServerBackend['listen']>[2]>>
>;

describe('ServerListenOptions on the http barrel (#1487)', () => {
  test('a backend outside the repository can name what listen() is handed', () => {
    const handed: ServerListenOptions = { idleTimeoutMs: 5_000, requestDeadlineMs: 30_000 };
    expect(handed.requestDeadlineMs).toBe(30_000);
  });
});
