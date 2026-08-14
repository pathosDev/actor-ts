/**
 * Request metadata (#611) — a handler is handed the client's real
 * headers, not an empty record.
 *
 * This is the only place the extraction meets a *real* grpc-js
 * `Metadata` object, which is why it is worth a live scenario at all.
 * The unit suite drives `extractMetadata` through a fake whose `getMap`
 * this repository writes, so it proves the filtering and the
 * null-prototype record and nothing whatsoever about grpc-js: were the
 * real `Metadata` to lack `getMap`, every call would silently go back to
 * `{}` — the defect itself, restored, with the unit suite still green.
 * Same class of blind spot as the one 05-deadline exists for.
 *
 * The assertion rides on what grpc-js attaches by itself.
 * `GrpcClientActor` has no surface for sending custom request headers
 * yet, so a scenario cannot put a header of its own on the wire; every
 * gRPC implementation announces itself in `user-agent`, and grpc-js is
 * no exception.
 */
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { GrpcClientCommand } from '../../../../../src/io/broker/GrpcClientActor.js';
import { METADATA_REQUEST_TEXT, spawnCollector, type GrpcContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

/** Sent on every call grpc-js makes, as `grpc-node-js/<version>`. */
const ALWAYS_SENT_HEADER = 'user-agent';

export const scenario: BrokerScenario<GrpcContext> = {
  name: 'request metadata — the handler sees the real client headers',
  async run(context) {
    const { ref: collectorRef, collector } = spawnCollector(context);
    try {
      const client = context.client as unknown as ActorRef<GrpcClientCommand>;
      // The handler answers this one with the header names it saw,
      // comma-separated, and their count in `sequence`.
      client.tell({
        kind: 'unary',
        method: 'Unary',
        request: { text: METADATA_REQUEST_TEXT },
        target: collectorRef as ActorRef<unknown>,
      });

      await waitFor('the handler answered',
        () => collector.inbound.some((m) => m.kind === 'reply'),
        5_000,
      );
      const reply = collector.inbound.find((m) => m.kind === 'reply');
      if (!reply || reply.kind !== 'reply') throw new Error('not a reply');
      const response = reply.response as { text?: string; sequence?: number };
      const names = (response.text ?? '').split(',').filter((name) => name.length > 0);

      // The stub answered `{}` for every call on every call class, so an
      // empty record here means the fix never reached the live path.
      if (names.length === 0) {
        throw new Error('the handler saw no request headers at all — extractMetadata is back to a stub');
      }
      if (!names.includes(ALWAYS_SENT_HEADER)) {
        throw new Error(`expected a '${ALWAYS_SENT_HEADER}' header, saw: ${names.join(', ')}`);
      }
    } finally {
      collectorRef.stop();
    }
  },
};
