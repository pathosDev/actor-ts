/**
 * QoS 1 — at-least-once.  The broker sends PUBACK; the framework
 * adapter doesn't surface it explicitly but the message must still
 * arrive at the subscriber with the correct QoS marked on inbound.
 */
import type { MqttMessage } from '../../../../../src/io/broker/MqttActor.js';
import { spawnInbox, spawnMqtt, type MqttCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<MqttCtx> = {
  name: 'QoS 1 — at-least-once delivery',
  async run(ctx) {
    const tag = `b3/qos1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ref: mqtt } = spawnMqtt(ctx);
    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    try {
      mqtt.tell({
        kind: 'subscribe',
        topic: tag,
        target: inboxRef as unknown as { tell(_m: MqttMessage): void },
        qos: 1,
      });
      await new Promise((r) => setTimeout(r, 200));

      // Burst of 5 publishes — each at QoS 1.  At-least-once allows
      // duplicates but every one MUST arrive at least once.
      for (let i = 0; i < 5; i++) {
        mqtt.tell({
          kind: 'publish',
          publish: { topic: tag, payload: new TextEncoder().encode(`msg-${i}`), qos: 1 },
        });
      }

      await waitFor(`received >= 5 messages on ${tag}`,
        () => inbox.received.filter((m) => m.topic === tag).length >= 5,
        5_000,
      );
      // Verify each published payload was observed at least once.
      const seen = new Set(inbox.received.map((m) => new TextDecoder().decode(m.payload)));
      for (let i = 0; i < 5; i++) {
        if (!seen.has(`msg-${i}`)) throw new Error(`missing msg-${i}`);
      }
    } finally {
      mqtt.stop();
      inboxRef.stop();
    }
  },
};
