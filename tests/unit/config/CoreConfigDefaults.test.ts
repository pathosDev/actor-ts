import { describe, expect, test } from 'bun:test';
import {
  ActorSystem,
  readActorThroughputFromConfig,
  readAskTimeoutFromConfig,
  readDispatcherOptionsFromConfig,
  readLoggerCloseTimeoutFromConfig,
  readShutdownDrainTimeoutFromConfig,
  readSystemNameFromConfig,
} from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import {
  readCoordinatedShutdownOptionsFromConfig,
  type CoordinatedShutdownConfiguration,
} from '../../../src/CoordinatedShutdown.js';
import {
  HybridDispatcher,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from '../../../src/Dispatcher.js';
import { NoopLogger } from '../../../src/Logger.js';
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

/**
 * `actor-ts.dispatcher` is read apart from building the dispatcher, because a
 * `Dispatcher` instance is not something two reads can be compared by.  The
 * reader answers with the kind and, under the throughput kind only, the
 * count — the count has never been consulted for another kind, and reading it
 * there would turn a malformed value nobody uses into a startup failure.
 */
describe('actor-ts.dispatcher', () => {
  test('the reference defaults name the hybrid dispatcher', () => {
    expectExactOptions(readDispatcherOptionsFromConfig(reference), { kind: 'hybrid' });
  });

  test('the reference count is the one the throughput kind gets', () => {
    const config = Config.parseString('actor-ts.dispatcher.default = "throughput"').withFallback(reference);

    expectExactOptions(readDispatcherOptionsFromConfig(config), { kind: 'throughput', throughput: 16 });
  });

  test('every leaf reaches its field, through the accessor its literal needs', () => {
    const config = Config.parseString(`
      actor-ts.dispatcher {
        default    = "throughput"
        throughput = 42
      }
    `);

    expectExactOptions(readDispatcherOptionsFromConfig(config), { kind: 'throughput', throughput: 42 });
  });

  test.each(['hybrid', 'immediate', 'microtask', 'throughput'] as const)(
    '"%s" is a kind the reader names',
    (kind) => {
      const config = Config.parseString(`actor-ts.dispatcher.default = "${kind}"`);

      expectExactOptions(readDispatcherOptionsFromConfig(config), { kind });
    },
  );

  test('the kind is matched whatever its case', () => {
    const config = Config.parseString('actor-ts.dispatcher.default = "MicroTask"');

    expectExactOptions(readDispatcherOptionsFromConfig(config), { kind: 'microtask' });
  });

  test('an absent leaf stays absent rather than being defaulted in', () => {
    expectExactOptions(readDispatcherOptionsFromConfig(Config.empty()), {});
    // The throughput kind with no count of its own: the count stays absent,
    // for the built-in one to fill.
    expectExactOptions(
      readDispatcherOptionsFromConfig(Config.parseString('actor-ts.dispatcher.default = "throughput"')),
      { kind: 'throughput' },
    );
    // A count with no kind: nothing named the throughput dispatcher, so the
    // count is not read.
    expectExactOptions(
      readDispatcherOptionsFromConfig(Config.parseString('actor-ts.dispatcher.throughput = 42')),
      {},
    );
  });

  test('an unrecognised kind reads as no kind, the same answer an unset one gets', () => {
    // So the one default the system applies covers a typo too, rather than a
    // second copy of "hybrid" living in the reader.
    expectExactOptions(
      readDispatcherOptionsFromConfig(Config.parseString('actor-ts.dispatcher.default = "fast"')),
      {},
    );
  });

  test('under the throughput kind the count is an integer: a duration there is refused', () => {
    const config = Config.parseString(`
      actor-ts.dispatcher {
        default    = "throughput"
        throughput = 42ms
      }
    `);

    expect(() => readDispatcherOptionsFromConfig(config)).toThrow(ConfigError);
  });

  test('under another kind a malformed count is not read, as it never was', () => {
    const config = Config.parseString(`
      actor-ts.dispatcher {
        default    = "hybrid"
        throughput = 42ms
      }
    `);

    expectExactOptions(readDispatcherOptionsFromConfig(config), { kind: 'hybrid' });
  });
});

describe('the dispatcher a system builds from actor-ts.dispatcher', () => {
  async function dispatcherFor(dispatcher: ConfigObject): Promise<unknown> {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withConfig({ 'actor-ts': { dispatcher } });
    const system = ActorSystem.create('core-config-dispatcher', options);
    const built = system.dispatcher;
    await system.terminate();
    return built;
  }

  test('each kind builds its own dispatcher', async () => {
    expect(await dispatcherFor({ default: 'hybrid' })).toBeInstanceOf(HybridDispatcher);
    expect(await dispatcherFor({ default: 'immediate' })).toBeInstanceOf(ImmediateDispatcher);
    expect(await dispatcherFor({ default: 'microtask' })).toBeInstanceOf(MicrotaskDispatcher);
    const throughput = await dispatcherFor({ default: 'throughput', throughput: 7 });
    expect(throughput).toBeInstanceOf(ThroughputDispatcher);
    expect((throughput as ThroughputDispatcher).throughput).toBe(7);
  });

  test('an unrecognised kind starts the hybrid dispatcher, as an unset one does', async () => {
    // Documented: a typo lands on the default rather than on a named kind or
    // a startup failure, so "what runs when nobody chose?" has one answer.
    expect(await dispatcherFor({ default: 'fast' })).toBeInstanceOf(HybridDispatcher);
  });
});

/**
 * The six leaves the coordinated-shutdown extension reads about itself.  The
 * `phases` block is not among them: it names the operator's own phases and
 * ships no leaf, so it is applied against the seeded graph by the extension
 * and pinned by SystemShutdownWorkerConfig.
 */
describe('actor-ts.coordinated-shutdown', () => {
  test('the reference defaults are the shipped ones', () => {
    expectExactOptions(readCoordinatedShutdownOptionsFromConfig(reference), {
      defaultPhaseTimeoutMs: 5_000,
      exitProcess: false,
      exitCode: 0,
      terminateActorSystem: true,
      autoRegisterTasks: true,
      runByProcessSignals: true,
    });
  });

  test('every leaf reaches its field, through the accessor its literal needs', () => {
    const config = Config.parseString(`
      actor-ts.coordinated-shutdown {
        default-phase-timeout  = 250ms
        exit-process           = true
        exit-code              = 3
        terminate-actor-system = false
        auto-register-tasks    = false
        run-by-process-signals = false
      }
    `);

    expectExactOptions(readCoordinatedShutdownOptionsFromConfig(config), {
      defaultPhaseTimeoutMs: 250,
      exitProcess: true,
      exitCode: 3,
      terminateActorSystem: false,
      autoRegisterTasks: false,
      runByProcessSignals: false,
    });
  });

  /**
   * One leaf at a time, the other five absent.  The case above sets the four
   * switches to the same value, and the reference sets them to the same value
   * too, so two of them reading each other's key would pass both; alone, a
   * leaf can only land in its own field.
   */
  test.each<[string, CoordinatedShutdownConfiguration]>([
    ['default-phase-timeout = 250ms', { defaultPhaseTimeoutMs: 250 }],
    ['exit-process = true', { exitProcess: true }],
    ['exit-code = 3', { exitCode: 3 }],
    ['terminate-actor-system = false', { terminateActorSystem: false }],
    ['auto-register-tasks = false', { autoRegisterTasks: false }],
    ['run-by-process-signals = false', { runByProcessSignals: false }],
  ])('%s alone reaches its own field, and the absent leaves stay absent', (leaf, expected) => {
    const config = Config.parseString(`actor-ts.coordinated-shutdown.${leaf}`);

    expectExactOptions(readCoordinatedShutdownOptionsFromConfig(config), expected);
  });

  test('an absent block reads as nothing at all, not a bag of defaults', () => {
    expectExactOptions(readCoordinatedShutdownOptionsFromConfig(Config.empty()), {});
  });

  test('exit-code is a status the operating system keeps: outside 0-255 the reader refuses it', () => {
    for (const code of [256, -1]) {
      const config = Config.parseString(`actor-ts.coordinated-shutdown.exit-code = ${code}`);

      expect(() => readCoordinatedShutdownOptionsFromConfig(config)).toThrow(ConfigError);
    }
    // And it is an integer, which a duration is not.
    const duration = Config.parseString('actor-ts.coordinated-shutdown.exit-code = 3ms');
    expect(() => readCoordinatedShutdownOptionsFromConfig(duration)).toThrow(ConfigError);
  });
});
