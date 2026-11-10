import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { readDistributedPubSubOptionsFromConfig } from '../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { readReceptionistOptionsFromConfig } from '../../../src/discovery/ReceptionistOptions.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * #857 — before this, both mediators were tunable only in code: there was no
 * `actor-ts.cluster.pub-sub` or `.receptionist` block at all.  What the
 * readers must get right is the mapping (kebab HOCON leaf → camelCase option
 * field) and the "absent means absent" rule — a key nobody set has to stay
 * out of the returned object entirely, or it would land as an explicit
 * `undefined` and shadow the built-in default underneath it.  `toEqual`
 * cannot see that second half, so every case goes through
 * `expectExactOptions` (#1447).
 */

describe('readDistributedPubSubOptionsFromConfig', () => {
  test('reads every leaf of the pub-sub block', () => {
    const config = Config.parseString(`
      actor-ts.cluster.pub-sub {
        gossip-interval            = 250ms
        max-subscribers-per-topic  = 32
        max-topics                 = 8
        max-remote-nodes-per-topic = 4
        send-to-dead-letters-when-no-subscribers = off
      }
    `);

    expectExactOptions(readDistributedPubSubOptionsFromConfig(config), {
      gossipIntervalMs: 250,
      maxSubscribersPerTopic: 32,
      maxTopics: 8,
      maxRemoteNodesPerTopic: 4,
      sendToDeadLettersWhenNoSubscribers: false,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const options = readDistributedPubSubOptionsFromConfig(Config.parseString('actor-ts.system.name = x'));

    expectExactOptions(options, {});
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    // Locks the published values to the reader: a rename on either side turns
    // into a failure here rather than into a key that quietly stops applying.
    expectExactOptions(readDistributedPubSubOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      gossipIntervalMs: 1_000,
      maxSubscribersPerTopic: 10_000,
      maxTopics: 10_000,
      maxRemoteNodesPerTopic: 1_000,
      sendToDeadLettersWhenNoSubscribers: true,
    });
  });
});

describe('readReceptionistOptionsFromConfig', () => {
  test('reads every leaf of the receptionist block', () => {
    const config = Config.parseString(`
      actor-ts.cluster.receptionist {
        gossip-interval          = 2s
        max-subscribers-per-key  = 16
        max-subscriptions-total    = 64
      }
    `);

    expectExactOptions(readReceptionistOptionsFromConfig(config), {
      gossipIntervalMs: 2_000,
      maxSubscribersPerKey: 16,
      maxSubscriptionsTotal: 64,
    });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const options = readReceptionistOptionsFromConfig(Config.parseString('actor-ts.system.name = x'));

    expectExactOptions(options, {});
  });

  test('the shipped reference.conf resolves to the documented defaults', () => {
    expectExactOptions(readReceptionistOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      gossipIntervalMs: 1_000,
      maxSubscribersPerKey: 1_000,
      maxSubscriptionsTotal: 10_000,
    });
  });
});
