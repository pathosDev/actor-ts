/**
 * QoS 2 — exactly-once.  Four-step handshake (PUBLISH / PUBREC /
 * PUBREL / PUBCOMP); the broker guarantees no duplicates and no
 * loss.  We can't directly observe the four packets without
 * cracking open the mqtt-packet types, so the assertion is "every
 * published message arrives exactly once" — pin the count.
 */
import type { MqttMessage } from '../../../../../src/io/broker/MqttActor.js';
import { spawnInbox, spawnMqtt, type MqttCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<MqttCtx> = {
  name: 'QoS 2 — exactly-once delivery',
  async run(ctx) {
    const tag = `b3/qos2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ref: mqtt } = spawnMqtt(ctx);
    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    try {
      mqtt.tell({
        kind: 'subscribe',
        topic: tag,
        target: inboxRef as unknown as { tell(_m: MqttMessage): void },
        qos: 2,
      });
      await new Promise((r) => setTimeout(r, 200));

      // Three publishes — each must be observed exactly once.
      const N = 3;
      for (let i = 0; i < N; i++) {
        mqtt.tell({
          kind: 'publish',
          publish: { topic: tag, payload: new TextEncoder().encode(`q2-${i}`), qos: 2 },
        });
      }

      await waitFor(`received exactly ${N} messages on ${tag}`,
        () => inbox.received.filter((m) => m.topic === tag).length >= N,
        5_000,
      );

      // Settle — wait one more poll-window for any duplicates that
      // would arrive on a broken QoS-2 path.
      await new Promise((r) => setTimeout(r, 500));
      const count = inbox.received.filter((m) => m.topic === tag).length;
      if (count !== N) {
        throw new Error(`QoS 2 expected exactly ${N} messages, got ${count}`);
      }
    } finally {
      mqtt.stop();
      inboxRef.stop();
    }
  },
};
