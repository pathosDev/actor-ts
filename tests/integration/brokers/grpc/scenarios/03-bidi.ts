/**
 * Bidirectional stream — client sends N chunks, server echoes each
 * back, client closes.  Verifies the `stream-started` handshake, the
 * handle-addressed sends, and the stream-end signal in the framework's
 * bidi flow.
 *
 * The second half is the security half, and it is the same one
 * `04-client-stream.ts` runs: a handle with the right stream id but a
 * forged token must not reach the stream.  Bidi echoes, so the check
 * reads off the echo — a forged chunk that was written comes back.
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
  client.tell({ kind: 'bidiStart', method: 'Bidi', target: collectorRef });
  await waitFor('bidi handle received',
    () => collector.inbound.some((m) => m.kind === 'stream-started'),
    5_000,
  );
  const started = collector.inbound.find((m) => m.kind === 'stream-started')!;
  if (started.kind !== 'stream-started') throw new Error('not a stream-started frame');
  return started.handle;
}

export const scenario: BrokerScenario<GrpcContext> = {
  name: 'bidi — client sends N, server echoes N, client closes',
  async run(context) {
    const client = context.client as unknown as ActorRef<GrpcClientCommand>;

    const happyPath = spawnCollector(context);
    try {
      const handle = await openStream(
        client, happyPath.ref as ActorRef<unknown>, happyPath.collector,
      );

      const N = 4;
      for (let i = 0; i < N; i++) {
        client.tell({ kind: 'bidiSend', handle, chunk: { text: `bidi-${i}` } });
      }
      client.tell({ kind: 'bidiClose', handle });

      await waitFor('bidi stream-end observed',
        () => happyPath.collector.inbound.some((m) => m.kind === 'stream-end'),
        5_000,
      );
      // Every `stream-data` frame on this collector is an echoed chunk:
      // the handshake no longer rides in as one, so there is nothing to
      // filter out.
      const data = happyPath.collector.inbound.filter((m) => m.kind === 'stream-data');
      if (data.length !== N) {
        throw new Error(`expected ${N} echoed chunks, got ${data.length}`);
      }
      if (data.some((m) => m.kind === 'stream-data' && m.streamId !== handle.streamId)) {
        throw new Error('an echoed chunk carried a stream id the handle does not name');
      }
    } finally {
      happyPath.ref.stop();
    }

    const forged = spawnCollector(context);
    try {
      const handle = await openStream(
        client, forged.ref as ActorRef<unknown>, forged.collector,
      );

      client.tell({ kind: 'bidiSend', handle, chunk: { text: 'legitimate' } });
      // Right stream, wrong capability — must be dropped, not written.
      client.tell({
        kind: 'bidiSend',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
        chunk: { text: 'forged' },
      });
      client.tell({ kind: 'bidiClose', handle });

      await waitFor('bidi stream-end after the forged send',
        () => forged.collector.inbound.some((m) => m.kind === 'stream-end'),
        5_000,
      );
      const echoed = forged.collector.inbound.filter((m) => m.kind === 'stream-data');
      if (echoed.length !== 1) {
        throw new Error(`forged handle reached the stream: server echoed ${echoed.length} chunks, expected 1`);
      }
    } finally {
      forged.ref.stop();
    }
  },
};
