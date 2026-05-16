/**
 * Multiple subscribers on the same subject — pub/sub fan-out.
 * NATS-Core (no JetStream) doesn't have queue groups in this test
 * setup; every subscriber on the subject gets every message.
 */
import type { NatsMessage } from '../../../../../src/io/broker/NatsActor.js';
import { spawnInbox, spawnNats, type NatsCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<NatsCtx> = {
  name: 'multiple subscribers on the same subject — fan-out',
  async run(ctx) {
    const subject = `b6.fanout.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const nats = spawnNats(ctx);
    const { ref: refA, inbox: aInbox } = spawnInbox(ctx);
    const { ref: refB, inbox: bInbox } = spawnInbox(ctx);
    const { ref: refC, inbox: cInbox } = spawnInbox(ctx);
    try {
      for (const r of [refA, refB, refC]) {
        nats.tell({
          kind: 'subscribe', subject,
          target: r as unknown as { tell(_m: NatsMessage): void },
        });
      }
      await new Promise((r) => setTimeout(r, 100));

      nats.tell({ kind: 'publish', publish: { subject, payload: 'broadcast' } });

      await waitFor('all three inboxes received',
        () => aInbox.received.length >= 1 && bInbox.received.length >= 1 && cInbox.received.length >= 1,
        3_000,
      );
    } finally {
      nats.stop();
      refA.stop();
      refB.stop();
      refC.stop();
    }
  },
};
