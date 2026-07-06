/**
 * Wildcard subscriptions — `+` (single level) + `#` (multi-level).
 * The broker fans inbound traffic out based on its pattern; the
 * actor's `patternSubs` map matches them on delivery.  Both halves
 * must work together — broker accepts the wildcard subscribe and
 * actor matches concrete inbound topics against the pattern.
 */
import { spawnInbox, spawnMqtt, type MqttCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<MqttCtx> = {
  name: 'wildcard subscriptions — + and # patterns',
  async run(ctx) {
    const base = `b3/wc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ref: mqtt } = spawnMqtt(ctx);
    const { ref: plusRef, inbox: plusInbox } = spawnInbox(ctx);
    const { ref: hashRef, inbox: hashInbox } = spawnInbox(ctx);
    try {
      // `+` matches exactly one level.  `base/+/leaf` → matches
      // base/x/leaf, base/y/leaf, but NOT base/x/y/leaf or base/leaf.
      mqtt.tell({ kind: 'subscribe', topic: `${base}/+/leaf`, target: plusRef, qos: 0 });
      // `#` matches one-or-more levels.  `base/sensor/#` → matches
      // base/sensor/temp, base/sensor/x/y, but NOT base/sensor.
      mqtt.tell({ kind: 'subscribe', topic: `${base}/sensor/#`, target: hashRef, qos: 0 });
      await new Promise((r) => setTimeout(r, 200));

      const publishes = [
        `${base}/a/leaf`,       // matches +/leaf
        `${base}/b/leaf`,       // matches +/leaf
        `${base}/c/x/leaf`,     // does NOT match +/leaf (too deep)
        `${base}/sensor/temp`,  // matches sensor/#
        `${base}/sensor/x/y`,   // matches sensor/#
        `${base}/other/x`,      // matches neither
      ];
      for (const t of publishes) {
        mqtt.tell({
          kind: 'publish',
          publish: { topic: t, payload: new TextEncoder().encode(t), qos: 0 },
        });
      }
      await new Promise((r) => setTimeout(r, 500));

      await waitFor('+ inbox saw both /leaf publishes',
        () => plusInbox.received.length >= 2, 5_000);
      const plusTopics = new Set(plusInbox.received.map((m) => m.topic));
      if (!plusTopics.has(`${base}/a/leaf`) || !plusTopics.has(`${base}/b/leaf`)) {
        throw new Error(`+ inbox missing expected topics: got ${[...plusTopics].join(', ')}`);
      }
      // The too-deep one must NOT have landed on the + subscription.
      if (plusTopics.has(`${base}/c/x/leaf`)) {
        throw new Error(`+ inbox got the too-deep ${base}/c/x/leaf — wildcard scoping broken`);
      }

      await waitFor('# inbox saw both sensor publishes',
        () => hashInbox.received.length >= 2, 5_000);
      const hashTopics = new Set(hashInbox.received.map((m) => m.topic));
      if (!hashTopics.has(`${base}/sensor/temp`) || !hashTopics.has(`${base}/sensor/x/y`)) {
        throw new Error(`# inbox missing expected topics: got ${[...hashTopics].join(', ')}`);
      }
      if (hashTopics.has(`${base}/other/x`)) {
        throw new Error(`# inbox got the unrelated ${base}/other/x — wildcard scoping broken`);
      }
    } finally {
      mqtt.stop();
      plusRef.stop();
      hashRef.stop();
    }
  },
};
