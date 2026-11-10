/**
 * JetStream object store, end to end.
 *
 * Same shape change as the key-value scenario: v3 moved the view into
 * `@nats-io/obj` behind `Objm`, and `create: false` became `open`.  The blob
 * methods themselves (`putBlob` / `getBlob`) survived the split unchanged,
 * which is worth having a live check on rather than assuming.
 */
import { Actor } from '../../../../../src/Actor.js';
import {
  JetStreamObjectStoreActor,
  type JetStreamObjectStoreMessage,
} from '../../../../../src/io/broker/JetStreamObjectStoreActor.js';
import { JetStreamObjectStoreOptions } from '../../../../../src/io/broker/JetStreamObjectStoreOptions.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';
import { jetStreamNames, type NatsContext } from '../Runner.js';

class Inbox extends Actor<JetStreamObjectStoreMessage> {
  readonly received: JetStreamObjectStoreMessage[] = [];
  override onReceive(message: JetStreamObjectStoreMessage): void { this.received.push(message); }
}

export const scenario: BrokerScenario<NatsContext> = {
  name: 'jetstream object store — put and get a blob',
  async run(context) {
    const { bucket } = jetStreamNames('obj');
    const inbox = new Inbox();
    const inboxRef = context.system.spawnAnonymous(() => inbox);
    const actor = context.system.spawnAnonymous(() => new JetStreamObjectStoreActor(
      JetStreamObjectStoreOptions.create()
        .withServers([...context.servers])
        .withBucket(bucket)
        .withDescription('actor-ts integration'),
    ));

    try {
      await waitFor('the object round-tripped through the bucket',
        () => {
          actor.tell({ kind: 'put', name: 'greeting.txt', payload: 'hello-object' });
          actor.tell({ kind: 'get', name: 'greeting.txt', target: inboxRef });
          return inbox.received.some((m) => m.kind === 'objectBody');
        },
        20_000,
      );

      const object = inbox.received.find((m) => m.kind === 'objectBody')!;
      if (object.kind !== 'objectBody') throw new Error('unreachable');
      const payload = new TextDecoder().decode(object.payload);
      if (payload !== 'hello-object') throw new Error(`payload mismatch: ${payload}`);
    } finally {
      actor.stop();
      inboxRef.stop();
    }
  },
};
