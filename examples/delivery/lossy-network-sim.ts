/**
 * Realistic Reliable Delivery: a lossy "relay" drops 50% of deliveries.
 * The producer retries on timeout until every message is acked.  The
 * consumer dedups redeliveries so the user handler runs exactly once per
 * body.
 *
 *   bun run examples/delivery/lossy-network-sim.ts
 */
import {
  Actor,
  ActorSystem,
  Props,
  ReliableDelivery,
  type Delivery,
} from '../../src/index.js';

/** A relay that forwards only a random half of incoming deliveries. */
class LossyRelay extends Actor<Delivery<string>> {
  constructor(private readonly downstream: import('../../src/ActorRef.js').ActorRef<Delivery<string>>) { super(); }
  override onReceive(d: Delivery<string>): void {
    if (Math.random() < 0.5) {
      console.log(`[relay] dropping seq=${d.seq} body="${d.body}"`);
      return;
    }
    console.log(`[relay] forwarding seq=${d.seq} body="${d.body}"`);
    this.downstream.tell(d);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('rd-lossy');

  const handled: string[] = [];
  const consumer = ReliableDelivery.consumer<string>(system, {
    handler: (m) => { handled.push(m); console.log(`[consumer] handled "${m}"`); },
  });

  // Producer talks to the relay, which forwards to the consumer.
  const relay = system.spawn(
    Props.create(() => new LossyRelay(consumer.ref as never)),
    'lossy-relay',
  );

  const producer = ReliableDelivery.producer<string>(system, {
    consumer: relay as never,
    resendTimeoutMs: 60,
    windowSize: 4,
  });

  const N = 10;
  let confirmed = 0;
  for (let i = 0; i < N; i++) {
    producer.tell(`msg-${i}`, () => {
      confirmed++;
      if (confirmed === N) console.log(`[producer] all ${N} messages acked`);
    });
  }

  // Wait until every message has been handled (or we give up after a few seconds).
  const deadline = Date.now() + 5_000;
  while (handled.length < N && Date.now() < deadline) await Bun.sleep(20);
  console.log(`[result] unique handled: ${handled.length} / ${N}`);

  producer.stop(); consumer.stop();
  await system.terminate();
}

void main();
