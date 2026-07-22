/**
 * Typed, subclass-first round-trip against a real broker:
 *
 *   - a subclass subscribes in its constructor (pending-flush path)
 *   - inbound payloads decode via `message.payload.entity()`
 *   - `publish(topic, entity)` encodes through the codec (JSON default)
 *   - `publish(topic, string)` still sends raw bytes
 *
 * Covers the new API end-to-end where the unit tests use a fake client.
 */
import { Props } from '../../../../../src/Props.js';
import { MqttActor, type MqttMessage } from '../../../../../src/io/broker/MqttActor.js';
import { MqttOptions } from '../../../../../src/io/broker/MqttOptions.js';
import { spawnInbox, spawnMqtt, type MqttContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

interface Reading {
  readonly sensor: string;
  readonly celsius: number;
}

type ReadingSelf =
  | { readonly kind: 'send'; readonly topic: string; readonly reading: Reading }
  | { readonly kind: 'sendRaw'; readonly topic: string; readonly text: string };

/** Subclass that subscribes in its constructor and decodes entities. */
class ReadingActor extends MqttActor<Reading, ReadingSelf> {
  readonly received: MqttMessage<Reading>[] = [];

  constructor(brokerUrl: string, clientId: string, subTopic: string) {
    const mqttOptions = MqttOptions.create()
      .withBrokerUrl(brokerUrl)
      .withClientId(clientId)
      .withCleanSession(true);
    super(mqttOptions);
    this.subscribe(subTopic, { qos: 1 });
  }

  override onMessage(message: MqttMessage<Reading>): void {
    this.received.push(message);
  }

  protected override onSelfMessage(message: ReadingSelf): void {
    if (message.kind === 'send') this.publish(message.topic, message.reading, { qos: 1 });
    else this.publish(message.topic, message.text, { qos: 1 });
  }
}

export const scenario: BrokerScenario<MqttContext> = {
  name: 'typed entities — constructor subscribe, entity() decode, entity/raw publish',
  async run(context) {
    const tag = `b3/typed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const subTopic = `${tag}/in`;
    const outTopic = `${tag}/out`;
    const rawTopic = `${tag}/raw`;

    const reader = new ReadingActor(context.brokerUrl, `${tag}-reader`, subTopic);
    const readerRef = context.system.spawnAnonymous(Props.create(() => reader));
    const { ref: mqtt } = spawnMqtt(context);
    const { ref: inboxRef, inbox } = spawnInbox(context);
    try {
      // Router subscribes to the reader's outbound topics.
      mqtt.tell({ kind: 'subscribe', topic: outTopic, target: inboxRef, qos: 1 });
      mqtt.tell({ kind: 'subscribe', topic: rawTopic, target: inboxRef, qos: 1 });
      // Let the constructor subscribe + router subscribes land on the broker.
      await new Promise((r) => setTimeout(r, 300));

      // 1) Inbound entity decode: publisher → reader's own onMessage.
      const inbound: Reading = { sensor: 'kitchen', celsius: 21.5 };
      mqtt.tell({
        kind: 'publish',
        publish: { topic: subTopic, payload: JSON.stringify(inbound), qos: 1 },
      });
      await waitFor(`reader received an inbound reading on ${subTopic}`,
        () => reader.received.length >= 1, 5_000);
      const got = reader.received[0]!.payload.entity();
      if (got.sensor !== inbound.sensor || got.celsius !== inbound.celsius) {
        throw new Error(`entity() decode mismatch: ${JSON.stringify(got)}`);
      }

      // 2) Entity publish: reader encodes via the codec → inbox decodes.
      const outbound: Reading = { sensor: 'bedroom', celsius: 19 };
      readerRef.tell({ kind: 'send', topic: outTopic, reading: outbound });
      await waitFor(`entity published to ${outTopic}`,
        () => inbox.received.some((m) => m.topic === outTopic), 5_000);
      const outMessage = inbox.received.find((m) => m.topic === outTopic)!;
      const decoded = outMessage.payload.entity<Reading>();
      if (decoded.sensor !== outbound.sensor || decoded.celsius !== outbound.celsius) {
        throw new Error(`published entity round-trip mismatch: ${outMessage.payload.text()}`);
      }

      // 3) Raw string publish: bytes sent verbatim.
      readerRef.tell({ kind: 'sendRaw', topic: rawTopic, text: 'plain-text' });
      await waitFor(`raw string published to ${rawTopic}`,
        () => inbox.received.some((m) => m.topic === rawTopic), 5_000);
      const rawMessage = inbox.received.find((m) => m.topic === rawTopic)!;
      if (rawMessage.payload.text() !== 'plain-text') {
        throw new Error(`raw publish mismatch: got ${rawMessage.payload.text()}`);
      }
    } finally {
      readerRef.stop();
      mqtt.stop();
      inboxRef.stop();
    }
  },
};
