/**
 * Per-call deadline (#577) — a unary call the server never answers
 * fails with `DEADLINE_EXCEEDED` instead of hanging forever.
 *
 * This is the only place the deadline meets the *real* grpc-js
 * argument parser, which is why it is worth a live scenario at all.
 * A generated client reads `method(request, [metadata], [options],
 * callback)` positionally: an options object handed to the metadata
 * slot compiles, type-checks and is silently ignored — the same class
 * of bug as the one #577 fixes, and one a fake client in the unit
 * suite cannot see, because there the shim's own signature defines the
 * slots.
 *
 * The scenario spawns its own client: the shared one runs on the
 * default 30 s deadline, and waiting that out would dominate the
 * suite's runtime.
 */
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { GrpcClientActor } from '../../../../../src/io/broker/GrpcClientActor.js';
import type { GrpcClientCommand } from '../../../../../src/io/broker/GrpcClientActor.js';
import { GrpcClientOptions } from '../../../../../src/io/broker/GrpcClientOptions.js';
import { HANG_REQUEST_TEXT, spawnCollector, type GrpcContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

/** Short enough to keep the scenario quick, long enough to outlive the connect. */
const DEADLINE_MS = 1_000;

export const scenario: BrokerScenario<GrpcContext> = {
  name: 'unary deadline — an unanswered call fails with DEADLINE_EXCEEDED',
  async run(context) {
    const protoPath = context.env.GRPC_PROTO_PATH;
    if (!protoPath) throw new Error('05-deadline: missing env var GRPC_PROTO_PATH');

    const clientOptions = GrpcClientOptions.create()
      .withProtoPath(protoPath)
      .withPackageName('echo.v1')
      .withServiceName('EchoService')
      .withEndpoint(context.endpoint)
      .withCredentials({ kind: 'insecure' })
      .withDeadlineMs(DEADLINE_MS);
    const shortDeadlineClient = context.system.spawnAnonymous(() => new GrpcClientActor(clientOptions));
    // Not a correctness gate — an early command is buffered until the
    // connection is up — just keeps the deadline window off the connect.
    await new Promise((r) => setTimeout(r, 500));

    const { ref: collectorRef, collector } = spawnCollector(context);
    try {
      const client = shortDeadlineClient as unknown as ActorRef<GrpcClientCommand>;
      client.tell({
        kind: 'unary',
        method: 'Unary',
        request: { text: HANG_REQUEST_TEXT },
        target: collectorRef as ActorRef<unknown>,
      });

      await waitFor('the unanswered call failed',
        () => collector.inbound.some((m) => m.kind === 'rpc-error'),
        5_000,
      );
      const failure = collector.inbound.find((m) => m.kind === 'rpc-error');
      if (!failure || failure.kind !== 'rpc-error') throw new Error('not an rpc-error');
      if (!/DEADLINE_EXCEEDED/i.test(failure.error.message)) {
        throw new Error(`expected DEADLINE_EXCEEDED, got: ${failure.error.message}`);
      }
      if (collector.inbound.some((m) => m.kind === 'reply')) {
        throw new Error('the hang request was answered — the server-side hang did not take');
      }
    } finally {
      collectorRef.stop();
      shortDeadlineClient.stop();
    }
  },
};
