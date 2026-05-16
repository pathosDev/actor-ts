import { MultiNodeSpec, type MultiNodeSpecSettings } from './MultiNodeSpec.js';

/**
 * Test fixture that boots a {@link MultiNodeSpec} ONCE per describe-
 * block and tears it down after the last `test()` in the block runs.
 * Wraps the runner's `beforeAll` / `afterAll` hooks so a multi-node
 * test file doesn't have to re-spin a 3-node cluster per-test —
 * the bootstrap cost is paid once and amortised across the block.
 *
 * **Test-runner agnostic**: the framework's build output mustn't
 * import `bun:test` directly (that breaks Node / Deno consumers
 * who installed actor-ts and then run their own Vitest/Jest suite).
 * Instead the caller passes the runner's `beforeAll` / `afterAll`
 * in.  For Bun:
 *
 *   import { beforeAll, afterAll, describe, test } from 'bun:test';
 *   import { MultiNodeClusterFixture } from 'actor-ts/testkit';
 *
 *   describe('sharding', () => {
 *     const fixture = MultiNodeClusterFixture.create(
 *       { roles: ['a', 'b', 'c'] },
 *       { beforeAll, afterAll },
 *     );
 *
 *     test('shard rebalances on join', async () => {
 *       const a = fixture.spec().clusterFor('a');
 *       // …
 *     });
 *   });
 *
 * Vitest and Jest export `beforeAll` / `afterAll` with compatible
 * signatures, so the same shape works there.
 */
export interface TestRunnerHooks {
  beforeAll(fn: () => void | Promise<void>): void;
  afterAll(fn: () => void | Promise<void>): void;
}

export interface MultiNodeClusterFixture {
  /** The underlying MultiNodeSpec — available inside any `test()` in the describe block. */
  spec(): MultiNodeSpec;
  /**
   * `true` after `beforeAll` has run.  Used by tests that need to
   * detect "is the fixture set up yet" (rare — usually you just
   * call `spec()` and it throws helpfully if not started).
   */
  isStarted(): boolean;
}

export const MultiNodeClusterFixture = {
  /**
   * Register a multi-node cluster fixture in the current describe
   * block.  Returns a handle whose `.spec()` is callable inside any
   * `test()` in the same block.
   *
   * The implementation captures `settings` lazily — start happens
   * inside the registered `beforeAll`, not at `create()` time.
   * Bun's TestKit also hadn't started any actor systems yet at
   * describe-registration time, so any side effects of MultiNodeSpec
   * construction would be wasted if a sibling `test.skip`/filter
   * skipped this block.
   */
  create(
    settings: MultiNodeSpecSettings,
    hooks: TestRunnerHooks,
  ): MultiNodeClusterFixture {
    let spec: MultiNodeSpec | null = null;
    let started = false;

    hooks.beforeAll(async () => {
      spec = new MultiNodeSpec(settings);
      await spec.start();
      started = true;
    });

    hooks.afterAll(async () => {
      if (spec && started) {
        await spec.stop();
        spec = null;
        started = false;
      }
    });

    return {
      spec(): MultiNodeSpec {
        if (!spec) {
          throw new Error(
            'MultiNodeClusterFixture.spec(): the fixture has not started yet.  ' +
            'Call this from inside a `test()` body — the beforeAll hook only runs ' +
            'after all tests in the describe block are registered.',
          );
        }
        return spec;
      },
      isStarted(): boolean { return started; },
    };
  },
};
