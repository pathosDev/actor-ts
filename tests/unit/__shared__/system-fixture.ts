/**
 * Shared fixtures (#263) — reusable beforeAll/afterAll wrappers
 * for the two most-repeated test setups: a single ActorSystem and
 * a TestKit.
 *
 * Tests can use these to share one ActorSystem across N test()
 * cases in the same describe-block — avoiding the ~50ms boot cost
 * per test while keeping test isolation via per-test actor spawns.
 *
 * Typical:
 *
 *   describe('Foo', () => {
 *     const sys = systemFixture('foo-tests');
 *     test('case A', () => {
 *       const ref = sys().spawnAnonymous(...);
 *       // ...
 *     });
 *     test('case B', () => {
 *       const ref = sys().spawnAnonymous(...);
 *       // ...
 *     });
 *   });
 */
import { afterAll, beforeAll } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';

export interface SystemFixtureOptions {
  readonly logger?: Logger;
  readonly logLevel?: LogLevel;
}

/**
 * Boot one {@link ActorSystem} per describe block.  Returns an
 * accessor — `sys()` — that returns the live system inside any
 * `test()` in the block.  Tears down on afterAll.
 */
export function systemFixture(
  systemName: string,
  opts: SystemFixtureOptions = {},
): () => ActorSystem {
  let sys: ActorSystem | null = null;
  beforeAll(() => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(opts.logger ?? new NoopLogger())
      .withLogLevel(opts.logLevel ?? LogLevel.Off);
    sys = ActorSystem.create(systemName, sysOptions);
  });
  afterAll(async () => {
    if (sys) await sys.terminate();
    sys = null;
  });
  return () => {
    if (!sys) {
      throw new Error(`systemFixture("${systemName}"): not initialised — call from inside a test() body`);
    }
    return sys;
  };
}

/**
 * Boot one {@link TestKit} per describe block.  Same shape as
 * `systemFixture` but exposes the TestKit shorthand (with
 * `createTestProbe`, etc.).
 */
export function testKitFixture(
  systemName: string,
  opts: SystemFixtureOptions = {},
): () => TestKit {
  let kit: TestKit | null = null;
  beforeAll(() => {
    const kitOptions = TestKitOptions.create()
      .withLogger(opts.logger ?? new NoopLogger())
      .withLogLevel(opts.logLevel ?? LogLevel.Off);
    kit = TestKit.create(systemName, kitOptions);
  });
  afterAll(async () => {
    if (kit) await kit.system.terminate();
    kit = null;
  });
  return () => {
    if (!kit) {
      throw new Error(`testKitFixture("${systemName}"): not initialised — call from inside a test() body`);
    }
    return kit;
  };
}
