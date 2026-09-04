import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Config } from '../../../src/config/Config.js';
import { CircuitBreaker } from '../../../src/pattern/CircuitBreaker.js';
import {
  CircuitBreakerExtensionId,
  DEFAULT_CIRCUIT_BREAKER_ID,
} from '../../../src/pattern/CircuitBreakerExtension.js';
import {
  DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR,
  DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES,
  DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS,
  DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR,
  DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
} from '../../../src/pattern/CircuitBreakerOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * The config half of #864: `actor-ts.circuit-breaker.<id>.*` over
 * `actor-ts.circuit-breaker.default.*` over the built-in floor, with explicit
 * options above all three.
 *
 * Every config here is built with `Config.parseString`, never
 * `Config.fromObject({'actor-ts.x.y': v})` — the latter keeps the dotted
 * string as one literal top-level key, so `hasPath` goes on resolving the
 * *nested* reference.conf value and the test asserts nothing at all.
 */

let systemCounter = 0;

/** A silent system whose config is reference.conf plus `hocon`. */
function systemWith(hocon: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  return ActorSystem.create(`circuit-breaker-config-${systemCounter++}`, systemOptions);
}

describe('CircuitBreakerExtension — the shipped defaults', () => {
  test('a breaker resolved with no configuration takes the published block', async () => {
    const system = systemWith('');
    const breaker = system.extension(CircuitBreakerExtensionId).breaker();

    expect(breaker.options.maxFailures).toBe(DEFAULT_CIRCUIT_BREAKER_MAX_FAILURES);
    expect(breaker.options.resetTimeoutMs).toBe(DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS);
    expect(breaker.options.maxResetTimeoutMs).toBe(DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS);
    expect(breaker.options.backoffFactor).toBe(DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR);
    expect(breaker.options.randomFactor).toBe(DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR);
    // Comment-only in reference.conf, so nothing supplies it and the per-call
    // timeout stays off — the same state a hand-built breaker is in.
    expect(breaker.options.callTimeoutMs).toBeUndefined();
    expect(breaker.state).toBe('closed');
    await system.terminate();
  });

  test('the reserved id and the no-argument call are the same breaker', async () => {
    const system = systemWith('actor-ts.circuit-breaker.default.max-failures = 4');
    const extension = system.extension(CircuitBreakerExtensionId);

    expect(extension.breaker()).toBe(extension.breaker(DEFAULT_CIRCUIT_BREAKER_ID));
    // `default` is the defaults block AND this breaker's own block, so it
    // reads them as one rather than layering the same object over itself.
    expect(extension.breaker().options.maxFailures).toBe(4);
    await system.terminate();
  });

  test('one instance per id, and different ids are different instances', async () => {
    const system = systemWith('');
    const extension = system.extension(CircuitBreakerExtensionId);

    expect(extension.breaker('payments')).toBe(extension.breaker('payments'));
    expect(extension.breaker('payments')).not.toBe(extension.breaker('shipping'));
    expect(extension.names().sort()).toEqual(['payments', 'shipping']);
    await system.terminate();
  });
});

describe('CircuitBreakerExtension — the layers', () => {
  test('the default block moves every breaker that does not override it', async () => {
    const system = systemWith(`
      actor-ts.circuit-breaker.default {
        max-failures  = 2
        reset-timeout = 5s
        call-timeout  = 250ms
      }
    `);
    const breaker = system.extension(CircuitBreakerExtensionId).breaker('shipping');

    expect(breaker.options.maxFailures).toBe(2);
    expect(breaker.options.resetTimeoutMs).toBe(5_000);
    // The comment-only leaf is still read when a deployment writes it.
    expect(breaker.options.callTimeoutMs).toBe(250);
    await system.terminate();
  });

  test('a named block wins leaf by leaf, and an unset leaf falls through', async () => {
    const system = systemWith(`
      actor-ts.circuit-breaker {
        default    { max-failures = 2, reset-timeout = 5s, backoff-factor = 3.0 }
        payments   { max-failures = 7 }
      }
    `);
    const extension = system.extension(CircuitBreakerExtensionId);

    const payments = extension.breaker('payments');
    expect(payments.options.maxFailures).toBe(7);      // from the named block
    expect(payments.options.resetTimeoutMs).toBe(5_000); // fell through to `default`
    expect(payments.options.backoffFactor).toBe(3);      // fell through to `default`

    // A breaker with no block of its own is untouched by the one above.
    expect(extension.breaker('shipping').options.maxFailures).toBe(2);
    await system.terminate();
  });

  test('explicit options beat both blocks, and carry what HOCON cannot', async () => {
    const system = systemWith(`
      actor-ts.circuit-breaker {
        default  { max-failures = 2 }
        payments { max-failures = 7, reset-timeout = 5s }
      }
    `);
    const isFailure = (error: Error): boolean => error.message !== 'expected';
    const breaker = system.extension(CircuitBreakerExtensionId).breaker('payments', { maxFailures: 9, isFailure });

    expect(breaker.options.maxFailures).toBe(9);
    expect(breaker.options.resetTimeoutMs).toBe(5_000); // untouched by the explicit layer
    expect(breaker.options.isFailure).toBe(isFailure);
    await system.terminate();
  });

  test('an unset explicit field does not blank out the config underneath it', async () => {
    const system = systemWith('actor-ts.circuit-breaker.payments.max-failures = 7');
    // `mergeOptions` strips `undefined` from the upper layers, so a partial
    // options object cannot shadow a leaf it never assigned.
    const breaker = system.extension(CircuitBreakerExtensionId)
      .breaker('payments', { maxFailures: undefined, callTimeoutMs: 900 });

    expect(breaker.options.maxFailures).toBe(7);
    expect(breaker.options.callTimeoutMs).toBe(900);
    await system.terminate();
  });
});

describe('CircuitBreakerExtension — what the config actually does', () => {
  test('ignored-error-names from config reaches the classifier', async () => {
    const system = systemWith(`
      actor-ts.circuit-breaker.payments {
        max-failures        = 1
        ignored-error-names = ["ValidationError"]
      }
    `);
    const breaker = system.extension(CircuitBreakerExtensionId).breaker('payments');
    expect(breaker.options.ignoredErrorNames).toEqual(['ValidationError']);

    const ignored = new Error('bad input');
    ignored.name = 'ValidationError';
    await expect(breaker.call(async () => { throw ignored; })).rejects.toThrow('bad input');
    expect(breaker.state).toBe('closed'); // one maxFailure, and it did not count

    await expect(breaker.call(async () => { throw new Error('upstream down'); }))
      .rejects.toThrow('upstream down');
    expect(breaker.state).toBe('open');
    await system.terminate();
  });

  test('backoff-factor from config grows the reopen window', async () => {
    const system = systemWith(`
      actor-ts.circuit-breaker.payments {
        reset-timeout     = 1s
        backoff-factor    = 2.0
        max-reset-timeout = 30s
      }
    `);
    const breaker = system.extension(CircuitBreakerExtensionId).breaker('payments');

    breaker.setState('open');
    const first = breaker.nextProbeAt;
    breaker.setState('half-open');
    breaker.setState('open');
    // Two open cycles, one doubling: the second window is a second longer than
    // the first, whatever the clock did between the two calls.
    expect(breaker.nextProbeAt - first).toBeGreaterThan(500);
    expect(breaker.consecutiveOpens).toBe(2);
    await system.terminate();
  });

  test('a bad override throws OptionsError at the first breaker(id)', async () => {
    const system = systemWith('actor-ts.circuit-breaker.payments.random-factor = 4.0');
    const extension = system.extension(CircuitBreakerExtensionId);

    expect(() => extension.breaker('payments')).toThrow(OptionsError);
    expect(() => extension.breaker('payments')).toThrow(/randomFactor/);
    // And only that instance — a typo in one block does not take the rest down.
    expect(extension.breaker('shipping')).toBeInstanceOf(CircuitBreaker);
    await system.terminate();
  });

  test('setBreaker replaces an instance for tests', async () => {
    const system = systemWith('');
    const extension = system.extension(CircuitBreakerExtensionId);
    const injected = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10 });

    extension.setBreaker('payments', injected);
    expect(extension.breaker('payments')).toBe(injected);
    await system.terminate();
  });
});
