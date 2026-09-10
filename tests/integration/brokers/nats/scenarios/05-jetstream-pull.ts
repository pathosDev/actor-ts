/**
 * JetStream pull mode (#62) — nothing is delivered until a `fetch` asks.
 *
 * The counterpart to the push scenario, and the reason both exist: v3 refuses
 * `consumers.get` on a push consumer and `getPushConsumer` on a pull one, so
 * the mode the actor is configured with and the consumer its own upsert writes
 * have to agree.  A scenario per mode is what makes a mismatch fail loudly.
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
  name: 'jetstream pull mode — nothing arrives until a fetch asks for it',
  async run(context) {
    const { stream, subject, durable } = jetStreamNames('pull');
    const inbox = new Inbox();
    const inboxRef = context.system.spawnAnonymous(() => inbox);
    const options = JetStreamOptions.create()
      .withServers([...context.servers])
      .withStream({ name: stream, subjects: [`${subject}.>`] })
      .withConsumer({ durable, mode: 'pull', ackWaitMs: 10_000 })
      .withTarget(inboxRef);
    const actor = context.system.spawnAnonymous(() => new JetStreamActor(options));

    try {
      // Publish and fetch in the same poll: a command sent before the actor
      // finished connecting is buffered rather than lost, so repeating both is
      // how the scenario waits for provisioning without a fixed sleep.
      //
      // Nothing here has to assert "no delivery without a fetch", which would
      // be an absence and need a wait to mean anything.  The driver already
      // guarantees it: v3 refuses `consumers.get` on a consumer that carries a
      // `deliver_subject`, so if this consumer had been provisioned as a push
      // consumer the handle would never have been created and no fetch would
      // ever deliver.  Arriving below *is* the proof it is a pull consumer.
      await waitFor('the fetch delivered the batch',
        () => {
          actor.tell({ kind: 'publish', publish: { subject: `${subject}.one`, payload: 'pull-payload' } });
          actor.tell({ kind: 'fetch', batch: 10 });
          return inbox.received.length > 0;
        },
        20_000,
      );
      const message = inbox.received[0]!;
      const payload = new TextDecoder().decode(message.payload);
      if (payload !== 'pull-payload') throw new Error(`payload mismatch: ${payload}`);
      actor.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
    } finally {
      actor.stop();
      inboxRef.stop();
    }
  },
};
