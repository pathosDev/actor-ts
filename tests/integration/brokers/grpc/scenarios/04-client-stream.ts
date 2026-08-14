/**
 * Client stream — client sends N chunks, half-closes, server answers
 * once.  Verifies the `stream-started` handshake, the handle-addressed
 * sends, and that the single response comes back as a plain `reply`.
 *
 * The second half is the security half: a handle with the right stream
 * id but a forged token must not reach the stream.  That is the whole
 * reason the handle carries a capability instead of a bare number
 * (#788 covers migrating bidi onto the same seam).
 */
import type { GrpcClientCommand, GrpcStreamHandle } from '../../../../../src/io/broker/GrpcClientActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnCollector, type CollectorActor, type GrpcContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

async function openStream(
  client: ActorRef<GrpcClientCommand>,
  collectorRef: ActorRef<unknown>,
  collector: CollectorActor,
): Promise<GrpcStreamHandle> {
  client.tell({ kind: 'clientStreamStart', method: 'ClientStream', target: collectorRef });
  await waitFor('client-stream handle received',
    () => collector.inbound.some((m) => m.kind === 'stream-started'),
    5_000,
  );
  const started = collector.inbound.find((m) => m.kind === 'stream-started')!;
  if (started.kind !== 'stream-started') throw new Error('not a stream-started frame');
  return started.handle;
}

export const scenario: BrokerScenario<GrpcContext> = {
  name: 'client-stream — client sends N, server answers once',
  async run(context) {
    const client = context.client as unknown as ActorRef<GrpcClientCommand>;

    const happyPath = spawnCollector(context);
    try {
      const handle = await openStream(
        client, happyPath.ref as ActorRef<unknown>, happyPath.collector,
      );

      const N = 4;
      for (let i = 0; i < N; i++) {
        client.tell({ kind: 'clientStreamSend', handle, chunk: { text: `client-${i}` } });
      }
      client.tell({ kind: 'clientStreamClose', handle });

      await waitFor('client-stream reply observed',
        () => happyPath.collector.inbound.some((m) => m.kind === 'reply'),
        5_000,
      );
      const reply = happyPath.collector.inbound.find((m) => m.kind === 'reply')!;
      if (reply.kind !== 'reply') throw new Error('not a reply');
      const response = reply.response as { text?: string; sequence?: number };
      if (response.sequence !== N) {
        throw new Error(`expected the server to have counted ${N} chunks, got ${response.sequence}`);
      }
      if (response.text !== `client-${N - 1}`) {
        throw new Error(`expected text=client-${N - 1}, got ${response.text}`);
      }
    } finally {
      happyPath.ref.stop();
    }

    const forged = spawnCollector(context);
    try {
      const handle = await openStream(
        client, forged.ref as ActorRef<unknown>, forged.collector,
      );

      client.tell({ kind: 'clientStreamSend', handle, chunk: { text: 'legitimate' } });
      // Right stream, wrong capability — must be dropped, not written.
      client.tell({
        kind: 'clientStreamSend',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
        chunk: { text: 'forged' },
      });
      client.tell({ kind: 'clientStreamClose', handle });

      await waitFor('forged-handle reply observed',
        () => forged.collector.inbound.some((m) => m.kind === 'reply'),
        5_000,
      );
      const reply = forged.collector.inbound.find((m) => m.kind === 'reply')!;
      if (reply.kind !== 'reply') throw new Error('not a reply');
      const response = reply.response as { text?: string; sequence?: number };
      if (response.sequence !== 1) {
        throw new Error(`forged handle reached the stream: server counted ${response.sequence} chunks, expected 1`);
      }
    } finally {
      forged.ref.stop();
    }
  },
};
