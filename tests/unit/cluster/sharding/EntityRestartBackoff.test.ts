/**
 * An entity that stops without being passivated is backed off before its shard
 * re-creates it (#1437, the entity half of #849's "failure backoffs are honoured
 * on the respawn paths").
 *
 * The options half is pinned here, beside the mechanism its four fields exist
 * for, the way `ShardFailureBackoff.test.ts` pins the region half's: their
 * rules are what keeps it a backoff.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { Config } from '../../../../src/config/Config.js';
import { ShardingOptionsValidator } from '../../../../src/cluster/sharding/ShardingOptions.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  readShardingOptionsFromConfig,
  StartShardingOptionsValidator,
} from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { mergeOptions } from '../../../../src/util/OptionsMerge.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

class NoopEntity extends Actor<unknown> {
  override onReceive(): void { /* never told anything */ }
}

/** The three fields every non-proxy region must have, so only the backoff is under test. */
const REQUIRED: ShardingOptionsType<unknown> = {
  typeName: 'entity',
  entityActor: NoopEntity,
  extractEntityId: (message: unknown) => String(message),
};

/** The error `ShardingOptionsValidator` throws for `settings`, or `null` when it accepts them. */
function refusalOf(settings: Partial<ShardingOptionsType<unknown>>): OptionsError | null {
  try {
    new ShardingOptionsValidator<unknown>().validate({ ...REQUIRED, ...settings });
    return null;
  } catch (error) {
    if (error instanceof OptionsError) return error;
    throw error;
  }
}

describe('ShardingOptionsValidator — the entity restart backoff (#1437)', () => {
  test('the shipped defaults and a legal set are accepted', () => {
    expect(refusalOf({})).toBeNull();
    expect(refusalOf({
      entityRestartBackoffMinMs: 50,
      entityRestartBackoffMaxMs: 50,
      entityRestartBackoffRandomFactor: 0,
      entityRestartBackoffResetAfterMs: 1,
    })).toBeNull();
    // Both ends of the jitter range are real values: 0 makes every wait exact,
    // 1 lets a wait fall anywhere between nothing and twice its length.
    expect(refusalOf({ entityRestartBackoffRandomFactor: 1 })).toBeNull();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a first wait of %p is refused, naming the field',
    (value) => {
      // Zero is the one that matters: every later wait is a multiple of it, so
      // a zero first wait re-creates the entity per message again.
      const refusal = refusalOf({ entityRestartBackoffMinMs: value });

      expect(refusal?.field).toBe('entityRestartBackoffMinMs');
      expect(refusal?.message).toMatch(/^ShardingOptions: entityRestartBackoffMinMs must be a positive finite number/);
    },
  );

  test.each([0, -5, Number.NaN])('a reset window of %p is refused, naming the field', (value) => {
    // A zero window would count every stop as the first, so the wait would never grow.
    const refusal = refusalOf({ entityRestartBackoffResetAfterMs: value });

    expect(refusal?.field).toBe('entityRestartBackoffResetAfterMs');
    expect(refusal?.message).toMatch(/must be a positive finite number/);
  });

  test.each([-0.1, 1.5, Number.NaN])('a random factor of %p is refused, naming the field', (value) => {
    const refusal = refusalOf({ entityRestartBackoffRandomFactor: value });

    expect(refusal?.field).toBe('entityRestartBackoffRandomFactor');
    expect(refusal?.message).toMatch(/must be a number in \[0, 1\]/);
  });

  test('a ceiling below the first wait is refused, naming the ceiling', () => {
    const refusal = refusalOf({ entityRestartBackoffMinMs: 5_000, entityRestartBackoffMaxMs: 1_000 });

    expect(refusal?.field).toBe('entityRestartBackoffMaxMs');
    expect(refusal?.message).toMatch(/must be a finite number >= entityRestartBackoffMinMs \(5000\)/);
  });

  test('the pair is checked as resolved, so one field cannot cross the other\'s default', () => {
    // A first wait above the shipped 10 s ceiling, with the ceiling left unset —
    // and the mirror image.  Checked one field at a time, both would pass, and
    // every shard of the type would run a ceiling below its first wait.
    expect(refusalOf({ entityRestartBackoffMinMs: 20_000 })?.field).toBe('entityRestartBackoffMaxMs');
    expect(refusalOf({ entityRestartBackoffMaxMs: 100 })?.field).toBe('entityRestartBackoffMaxMs');
  });

  test('an unbounded ceiling is refused: the doubling needs somewhere to stop', () => {
    expect(refusalOf({ entityRestartBackoffMaxMs: Number.POSITIVE_INFINITY })?.field)
      .toBe('entityRestartBackoffMaxMs');
  });

  test('the shard failure backoff\'s rules do not stand in for these', () => {
    // The two backoffs are separate settings with separate rules: a legal shard
    // backoff says nothing about the entity one, and the other way round.
    expect(refusalOf({ shardFailureBackoffMinMs: 50, entityRestartBackoffMinMs: 0 })?.field)
      .toBe('entityRestartBackoffMinMs');
    expect(refusalOf({ shardFailureBackoffMinMs: 0, entityRestartBackoffMinMs: 50 })?.field)
      .toBe('shardFailureBackoffMinMs');
  });

  test('a value from HOCON is refused the same way at start, since the reader leaves the bound to the validator', () => {
    // `readShardingOptionsFromConfig` reads `random-factor` as a plain number and
    // checks nothing; what `ClusterSharding.start` validates is the merged
    // options, so a file value outside the range is refused there, by name.
    const fromConfig = readShardingOptionsFromConfig(
      Config.parseString('actor-ts.sharding.entity-restart-backoff.random-factor = 1.5'),
    );
    const merged = mergeOptions<ShardingOptionsType<unknown>>({}, fromConfig, REQUIRED);

    expect(() => new StartShardingOptionsValidator<unknown>().validate(merged))
      .toThrow(/^StartShardingOptions: entityRestartBackoffRandomFactor must be a number in \[0, 1\] \(got 1\.5\)/);
  });
});
