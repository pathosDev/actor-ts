import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DEFAULT_JOURNAL_BREAKER_ID,
  DEFAULT_MAX_CONCURRENT_RECOVERIES,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_BREAKER_ID,
  DEFAULT_SNAPSHOT_IS_OPTIONAL,
  PersistenceBehaviorOptions,
  PersistenceBehaviorOptionsValidator,
  readPersistenceBehaviorOptionsFromConfig,
  type PersistenceBehaviorOptionsType,
} from '../../../src/persistence/PersistenceBehaviorOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #874 — `actor-ts.persistence` was five plugin-id namespaces and nothing
 * else, so a deployment could not bound a replay, cap a restart storm, or put
 * a breaker in front of the journal from a config file at all.
 *
 * Sibling of `PersistenceConfigDefaults.test.ts`, which covers #872's plugin
 * blocks; these five leaves sit one level above those and are read by
 * `PersistenceExtension` rather than by a backend.
 *
 * What the reader has to get right is the mapping (kebab HOCON leaf →
 * camelCase field, with the unit suffix dropped per #1405) and the "absent
 * means absent" rule — a key nobody set has to stay out of the returned
 * object entirely, or it lands as an explicit `undefined` and shadows the
 * built-in default underneath it.
 *
 * `Config.parseString` throughout, never `Config.fromObject({'a.b': 1})`: the
 * latter keeps the dotted string as a literal top-level key, so `hasPath`
 * resolves the nested reference.conf value instead and the assertion is about
 * nothing.
 */

/**
 * `toEqual` ignores a property whose value is `undefined`, so a reader
 * rewritten to punch holes passes every `toEqual` below.  The own-key list is
 * what actually pins the omission.
 */
function ownKeysOf(options: object): string[] {
  return Object.keys(options);
}

describe('readPersistenceBehaviorOptionsFromConfig', () => {
  test('reads every behaviour leaf of the persistence block', () => {
    const config = Config.parseString(`
      actor-ts.persistence {
        max-concurrent-recoveries = 8
        recovery-timeout          = 2500ms
        snapshot-is-optional      = true
        journal-breaker           = "jrnl"
        snapshot-breaker          = "snap"
      }
    `);

    expect(readPersistenceBehaviorOptionsFromConfig(config)).toEqual({
      maxConcurrentRecoveries: 8,
      recoveryTimeoutMs: 2_500,
      snapshotIsOptional: true,
      journalBreaker: 'jrnl',
      snapshotBreaker: 'snap',
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const options = readPersistenceBehaviorOptionsFromConfig(
      Config.parseString('actor-ts.system.name = x'),
    );

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('the plugin sub-blocks alone are not behaviour', () => {
    // `journal { plugin }` is the only thing this block held before #874, and
    // it belongs to a different reader.  A behaviour reader that answered for
    // it would be reading another block's leaf.
    const options = readPersistenceBehaviorOptionsFromConfig(Config.parseString(
      'actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.sqlite"',
    ));

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('a partial block leaves the unset leaves out', () => {
    const options = readPersistenceBehaviorOptionsFromConfig(
      Config.parseString('actor-ts.persistence.recovery-timeout = 90ms'),
    );

    expect(options).toEqual({ recoveryTimeoutMs: 90 });
    expect(ownKeysOf(options)).toEqual(['recoveryTimeoutMs']);
  });

  test('the empty string survives the read — it is how a breaker is switched off', () => {
    // `""` is a value, not an absence.  A reader that dropped it the way the
    // SQLite `path` reader drops its placeholder would make the documented
    // off-switch fall through to the default id, and silently give every
    // actor a breaker it asked not to have.
    const options = readPersistenceBehaviorOptionsFromConfig(
      Config.parseString('actor-ts.persistence.journal-breaker = ""'),
    );

    expect(options).toEqual({ journalBreaker: '' });
    expect(ownKeysOf(options)).toEqual(['journalBreaker']);
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    expect(readPersistenceBehaviorOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      maxConcurrentRecoveries: DEFAULT_MAX_CONCURRENT_RECOVERIES,
      recoveryTimeoutMs: DEFAULT_RECOVERY_TIMEOUT_MS,
      snapshotIsOptional: DEFAULT_SNAPSHOT_IS_OPTIONAL,
      journalBreaker: DEFAULT_JOURNAL_BREAKER_ID,
      snapshotBreaker: DEFAULT_SNAPSHOT_BREAKER_ID,
    });
  });
});

describe('PersistenceBehaviorOptionsValidator', () => {
  const check = (settings: Partial<PersistenceBehaviorOptionsType>): void =>
    new PersistenceBehaviorOptionsValidator().validate(settings);

  test('accepts 0 for both bounds — it is the documented "off"', () => {
    expect(() => check({ maxConcurrentRecoveries: 0, recoveryTimeoutMs: 0 })).not.toThrow();
  });

  test('rejects a negative or fractional cap', () => {
    expect(() => check({ maxConcurrentRecoveries: -1 })).toThrow(OptionsError);
    expect(() => check({ maxConcurrentRecoveries: 1.5 })).toThrow(OptionsError);
  });

  test('rejects a negative or infinite recovery timeout', () => {
    expect(() => check({ recoveryTimeoutMs: -1 })).toThrow(OptionsError);
    expect(() => check({ recoveryTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(OptionsError);
  });

  test('an unset field always passes', () => {
    expect(() => check({})).not.toThrow();
  });
});

describe('PersistenceBehaviorOptionsBuilder', () => {
  test('a builder is structurally the bag of fields it was given', () => {
    // The naming lockstep the project requires, asserted rather than assumed:
    // builder `withX` ⇔ field `x` ⇔ HOCON leaf `x` with the unit suffix
    // dropped.  A `withX` that set the wrong key would still typecheck and
    // would still merge — into a field nothing reads.
    const options = PersistenceBehaviorOptions.create()
      .withMaxConcurrentRecoveries(4)
      .withRecoveryTimeoutMs(1_500)
      .withSnapshotIsOptional(true)
      .withJournalBreaker('shared-database')
      .withSnapshotBreaker('');

    expect({ ...options }).toEqual({
      maxConcurrentRecoveries: 4,
      recoveryTimeoutMs: 1_500,
      snapshotIsOptional: true,
      journalBreaker: 'shared-database',
      snapshotBreaker: '',
    });
    // Unset fields stay unset, so a builder never competes with HOCON.
    expect(ownKeysOf(PersistenceBehaviorOptions.create().withRecoveryTimeoutMs(1)))
      .toEqual(['recoveryTimeoutMs']);
  });
});
