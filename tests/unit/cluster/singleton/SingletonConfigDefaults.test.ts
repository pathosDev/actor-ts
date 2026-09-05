/**
 * `readSingletonOptionsFromConfig` — the reader half of
 * `actor-ts.cluster.singleton.*` (#855).
 *
 * Exact objects throughout, and `Object.keys` beside every one of them.  A
 * `toEqual({ … })` alone passes for a result carrying explicit `undefined`s,
 * and that is precisely the bug the `hasPath` guards exist to prevent:
 * `mergeOptions` falls through on `undefined`, not on absent, so a
 * present-but-undefined field would shadow the built-in default the config
 * layer was supposed to sit *under*.
 *
 * `Config.parseString` and never `Config.fromObject({'actor-ts.x.y': …})`: the
 * latter keeps the dotted string as one literal top-level key, so `hasPath`
 * goes on resolving the nested `reference.conf` value and the test asserts
 * nothing.
 */
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../../src/config/Config.js';
import { ConfigKeys } from '../../../../src/config/ConfigKeys.js';
import {
  DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS,
  DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS,
  DEFAULT_SINGLETON_MAX_HAND_OVER_STATE_BYTES,
  DEFAULT_SINGLETON_RESTART_ON_TERMINATION,
} from '../../../../src/cluster/Constants.js';
import {
  DEFAULT_BUFFER_SIZE,
  readSingletonOptionsFromConfig,
} from '../../../../src/cluster/singleton/StartSingletonOptions.js';
import type { SingletonConfigDefaults } from '../../../../src/cluster/singleton/StartSingletonOptions.js';
import { mergeOptions } from '../../../../src/util/OptionsMerge.js';

describe('readSingletonOptionsFromConfig', () => {
  test('reads every key of the singleton block', () => {
    const config = Config.parseString(`
      actor-ts.cluster.singleton {
        role                      = "backend"
        buffer-size               = 4096
        hand-over-timeout         = 30s
        acquire-retry-interval    = 1500ms
        max-hand-over-state-bytes = 64K
        restart-on-termination    = off
      }
    `);

    expect(readSingletonOptionsFromConfig(config)).toEqual({
      role: 'backend',
      bufferSize: 4_096,
      handOverTimeoutMs: 30_000,
      acquireRetryIntervalMs: 1_500,
      maxHandOverStateBytes: 65_536,
      restartOnTermination: false,
    });
  });

  test('omits absent keys entirely rather than reporting them as undefined', () => {
    const config = Config.parseString('actor-ts.cluster.singleton.hand-over-timeout = 90s');
    const fromConfig = readSingletonOptionsFromConfig(config);

    expect(fromConfig).toEqual({ handOverTimeoutMs: 90_000 });
    // The distinction that matters: a present-but-undefined key would shadow
    // the built-in default once spread.
    expect(Object.keys(fromConfig)).toEqual(['handOverTimeoutMs']);
  });

  test('an empty config yields no settings at all', () => {
    expect(readSingletonOptionsFromConfig(Config.empty())).toEqual({});
    expect(Object.keys(readSingletonOptionsFromConfig(Config.empty()))).toEqual([]);
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // The values `reference.conf` ships have to equal what the code falls back
    // to, or merely wiring the block would change behaviour for everyone who
    // configured nothing.
    //
    // `role` is absent from this object although the leaf *does* ship: it
    // ships as `""`, so `hasPath` is true forever, and the reader's
    // empty-string skip is the only thing keeping `role: ''` out of every
    // merged options object on every node.  Here that is not merely tidy —
    // `StartSingletonOptionsValidator.nonEmptyString('role')` throws on `''`,
    // so passing it through would refuse every `start()` on a node that copied
    // the shipped file unedited.
    const config = Config.loadReference();

    expect(readSingletonOptionsFromConfig(config)).toEqual({
      bufferSize: DEFAULT_BUFFER_SIZE,
      handOverTimeoutMs: DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS,
      acquireRetryIntervalMs: DEFAULT_SINGLETON_ACQUIRE_RETRY_INTERVAL_MS,
      maxHandOverStateBytes: DEFAULT_SINGLETON_MAX_HAND_OVER_STATE_BYTES,
      restartOnTermination: DEFAULT_SINGLETON_RESTART_ON_TERMINATION,
    });
    expect(Object.keys(readSingletonOptionsFromConfig(config))).not.toContain('role');
  });

  test('an explicitly empty role is "unrestricted", not a role named ""', () => {
    // The shape an operator hits by leaving the shipped line alone.  Two
    // separate failures ride on the skip: `role: ''` would shadow an explicit
    // `withRole` on the layer above (`mergeOptions` only falls through on
    // `undefined`), and it would fail the options validator outright.
    const config = Config.parseString('actor-ts.cluster.singleton.role = ""');

    expect(readSingletonOptionsFromConfig(config)).toEqual({});
    expect(Object.keys(readSingletonOptionsFromConfig(config))).toEqual([]);
  });

  test('explicit options beat HOCON, and an explicit undefined does not shadow', () => {
    const config = Config.parseString(`
      actor-ts.cluster.singleton {
        role        = "backend"
        buffer-size = 32
      }
    `);
    const fromConfig = readSingletonOptionsFromConfig(config);

    const explicit = mergeOptions<SingletonConfigDefaults>(
      {},
      fromConfig,
      { role: 'gpu', bufferSize: undefined },
    );
    expect(explicit.role).toBe('gpu');
    // `bufferSize: undefined` is "not set", not "explicitly clear" — the
    // configured 32 has to survive it, or every partially-filled options object
    // would blank out the config file underneath it.
    expect(explicit.bufferSize).toBe(32);

    expect(mergeOptions<SingletonConfigDefaults>({}, fromConfig, {}).role).toBe('backend');
  });

  test('every key it reads is reachable from ConfigKeys as a full dotted path', () => {
    // Full paths rather than a bare `singleton` root, and the exact object is
    // what holds that shape: `NoDeadConfigKeys`' `coveringAccessor` falls back
    // to the nearest config root, so a root-only declaration would pass the
    // dead-key guard for every leaf beneath it whether or not anything read
    // one.
    expect(ConfigKeys.cluster.singleton).toEqual({
      role: 'actor-ts.cluster.singleton.role',
      bufferSize: 'actor-ts.cluster.singleton.buffer-size',
      handOverTimeout: 'actor-ts.cluster.singleton.hand-over-timeout',
      acquireRetryInterval: 'actor-ts.cluster.singleton.acquire-retry-interval',
      maxHandOverStateBytes: 'actor-ts.cluster.singleton.max-hand-over-state-bytes',
      restartOnTermination: 'actor-ts.cluster.singleton.restart-on-termination',
    });
  });

  test('the keys with no mechanism behind them are still absent', () => {
    // Four of the eight keys #855 proposed have nothing to configure, and one
    // more is refused in writing by `SINGLETON_HAND_OVER_RETRY_INTERVAL_MS`'s
    // JSDoc.  Asserted rather than merely omitted, because the cost of the
    // mistake is asymmetric: a key that ships cannot be withdrawn without a
    // breaking config change, and each of these would read as a feature that
    // is not there — `use-lease = on` most of all, which would advertise
    // split-brain protection nothing builds.
    const reference = Config.loadReference();
    for (const leaf of [
      'use-lease',
      'lease-name',
      'hand-over-retry-interval',
      'min-number-of-hand-over-retries',
      'singleton-identification-interval',
    ]) {
      expect(reference.hasPath(`actor-ts.cluster.singleton.${leaf}`)).toBe(false);
    }
    // …and no second block for the proxy: `buffer-size` is a field of the same
    // options type as the manager keys, so `actor-ts.cluster.singleton-proxy`
    // would split one options type across two namespaces.
    expect(reference.hasPath('actor-ts.cluster.singleton-proxy')).toBe(false);
  });
});
