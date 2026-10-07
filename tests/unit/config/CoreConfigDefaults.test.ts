import { describe, expect, test } from 'bun:test';
import {
  readActorThroughputFromConfig,
  readAskTimeoutFromConfig,
  readLoggerCloseTimeoutFromConfig,
  readShutdownDrainTimeoutFromConfig,
  readSystemNameFromConfig,
} from '../../../src/ActorSystem.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * The leaves the `ActorSystem` constructor reads for itself, each through an
 * exported reader (#1425).
 *
 * A reader returns the config's own answer and nothing more: an unset leaf
 * comes back absent — `undefined` from a single-leaf reader, an omitted key
 * from a block reader — and the built-in default is applied once, by the
 * constructor.  That is what lets "configured" and "fell through" be told
 * apart from the output alone, and it is the half of the contract a reader
 * that quietly defaulted a leaf in would break without any system-level test
 * noticing: the system would still start with the right number.
 *
 * Three cases per reader, as in the other `*ConfigDefaults` suites: the
 * reference defaults, written out as literals so they are a second copy that
 * does not lean on the `DEFAULT_*` constants (DocumentedDefaults compares
 * those with reference.conf); every leaf at a value that is not its default,
 * through the accessor its literal needs; and an absent leaf staying absent,
 * with its siblings set so a reader reading the wrong one shows up too.
 *
 * Every assertion goes through `expectExactOptions`, scalars included.  On a
 * scalar it is a plain equality, and `undefined` is the absence; on a block
 * it is the own-key check `toEqual` alone cannot make.
 */
const reference = Config.loadReference();

describe('actor-ts.system', () => {
  test('the reference defaults are the shipped name and drain budget', () => {
    expectExactOptions(readSystemNameFromConfig(reference), 'default');
    expectExactOptions(readShutdownDrainTimeoutFromConfig(reference), 2_000);
  });

  test('every leaf reaches its reader, through the accessor its literal needs', () => {
    const config = Config.parseString(`
      actor-ts.system {
        name                   = "billing"
        shutdown-drain-timeout = 750ms
      }
    `);

    expectExactOptions(readSystemNameFromConfig(config), 'billing');
    expectExactOptions(readShutdownDrainTimeoutFromConfig(config), 750);
  });

  test('an absent leaf stays absent rather than being defaulted in', () => {
    expectExactOptions(
      readSystemNameFromConfig(Config.parseString('actor-ts.system.shutdown-drain-timeout = 1s')),
      undefined,
    );
    expectExactOptions(
      readShutdownDrainTimeoutFromConfig(Config.parseString('actor-ts.system.name = "billing"')),
      undefined,
    );
  });

  test('a drain budget of 0 is the documented opt-out, not an absent leaf', () => {
    // `0` is falsy, so a reader that turned "no value" into `undefined` with
    // `||` would hand the constructor the 2s default for a system that asked
    // not to drain at all.
    expectExactOptions(
      readShutdownDrainTimeoutFromConfig(Config.parseString('actor-ts.system.shutdown-drain-timeout = 0')),
      0,
    );
  });

  test('a drain budget that is not a finite duration is refused by the reader', () => {
    // `Config.fromObject`, because HOCON has no NaN literal: the value can only
    // arrive from code, which is the path #1513 found it on.
    const config = Config.fromObject({ 'actor-ts': { system: { 'shutdown-drain-timeout': Number.NaN } } });

    expect(() => readShutdownDrainTimeoutFromConfig(config)).toThrow(ConfigError);
  });
});

describe('actor-ts.logger.close-timeout', () => {
  test('the reference default is the shipped grace period', () => {
    expectExactOptions(readLoggerCloseTimeoutFromConfig(reference), 3_000);
  });

  test('the leaf reaches its reader as a duration', () => {
    expectExactOptions(
      readLoggerCloseTimeoutFromConfig(Config.parseString('actor-ts.logger.close-timeout = 1500ms')),
      1_500,
    );
  });

  test('an absent leaf stays absent rather than being defaulted in', () => {
    expectExactOptions(
      readLoggerCloseTimeoutFromConfig(Config.parseString('actor-ts.logger.level = "warn"')),
      undefined,
    );
  });
});

describe('actor-ts.actor', () => {
  test('the reference defaults are the shipped batch and ask deadline', () => {
    expectExactOptions(readActorThroughputFromConfig(reference), 16);
    expectExactOptions(readAskTimeoutFromConfig(reference), 5_000);
  });

  test('every leaf reaches its reader, through the accessor its literal needs', () => {
    const config = Config.parseString(`
      actor-ts.actor {
        throughput  = 64
        ask-timeout = 2s
      }
    `);

    expectExactOptions(readActorThroughputFromConfig(config), 64);
    expectExactOptions(readAskTimeoutFromConfig(config), 2_000);
  });

  test('an absent leaf stays absent rather than being defaulted in', () => {
    expectExactOptions(
      readActorThroughputFromConfig(Config.parseString('actor-ts.actor.ask-timeout = 2s')),
      undefined,
    );
    expectExactOptions(
      readAskTimeoutFromConfig(Config.parseString('actor-ts.actor.throughput = 64')),
      undefined,
    );
  });

  test('throughput is a count: a duration there is refused, and a non-positive one is clamped to 1', () => {
    // A bare integer reads the same through getInt and getDuration, so the
    // case above cannot tell the two accessors apart; a unit can.
    expect(() => readActorThroughputFromConfig(Config.parseString('actor-ts.actor.throughput = 64ms')))
      .toThrow(ConfigError);
    // Clamped rather than rejected (#409): 0 would leave every actor
    // accepting mail and never reading it.
    expectExactOptions(readActorThroughputFromConfig(Config.parseString('actor-ts.actor.throughput = 0')), 1);
    expectExactOptions(readActorThroughputFromConfig(Config.parseString('actor-ts.actor.throughput = -3')), 1);
  });

  test('an ask deadline no ask could arm is refused by the reader, naming the key', () => {
    // Refused rather than clamped (#863), and by the reader itself, so the
    // check holds for every caller of it and not only for the constructor.
    for (const bad of ['0s', '-1s']) {
      let caught: unknown = null;
      try {
        readAskTimeoutFromConfig(Config.parseString(`actor-ts.actor.ask-timeout = "${bad}"`));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OptionsError);
      expect((caught as OptionsError).field).toBe('ask-timeout');
      expect((caught as OptionsError).message).toContain('actor-ts.actor.ask-timeout');
    }
  });
});
