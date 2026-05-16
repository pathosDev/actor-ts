/**
 * Retained messages — the broker keeps the latest retained
 * publication per topic.  A late subscriber receives it immediately
 * on subscribe.  Verifies the `retain` flag round-trips through the
 * adapter unchanged.
 */
import type { MqttMessage } from '../../../../../src/io/broker/MqttActor.js';
import { spawnInbox, spawnMqtt, type MqttCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<MqttCtx> = {
  name: 'retained messages survive subscription gap',
  async run(ctx) {
    const tag = `b3/retained-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ref: publisher } = spawnMqtt(ctx);
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
      const { ref: subscriber } = spawnMqtt(ctx);
      const { ref: inboxRef, inbox } = spawnInbox(ctx);
      try {
        subscriber.tell({
          kind: 'subscribe',
          topic: tag,
          target: inboxRef as unknown as { tell(_m: MqttMessage): void },
          qos: 1,
        });
        await waitFor(`retained message delivered on ${tag}`,
          () => inbox.received.some((m) => m.topic === tag),
          5_000,
        );
        const msg = inbox.received.find((m) => m.topic === tag)!;
        if (new TextDecoder().decode(msg.payload) !== 'retained-value') {
          throw new Error(`retained payload mismatch: got ${new TextDecoder().decode(msg.payload)}`);
        }
        // The retain flag must be true on inbound for retained.
        if (msg.retain !== true) {
          throw new Error(`retain flag lost on inbound: ${msg.retain}`);
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
