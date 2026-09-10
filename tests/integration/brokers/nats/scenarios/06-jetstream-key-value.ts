/**
 * JetStream key-value, end to end.
 *
 * The KV view moved to its own package in nats.js v3 (`Kvm` replacing
 * `JetStreamClient.views.kv`), and `create: false` now means calling `open`
 * rather than passing a `bindOnly` flag.  Both are shape changes a stub cannot
 * catch, which is what this scenario is for.
 */
import { Actor } from '../../../../../src/Actor.js';
import {
  JetStreamKeyValueActor,
  type JetStreamKeyValueMessage,
} from '../../../../../src/io/broker/JetStreamKeyValueActor.js';
import { JetStreamKeyValueOptions } from '../../../../../src/io/broker/JetStreamKeyValueOptions.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';
import { jetStreamNames, type NatsContext } from '../Runner.js';

class Inbox extends Actor<JetStreamKeyValueMessage> {
  readonly received: JetStreamKeyValueMessage[] = [];
  override onReceive(message: JetStreamKeyValueMessage): void { this.received.push(message); }
}

export const scenario: BrokerScenario<NatsContext> = {
  name: 'jetstream key-value — put, get and a bound reader',
  async run(context) {
    const { bucket } = jetStreamNames('kv');
    const inbox = new Inbox();
    const inboxRef = context.system.spawnAnonymous(() => inbox);
    const writer = context.system.spawnAnonymous(() => new JetStreamKeyValueActor(
      JetStreamKeyValueOptions.create()
        .withServers([...context.servers])
        .withBucket(bucket)
        .withHistory(3),
    ));
    // A second actor with `create: false` — it must find the bucket the first
    // one made, which is the `open` path rather than `create`.
    const reader = context.system.spawnAnonymous(() => new JetStreamKeyValueActor(
      JetStreamKeyValueOptions.create()
        .withServers([...context.servers])
        .withBucket(bucket)
        .withCreate(false),
    ));

    try {
      await waitFor('the value round-tripped through the bucket',
        () => {
          writer.tell({ kind: 'put', key: 'greeting', value: 'hello-kv' });
          reader.tell({ kind: 'get', key: 'greeting', target: inboxRef });
          return inbox.received.some((m) => m.kind === 'keyValueEntry');
        },
        20_000,
      );

      const entry = inbox.received.find((m) => m.kind === 'keyValueEntry')!;
      if (entry.kind !== 'keyValueEntry') throw new Error('unreachable');
      const value = new TextDecoder().decode(entry.value);
      if (value !== 'hello-kv') throw new Error(`value mismatch: ${value}`);
      if (entry.revision < 1) throw new Error(`revision not set: ${entry.revision}`);
    } finally {
      writer.stop();
      reader.stop();
      inboxRef.stop();
    }
  },
};
