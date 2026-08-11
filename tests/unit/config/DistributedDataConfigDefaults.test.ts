import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/reference.js';
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
      }
    `);

    expect(readDistributedDataOptionsFromConfig(config)).toEqual({
      gossipInterval: 250,
      maxPendingQuorumRequests: 32,
      maxQuorumTimeout: 4_000,
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
    });
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

  test('an unset optional always passes', () => {
    expect(() => new DistributedDataOptionsValidator().validate({})).not.toThrow();
  });
});
