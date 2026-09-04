import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DistributedDataOptionsValidator,
  readDistributedDataOptionsFromConfig,
} from '../../../src/crdt/DistributedDataOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #856 — DistributedData read no HOCON at all before this: there was no
 * `actor-ts.distributed-data` block, so a deployment could only tune the
 * replicator from code.  What the reader has to get right is the mapping
 * (kebab HOCON leaf → camelCase option field) and the "absent means absent"
 * rule — a key nobody set has to stay out of the returned object entirely, or
 * it lands as an explicit `undefined` and shadows the built-in default
 * underneath it.
 */

describe('readDistributedDataOptionsFromConfig', () => {
  test('reads every leaf of the distributed-data block', () => {
    const config = Config.parseString(`
      actor-ts.distributed-data {
        gossip-interval             = 250ms
        max-pending-quorum-requests = 32
        max-quorum-timeout          = 4s
        max-gossip-bytes            = 512K
        log-data-size-exceeding     = 64K
        durable-keys                = ["cart-42", "session-*"]
      }
    `);

    expect(readDistributedDataOptionsFromConfig(config)).toEqual({
      gossipInterval: 250,
      maxPendingQuorumRequests: 32,
      maxQuorumTimeout: 4_000,
      maxGossipBytes: 512 * 1024,
      logDataSizeExceeding: 64 * 1024,
      durableKeys: ['cart-42', 'session-*'],
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    expect(readDistributedDataOptionsFromConfig(Config.parseString('actor-ts.system.name = x')))
      .toEqual({});
  });

  test('a partial block leaves the unset leaves out', () => {
    const config = Config.parseString('actor-ts.distributed-data.max-quorum-timeout = 90ms');

    expect(readDistributedDataOptionsFromConfig(config)).toEqual({ maxQuorumTimeout: 90 });
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    expect(readDistributedDataOptionsFromConfig(Config.parseString(REFERENCE_CONF))).toEqual({
      gossipInterval: 1_000,
      maxPendingQuorumRequests: 1_000,
      maxQuorumTimeout: 30_000,
      maxGossipBytes: 1024 * 1024,
      logDataSizeExceeding: 100 * 1024,
      durableKeys: [],
    });
  });

  test('the shipped reporting threshold is about a tenth of the shipped gossip budget', () => {
    // The relationship, not the number.  "Large" has no absolute meaning for a
    // CRDT, so the threshold is only defensible as a share of one tick: around
    // a tenth, ten such keys fill a whole frame and every other key waits an
    // extra sweep per offender, which is the moment one value starts governing
    // everybody else's convergence.  Akka's 10 KiB is a tenth of *this* — 1 %
    // of a tick — and would fire on the first honest ORSet a deployment
    // stores (#856).
    //
    // A band rather than an equality, and deliberately so: both values are
    // round numbers in the same unit, so 100 KiB is 9.77 % of 1 MiB and no
    // HOCON size literal is exactly a tenth of `1M`.  The band still fails the
    // two changes worth catching — Akka's 10 KiB (1 %) and a threshold that
    // has drifted up to the budget itself.
    const shipped = readDistributedDataOptionsFromConfig(Config.parseString(REFERENCE_CONF));
    const share = shipped.logDataSizeExceeding! / shipped.maxGossipBytes!;

    expect(shipped.logDataSizeExceeding).toBeGreaterThan(0);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.15);
  });

  test('the shipped durable whitelist is empty, which means every key', () => {
    // Pinned because the *other* reading of `[]` — persist nothing — is the
    // one that loses data silently, and nothing in the type says which it is.
    // `DurableDistributedData.test.ts` asserts the behaviour this value
    // selects; this asserts that the shipped value selects it.
    const shipped = readDistributedDataOptionsFromConfig(Config.parseString(REFERENCE_CONF));

    expect(shipped.durableKeys).toEqual([]);
  });

  test('the shipped gossip budget sits well under the shipped wire cap', () => {
    // The relationship, not the numbers.  A gossip budget *at* the frame cap
    // would still be correct — the clamp holds either way — but it would put a
    // 16 MiB frame on the association that also carries heartbeats, and
    // `failure-detector.unreachable-after` is 2 s.  So the budget being the
    // smaller of the two is the property, and an order of magnitude is the
    // margin the default was chosen for (#691).
    const distributedData = readDistributedDataOptionsFromConfig(Config.parseString(REFERENCE_CONF));
    const frameCap = Config.parseString(REFERENCE_CONF).getBytes(ConfigKeys.remote.maxFrameBytes);

    expect(distributedData.maxGossipBytes).toBeGreaterThan(0);
    expect(distributedData.maxGossipBytes! * 8).toBeLessThanOrEqual(frameCap);
  });

  test('the shipped cap is low enough to fire before a timeout storm forms', () => {
    // This used to assert the cap sat under the default mailbox's 10 000
    // bound, so it would fire before the mailbox stranded an envelope.  #1148
    // removed that bound and #1078 showed it never worked that way anyway.
    // What the number still has to be is *small*: each pending request pins a
    // promise, a timer and a target set for its whole deadline, so the cap is
    // what turns a partition into immediate rejections instead of thousands
    // of timeouts expiring together (#140).
    const shipped = readDistributedDataOptionsFromConfig(Config.parseString(REFERENCE_CONF));

    expect(shipped.maxPendingQuorumRequests).toBeGreaterThan(0);
    expect(shipped.maxPendingQuorumRequests).toBeLessThanOrEqual(1_000);
  });
});

describe('DistributedDataOptionsValidator over config-sourced values', () => {
  test('accepts 0 for both caps — that is how they are switched off', () => {
    expect(() => new DistributedDataOptionsValidator().validate({
      maxPendingQuorumRequests: 0,
      maxQuorumTimeout: 0,
    })).not.toThrow();
  });

  test('rejects a negative or fractional pending cap', () => {
    const validator = new DistributedDataOptionsValidator();

    expect(() => validator.validate({ maxPendingQuorumRequests: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxPendingQuorumRequests: 2.5 })).toThrow(OptionsError);
  });

  test('rejects a negative quorum-timeout ceiling', () => {
    expect(() => new DistributedDataOptionsValidator().validate({ maxQuorumTimeout: -5 }))
      .toThrow(OptionsError);
  });

  test('accepts 0 for the gossip budget and rejects a negative or fractional one', () => {
    const validator = new DistributedDataOptionsValidator();

    expect(() => validator.validate({ maxGossipBytes: 0 })).not.toThrow();
    expect(() => validator.validate({ maxGossipBytes: -1 })).toThrow(/maxGossipBytes/);
    expect(() => validator.validate({ maxGossipBytes: 1.5 })).toThrow(/maxGossipBytes/);
  });

  test('accepts 0 for the reporting threshold and rejects a negative or fractional one', () => {
    const validator = new DistributedDataOptionsValidator();

    expect(() => validator.validate({ logDataSizeExceeding: 0 })).not.toThrow();
    expect(() => validator.validate({ logDataSizeExceeding: -1 })).toThrow(/logDataSizeExceeding/);
    expect(() => validator.validate({ logDataSizeExceeding: 1.5 })).toThrow(/logDataSizeExceeding/);
  });

  test('accepts the two durable-key forms and nothing else', () => {
    const validator = new DistributedDataOptionsValidator();

    expect(() => validator.validate({ durableKeys: [] })).not.toThrow();
    expect(() => validator.validate({ durableKeys: ['cart-42', 'session-*'] })).not.toThrow();
    // A blank entry matches nothing, and on a whitelist an entry that matches
    // nothing is a key the operator believes is persisted and is not.
    expect(() => validator.validate({ durableKeys: ['   '] })).toThrow(OptionsError);
    // `*` in the middle is not a glob here — it would match the literal key
    // `a*b` and nothing else, which is exactly the surprise a durable
    // whitelist cannot afford, so it is refused rather than reinterpreted.
    expect(() => validator.validate({ durableKeys: ['a*b'] })).toThrow(/durableKeys/);
    // A bare `*` has a spelling already: the empty list.
    expect(() => validator.validate({ durableKeys: ['*'] })).toThrow(/durableKeys/);
  });

  test('an unset optional always passes', () => {
    expect(() => new DistributedDataOptionsValidator().validate({})).not.toThrow();
  });
});
