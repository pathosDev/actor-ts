import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import {
  DEFAULT_DEBUG_EVENT_STREAM,
  DEFAULT_DEBUG_LIFECYCLE,
  DEFAULT_DEBUG_UNHANDLED,
  DEFAULT_LOG_CONFIG_ON_START,
  DEFAULT_LOG_DEAD_LETTERS,
  DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN,
  DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS,
  DiagnosticsOptions,
  DiagnosticsOptionsValidator,
  readDiagnosticsOptionsFromConfig,
} from '../../../src/diagnostics/DiagnosticsOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * `actor-ts.diagnostics.*` is a new block (#1000), so this file states the
 * three properties the rest of the config machinery cannot state for it: the
 * reader sees every leaf, an absent leaf comes back absent rather than
 * `undefined`, and what `reference.conf` publishes is what the code falls back
 * to when nothing is configured.
 *
 * Every config is built with `Config.parseString` and not
 * `Config.fromObject({'actor-ts.diagnostics.x': 1})` — the latter keeps the
 * dotted string as a literal top-level key, so `hasPath` would resolve the
 * *nested* reference value instead and the assertions would pass while reading
 * the defaults they were meant to override.
 */
describe('readDiagnosticsOptionsFromConfig', () => {
  test('reads every key of the diagnostics block', () => {
    const config = Config.parseString(`
      actor-ts.diagnostics {
        log-dead-letters                  = 3
        log-dead-letters-during-shutdown  = true
        log-dead-letters-suspend-duration = 90s
        log-config-on-start               = true
        debug {
          unhandled    = true
          lifecycle    = true
          event-stream = true
        }
      }
    `);

    expect(readDiagnosticsOptionsFromConfig(config)).toEqual({
      logDeadLetters: 3,
      logDeadLettersDuringShutdown: true,
      logDeadLettersSuspendDurationMs: 90_000,
      logConfigOnStart: true,
      debugUnhandled: true,
      debugLifecycle: true,
      debugEventStream: true,
    });
  });

  test('omits absent keys entirely rather than reporting them as undefined', () => {
    const config = Config.parseString('actor-ts.diagnostics.log-dead-letters = 0');
    const fromConfig = readDiagnosticsOptionsFromConfig(config);

    expect(fromConfig).toEqual({ logDeadLetters: 0 });
    // The distinction that matters: a present-but-undefined key would shadow
    // the built-in default once spread.  `0` is also the one value that would
    // survive a falsy guard written by accident, which is why it is the value
    // this case uses.
    expect(Object.keys(fromConfig)).toEqual(['logDeadLetters']);
  });

  test('an empty config yields no settings at all', () => {
    expect(readDiagnosticsOptionsFromConfig(Config.empty())).toEqual({});
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // The values `reference.conf` ships have to match what the code falls back
    // to, or merely wiring the block would change behaviour for everyone.
    const config = Config.loadReference();

    expect(readDiagnosticsOptionsFromConfig(config)).toEqual({
      logDeadLetters: DEFAULT_LOG_DEAD_LETTERS,
      logDeadLettersDuringShutdown: DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN,
      logDeadLettersSuspendDurationMs: DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS,
      logConfigOnStart: DEFAULT_LOG_CONFIG_ON_START,
      debugUnhandled: DEFAULT_DEBUG_UNHANDLED,
      debugLifecycle: DEFAULT_DEBUG_LIFECYCLE,
      debugEventStream: DEFAULT_DEBUG_EVENT_STREAM,
    });
  });

  test('every key it reads is reachable from ConfigKeys', () => {
    // Exact object, and full dotted leaves rather than a block root: a root
    // alone would satisfy `NoDeadConfigKeys` for every leaf beneath it
    // (`coveringAccessor` falls back to the nearest root), so a leaf nothing
    // read could ship with that guard green.
    expect(ConfigKeys.diagnostics).toEqual({
      logDeadLetters: 'actor-ts.diagnostics.log-dead-letters',
      logDeadLettersDuringShutdown: 'actor-ts.diagnostics.log-dead-letters-during-shutdown',
      logDeadLettersSuspendDuration: 'actor-ts.diagnostics.log-dead-letters-suspend-duration',
      logConfigOnStart: 'actor-ts.diagnostics.log-config-on-start',
      debugUnhandled: 'actor-ts.diagnostics.debug.unhandled',
      debugLifecycle: 'actor-ts.diagnostics.debug.lifecycle',
      debugEventStream: 'actor-ts.diagnostics.debug.event-stream',
    });
  });
});

describe('DiagnosticsOptions — the builder and its validator', () => {
  test('a builder is structurally the options it was given', () => {
    const diagnosticsOptions = DiagnosticsOptions.create()
      .withLogDeadLetters(25)
      .withLogDeadLettersDuringShutdown(true)
      .withLogDeadLettersSuspendDurationMs(30_000);

    // Spread rather than `build()`: the point of the project's builder is that
    // an instance IS its options, so a consumer taking the union reads it
    // directly and the `withX` methods never surface.
    expect({ ...diagnosticsOptions }).toEqual({
      logDeadLetters: 25,
      logDeadLettersDuringShutdown: true,
      logDeadLettersSuspendDurationMs: 30_000,
    });
  });

  test('an unset field stays unset, so it can fall through to HOCON', () => {
    const diagnosticsOptions = DiagnosticsOptions.create().withLogDeadLetters(1);

    expect(Object.keys({ ...diagnosticsOptions })).toEqual(['logDeadLetters']);
  });

  test('the four switches default to on when called bare, and take a false', () => {
    // `withX()` with no argument reads as "turn this on", which is the only
    // thing anyone ever means by naming a switch — but the parameter stays,
    // so a builder assembled from a variable can also say `false` and have
    // that beat a HOCON `on` rather than silently agreeing with it.
    const allOn = DiagnosticsOptions.create()
      .withLogConfigOnStart()
      .withDebugUnhandled()
      .withDebugLifecycle()
      .withDebugEventStream();

    expect({ ...allOn }).toEqual({
      logConfigOnStart: true,
      debugUnhandled: true,
      debugLifecycle: true,
      debugEventStream: true,
    });
    expect({ ...DiagnosticsOptions.create().withDebugLifecycle(false) })
      .toEqual({ debugLifecycle: false });
  });

  test('0 passes on both numeric fields — a documented posture, not a mistake', () => {
    // `logDeadLetters = 0` is "never log" and `…SuspendDurationMs = 0` is
    // "never suspend"; `positiveInt` would have removed the only way to say
    // either.
    expect(() => new DiagnosticsOptionsValidator().validate({
      logDeadLetters: 0,
      logDeadLettersSuspendDurationMs: 0,
    })).not.toThrow();
  });

  test('a negative count is rejected', () => {
    expect(() => new DiagnosticsOptionsValidator().validate({ logDeadLetters: -1 }))
      .toThrow(OptionsError);
  });

  test('a fractional suspend duration is rejected', () => {
    expect(() => new DiagnosticsOptionsValidator().validate({
      logDeadLettersSuspendDurationMs: 1.5,
    })).toThrow(OptionsError);
  });

  test('an empty settings object passes — required-ness lives elsewhere', () => {
    expect(() => new DiagnosticsOptionsValidator().validate({})).not.toThrow();
  });
});
