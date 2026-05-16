/**
 * Headers — Kafka records carry a `headers` map.  The framework
 * adapter passes them through both directions; this scenario
 * round-trips a structured header set through Redpanda.
 */
import { spawnInbox, spawnKafka, type KafkaCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<KafkaCtx> = {
  name: 'headers round-trip',
  async run(ctx) {
    const tag = `b4-headers-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const topic = `${tag}-topic`;
    const groupId = `${tag}-group`;

    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    const consumer = spawnKafka(ctx, { groupId, topics: [topic], target: inboxRef });
    const producer = spawnKafka(ctx);
    try {
      await new Promise((r) => setTimeout(r, 1_500));

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

      await waitFor(`received the headers record on ${topic}`,
        () => inbox.received.length >= 1,
        15_000,
      );
      const r = inbox.received[0]!;
      const decode = (v: Uint8Array | string | null | undefined): string => {
        if (v === null || v === undefined) return '<null>';
        if (typeof v === 'string') return v;
        return new TextDecoder().decode(v);
      };
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
