/**
 * Server-stream — single request → N stream-data + 1 stream-end.
 */
import type { GrpcClientCommand } from '../../../../../src/io/broker/GrpcClientActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnCollector, type GrpcContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<GrpcContext> = {
  name: 'server-stream — N data chunks + end',
  async run(context) {
    const { ref: collectorRef, collector } = spawnCollector(context);
    try {
      const N = 5;
      const client = context.client as unknown as ActorRef<GrpcClientCommand>;
      client.tell({
        kind: 'serverStream',
        method: 'ServerStream',
        request: { text: 'chunk', count: N },
        target: collectorRef as ActorRef<unknown>,
      });

      await waitFor(`stream-end after ${N} data chunks`,
        () => collector.inbound.some((m) => m.kind === 'stream-end'),
        5_000,
      );
      const data = collector.inbound.filter((m) => m.kind === 'stream-data');
      if (data.length !== N) {
        throw new Error(`expected ${N} stream-data chunks, got ${data.length}`);
      }
      for (let i = 0; i < N; i++) {
        const chunk = data[i]!;
        if (chunk.kind !== 'stream-data') throw new Error('not stream-data');
        const payload = chunk.chunk as { text?: string; sequence?: number };
        if (payload.sequence !== i || payload.text !== `chunk-${i}`) {
          throw new Error(`chunk ${i} mismatch: ${JSON.stringify(payload)}`);
        }
      }
    } finally {
      collectorRef.stop();
    }
  },
};
