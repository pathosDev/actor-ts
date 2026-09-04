import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { readProducerControllerOptionsFromConfig } from '../../../src/delivery/ProducerControllerOptions.js';
import { readConsumerControllerOptionsFromConfig } from '../../../src/delivery/ConsumerControllerOptions.js';

/**
 * #861 — before this, `src/delivery/` read no configuration at all: there was
 * no `actor-ts.reliable-delivery` block, no delivery group in `ConfigKeys`,
 * and the four tunables were settable only in code.  What the readers must get
 * right is the mapping (kebab HOCON leaf → camelCase option field), the
 * "absent means absent" rule — a key nobody set has to stay out of the
 * returned object entirely, or it lands as an explicit `undefined` and shadows
 * the built-in default underneath it — and the `0` → `Infinity` translation,
 * which exists because the opt-out both consumer bounds document cannot be
 * written in HOCON at all.
 *
 * Every fixture goes through `Config.parseString`, never
 * `Config.fromObject({'actor-ts.x.y': …})`: the latter keeps the dotted string
 * as a literal top-level key, so `hasPath` would resolve the *nested*
 * reference.conf value instead and the assertion would be about the shipped
 * default rather than about the fixture.
 */

describe('readProducerControllerOptionsFromConfig', () => {
  test('reads every leaf of the producer block', () => {
    const config = Config.parseString(`
      actor-ts.reliable-delivery.producer {
        resend-timeout = 2s
        window-size    = 64
      }
    `);

    expect(readProducerControllerOptionsFromConfig(config)).toEqual({
      resendTimeout: 2_000,
      windowSize: 64,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    // `toStrictEqual`, not `toEqual`: the latter ignores properties whose value
    // is `undefined`, so it cannot tell "absent" from "present and undefined" —
    // the only thing this test is about.  `6a63d251` measured that on the
    // DevTools reader: `out.x = hasPath ? read : undefined` passed all twelve
    // of its `toEqual` assertions.
    expect(readProducerControllerOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toStrictEqual({});
  });

  test('one leaf set returns only that leaf', () => {
    // The half of "absent means absent" a wholly-absent block cannot show: a
    // reader that filled the gap with a default would still pass the test
    // above, because `{}` is what an absent block produces either way.
    const config = Config.parseString('actor-ts.reliable-delivery.producer.window-size = 4');

    expect(readProducerControllerOptionsFromConfig(config)).toStrictEqual({ windowSize: 4 });
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    expect(readProducerControllerOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      resendTimeout: 500,
      windowSize: 16,
    });
  });
});

describe('readConsumerControllerOptionsFromConfig', () => {
  test('reads every leaf of the consumer block', () => {
    const config = Config.parseString(`
      actor-ts.reliable-delivery.consumer {
        max-producers              = 32
        producer-idle-time-to-live = 90s
      }
    `);

    expect(readConsumerControllerOptionsFromConfig(config)).toEqual({
      maxProducers: 32,
      producerIdleTtlMs: 90_000,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expect(readConsumerControllerOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toStrictEqual({});
  });

  test('one leaf set returns only that leaf', () => {
    const config = Config.parseString('actor-ts.reliable-delivery.consumer.max-producers = 8');

    expect(readConsumerControllerOptionsFromConfig(config)).toStrictEqual({ maxProducers: 8 });
  });

  test('0 is the HOCON spelling of the Infinity both bounds document', () => {
    // `Infinity` is not writable in this config language — `getInt` takes a
    // number or a `/^-?\d+(\.\d+)?$/` string, and `parseDuration` throws on a
    // non-finite one — so the opt-out has to arrive as `0` and be translated.
    // Without the translation the consumer would be built with a cap of zero
    // producers, which its validator rejects outright: the operator asking for
    // "no bound" would get a refused actor.
    const config = Config.parseString(`
      actor-ts.reliable-delivery.consumer {
        max-producers              = 0
        producer-idle-time-to-live = 0
      }
    `);

    expect(readConsumerControllerOptionsFromConfig(config)).toEqual({
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
    });
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    expect(readConsumerControllerOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      maxProducers: 1_024,
      producerIdleTtlMs: 300_000,
    });
  });
});
