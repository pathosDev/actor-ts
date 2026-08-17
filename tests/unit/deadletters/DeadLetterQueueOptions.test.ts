import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import {
  DEFAULT_DEAD_LETTER_MAX_ENTRIES,
  DEFAULT_DEAD_LETTER_MAX_REPLAYS,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_DEAD_LETTER_STORE,
  DeadLetterQueueOptions,
  DeadLetterQueueOptionsValidator,
  defaultDeadLetterPersistenceId,
  readDeadLetterQueueOptionsFromConfig,
  type DeadLetterQueueOptionsType,
} from '../../../src/deadletters/DeadLetterQueueOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const check = (s: Partial<DeadLetterQueueOptionsType>): void =>
  new DeadLetterQueueOptionsValidator().validate(s);

describe('DeadLetterQueueOptionsValidator', () => {
  test('rejects a store outside the three known values', () => {
    expect(() => check({ store: 'log-only' as never })).toThrow(OptionsError);
    expect(() => check({ store: 'memory' })).not.toThrow();
    expect(() => check({ store: 'persistent' })).not.toThrow();
    expect(() => check({ store: 'off' })).not.toThrow();
  });

  test('rejects a non-positive or fractional maxEntries', () => {
    expect(() => check({ maxEntries: 0 })).toThrow(OptionsError);
    expect(() => check({ maxEntries: 1.5 })).toThrow(OptionsError);
    expect(() => check({ maxEntries: 1 })).not.toThrow();
  });

  test('accepts 0 for retention and maxReplays but not a negative one', () => {
    // 0 is meaningful for both: "never age out" and "captured, never
    // replayable".  A validator that demanded positives would have made two
    // coherent postures unexpressible.
    expect(() => check({ retentionMs: 0, maxReplays: 0 })).not.toThrow();
    expect(() => check({ retentionMs: -1 })).toThrow(OptionsError);
    expect(() => check({ maxReplays: -1 })).toThrow(OptionsError);
  });

  test('rejects an empty persistenceId', () => {
    expect(() => check({ persistenceId: '' })).toThrow(OptionsError);
    expect(() => check({ persistenceId: 'letters' })).not.toThrow();
  });

  test('an entirely unset options object passes', () => {
    expect(() => check({})).not.toThrow();
  });
});

describe('DeadLetterQueueOptionsBuilder', () => {
  test('a builder is structurally the settings it was given', () => {
    const options = DeadLetterQueueOptions.create()
      .withStore('persistent')
      .withMaxEntries(50)
      .withRetentionMs(1_000)
      .withMaxReplays(1)
      .withPersistenceId('letters');
    expect({ ...options }).toEqual({
      store: 'persistent',
      maxEntries: 50,
      retentionMs: 1_000,
      maxReplays: 1,
      persistenceId: 'letters',
    });
  });
});

describe('readDeadLetterQueueOptionsFromConfig', () => {
  test('an absent key is left out entirely, so the built-in default survives', () => {
    expect(readDeadLetterQueueOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('reads every leaf, with retention as a duration', () => {
    const config = Config.fromObject({
      'actor-ts': {
        'dead-letters': {
          store: 'memory',
          'max-entries': 7,
          retention: '2s',
          'max-replays': 2,
          'persistence-id': 'letters',
        },
      },
    });
    expect(readDeadLetterQueueOptionsFromConfig(config)).toEqual({
      store: 'memory',
      maxEntries: 7,
      retentionMs: 2_000,
      maxReplays: 2,
      persistenceId: 'letters',
    });
  });

  test('the shipped empty persistence-id reads as unset, not as an empty string', () => {
    // reference.conf ships `persistence-id = ""` to document the key.  Passed
    // through it would reach the validator, which rejects an empty string —
    // so an operator who changed nothing would fail to start.
    const config = Config.fromObject({
      'actor-ts': { 'dead-letters': { 'persistence-id': '' } },
    });
    expect(readDeadLetterQueueOptionsFromConfig(config)).toEqual({});
  });
});

describe('built-in defaults', () => {
  test('capture is off, so nothing changes for a system that did not ask', () => {
    expect(DEFAULT_DEAD_LETTER_STORE).toBe('off');
  });

  test('the ring and the replay cap are bounded', () => {
    expect(DEFAULT_DEAD_LETTER_MAX_ENTRIES).toBeGreaterThan(0);
    expect(DEFAULT_DEAD_LETTER_RETENTION_MS).toBeGreaterThan(0);
    expect(DEFAULT_DEAD_LETTER_MAX_REPLAYS).toBeGreaterThan(0);
  });

  test('the derived persistence id carries the system name', () => {
    expect(defaultDeadLetterPersistenceId('orders')).toContain('orders');
    expect(defaultDeadLetterPersistenceId('orders'))
      .not.toBe(defaultDeadLetterPersistenceId('billing'));
  });
});
