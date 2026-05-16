/**
 * Baseline NATS publish/subscribe — single subject.
 */
import type { NatsMessage } from '../../../../../src/io/broker/NatsActor.js';
import { spawnInbox, spawnNats, type NatsCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<NatsCtx> = {
  name: 'publish/subscribe round-trip',
  async run(ctx) {
    const tag = `b6.pubsub.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const nats = spawnNats(ctx);
    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    try {
      nats.tell({
        kind: 'subscribe',
        subject: tag,
        target: inboxRef as unknown as { tell(_m: NatsMessage): void },
      });
      // NATS subscribes propagate in <10ms.
      await new Promise((r) => setTimeout(r, 100));

      nats.tell({
        kind: 'publish',
        publish: { subject: tag, payload: 'hello-nats' },
      });

      await waitFor(`message arrived on ${tag}`,
        () => inbox.received.some((m) => m.subject === tag),
        3_000,
      );
      const m = inbox.received.find((x) => x.subject === tag)!;
      if (new TextDecoder().decode(m.payload) !== 'hello-nats') {
        throw new Error(`payload mismatch: got ${new TextDecoder().decode(m.payload)}`);
      }
    } finally {
      nats.stop();
      inboxRef.stop();
    }
  },
};
