/**
 * MAXLEN cap — XADD ... MAXLEN ~ N drops oldest entries when the
 * stream exceeds N.  The framework adapter sets this via the
 * `maxLenApprox` field; verifies the cap actually trims the stream.
 */
import { spawnRedis, type RedisContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<RedisContext> = {
  name: 'MAXLEN ~ N caps stream length',
  async run(context) {
    const tag = `b7:maxlen:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const producer = spawnRedis(context);
    try {
      await new Promise((r) => setTimeout(r, 200));

      // Publish 50 entries, but cap at MAXLEN ~ 10.  Redis's "~"
      // approximate trim may leave a few extras (radix-tree boundary
      // semantics), so the assertion is "well below 50, not exactly 10".
      const CAP = 10;
      for (let i = 0; i < 50; i++) {
        producer.tell({
          kind: 'publish',
          publish: {
            stream: tag,
            fields: { i: String(i) },
            maxLenApprox: CAP,
          },
        });
      }

      const ioredis = await import('ioredis');
      const Redis = (ioredis as { default?: typeof ioredis.default }).default ?? ioredis;
      const client = new (Redis as unknown as new (url: string) => {
        xlen(s: string): Promise<number>; quit(): Promise<unknown>;
      })(context.url);
      try {
        await waitFor('stream length stays within MAXLEN ~ approximation',
          async () => {
            const len = await client.xlen(tag);
            // Approximate trim — Redis may leave a few extras at radix
            // boundaries.  Allow up to 2x the cap as the upper bound.
            return len > 0 && len <= CAP * 2 && len < 50;
          },
          5_000,
        );
      } finally {
        await client.quit();
      }
    } finally {
      producer.stop();
    }
  },
};
