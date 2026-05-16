/**
 * Bidirectional stream — client sends N chunks, server echoes each
 * back, client closes.  Verifies the streamId threading +
 * stream-end signal in the framework's bidi flow.
 */
import type { GrpcClientCmd } from '../../../../../src/io/broker/GrpcClientActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnCollector, type GrpcCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<GrpcCtx> = {
  name: 'bidi — client sends N, server echoes N, client closes',
  async run(ctx) {
    const { ref: collectorRef, collector } = spawnCollector(ctx);
    try {
      const client = ctx.client as unknown as ActorRef<GrpcClientCmd>;
      client.tell({
        kind: 'bidiStart',
        method: 'Bidi',
        target: collectorRef as ActorRef<unknown>,
      });

      // Pluck the streamId from the first inbound — the framework's
      // bidi emits an initial frame so the caller knows the id.  We
      // don't have a clean API for that, so derive it as 1 (the
      // GrpcClientActor's monotonic counter starts at 1, and this is
      // the first bidi for this client).
      const N = 4;
      const streamId = 1;
      for (let i = 0; i < N; i++) {
        client.tell({
          kind: 'bidiSend',
          streamId,
          chunk: { text: `bidi-${i}` },
        });
      }
      client.tell({ kind: 'bidiClose', streamId });

      await waitFor(`bidi stream-end observed`,
        () => collector.inbound.some((m) => m.kind === 'stream-end'),
        5_000,
      );
      const data = collector.inbound.filter((m) => m.kind === 'stream-data');
      if (data.length !== N) {
        throw new Error(`expected ${N} echoed chunks, got ${data.length}`);
      }
    } finally {
      collectorRef.stop();
    }
  },
};
