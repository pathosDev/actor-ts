/**
 * XADD path — publish entries, then verify they're on the stream
 * via a direct XLEN.  Tests the producer half of RedisStreamsActor
 * without involving the consumer pump (which has its own scenario).
 */
import { spawnRedis, type RedisContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<RedisContext> = {
  name: 'XADD — publish entries land on the stream',
  async run(ctx) {
    const tag = `b7:stream:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const producer = spawnRedis(ctx);
    try {
      // Give the actor a tick to connect.
      await new Promise((r) => setTimeout(r, 200));

      const N = 5;
      for (let i = 0; i < N; i++) {
        producer.tell({
          kind: 'publish',
          publish: { stream: tag, fields: { i: String(i), kind: 'test' } },
        });
      }

      // Verify via a direct XLEN on a side connection.
      const ioredis = await import('ioredis');
      const Redis = (ioredis as { default?: typeof ioredis.default }).default ?? ioredis;
      const client = new (Redis as unknown as new (url: string) => {
        xlen(s: string): Promise<number>; quit(): Promise<unknown>;
      })(ctx.url);
      try {
        await waitFor(`XLEN ${tag} == ${N}`,
          async () => (await client.xlen(tag)) === N,
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
