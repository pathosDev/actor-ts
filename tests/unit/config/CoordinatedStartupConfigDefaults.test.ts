import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DEFAULT_STARTUP_PHASE_TIMEOUT_MS,
  readCoordinatedStartupOptionsFromConfig,
} from '../../../src/CoordinatedStartupOptions.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * `actor-ts.coordinated-startup` (#1473) — the startup graph's budgets from a
 * config file, read under whatever `ActorSystemOptions.withCoordinatedStartup`
 * sets in code.
 *
 * What the reader has to get right is the mapping (kebab HOCON leaf → field,
 * the unit suffix dropped) and the "absent means absent" rule, at every depth:
 * a phase child that only sets `timeout` must come back without `recover` and
 * `dependsOn`, or the phase it merges into would have them blanked.  `toEqual`
 * cannot see an own `undefined`, so every read goes through
 * `expectExactOptions`.  How the graph applies what is read — the merge with
 * the options, the declared-phase and cycle rules — is
 * `tests/unit/CoordinatedStartup.test.ts`'s business.
 *
 * `Config.parseString` throughout: `Config.fromObject` with a dotted key keeps
 * it as one literal top-level key, and the assertion would be about nothing.
 */

describe('readCoordinatedStartupOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented default budget and no phases', () => {
    // `phases` ships comment-only, so it is absent rather than an empty list.
    expectExactOptions(readCoordinatedStartupOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      defaultPhaseTimeoutMs: DEFAULT_STARTUP_PHASE_TIMEOUT_MS,
    });
  });

  test('every leaf of the block reaches its field, and a phase child keeps only what it sets', () => {
    const config = Config.parseString(`
      actor-ts.coordinated-startup {
        default-phase-timeout = 45s
        phases {
          persistence-start { timeout = 2m }
          before-system-ready { recover = true }
          warm-caches {
            timeout    = 10s
            recover    = false
            depends-on = ["persistence-start"]
          }
        }
      }
    `);

    expectExactOptions(readCoordinatedStartupOptionsFromConfig(config), {
      defaultPhaseTimeoutMs: 45_000,
      phases: [
        { name: 'persistence-start', timeoutMs: 120_000 },
        { name: 'before-system-ready', recover: true },
        { name: 'warm-caches', timeoutMs: 10_000, recover: false, dependsOn: ['persistence-start'] },
      ],
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expectExactOptions(readCoordinatedStartupOptionsFromConfig(Config.parseString('actor-ts.system.name = x')), {});
  });

  test('a block with phases alone leaves the budget out', () => {
    const config = Config.parseString('actor-ts.coordinated-startup.phases.persistence-start.timeout = 5s');

    expectExactOptions(readCoordinatedStartupOptionsFromConfig(config), {
      phases: [{ name: 'persistence-start', timeoutMs: 5_000 }],
    });
  });

  test('the budget is read as a duration: a bare count is milliseconds', () => {
    const config = Config.parseString('actor-ts.coordinated-startup.default-phase-timeout = 1500');

    expectExactOptions(readCoordinatedStartupOptionsFromConfig(config), { defaultPhaseTimeoutMs: 1_500 });
  });

  test('the shutdown block next to it is not read', () => {
    // The two blocks share their leaf names, so a reader handed the wrong
    // root would read the other block's budget without a word.
    const config = Config.parseString(`
      actor-ts.coordinated-shutdown {
        default-phase-timeout = 9s
        phases { service-unbind { timeout = 3s } }
      }
    `);

    expectExactOptions(readCoordinatedStartupOptionsFromConfig(config), {});
  });

  test('a phase child is held to the shutdown block\'s rules: an unknown setting or a bare value is a ConfigError', () => {
    const misspelt = Config.parseString('actor-ts.coordinated-startup.phases.persistence-start.timout = 5s');
    expect(() => readCoordinatedStartupOptionsFromConfig(misspelt)).toThrow(ConfigError);
    expect(() => readCoordinatedStartupOptionsFromConfig(misspelt))
      .toThrow(/actor-ts\.coordinated-startup\.phases\.persistence-start\.timout is not a phase setting/);

    const bare = Config.parseString('actor-ts.coordinated-startup.phases.persistence-start = 5s');
    expect(() => readCoordinatedStartupOptionsFromConfig(bare))
      .toThrow(/actor-ts\.coordinated-startup\.phases\.persistence-start must be a block/);
  });
});
