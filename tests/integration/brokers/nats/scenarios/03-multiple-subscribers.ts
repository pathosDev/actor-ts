/**
 * Multiple subscribers on the same subject — pub/sub fan-out.
 * NATS-Core (no JetStream) delivers each published message to
 * every connected client that has subscribed to the subject.
 *
 * Note on the framework's NatsActor: each actor instance allows
 * at most one subscription per subject (subsequent subscribes on
 * the same subject are silently de-duped — same semantics as
 * "one client, one subscription").  To get fan-out we spawn
 * three separate NatsActor instances, each with its own NATS
 * connection.
 */
import type { NatsMessage } from '../../../../../src/io/broker/NatsActor.js';
import { spawnInbox, spawnNats, type NatsContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<NatsContext> = {
  name: 'multiple subscribers on the same subject — fan-out',
  async run(ctx) {
    const subject = `b6.fanout.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    // Three independent NATS clients, each subscribing once.
    const { ref: refA, inbox: aInbox } = spawnInbox(ctx);
    const { ref: refB, inbox: bInbox } = spawnInbox(ctx);
    const { ref: refC, inbox: cInbox } = spawnInbox(ctx);
    const natsA = spawnNats(ctx);
    const natsB = spawnNats(ctx);
    const natsC = spawnNats(ctx);
    const publisher = spawnNats(ctx);
    try {
      for (const [actor, target] of [[natsA, refA], [natsB, refB], [natsC, refC]] as const) {
        actor.tell({
          kind: 'subscribe', subject,
          target: target as unknown as { tell(_m: NatsMessage): void },
        });
      }
      // Give every connection time to register its subscription.
      await new Promise((r) => setTimeout(r, 200));

      publisher.tell({ kind: 'publish', publish: { subject, payload: 'broadcast' } });

      await waitFor('all three inboxes received',
        () => aInbox.received.length >= 1 && bInbox.received.length >= 1 && cInbox.received.length >= 1,
        3_000,
      );
    } finally {
      publisher.stop();
      natsA.stop();
      natsB.stop();
      natsC.stop();
      refA.stop();
      refB.stop();
      refC.stop();
    }
  },
};
