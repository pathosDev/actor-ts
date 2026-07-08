/**
 * Manual-commit pump — the consumer pauses on each message and
 * waits for an explicit `{ kind: 'commit', ... }` before advancing.
 * Verifies the "exactly-once-with-processing" path (#2).
 *
 * Wiring trick: the committer actor needs a ref to the Kafka actor
 * so it can send `commit` back.  We resolve the chicken-and-egg by
 * deferring the kafka-ref look-up via a callback supplied at spawn.
 */
import { Actor } from '../../../../../src/Actor.js';
import { Props } from '../../../../../src/Props.js';
import type { KafkaCommand, KafkaRecord } from '../../../../../src/io/broker/KafkaActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnKafka, type KafkaCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

class ManualCommitter extends Actor<KafkaRecord> {
  readonly seen: KafkaRecord[] = [];
  /** Late-bound — set after the kafka actor is spawned. */
  kafka: ActorRef<KafkaCommand> | null = null;
  override onReceive(r: KafkaRecord): void {
    this.seen.push(r);
    this.kafka?.tell({
      kind: 'commit',
      topic: r.topic,
      partition: r.partition,
      offset: r.offset,
    });
  }
}

export const scenario: BrokerScenario<KafkaCtx> = {
  name: 'manual-commit pump — pause-and-advance',
  async run(ctx) {
    const tag = `b4-manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const topic = `${tag}-topic`;
    const groupId = `${tag}-group`;

    const committer = new ManualCommitter();
    const inboxRef = ctx.system.spawnAnonymous(Props.create(() => committer));
    const consumer = spawnKafka(ctx, {
      groupId, topics: [topic], commitMode: 'manual',
      target: inboxRef,
    });
    committer.kafka = consumer as unknown as ActorRef<KafkaCommand>;
    const producer = spawnKafka(ctx);
    try {
      await new Promise((r) => setTimeout(r, 2_000));

      const N = 3;
      for (let i = 0; i < N; i++) {
        producer.tell({
          kind: 'publish',
          publish: { topic, value: `manual-${i}` },
        });
      }

      await waitFor(`manual-commit consumer saw ${N} records`,
        () => committer.seen.length >= N,
        20_000,
      );

      // Settle — verify no duplicates (each record arrives once).
      await new Promise((r) => setTimeout(r, 1_000));
      if (committer.seen.length !== N) {
        throw new Error(`manual commit expected ${N} records, got ${committer.seen.length}`);
      }
    } finally {
      producer.stop();
      consumer.stop();
      inboxRef.stop();
    }
  },
};
