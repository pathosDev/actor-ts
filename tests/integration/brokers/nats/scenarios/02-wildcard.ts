/**
 * NATS subject wildcards: `*` (single token) and `>` (rest of subject).
 * Distinct semantics from MQTT — verify both flavours work on the
 * broker side as the framework's subscribe just passes through.
 */
import type { NatsMessage } from '../../../../../src/io/broker/NatsActor.js';
import { spawnInbox, spawnNats, type NatsContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<NatsContext> = {
  name: 'wildcard subscriptions — * and > tokens',
  async run(context) {
    const base = `b6wc.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const nats = spawnNats(context);
    const { ref: starRef, inbox: starInbox } = spawnInbox(context);
    const { ref: gtRef, inbox: gtInbox } = spawnInbox(context);
    try {
      // `*` matches exactly one token (no dots in the substitution).
      nats.tell({
        kind: 'subscribe', subject: `${base}.*.leaf`,
        target: starRef as unknown as { tell(_m: NatsMessage): void },
      });
      // `>` matches one-or-more tokens, including dots.
      nats.tell({
        kind: 'subscribe', subject: `${base}.sensor.>`,
        target: gtRef as unknown as { tell(_m: NatsMessage): void },
      });
      await new Promise((r) => setTimeout(r, 100));

      const publishes = [
        `${base}.a.leaf`,         // matches *.leaf
        `${base}.b.leaf`,         // matches *.leaf
        `${base}.c.deeper.leaf`,  // does NOT match *.leaf (two tokens)
        `${base}.sensor.temp`,    // matches sensor.>
        `${base}.sensor.a.b`,     // matches sensor.>
        `${base}.other.x`,        // matches neither
      ];
      for (const s of publishes) {
        nats.tell({ kind: 'publish', publish: { subject: s, payload: s } });
      }
      await new Promise((r) => setTimeout(r, 200));

      await waitFor(`* inbox saw both .leaf messages`,
        () => starInbox.received.length >= 2, 3_000);
      const starSubs = new Set(starInbox.received.map((m) => m.subject));
      if (!starSubs.has(`${base}.a.leaf`) || !starSubs.has(`${base}.b.leaf`)) {
        throw new Error(`* inbox missing expected subjects: ${[...starSubs].join(', ')}`);
      }
      if (starSubs.has(`${base}.c.deeper.leaf`)) {
        throw new Error(`* matched too-deep ${base}.c.deeper.leaf — wildcard scoping broken`);
      }

      await waitFor(`> inbox saw both sensor.* messages`,
        () => gtInbox.received.length >= 2, 3_000);
      const gtSubs = new Set(gtInbox.received.map((m) => m.subject));
      if (!gtSubs.has(`${base}.sensor.temp`) || !gtSubs.has(`${base}.sensor.a.b`)) {
        throw new Error(`> inbox missing expected subjects: ${[...gtSubs].join(', ')}`);
      }
      if (gtSubs.has(`${base}.other.x`)) {
        throw new Error(`> matched unrelated ${base}.other.x — wildcard scoping broken`);
      }
    } finally {
      nats.stop();
      starRef.stop();
      gtRef.stop();
    }
  },
};
