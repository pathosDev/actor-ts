/**
 * Retained messages — the broker keeps the latest retained
 * publication per topic.  A late subscriber receives it immediately
 * on subscribe.  Verifies the `retain` flag round-trips through the
 * adapter unchanged.
 */
import { spawnInbox, spawnMqtt, type MqttContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<MqttContext> = {
  name: 'retained messages survive subscription gap',
  async run(context) {
    const tag = `b3/retained-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ref: publisher } = spawnMqtt(context);
    try {
      // Publish retained BEFORE any subscriber exists.  The broker
      // should hold it for the next matching subscription.
      publisher.tell({
        kind: 'publish',
        publish: {
          topic: tag,
          payload: new TextEncoder().encode('retained-value'),
          qos: 1,
          retain: true,
        },
      });
      await new Promise((r) => setTimeout(r, 300));

      // Now spawn a late subscriber.
      const { ref: subscriber } = spawnMqtt(context);
      const { ref: inboxRef, inbox } = spawnInbox(context);
      try {
        subscriber.tell({ kind: 'subscribe', topic: tag, target: inboxRef, qos: 1 });
        await waitFor(`retained message delivered on ${tag}`,
          () => inbox.received.some((m) => m.topic === tag),
          5_000,
        );
        const message = inbox.received.find((m) => m.topic === tag)!;
        if (message.payload.text() !== 'retained-value') {
          throw new Error(`retained payload mismatch: got ${message.payload.text()}`);
        }
        // The retain flag must be true on inbound for retained.
        if (message.retain !== true) {
          throw new Error(`retain flag lost on inbound: ${message.retain}`);
        }
      } finally {
        subscriber.stop();
        inboxRef.stop();
      }
    } finally {
      // Clean up the retained message — empty payload + retain=true wipes it.
      publisher.tell({
        kind: 'publish',
        publish: { topic: tag, payload: new Uint8Array(0), retain: true, qos: 1 },
      });
      await new Promise((r) => setTimeout(r, 100));
      publisher.stop();
    }
  },
};
