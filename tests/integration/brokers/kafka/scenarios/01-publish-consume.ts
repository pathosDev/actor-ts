/**
 * Baseline — produce N records, the consumer in the same actor
 * group receives them all.  Auto-commit mode (the default).
 */
import { spawnInbox, spawnKafka, type KafkaContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<KafkaContext> = {
  name: 'publish + consume round-trip (auto commit)',
  async run(context) {
    const tag = `b4-pubsub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const topic = `${tag}-topic`;
    const groupId = `${tag}-group`;

    const { ref: inboxRef, inbox } = spawnInbox(context);
    const consumer = spawnKafka(context, { groupId, topics: [topic], target: inboxRef });
    const producer = spawnKafka(context);
    try {
      // Wait for consumer to join the group + claim the partition.
      // Redpanda assigns immediately after the join request lands;
      // 1-2s is the typical wall-clock cost.
      await new Promise((r) => setTimeout(r, 1_500));

      const N = 5;
      for (let i = 0; i < N; i++) {
        producer.tell({
          kind: 'publish',
          publish: { topic, value: `msg-${i}`, key: `k-${i}` },
        });
      }

      await waitFor(`received ${N} records on ${topic}`,
        () => inbox.received.filter((r) => r.topic === topic).length >= N,
        15_000, // first message in a fresh group needs metadata fetch
      );

      const seenKeys = new Set(
        inbox.received
          .filter((r) => r.topic === topic && r.key)
          .map((r) => new TextDecoder().decode(r.key!)),
      );
      for (let i = 0; i < N; i++) {
        if (!seenKeys.has(`k-${i}`)) throw new Error(`missing key k-${i}`);
      }
    } finally {
      producer.stop();
      consumer.stop();
      inboxRef.stop();
    }
  },
};
