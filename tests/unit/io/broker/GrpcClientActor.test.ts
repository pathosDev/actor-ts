/**
 * Unit tests for `GrpcClientActor` (#577, #1040).
 *
 * `@grpc/grpc-js` and `@grpc/proto-loader` are optional peer deps that
 * the unit suite does not install — they exist only inside the
 * Dockerized broker-integration image — so everything this actor does
 * *at* a call site used to be unobservable here: the service client was
 * a private field written only by `connectImplementation`, and reaching
 * it meant loading both modules.
 *
 * `createServiceClient` (#1040) is the seam that removes that: the same
 * shape as `JetStreamActor.createNatsConnection`, overridden below by a
 * subclass that hands back a pure-JS fake.  Two properties become
 * assertable through it:
 *
 *   - #577 — a unary call actually carries the configured `deadlineMs`
 *     to grpc-js.  It was declared, builder-exposed, HOCON-read and
 *     validated, and then dropped on the floor.
 *   - #1040 — the client-stream registry is keyed by the handle's
 *     token, so the map lookup *is* the ownership check.  The
 *     counter-check recorded on the issue (re-key the map by
 *     `String(streamId)` and watch the suite stay green) fails against
 *     the last two tests here.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { GrpcClientActor } from '../../../../src/io/broker/GrpcClientActor.js';
import type {
  GrpcCallOptions,
  GrpcClientCommand,
  GrpcInbound,
  GrpcServiceClient,
  GrpcStreamHandle,
} from '../../../../src/io/broker/GrpcClientActor.js';
import {
  GrpcClientOptions,
  type GrpcClientOptionsBuilder,
} from '../../../../src/io/broker/GrpcClientOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* ------------------------------- Fakes -------------------------------- */

type RecordedUnaryCall = {
  readonly request: unknown;
  readonly options: GrpcCallOptions;
  readonly callback: (error: Error | null, response: unknown) => void;
};

/** Recording stand-in for grpc-js's `ClientWritableStream`. */
class FakeWritableCall {
  readonly writes: unknown[] = [];
  ended = false;

  write(chunk: unknown): void { this.writes.push(chunk); }
  end(): void { this.ended = true; }
}

type RecordedClientStreamCall = {
  readonly call: FakeWritableCall;
  readonly callback: (error: Error | null, response: unknown) => void;
};

/**
 * Fake service client.
 *
 * The method properties are what a proto-loaded client exposes; the
 * actor reaches them by name and invokes them with `Function.call`, so
 * their *arity* is part of what these tests pin — an options object
 * squeezed in front of the callback has to arrive in the options slot,
 * not the callback's.
 */
class FakeServiceClient {
  [method: string]: unknown;

  readonly unaryCalls: RecordedUnaryCall[] = [];
  readonly clientStreamCalls: RecordedClientStreamCall[] = [];
  closeCount = 0;

  close = (): void => { this.closeCount++; };

  Echo = (
    request: unknown,
    options: GrpcCallOptions,
    callback: (error: Error | null, response: unknown) => void,
  ): void => {
    this.unaryCalls.push({ request, options, callback });
  };

  ReportReadings = (
    callback: (error: Error | null, response: unknown) => void,
  ): FakeWritableCall => {
    const call = new FakeWritableCall();
    this.clientStreamCalls.push({ call, callback });
    return call;
  };
}

/** The seam under test: a client with no `@grpc/*` module behind it. */
class FakeGrpcClientActor extends GrpcClientActor {
  readonly fakeClient = new FakeServiceClient();
  /** Bumped by the hook — the strongest "the transport is up" signal a fake has. */
  clientCreations = 0;

  protected override async createServiceClient(): Promise<GrpcServiceClient> {
    this.clientCreations++;
    return this.fakeClient;
  }
}

class CollectingTarget extends Actor<GrpcInbound> {
  readonly received: GrpcInbound[] = [];
  override onReceive(message: GrpcInbound): void { this.received.push(message); }
}

/* ------------------------------ Harness ------------------------------- */

type Harness = {
  readonly clientRef: ActorRef<GrpcClientCommand>;
  readonly actor: FakeGrpcClientActor;
  readonly target: CollectingTarget;
  readonly targetRef: ActorRef<unknown>;
};

function newSystem(name: string, config?: ConfigObject): ActorSystem {
  let systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) systemOptions = systemOptions.withConfig(config);
  return ActorSystem.create(name, systemOptions);
}

const baseOptions = (): GrpcClientOptionsBuilder => GrpcClientOptions.create()
  .withProtoPath('./fake.proto')
  .withPackageName('fake.v1')
  .withServiceName('FakeService')
  .withEndpoint('fake-host:50051');

async function boot(system: ActorSystem, options: GrpcClientOptionsBuilder): Promise<Harness> {
  const target = new CollectingTarget();
  const targetRef = system.spawn(() => target, 'target') as ActorRef<unknown>;
  const held = { current: null as FakeGrpcClientActor | null };
  const clientRef = system.spawn(() => {
    const created = new FakeGrpcClientActor(options);
    held.current = created;
    return created;
  }, 'grpc-client') as ActorRef<GrpcClientCommand>;
  await awaitCondition(() => (held.current?.clientCreations ?? 0) > 0, {
    label: 'GrpcClientActor built its service client',
  });
  return { clientRef, actor: held.current!, target, targetRef };
}

/** The handle the actor published for the client stream it just opened. */
function publishedHandle(target: CollectingTarget): GrpcStreamHandle {
  const frames = target.received.filter((frame) => frame.kind === 'stream-started');
  const last = frames[frames.length - 1];
  if (!last || last.kind !== 'stream-started') throw new Error('no stream-started frame yet');
  return last.handle;
}

/* ============================== #577 ================================== */

describe('GrpcClientActor — per-call deadline', () => {
  test('a unary call carries a deadline derived from deadlineMs', async () => {
    const system = newSystem('grpc-deadline-explicit');
    try {
      const options = baseOptions().withDeadlineMs(5_000);
      const { clientRef, actor, targetRef } = await boot(system, options);
      const before = Date.now();
      clientRef.tell({ kind: 'unary', method: 'Echo', request: { text: 'ping' }, target: targetRef });
      await awaitCondition(() => actor.fakeClient.unaryCalls.length > 0, {
        label: 'the unary call reached the service client',
      });
      const after = Date.now();

      expect(actor.fakeClient.unaryCalls.length).toBe(1);
      const deadline = actor.fakeClient.unaryCalls[0]!.options.deadline;
      expect(deadline).toBeInstanceOf(Date);
      // An absolute instant minted at call time: it has to land inside the
      // window the call itself spanned, offset by the configured duration.
      expect(deadline!.getTime()).toBeGreaterThanOrEqual(before + 5_000);
      expect(deadline!.getTime()).toBeLessThanOrEqual(after + 5_000);
    } finally {
      await system.terminate();
    }
  });

  test('the built-in 30 s default reaches the call when nothing is configured', async () => {
    const system = newSystem('grpc-deadline-default');
    try {
      const { clientRef, actor, targetRef } = await boot(system, baseOptions());
      const before = Date.now();
      clientRef.tell({ kind: 'unary', method: 'Echo', request: { text: 'ping' }, target: targetRef });
      await awaitCondition(() => actor.fakeClient.unaryCalls.length > 0, {
        label: 'the unary call reached the service client',
      });
      const after = Date.now();

      const deadline = actor.fakeClient.unaryCalls[0]!.options.deadline;
      expect(deadline).toBeInstanceOf(Date);
      expect(deadline!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
      expect(deadline!.getTime()).toBeLessThanOrEqual(after + 30_000);
    } finally {
      await system.terminate();
    }
  });

  test('a HOCON deadlineMs reaches the call', async () => {
    const system = newSystem('grpc-deadline-hocon', {
      'actor-ts': { io: { broker: { grpc: { client: { deadlineMs: '2s' } } } } },
    });
    try {
      const { clientRef, actor, targetRef } = await boot(system, baseOptions());
      const before = Date.now();
      clientRef.tell({ kind: 'unary', method: 'Echo', request: { text: 'ping' }, target: targetRef });
      await awaitCondition(() => actor.fakeClient.unaryCalls.length > 0, {
        label: 'the unary call reached the service client',
      });
      const after = Date.now();

      const deadline = actor.fakeClient.unaryCalls[0]!.options.deadline;
      expect(deadline!.getTime()).toBeGreaterThanOrEqual(before + 2_000);
      expect(deadline!.getTime()).toBeLessThanOrEqual(after + 2_000);
    } finally {
      await system.terminate();
    }
  });

  test('the options object does not displace the response callback', async () => {
    const system = newSystem('grpc-deadline-arity');
    try {
      const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
      clientRef.tell({ kind: 'unary', method: 'Echo', request: { text: 'ping' }, target: targetRef });
      await awaitCondition(() => actor.fakeClient.unaryCalls.length > 0, {
        label: 'the unary call reached the service client',
      });

      // The fake declares (request, options, callback).  If the actor still
      // passed (request, callback), the callback would have landed in the
      // options slot and this call would throw instead of replying.
      actor.fakeClient.unaryCalls[0]!.callback(null, { text: 'pong' });
      await awaitCondition(() => target.received.some((frame) => frame.kind === 'reply'), {
        label: 'the unary reply reached the target actor',
      });
      const reply = target.received.find((frame) => frame.kind === 'reply');
      expect(reply?.kind === 'reply' ? reply.response : null).toEqual({ text: 'pong' });
    } finally {
      await system.terminate();
    }
  });
});

/* ============================== #1040 ================================= */

describe('GrpcClientActor — client-stream handle ownership', () => {
  test('a forged token does not reach the stream', async () => {
    const system = newSystem('grpc-forged-token');
    try {
      const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 0, {
        label: 'the client stream was opened',
      });
      const handle = publishedHandle(target);
      const call = actor.fakeClient.clientStreamCalls[0]!.call;

      // Right stream id, wrong token — the id alone must buy nothing.
      clientRef.tell({
        kind: 'clientStreamSend',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
        chunk: { value: 'forged' },
      });
      // A legitimate write behind it: same mailbox, so once this one has
      // landed the forged one has already been through the dispatcher.
      clientRef.tell({ kind: 'clientStreamSend', handle, chunk: { value: 'owned' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the legitimate chunk was written to the stream',
      });

      expect(call.writes).toEqual([{ value: 'owned' }]);
    } finally {
      await system.terminate();
    }
  });

  test('a forged token does not close the stream', async () => {
    const system = newSystem('grpc-forged-close');
    try {
      const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 0, {
        label: 'the client stream was opened',
      });
      const handle = publishedHandle(target);
      const call = actor.fakeClient.clientStreamCalls[0]!.call;

      clientRef.tell({
        kind: 'clientStreamClose',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
      });
      clientRef.tell({ kind: 'clientStreamSend', handle, chunk: { value: 'still open' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the chunk after the forged close was written',
      });
      expect(call.ended).toBe(false);

      clientRef.tell({ kind: 'clientStreamClose', handle });
      await awaitCondition(() => call.ended, { label: 'the owner closed the stream' });
    } finally {
      await system.terminate();
    }
  });

  test('the token, not the stream id, selects the stream', async () => {
    const system = newSystem('grpc-token-selects');
    try {
      const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 0, {
        label: 'the first client stream was opened',
      });
      const first = publishedHandle(target);
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 1, {
        label: 'the second client stream was opened',
      });
      const second = publishedHandle(target);
      expect(second.streamId).not.toBe(first.streamId);
      expect(second.token).not.toBe(first.token);

      // The first stream's token paired with the second stream's id: a
      // registry keyed by the id would route this into the second stream.
      clientRef.tell({
        kind: 'clientStreamSend',
        handle: { streamId: second.streamId, token: first.token },
        chunk: { value: 'follows the token' },
      });
      const firstCall = actor.fakeClient.clientStreamCalls[0]!.call;
      const secondCall = actor.fakeClient.clientStreamCalls[1]!.call;
      await awaitCondition(() => firstCall.writes.length > 0, {
        label: 'the chunk was written to the stream that owns the token',
      });

      expect(firstCall.writes).toEqual([{ value: 'follows the token' }]);
      expect(secondCall.writes).toEqual([]);
    } finally {
      await system.terminate();
    }
  });
});
