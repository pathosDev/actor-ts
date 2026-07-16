/**
 * Consumer group — XREADGROUP loop with ack.  The actor delivers
 * each new entry to `target` exactly once; ack is explicit (the
 * scenario's inbox just records, doesn't ack, but the actor's
 * connect path auto-creates the group with `createIfMissing`).
 */
import { spawnInbox, spawnRedis, type RedisContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<RedisContext> = {
  name: 'XREADGROUP — consumer group delivers entries to target',
  async run(context) {
    const tag = `b7:stream:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const groupName = `g-${Math.random().toString(36).slice(2)}`;
    const consumerName = `c-${Math.random().toString(36).slice(2)}`;

    const { ref: inboxRef, inbox } = spawnInbox(context);
    const consumer = spawnRedis(context, {
      streams: [tag],
      consumerGroup: { group: groupName, consumer: consumerName },
      target: inboxRef,
    });
    const producer = spawnRedis(context);
    try {
      // Let the consumer attach + create the group (XGROUP CREATE).
      await new Promise((r) => setTimeout(r, 500));

      const N = 3;
      for (let i = 0; i < N; i++) {
        producer.tell({
          kind: 'publish',
          publish: { stream: tag, fields: { idx: String(i), label: `entry-${i}` } },
        });
      }

      await waitFor(`consumer received ${N} entries`,
        () => inbox.received.length >= N,
        10_000,
      );
      // Verify the fields round-trip.
      const labels = new Set(inbox.received.map((e) => e.fields['label']));
      for (let i = 0; i < N; i++) {
        if (!labels.has(`entry-${i}`)) throw new Error(`missing entry-${i} in inbox`);
      }
    } finally {
      producer.stop();
      consumer.stop();
      inboxRef.stop();
    }
  },
};
