/**
 * Consumer group fan-out: two consumers in the SAME group share the
 * topic's partitions.  We can't easily force >1 partition on a
 * Redpanda dev container (auto-topic-creation defaults to 1
 * partition), so the assertion is the weaker "either consumer
 * eventually receives the record, but not both" — i.e. the message
 * is delivered exactly once across the group.
 */
import { spawnInbox, spawnKafka, type KafkaContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<KafkaContext> = {
  name: 'consumer-group exactly-once fan-out across two consumers',
  async run(context) {
    const tag = `b4-group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const topic = `${tag}-topic`;
    const groupId = `${tag}-group`;

    const { ref: inboxA, inbox: aInbox } = spawnInbox(context);
    const { ref: inboxB, inbox: bInbox } = spawnInbox(context);
    const consumerA = spawnKafka(context, { groupId, topics: [topic], target: inboxA });
    const consumerB = spawnKafka(context, { groupId, topics: [topic], target: inboxB });
    const producer = spawnKafka(context);
    try {
      // Wait for group assignment to stabilise.
      await new Promise((r) => setTimeout(r, 2_000));

      const N = 3;
      for (let i = 0; i < N; i++) {
        producer.tell({
          kind: 'publish',
          publish: { topic, value: `g-${i}` },
        });
      }

      await waitFor(`combined inboxes received ${N} records`,
        () => aInbox.received.length + bInbox.received.length >= N,
        15_000,
      );
      await new Promise((r) => setTimeout(r, 500)); // settle for duplicates

      // The protocol guarantee: within a single partition, exactly
      // one consumer in the group sees each message.  With Redpanda's
      // default single-partition topic, ALL messages land on ONE
      // consumer — that's fine for proving the group is honoured.
      const total = aInbox.received.length + bInbox.received.length;
      if (total !== N) {
        throw new Error(`group fan-out: expected ${N} total deliveries, got ${total} (A=${aInbox.received.length}, B=${bInbox.received.length})`);
      }
      // Both consumers in the same group → one of them got all
      // messages (single-partition topic).  The OTHER must be empty.
      if (aInbox.received.length > 0 && bInbox.received.length > 0) {
        throw new Error('single-partition topic but both consumers received records — group not honoured');
      }
    } finally {
      producer.stop();
      consumerA.stop();
      consumerB.stop();
      inboxA.stop();
      inboxB.stop();
    }
  },
};
