/**
 * A shard that stops unexpectedly is backed off before its region re-creates
 * it (#1437, the respawn half of #849's "failure backoffs are honoured on the
 * respawn paths").
 *
 * "Unexpectedly" is every stop but the three the region asks for itself — a
 * hand-off, a passivation and a release.  Without a wait, such a shard came
 * straight back on the next message, and under `rememberEntities` it did not
 * even need one: the region asked the coordinator for the shard's registry on
 * every death and re-created the shard on the answer, so a shard whose entity
 * failed its start looped thousands of times a second with no traffic at all.
 *
 * The options half is pinned here too, rather than in
 * `tests/unit/options/NonBrokerOptionsValidators.test.ts`: the four fields
 * exist for the mechanism below, and their rules are what keeps it a backoff.
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

describe('ShardingOptionsValidator — the shard failure backoff (#1437)', () => {
  test('the shipped defaults and a legal set are accepted', () => {
    expect(refusalOf({})).toBeNull();
    expect(refusalOf({
      shardFailureBackoffMinMs: 50,
      shardFailureBackoffMaxMs: 50,
      shardFailureBackoffRandomFactor: 0,
      shardFailureBackoffResetAfterMs: 1,
    })).toBeNull();
    // Both ends of the jitter range are real values: 0 makes every wait exact,
    // 1 lets a wait fall anywhere between nothing and twice its length.
    expect(refusalOf({ shardFailureBackoffRandomFactor: 1 })).toBeNull();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a first wait of %p is refused, naming the field',
    (value) => {
      // Zero is the one that matters: every later wait is a multiple of it, so
      // a zero first wait is the loop the backoff exists to end.
      const refusal = refusalOf({ shardFailureBackoffMinMs: value });

      expect(refusal?.field).toBe('shardFailureBackoffMinMs');
      expect(refusal?.message).toMatch(/^ShardingOptions: shardFailureBackoffMinMs must be a positive finite number/);
    },
  );

  test.each([0, -5, Number.NaN])('a reset window of %p is refused, naming the field', (value) => {
    // A zero window would count every death as the first, so the wait would never grow.
    const refusal = refusalOf({ shardFailureBackoffResetAfterMs: value });

    expect(refusal?.field).toBe('shardFailureBackoffResetAfterMs');
    expect(refusal?.message).toMatch(/must be a positive finite number/);
  });

  test.each([-0.1, 1.5, Number.NaN])('a random factor of %p is refused, naming the field', (value) => {
    const refusal = refusalOf({ shardFailureBackoffRandomFactor: value });

    expect(refusal?.field).toBe('shardFailureBackoffRandomFactor');
    expect(refusal?.message).toMatch(/must be a number in \[0, 1\]/);
  });

  test('a ceiling below the first wait is refused, naming the ceiling', () => {
    const refusal = refusalOf({ shardFailureBackoffMinMs: 5_000, shardFailureBackoffMaxMs: 1_000 });

    expect(refusal?.field).toBe('shardFailureBackoffMaxMs');
    expect(refusal?.message).toMatch(/must be a finite number >= shardFailureBackoffMinMs \(5000\)/);
  });

  test('the pair is checked as resolved, so one field cannot cross the other\'s default', () => {
    // A first wait above the shipped 10 s ceiling, with the ceiling left unset —
    // and the mirror image.  Checked one field at a time, both would pass and the
    // policy the region builds from the resolved pair would throw at its start.
    expect(refusalOf({ shardFailureBackoffMinMs: 20_000 })?.field).toBe('shardFailureBackoffMaxMs');
    expect(refusalOf({ shardFailureBackoffMaxMs: 100 })?.field).toBe('shardFailureBackoffMaxMs');
  });

  test('an unbounded ceiling is refused: the doubling needs somewhere to stop', () => {
    expect(refusalOf({ shardFailureBackoffMaxMs: Number.POSITIVE_INFINITY })?.field)
      .toBe('shardFailureBackoffMaxMs');
  });

  test('a value from HOCON is refused the same way at start, since the reader leaves the bound to the validator', () => {
    // `readShardingOptionsFromConfig` reads `random-factor` as a plain number and
    // checks nothing; what `ClusterSharding.start` validates is the merged
    // options, so a file value outside the range is refused there, by name.
    const fromConfig = readShardingOptionsFromConfig(
      Config.parseString('actor-ts.sharding.shard-failure-backoff.random-factor = 1.5'),
    );
    const merged = mergeOptions<ShardingOptionsType<unknown>>({}, fromConfig, REQUIRED);

    expect(() => new StartShardingOptionsValidator<unknown>().validate(merged))
      .toThrow(/^StartShardingOptions: shardFailureBackoffRandomFactor must be a number in \[0, 1\] \(got 1\.5\)/);
  });
});
