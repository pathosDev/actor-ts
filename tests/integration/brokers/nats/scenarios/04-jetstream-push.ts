/**
 * JetStream push mode, end to end — the default that never worked.
 *
 * `consumer.mode` defaults to `'push'`, and against a real server that path
 * threw before #1526: `upsertConsumer` created the consumer without a
 * `deliver_subject`, which makes it a **pull** consumer server-side, and the
 * push subscribe then refused to bind to it.  Nothing caught it because this
 * suite ran its NATS server without `-js`, so no JetStream scenario existed at
 * all — and the unit tests asserted against a hand-written stub that was happy
 * to pretend.
 *
 * So this is the regression test for a defect rather than a port of a working
 * feature: publish into a stream, wait for the server to deliver on its own
 * (no `fetch` anywhere), and settle.
 */
import { Actor } from '../../../../../src/Actor.js';
import { JetStreamActor, type JetStreamMessage } from '../../../../../src/io/broker/JetStreamActor.js';
import { JetStreamOptions } from '../../../../../src/io/broker/JetStreamOptions.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';
import { jetStreamNames, type NatsContext } from '../Runner.js';

class Inbox extends Actor<JetStreamMessage> {
  readonly received: JetStreamMessage[] = [];
  override onReceive(message: JetStreamMessage): void { this.received.push(message); }
}

export const scenario: BrokerScenario<NatsContext> = {
  name: 'jetstream push mode — the server delivers without being asked',
  async run(context) {
    const { stream, subject, durable } = jetStreamNames('push');
    const inbox = new Inbox();
    const inboxRef = context.system.spawnAnonymous(() => inbox);
    const options = JetStreamOptions.create()
      .withServers([...context.servers])
      .withStream({ name: stream, subjects: [`${subject}.>`] })
      .withConsumer({ durable, mode: 'push', ackWaitMs: 10_000 })
      .withTarget(inboxRef);
    const actor = context.system.spawnAnonymous(() => new JetStreamActor(options));

    try {
      // The actor provisions stream and consumer during connect, and a publish
      // sent before that lands in its outbound buffer rather than being lost —
      // so republishing while waiting is safe and keeps the scenario free of a
      // sleep that guesses at connect latency.
      await waitFor('a push delivery arrived without anything fetching it',
        () => {
          actor.tell({ kind: 'publish', publish: { subject: `${subject}.one`, payload: 'push-payload' } });
          return inbox.received.length > 0;
        },
        20_000,
      );

      const message = inbox.received[0]!;
      const payload = new TextDecoder().decode(message.payload);
      if (payload !== 'push-payload') throw new Error(`payload mismatch: ${payload}`);
      if (message.streamSeq < 1) throw new Error(`streamSeq not set: ${message.streamSeq}`);
      // Settling is the half a broken push path would never reach.
      actor.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
    } finally {
      actor.stop();
      inboxRef.stop();
    }
  },
};
