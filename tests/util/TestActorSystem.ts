/**
 * Shared factory for an ActorSystem suitable for unit tests.
 *
 * Before this helper existed, ~30 test files had their own
 * `makeSystem(name, config?)` helper:
 *
 *   function makeSystem(name = 'foo', config?: Record<string, unknown>): ActorSystem {
 *     return ActorSystem.create(name, {
 *       logger: new NoopLogger(), logLevel: LogLevel.Off,
 *       config,
 *     });
 *   }
 *
 * Identical across files with minor differences in default name +
 * occasional extra config plumbing.  This helper consolidates the
 * boilerplate; per-file `makeSystem` wrappers can either delete
 * themselves or remain as thin per-file aliases that still call
 * through here.
 *
 * **Behaviour-preserving**: the logger + level defaults match the
 * common per-file shape exactly.  Tests that need a different logger
 * or verbose output pass `{ logger, logLevel }` explicitly.
 */

import { ActorSystem } from '../../src/ActorSystem.js';
import type { ActorSystemSettings } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';

export interface TestActorSystemOptions extends Partial<ActorSystemSettings> {
  /** Override the default test-name.  Default: `'test-system'`. */
  readonly name?: string;
}

/**
 * Create an `ActorSystem` for tests with quiet defaults (NoopLogger,
 * LogLevel.Off).  Spread additional settings via `options` — any
 * field overrides the default.
 *
 *   const sys = createTestActorSystem();
 *   const sys2 = createTestActorSystem({ name: 'my-test', config: { foo: 'bar' } });
 *
 * The returned system is fully isolated — multiple test files can
 * each call this without interference.  Tests own the lifecycle and
 * MUST call `await sys.terminate()` in their cleanup (no auto-
 * cleanup at the helper layer; that would create cross-test
 * coupling).
 */
export function createTestActorSystem(options: TestActorSystemOptions = {}): ActorSystem {
  const { name = 'test-system', ...rest } = options;
  return ActorSystem.create(name, {
    logger: new NoopLogger(),
    logLevel: LogLevel.Off,
    ...rest,
  });
}
