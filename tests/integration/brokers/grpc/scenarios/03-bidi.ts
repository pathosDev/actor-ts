/**
 * Bidirectional stream — client sends N chunks, server echoes each
 * back, client closes.  Verifies the streamId threading +
 * stream-end signal in the framework's bidi flow.
 */
import type { GrpcClientCommand } from '../../../../../src/io/broker/GrpcClientActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnCollector, type GrpcCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

export const scenario: BrokerScenario<GrpcCtx> = {
  name: 'bidi — client sends N, server echoes N, client closes',
  async run(ctx) {
    const { ref: collectorRef, collector } = spawnCollector(ctx);
    try {
      const client = ctx.client as unknown as ActorRef<GrpcClientCommand>;
      client.tell({
        kind: 'bidiStart',
        method: 'Bidi',
        target: collectorRef as ActorRef<unknown>,
      });

      // The framework emits an initial inbound `stream-data` with
      // `{ __streamId: <id> }` as a hint so the caller knows which
      // id to use for subsequent bidiSend/Close.  We can't hard-
      // code streamId=1 here because earlier scenarios on the
      // same shared client already bumped the counter (server-
      // stream consumed id 1, so bidi would be id 2 — and so on).
      await waitFor('bidi streamId hint received',
        () => collector.inbound.some((m) =>
          m.kind === 'stream-data' &&
          typeof (m.chunk as { __streamId?: unknown })?.__streamId === 'number',
        ),
        5_000,
      );
      const hint = collector.inbound.find((m) =>
        m.kind === 'stream-data' &&
        typeof (m.chunk as { __streamId?: unknown })?.__streamId === 'number',
      )!;
      const streamId = (hint.chunk as { __streamId: number }).__streamId;

      const N = 4;
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
      // Echoed chunks are the "real" stream-data — exclude the
      // initial streamId-hint frame from the count.
      const data = collector.inbound.filter((m) =>
        m.kind === 'stream-data' &&
        (m.chunk as { __streamId?: unknown })?.__streamId === undefined,
      );
      if (data.length !== N) {
        throw new Error(`expected ${N} echoed chunks, got ${data.length}`);
      }
    } finally {
      collectorRef.stop();
    }
  },
};
