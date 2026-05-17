/**
 * Headers — Kafka records carry a `headers` map.  The framework
 * adapter passes them through both directions; this scenario
 * round-trips a structured header set through Redpanda.
 */
import { spawnInbox, spawnKafka, type KafkaCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

const decode = (v: Uint8Array | string | null | undefined): string => {
  if (v === null || v === undefined) return '<null>';
  if (typeof v === 'string') return v;
  return new TextDecoder().decode(v);
};

export const scenario: BrokerScenario<KafkaCtx> = {
  name: 'headers round-trip',
  async run(ctx) {
    const tag = `b4-headers-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const topic = `${tag}-topic`;
    const groupId = `${tag}-group`;

    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    // Pre-create the topic by sending an initial "warmup" publish
    // through a separate producer.  Auto-topic-creation on Redpanda
    // can take ~1-2s and we don't want to race the consumer's
    // group-join against it.  The warmup publish creates the topic
    // and gives the broker a settled metadata view BEFORE the
    // consumer subscribes.
    const warmup = spawnKafka(ctx);
    await new Promise((r) => setTimeout(r, 500));
    warmup.tell({ kind: 'publish', publish: { topic, value: 'warmup' } });
    await new Promise((r) => setTimeout(r, 1_500));
    warmup.stop();

    const consumer = spawnKafka(ctx, { groupId, topics: [topic], target: inboxRef });
    const producer = spawnKafka(ctx);
    try {
      await new Promise((r) => setTimeout(r, 2_000));

      // Plain `Uint8Array` deliberately — the framework's
      // KafkaActor.dispatchOutgoing coerces this to Buffer
      // before handing it to kafkajs (which silently drops
      // non-Buffer Uint8Array values).  If a future regression
      // ever drops that coercion this scenario will surface it.
      producer.tell({
        kind: 'publish',
        publish: {
          topic,
          value: 'with-headers',
          headers: {
            'x-trace-id': 'abc123',
            'x-source': 'integration-test',
            'x-binary': new Uint8Array([0xAA, 0xBB, 0xCC]),
          },
        },
      });

      // We may receive the warmup message first (fromBeginning: true).
      // Look specifically for the with-headers record.
      await waitFor(`received the headers record on ${topic}`,
        () => inbox.received.some((r) => decode(r.value) === 'with-headers'),
        20_000,
      );
      const r = inbox.received.find((x) => decode(x.value) === 'with-headers')!;
      if (decode(r.headers['x-trace-id']) !== 'abc123') {
        throw new Error(`x-trace-id missing/wrong: got ${decode(r.headers['x-trace-id'])}`);
      }
      if (decode(r.headers['x-source']) !== 'integration-test') {
        throw new Error(`x-source missing/wrong: got ${decode(r.headers['x-source'])}`);
      }
      const bin = r.headers['x-binary'];
      if (!(bin instanceof Uint8Array) && typeof bin !== 'string') {
        throw new Error(`x-binary unexpected shape: ${typeof bin}`);
      }
      // kafkajs returns headers as Buffer (Uint8Array compatible).
      const bytes = bin instanceof Uint8Array ? bin : new TextEncoder().encode(bin);
      if (bytes.length !== 3 || bytes[0] !== 0xAA || bytes[1] !== 0xBB || bytes[2] !== 0xCC) {
        throw new Error(`x-binary bytes mismatch: ${Array.from(bytes).map((b) => b.toString(16)).join(',')}`);
      }
    } finally {
      producer.stop();
      consumer.stop();
      inboxRef.stop();
    }
  },
};
