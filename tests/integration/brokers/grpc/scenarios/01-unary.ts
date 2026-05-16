/**
 * Unary gRPC call — request → single response → end.
 */
import type { GrpcClientCmd } from '../../../../../src/io/broker/GrpcClientActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnCollector, type GrpcCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<GrpcCtx> = {
  name: 'unary echo — request/response round-trip',
  async run(ctx) {
    const { ref: collectorRef, collector } = spawnCollector(ctx);
    try {
      const client = ctx.client as unknown as ActorRef<GrpcClientCmd>;
      client.tell({
        kind: 'unary',
        method: 'Unary',
        request: { text: 'ping' },
        target: collectorRef as ActorRef<unknown>,
      });

      await waitFor('unary reply observed',
        () => collector.inbound.some((m) => m.kind === 'reply'),
        5_000,
      );
      const reply = collector.inbound.find((m) => m.kind === 'reply')!;
      if (reply.kind !== 'reply') throw new Error('not a reply');
      const r = reply.response as { text?: string };
      if (r.text !== 'ping') {
        throw new Error(`expected text=ping, got ${r.text}`);
      }
    } finally {
      collectorRef.stop();
    }
  },
};
