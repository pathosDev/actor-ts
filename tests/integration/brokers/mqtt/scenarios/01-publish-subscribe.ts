/**
 * Baseline: subscribe → publish → message reaches the subscriber.
 * QoS 0 (at-most-once) — the cheapest delivery class.  If this
 * fails, the entire MQTT integration is broken; everything else
 * downstream is moot.  Exercises the external-target subscribe path
 * (`{ kind: 'subscribe', target }`) that still fans out to a foreign ref.
 */
import { spawnInbox, spawnMqtt, type MqttContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<MqttContext> = {
  name: 'publish/subscribe round-trip (QoS 0)',
  async run(ctx) {
    const tag = `b3/pubsub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ref: mqtt } = spawnMqtt(ctx);
    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    try {
      // Subscribe first so the broker has the route when the publish lands.
      mqtt.tell({ kind: 'subscribe', topic: tag, target: inboxRef, qos: 0 });
      // Give the subscription time to land on the broker.
      await new Promise((r) => setTimeout(r, 200));

      mqtt.tell({
        kind: 'publish',
        publish: { topic: tag, payload: new TextEncoder().encode('hello'), qos: 0 },
      });

      await waitFor(`message arrived on ${tag}`,
        () => inbox.received.some((m) => m.topic === tag),
        5_000,
      );
      const msg = inbox.received.find((m) => m.topic === tag)!;
      if (msg.payload.text() !== 'hello') {
        throw new Error(`payload mismatch: got ${msg.payload.text()}`);
      }
      if (msg.qos !== 0) {
        throw new Error(`qos mismatch: got ${msg.qos}`);
      }
    } finally {
      mqtt.stop();
      inboxRef.stop();
    }
  },
};
