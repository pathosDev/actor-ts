import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  DEAD_LETTER_STORES,
  DEFAULT_DEAD_LETTER_MAX_ENTRIES,
  DEFAULT_DEAD_LETTER_MAX_REPLAYS,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_DEAD_LETTER_STORE,
  DeadLetterQueueOptions,
  DeadLetterQueueOptionsValidator,
  defaultDeadLetterPersistenceId,
  readDeadLetterQueueOptionsFromConfig,
  type DeadLetterQueueOptionsBuilder,
  type DeadLetterQueueOptionsType,
} from '../../../src/deadletters/DeadLetterQueueOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const check = (s: Partial<DeadLetterQueueOptionsType>): void =>
  new DeadLetterQueueOptionsValidator().validate(s);

describe('DeadLetterQueueOptionsValidator', () => {
  test('rejects a store outside the four known values', () => {
    expect(() => check({ store: 'log-only' as never })).toThrow(OptionsError);
    expect(() => check({ store: 'metrics' })).not.toThrow();
    expect(() => check({ store: 'memory' })).not.toThrow();
    expect(() => check({ store: 'persistent' })).not.toThrow();
    expect(() => check({ store: 'off' })).not.toThrow();
  });

  test('the accepted values are the ladder, in retention order', () => {
    // The order is the documented meaning of the enum — "one axis, four
    // rungs, ordered by how much of the letter is retained" — so it is
    // asserted rather than left to the declaration's incidental sequence.
    expect(DEAD_LETTER_STORES).toEqual(['off', 'metrics', 'memory', 'persistent']);
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

describe('ActorSystemOptions.withDeadLetters — the explicit layer', () => {
  /**
   * Until this slot existed the options family had no reachable consumer:
   * `system.deadLetterQueue` is `readonly` and built from HOCON alone, and a
   * queue constructed by hand is never installed as the capture sink, so it
   * is a correctly-configured object that never receives a letter.  These
   * assertions are about the *live* queue for exactly that reason — a test
   * that only checked the merged settings object would have passed on the
   * broken version too.
   */
  function systemWith(
    name: string,
    hocon: ConfigObject,
    explicit?: DeadLetterQueueOptionsBuilder,
  ): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'dead-letters': hocon } });
    if (explicit !== undefined) systemOptions.withDeadLetters(explicit);
    return ActorSystem.create(name, systemOptions);
  }

  test('the builder turns the live queue on, and it actually captures', async () => {
    const deadLetterOptions = DeadLetterQueueOptions.create().withStore('memory');
    const sys = systemWith('dlq-explicit-on', {}, deadLetterOptions);
    try {
      expect(sys.deadLetterQueue.store).toBe('memory');

      // The capture sink is the half a settings-only assertion would miss.
      class Nothing extends Actor<string> { override onReceive(_m: string): void {} }
      const ref = sys.spawn(Nothing, 'gone');
      ref.stop();
      await awaitCondition(() => sys._resolvePath(['user', 'gone']).isNone(), {
        timeoutMs: 4_000,
        label: 'the actor reached the terminated state',
      });
      ref.tell('lost');
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 1, {
        timeoutMs: 4_000,
        label: 'the explicitly-configured queue captured the letter',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('an explicit field wins over the same key in HOCON', async () => {
    const deadLetterOptions = DeadLetterQueueOptions.create().withMaxEntries(9);
    const sys = systemWith(
      'dlq-explicit-wins',
      { store: 'memory', 'max-entries': 4 },
      deadLetterOptions,
    );
    try {
      // maxEntries is not publicly readable, so the ring's behaviour is the
      // observable: 9 wins over 4, therefore a 5th letter is not evicted.
      expect(sys.deadLetterQueue.store).toBe('memory');
      class Nothing extends Actor<string> { override onReceive(_m: string): void {} }
      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        const ref = sys.spawn(Nothing, name);
        ref.stop();
        await awaitCondition(() => sys._resolvePath(['user', name]).isNone(), {
          timeoutMs: 4_000,
          label: `the actor '${name}' reached the terminated state`,
        });
        ref.tell(name);
      }
      await awaitCondition(async () => (await sys.deadLetterQueue.list()).length === 5, {
        timeoutMs: 4_000,
        label: 'all five letters are held, so the cap is 9 rather than 4',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('a field the builder never set still falls through to HOCON', async () => {
    // The precedence rule that matters most in practice: naming one knob in
    // code must not blank the rest of the config block out.  `store` comes
    // from HOCON here and only `maxReplays` is explicit.
    const deadLetterOptions = DeadLetterQueueOptions.create().withMaxReplays(1);
    const sys = systemWith('dlq-explicit-partial', { store: 'persistent' }, deadLetterOptions);
    try {
      expect(sys.deadLetterQueue.store).toBe('persistent');
    } finally {
      await sys.terminate();
    }
  });

  test('an explicit store can switch the queue back off over HOCON', async () => {
    const deadLetterOptions = DeadLetterQueueOptions.create().withStore('off');
    const sys = systemWith('dlq-explicit-off', { store: 'memory' }, deadLetterOptions);
    try {
      expect(sys.deadLetterQueue.store).toBe('off');
    } finally {
      await sys.terminate();
    }
  });

  test('a plain object carrying an undefined field does not shadow HOCON', async () => {
    // `mergeOptions` treats undefined as "not set", not "explicitly clear".
    // A destructured default or a spread partial reaching the slot must not
    // silently blank the config file underneath it.
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'dead-letters': { store: 'memory' } } })
      .withDeadLetters({ store: undefined, maxEntries: 3 });
    const sys = ActorSystem.create('dlq-explicit-undefined', systemOptions);
    try {
      expect(sys.deadLetterQueue.store).toBe('memory');
    } finally {
      await sys.terminate();
    }
  });

  test('an invalid explicit value is rejected at construction', () => {
    const deadLetterOptions = DeadLetterQueueOptions.create().withMaxEntries(0);
    expect(() => systemWith('dlq-explicit-invalid', {}, deadLetterOptions)).toThrow(OptionsError);
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
