/**
 * Unit tests for `GrpcClientActor` (#577, #1040, #788).
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
 * subclass that hands back a pure-JS fake.  Three properties become
 * assertable through it:
 *
 *   - #577 — a unary call actually carries the configured `deadlineMs`
 *     to grpc-js.  It was declared, builder-exposed, HOCON-read and
 *     validated, and then dropped on the floor.
 *   - #1040 — the client-stream registry is keyed by the handle's
 *     token, so the map lookup *is* the ownership check.  The
 *     counter-check recorded on the issue (re-key the map by
 *     `String(streamId)` and watch the suite stay green) fails against
 *     the last two tests of that block.
 *   - #788 — the bidi class now shares both primitives: the handshake
 *     is a `'stream-started'` frame rather than a `'stream-data'` chunk
 *     carrying `{ __streamId }`, and the send/close registry is keyed
 *     by token.  Before this, *no* bidi path was exercised by
 *     `bun test` at all.
 *   - the repair of #788's own regression — keying the registry on the
 *     token turned `command.handle.token` into a *read* the four
 *     send/close paths perform before anything else, and nothing had
 *     ever checked that a handle is there to read.  The last block
 *     below is that: a malformed command must not be answered as a
 *     lost connection.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { GrpcClientActor } from '../../../../src/io/broker/GrpcClientActor.js';
import type {
  GrpcCallOptions,
  GrpcClientCommand,
  GrpcCredentialsLike,
  GrpcInbound,
  GrpcServiceClient,
  GrpcServiceConstructor,
  GrpcStreamHandle,
  RpcErrorMessage,
  StreamErrorMessage,
} from '../../../../src/io/broker/GrpcClientActor.js';
import {
  DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS,
  GrpcClientOptions,
  type GrpcChannelOptions,
  type GrpcClientOptionsBuilder,
} from '../../../../src/io/broker/GrpcClientOptions.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
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
  cancelled = 0;

  write(chunk: unknown): void { this.writes.push(chunk); }
  end(): void { this.ended = true; }
  cancel(): void { this.cancelled++; }
}

type RecordedClientStreamCall = {
  readonly call: FakeWritableCall;
  readonly callback: (error: Error | null, response: unknown) => void;
};

/**
 * Recording stand-in for grpc-js's `ClientDuplexStream`.
 *
 * `pushData` / `pushEnd` / `pushError` are the *server's* half — they let
 * a test drive an inbound chunk, which is the only way to show that a
 * server message cannot be mistaken for the handshake now that the
 * handshake has its own frame, and the only way to drive a stream to
 * completion at all.
 */
class FakeDuplexCall {
  readonly writes: unknown[] = [];
  ended = false;
  private readonly dataListeners: Array<(chunk: unknown) => void> = [];
  private readonly endListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  on(event: 'data' | 'end' | 'error', listener: (chunk: never) => void): void {
    if (event === 'data') this.dataListeners.push(listener as (chunk: unknown) => void);
    else if (event === 'end') this.endListeners.push(listener as () => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }

  write(chunk: unknown): void { this.writes.push(chunk); }
  end(): void { this.ended = true; }
  /** Counted, not latched: an idle reap must cancel a call exactly once. */
  cancelled = 0;
  cancel(): void { this.cancelled++; }

  pushData(chunk: unknown): void { for (const listener of this.dataListeners) listener(chunk); }
  pushEnd(): void { for (const listener of this.endListeners) listener(); }
  pushError(error: Error): void { for (const listener of this.errorListeners) listener(error); }
}

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
  readonly bidiCalls: FakeDuplexCall[] = [];
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

  Chat = (): FakeDuplexCall => {
    const call = new FakeDuplexCall();
    this.bidiCalls.push(call);
    return call;
  };

  /** Server-streaming: grpc-js hands back a readable call, which the duplex fake covers. */
  readonly serverStreamCalls: FakeDuplexCall[] = [];
  Watch = (_request: unknown): FakeDuplexCall => {
    const call = new FakeDuplexCall();
    this.serverStreamCalls.push(call);
    return call;
  };
}

/** One `new ServiceConstructor(...)` the actor performed. */
type RecordedConstruction = {
  readonly endpoint: string;
  readonly channelOptions: GrpcChannelOptions | undefined;
};

/** The seam under test: a client with no `@grpc/*` module behind it. */
class FakeGrpcClientActor extends GrpcClientActor {
  readonly fakeClient = new FakeServiceClient();
  /** Bumped by the hook — the strongest "the transport is up" signal a fake has. */
  clientCreations = 0;
  /**
   * What the production `instantiateServiceClient` handed grpc-js's
   * constructor.  The channel options (#790) live in its third slot and
   * nowhere else — they are not per-call options, so no other assertion
   * in this file could see them.
   */
  readonly constructions: RecordedConstruction[] = [];

  protected override async createServiceClient(): Promise<GrpcServiceClient> {
    this.clientCreations++;
    // Drive the *production* hook with a recording constructor rather than
    // reimplementing it.  That one line is what hands grpc-js the
    // endpoint, the credentials and the channel options, and it is the
    // only part of `createServiceClient` that needs neither `@grpc/*`
    // module — which is why it is a hook at all.
    const recorded = this.constructions;
    class RecordingServiceConstructor {
      constructor(
        endpoint: string,
        _credentials: GrpcCredentialsLike,
        channelOptions?: GrpcChannelOptions,
      ) {
        recorded.push({ endpoint, channelOptions });
      }
    }
    this.instantiateServiceClient(
      RecordingServiceConstructor as unknown as GrpcServiceConstructor,
      {},
    );
    return this.fakeClient;
  }

  /**
   * `BrokerActor.connectionState` is protected, and it is the *earliest*
   * observable consequence of a throw escaping `dispatchOutgoing`:
   * `_dispatchOne` catches, and `handleConnectionLost` flips the state
   * before it schedules anything.  Waiting on a reconnect instead would
   * race the message that provoked it.
   */
  publicConnectionState(): string { return this.connectionState; }

  /**
   * Ditto `outboundBufferSize`.  A throw out of `dispatchOutgoing` also
   * *unshifts* the offending envelope back at the head of this buffer, so
   * a non-zero size after the pipeline has settled is the re-dispatch loop
   * itself, not a symptom of it.
   */
  publicOutboundBufferSize(): number { return this.outboundBufferSize; }
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

function newSystem(name: string, config?: ConfigObject, scheduler?: ManualScheduler): ActorSystem {
  let systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) systemOptions = systemOptions.withConfig(config);
  if (scheduler) systemOptions = systemOptions.withScheduler(scheduler);
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

/**
 * Collect every `DeadLetter` the system publishes, and resolve only once
 * the collector is genuinely on the stream.
 *
 * Subscribing without waiting is a race the assertions below cannot
 * survive: the publication under test happens a millisecond after the
 * `tell` that triggers it, and a subscriber that arrives second sees
 * nothing at all.
 */
async function captureDeadLetters(system: ActorSystem): Promise<DeadLetter[]> {
  const captured: DeadLetter[] = [];
  const subscribed = { value: false };
  class DeadLetterCollector extends Actor<DeadLetter> {
    override preStart(): void {
      this.system.eventStream.subscribe(this.self, DeadLetter);
      subscribed.value = true;
    }
    override onReceive(letter: DeadLetter): void { captured.push(letter); }
  }
  system.spawn(DeadLetterCollector, 'dead-letter-collector');
  await awaitCondition(() => subscribed.value, {
    label: 'the dead-letter collector subscribed to the event stream',
  });
  return captured;
}

/**
 * The handle the actor published for the caller-driven stream it just
 * opened.  Client-stream and bidi share the frame, so this reads both.
 */
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

  test('a HOCON deadline reaches the call', async () => {
    const system = newSystem('grpc-deadline-hocon', {
      'actor-ts': { io: { broker: { grpc: { client: { deadline: '2s' } } } } },
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

/* ============================== #790 ================================== */

describe('GrpcClientActor — channel options', () => {
  test('withChannelOptions reaches grpc-js in the third constructor slot', async () => {
    const system = newSystem('grpc-channel-options');
    try {
      const channelOptions = {
        'grpc.keepalive_time_ms': 20_000,
        'grpc.keepalive_permit_without_calls': 1,
        'grpc.max_receive_message_length': 1_048_576,
      };
      const options = baseOptions().withChannelOptions(channelOptions);
      const { actor } = await boot(system, options);

      expect(actor.constructions.length).toBe(1);
      // The third slot, not the second: credentials sit between the
      // endpoint and the channel arguments, and grpc-js reads them
      // positionally.
      expect(actor.constructions[0]!.endpoint).toBe('fake-host:50051');
      expect(actor.constructions[0]!.channelOptions).toEqual(channelOptions);
    } finally {
      await system.terminate();
    }
  });

  test('the argument stays undefined when nothing is configured', async () => {
    const system = newSystem('grpc-channel-options-unset');
    try {
      const { actor } = await boot(system, baseOptions());

      // Not `{}`: an empty object is a real argument, and which grpc-js
      // defaults survive one is a per-release question this framework has
      // no business answering.
      expect(actor.constructions[0]!.channelOptions).toBeUndefined();
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

/* =============================== #788 ================================= */

/** Boot a system, open one bidi stream, and hand back everything it needs. */
async function openBidiStream(name: string): Promise<{
  system: ActorSystem;
  clientRef: ActorRef<GrpcClientCommand>;
  actor: FakeGrpcClientActor;
  target: CollectingTarget;
  targetRef: ActorRef<unknown>;
  handle: GrpcStreamHandle;
  call: FakeDuplexCall;
}> {
  const system = newSystem(name);
  const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
  clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: targetRef });
  await awaitCondition(() => actor.fakeClient.bidiCalls.length > 0, {
    label: 'the bidi stream was opened',
  });
  await awaitCondition(() => target.received.some((frame) => frame.kind === 'stream-started'), {
    label: 'the bidi handshake reached the target actor',
  });
  return {
    system, clientRef, actor, target, targetRef,
    handle: publishedHandle(target),
    call: actor.fakeClient.bidiCalls[0]!,
  };
}

describe('GrpcClientActor — bidi handshake', () => {
  test('the handle arrives out of band, not as a stream chunk', async () => {
    const opened = await openBidiStream('grpc-bidi-handshake');
    try {
      const { target, handle, call } = opened;

      // The handshake is its own frame, and it is the *only* frame the
      // stream has produced: the in-band `{ __streamId }` chunk is gone.
      expect(target.received.filter((frame) => frame.kind === 'stream-started').length).toBe(1);
      expect(target.received.filter((frame) => frame.kind === 'stream-data')).toEqual([]);
      expect(typeof handle.streamId).toBe('number');
      expect(handle.token).toMatch(/^[0-9a-f]{16}$/);

      // A server message shaped exactly like the old handshake is just
      // payload now — it arrives as data, and the framework's own
      // `streamId` on the envelope is the one that is authoritative.
      call.pushData({ __streamId: 9_999 });
      await awaitCondition(() => target.received.some((frame) => frame.kind === 'stream-data'), {
        label: 'the server chunk reached the target actor',
      });
      const chunks = target.received.filter((frame) => frame.kind === 'stream-data');
      expect(chunks.length).toBe(1);
      const first = chunks[0]!;
      expect(first.kind === 'stream-data' ? first.streamId : null).toBe(handle.streamId);
    } finally {
      await opened.system.terminate();
    }
  });
});

describe('GrpcClientActor — bidi handle ownership', () => {
  test('a forged token does not reach the stream', async () => {
    const opened = await openBidiStream('grpc-bidi-forged-token');
    try {
      const { clientRef, handle, call } = opened;

      // Right stream id, wrong token — the id alone must buy nothing.
      clientRef.tell({
        kind: 'bidiSend',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
        chunk: { text: 'forged' },
      });
      // A legitimate write behind it: same mailbox, so once this one has
      // landed the forged one has already been through the dispatcher.
      clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'owned' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the legitimate chunk was written to the bidi stream',
      });

      expect(call.writes).toEqual([{ text: 'owned' }]);
    } finally {
      await opened.system.terminate();
    }
  });

  test('a forged token does not close the stream', async () => {
    const opened = await openBidiStream('grpc-bidi-forged-close');
    try {
      const { clientRef, handle, call } = opened;

      clientRef.tell({
        kind: 'bidiClose',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
      });
      clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'still open' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the chunk after the forged close was written',
      });
      expect(call.ended).toBe(false);

      clientRef.tell({ kind: 'bidiClose', handle });
      await awaitCondition(() => call.ended, { label: 'the owner closed the bidi stream' });
    } finally {
      await opened.system.terminate();
    }
  });

  test('the token, not the stream id, selects the stream', async () => {
    const opened = await openBidiStream('grpc-bidi-token-selects');
    try {
      const { clientRef, actor, target, targetRef, handle: first } = opened;

      clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: targetRef });
      await awaitCondition(() => actor.fakeClient.bidiCalls.length > 1, {
        label: 'the second bidi stream was opened',
      });
      const second = publishedHandle(target);
      expect(second.streamId).not.toBe(first.streamId);
      expect(second.token).not.toBe(first.token);

      // The first stream's token paired with the second stream's id: a
      // registry keyed by the id would route this into the second stream.
      clientRef.tell({
        kind: 'bidiSend',
        handle: { streamId: second.streamId, token: first.token },
        chunk: { text: 'follows the token' },
      });
      const firstCall = actor.fakeClient.bidiCalls[0]!;
      const secondCall = actor.fakeClient.bidiCalls[1]!;
      await awaitCondition(() => firstCall.writes.length > 0, {
        label: 'the chunk was written to the bidi stream that owns the token',
      });

      expect(firstCall.writes).toEqual([{ text: 'follows the token' }]);
      expect(secondCall.writes).toEqual([]);
    } finally {
      await opened.system.terminate();
    }
  });
});

/**
 * A finished stream leaves the registry.
 *
 * Both eviction calls — the one in the `'end'` listener and the one in
 * `'error'` — could be deleted with all 13 tests here green, because no test
 * drove a bidi stream to completion at all: `FakeDuplexCall.pushEnd` existed
 * and nothing called it, and there was no `pushError` to call.
 *
 * Two things go wrong without them, and the second is the one that matters.
 * A long-lived client leaks one map entry per finished stream, which is a
 * slow unbounded growth on the actor that opens the most of them.  And the
 * token stays *live*: a `bidiSend` after the stream has ended still finds its
 * entry and writes into a call grpc-js has already finished with, so a handle
 * whose stream is over goes on being honoured instead of missing the map the
 * way a forged one does.  The registry is the ownership check, and an entry
 * that outlives its stream is an ownership check answering for something that
 * no longer exists.
 *
 * Read through the same fence the ownership tests use: a second stream is
 * opened, and a write to *it* landing proves the earlier write to the ended
 * handle has already been through the dispatcher.  Asserting an absence needs
 * that ordering, or it is a race that usually passes.
 */
describe('GrpcClientActor — a finished bidi stream leaves the registry (#788)', () => {
  /** Drives `first` to completion via `finish`, then writes to its handle. */
  async function writeAfterCompletion(
    name: string,
    finish: (call: FakeDuplexCall) => void,
    endedFrame: 'stream-end' | 'stream-error',
  ): Promise<{ endedCall: FakeDuplexCall; liveCall: FakeDuplexCall; system: ActorSystem }> {
    const opened = await openBidiStream(name);
    const { clientRef, actor, target, targetRef, handle, call } = opened;

    finish(call);
    await awaitCondition(() => target.received.some((frame) => frame.kind === endedFrame), {
      label: `the ${endedFrame} frame reached the target actor`,
    });

    // A second stream, whose write is the fence.
    clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: targetRef });
    await awaitCondition(() => actor.fakeClient.bidiCalls.length > 1, {
      label: 'the second bidi stream was opened',
    });
    const live = publishedHandle(target);

    clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'after the stream finished' } });
    clientRef.tell({ kind: 'bidiSend', handle: live, chunk: { text: 'fence' } });
    const liveCall = actor.fakeClient.bidiCalls[1]!;
    await awaitCondition(() => liveCall.writes.length > 0, {
      label: 'the fence chunk was written to the still-open stream',
    });
    return { endedCall: call, liveCall, system: opened.system };
  }

  test('a send on a stream that ended is a miss, not a write', async () => {
    const { endedCall, liveCall, system } = await writeAfterCompletion(
      'grpc-bidi-end-evicts',
      (call) => call.pushEnd(),
      'stream-end',
    );
    try {
      expect(endedCall.writes).toEqual([]);
      expect(liveCall.writes).toEqual([{ text: 'fence' }]);
    } finally {
      await system.terminate();
    }
  });

  test('a send on a stream that errored is a miss too', async () => {
    const { endedCall, liveCall, system } = await writeAfterCompletion(
      'grpc-bidi-error-evicts',
      (call) => call.pushError(new Error('stream reset by peer')),
      'stream-error',
    );
    try {
      expect(endedCall.writes).toEqual([]);
      expect(liveCall.writes).toEqual([{ text: 'fence' }]);
    } finally {
      await system.terminate();
    }
  });
});

/* =============================== #1510 ================================ */

/**
 * The own-property names of every live entry in one of the two registries.
 *
 * Read through a cast because both maps are `private`, and that is exactly
 * why this assertion has to exist: the only possible readers of a private
 * field are inside the class, so a field no method there touches is
 * unreachable from every behavioural test in this file.  Both maps carried a
 * copy of the opening command's `target` for seven weeks with all 19 tests
 * green, because nothing read it — `stream.call` is the only read either map
 * has (#1510).
 *
 * The pin is "exactly the fields the code reads", not "no more than N
 * fields": a field added for a reader that genuinely needs it has to update
 * this line in the same commit, which is the point.  It sees own enumerable
 * string keys only, so state parked on a symbol, a `WeakMap` or a closure is
 * outside what it can promise.
 */
function registryEntryFields(
  actor: FakeGrpcClientActor,
  registry: 'bidiStreams' | 'clientStreams',
): string[][] {
  const registries = actor as unknown as Record<string, Map<string, object> | undefined>;
  const map = registries[registry];
  if (!map) throw new Error(`GrpcClientActor has no '${registry}' registry to read`);
  return [...map.values()].map((entry) => Object.keys(entry).sort());
}

describe('GrpcClientActor — the stream registry stores only what it reads (#1510)', () => {
  // `idle` joined `call` with #1222: the send paths read it, a caller write being activity.
  test('a live bidi entry carries the call, its idle deadline and nothing else', async () => {
    const opened = await openBidiStream('grpc-bidi-entry-shape');
    try {
      expect(registryEntryFields(opened.actor, 'bidiStreams')).toEqual([['call', 'idle']]);
    } finally {
      await opened.system.terminate();
    }
  });

  test('a live client-stream entry carries the call, its idle deadline and nothing else', async () => {
    const system = newSystem('grpc-client-stream-entry-shape');
    try {
      const { clientRef, actor, targetRef } = await boot(system, baseOptions());
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 0, {
        label: 'the client stream was opened',
      });

      expect(registryEntryFields(actor, 'clientStreams')).toEqual([['call', 'idle']]);
    } finally {
      await system.terminate();
    }
  });
});

/**
 * An owner-driven close evicts the entry, on both stream kinds.
 *
 * The eviction on `'end'` / `'error'` is pinned above; the eviction on an
 * explicit `bidiClose` / `clientStreamClose` was not, and for the
 * client-stream half that left `onClientStreamClose`'s own stated reason
 * unobserved — it deletes at the close rather than when the response
 * arrives precisely so a `clientStreamSend` racing the close cannot become a
 * write-after-end, which grpc-js throws on.  Deleting either `delete` call
 * kept all 19 tests green.
 *
 * Same fence as the completion block: a write to a *second*, still-open
 * stream landing is what proves the write to the closed handle has already
 * been through the dispatcher.  Asserting an absence without that ordering
 * is a race that usually passes.
 */
describe('GrpcClientActor — an owner close evicts the entry (#1510)', () => {
  test('a bidi send after the owner closed is a miss, not a write', async () => {
    const opened = await openBidiStream('grpc-bidi-owner-close-evicts');
    try {
      const { clientRef, actor, target, targetRef, handle, call } = opened;
      clientRef.tell({ kind: 'bidiClose', handle });
      await awaitCondition(() => call.ended, { label: 'the owner closed the bidi stream' });

      clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: targetRef });
      await awaitCondition(() => actor.fakeClient.bidiCalls.length > 1, {
        label: 'the second bidi stream was opened',
      });
      const live = publishedHandle(target);

      clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'after the owner closed' } });
      clientRef.tell({ kind: 'bidiSend', handle: live, chunk: { text: 'fence' } });
      const liveCall = actor.fakeClient.bidiCalls[1]!;
      await awaitCondition(() => liveCall.writes.length > 0, {
        label: 'the fence chunk was written to the still-open bidi stream',
      });

      expect(call.writes).toEqual([]);
      expect(liveCall.writes).toEqual([{ text: 'fence' }]);
    } finally {
      await opened.system.terminate();
    }
  });

  test('a client-stream send after the owner closed is a miss, not a write-after-end', async () => {
    const system = newSystem('grpc-client-stream-owner-close-evicts');
    try {
      const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 0, {
        label: 'the client stream was opened',
      });
      const handle = publishedHandle(target);
      const call = actor.fakeClient.clientStreamCalls[0]!.call;

      clientRef.tell({ kind: 'clientStreamClose', handle });
      await awaitCondition(() => call.ended, { label: 'the owner closed the client stream' });

      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 1, {
        label: 'the second client stream was opened',
      });
      const live = publishedHandle(target);

      clientRef.tell({ kind: 'clientStreamSend', handle, chunk: { value: 'after the owner closed' } });
      clientRef.tell({ kind: 'clientStreamSend', handle: live, chunk: { value: 'fence' } });
      const liveCall = actor.fakeClient.clientStreamCalls[1]!.call;
      await awaitCondition(() => liveCall.writes.length > 0, {
        label: 'the fence chunk was written to the still-open client stream',
      });

      expect(call.writes).toEqual([]);
      expect(liveCall.writes).toEqual([{ value: 'fence' }]);
    } finally {
      await system.terminate();
    }
  });
});

/* ==================== #788 / #1040 — malformed handle ================== */

/**
 * A malformed send/close must not be answered as a lost connection.
 *
 * This is a regression the token registry introduced.  Keying the maps by
 * `GrpcStreamHandle.token` made `command.handle.token` the *first* thing
 * all four send/close paths do, and nothing checked that a handle is there
 * to read.  The pre-token code looked the stream up by a bare id, so a
 * command with no handle simply missed the map and was the documented
 * no-op.
 *
 * The read throws a `TypeError` inside `dispatchOutgoing`, and
 * `BrokerActor._dispatchOne` reads *any* throw from there as a dropped
 * connection: it unshifts the offending envelope back at the **head** of
 * the outbound buffer and calls `handleConnectionLost`, after which
 * `_drainBuffer` re-dispatches the very same envelope on every reconnect.
 * One malformed `tell` is therefore an unbounded reconnect loop, and the
 * legitimate writes queued behind the poisoned head never leave the
 * buffer.
 *
 * `as never` in these tests is not a test-only trick: it is how *every*
 * caller reaches this actor.  `GrpcClientCommand` is a compile-time claim
 * and `tell` erases it, so a JavaScript caller, a deserialised message and
 * a stale handle arriving as `null` all reach the same read.
 *
 * **Waiting on the reconnect is the trap**, and the first draft of these
 * tests fell into it: the owner's write is dispatched before the rejected
 * promise's catch even runs, and the retry is a scheduled 200 ms away, so
 * "the owner chunk landed and `clientCreations` is still 1" is true of the
 * *broken* tree too.  Every wait below is therefore a disjunction of the
 * two outcomes that are prompt in their own world — the dead letter the
 * fix produces, and the connection state the defect flips — so exactly one
 * disjunct becomes true within microseconds either way and the assertion
 * after it names which.
 */
describe('GrpcClientActor — a malformed stream command', () => {
  /** Both worlds' prompt answer to a malformed command; exactly one arrives. */
  const answered = (actor: FakeGrpcClientActor, deadLetters: DeadLetter[], expected = 1) =>
    (): boolean => deadLetters.length >= expected || actor.publicConnectionState() !== 'connected';

  test('a bidiSend with no handle is not a lost connection', async () => {
    const opened = await openBidiStream('grpc-bidi-malformed-send');
    try {
      const { system, clientRef, actor, handle, call } = opened;
      const deadLetters = await captureDeadLetters(system);
      expect(actor.publicConnectionState()).toBe('connected');

      clientRef.tell({ kind: 'bidiSend', chunk: { text: 'no handle' } } as never);
      await awaitCondition(answered(actor, deadLetters), {
        label: 'the malformed command was answered — as a dead letter, or as a lost connection',
      });

      expect(actor.publicConnectionState()).toBe('connected');
      // Zero is the re-dispatch claim: the defect pushes the offending
      // envelope back at the head, where `_drainBuffer` picks it up again
      // after every reconnect.
      expect(actor.publicOutboundBufferSize()).toBe(0);
      expect(actor.clientCreations).toBe(1);

      // Not silence: nothing `createGrpcStreamHandle` mints can look like
      // this, so a malformed command is a caller defect and gets the
      // framework's standard channel for a message that went nowhere.
      expect(deadLetters.length).toBe(1);
      const letter = deadLetters[0]!.message as { readonly kind?: string; readonly chunk?: unknown };
      expect(letter.kind).toBe('bidiSend');
      expect(letter.chunk).toEqual({ text: 'no handle' });
      expect(deadLetters[0]!.recipient.path.toString()).toContain('grpc-client');

      // And the stream owner's own later write still lands — the pipeline
      // behind the malformed command was never poisoned.
      clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'owned' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the owner chunk was written to the bidi stream',
      });
      expect(call.writes).toEqual([{ text: 'owned' }]);
    } finally {
      await opened.system.terminate();
    }
  });

  test('a bidiClose whose handle is null leaves the stream open', async () => {
    const opened = await openBidiStream('grpc-bidi-malformed-close');
    try {
      const { system, clientRef, actor, handle, call } = opened;
      const deadLetters = await captureDeadLetters(system);

      // The shape a handle takes when it is read back out of a field that
      // was cleared, or out of a serialised message that lost it.
      clientRef.tell({ kind: 'bidiClose', handle: null } as never);
      await awaitCondition(answered(actor, deadLetters), {
        label: 'the malformed close was answered — as a dead letter, or as a lost connection',
      });

      expect(actor.publicConnectionState()).toBe('connected');
      expect(actor.publicOutboundBufferSize()).toBe(0);
      expect(call.ended).toBe(false);

      clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'still open' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the owner chunk was written after the malformed close',
      });
      expect(call.writes).toEqual([{ text: 'still open' }]);
      expect(call.ended).toBe(false);
    } finally {
      await opened.system.terminate();
    }
  });

  test('the client-stream twins carry the same guard', async () => {
    const system = newSystem('grpc-client-stream-malformed');
    try {
      const { clientRef, actor, target, targetRef } = await boot(system, baseOptions());
      const deadLetters = await captureDeadLetters(system);
      clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: targetRef });
      await awaitCondition(() => actor.fakeClient.clientStreamCalls.length > 0, {
        label: 'the client stream was opened',
      });
      const handle = publishedHandle(target);
      const call = actor.fakeClient.clientStreamCalls[0]!.call;

      // Identical shape, from #1040 rather than #788, and identically
      // exposed.  Both malformed shapes, on both paths: an absent handle
      // is the one that *throws* on an unguarded read, and a handle that
      // is not an object is the one that does not — `'x'.token` is a legal
      // `undefined`, so unguarded it is an invisible no-op indistinguishable
      // from a stale token.  That second shape is why silence would have
      // been the wrong answer even where it is not a reconnect loop.
      clientRef.tell({ kind: 'clientStreamSend', chunk: { value: 'no handle' } } as never);
      clientRef.tell({ kind: 'clientStreamClose', handle: null } as never);
      clientRef.tell({ kind: 'clientStreamSend', handle: 'not-an-object', chunk: {} } as never);
      await awaitCondition(answered(actor, deadLetters, 3), {
        label: 'every malformed command was answered — as dead letters, or as a lost connection',
      });

      expect(actor.publicConnectionState()).toBe('connected');
      expect(actor.publicOutboundBufferSize()).toBe(0);
      expect(actor.clientCreations).toBe(1);
      expect(deadLetters.length).toBe(3);
      expect(call.ended).toBe(false);

      clientRef.tell({ kind: 'clientStreamSend', handle, chunk: { value: 'owned' } });
      await awaitCondition(() => call.writes.length > 0, {
        label: 'the owner chunk was written to the client stream',
      });
      expect(call.writes).toEqual([{ value: 'owned' }]);
    } finally {
      await system.terminate();
    }
  });

  test('an unknown token stays a silent no-op — only a malformed command is a letter', async () => {
    const opened = await openBidiStream('grpc-bidi-unknown-token-quiet');
    try {
      const { system, clientRef, actor, handle } = opened;
      const deadLetters = await captureDeadLetters(system);

      // A well-formed handle whose token names no live stream is the
      // documented race — the server closed the stream, or the connection
      // dropped and cleared the map, and the caller has not learned yet.
      // It happens in correct use, so it must stay quiet.
      clientRef.tell({
        kind: 'bidiSend',
        handle: { streamId: handle.streamId, token: 'deadbeefdeadbeef' },
        chunk: { text: 'stale' },
      });
      // Behind it, a genuinely malformed one.  Mailbox order is what makes
      // the negative assertion sound: a letter for the stale command would
      // have been published first, so it would have arrived first.
      clientRef.tell({ kind: 'bidiSend', chunk: { text: 'malformed' } } as never);
      await awaitCondition(answered(actor, deadLetters), {
        label: 'the malformed command was answered — as a dead letter, or as a lost connection',
      });

      expect(actor.publicConnectionState()).toBe('connected');
      expect(deadLetters.length).toBe(1);
      const letter = deadLetters[0]!.message as { readonly chunk?: unknown };
      expect(letter.chunk).toEqual({ text: 'malformed' });
    } finally {
      await opened.system.terminate();
    }
  });
});

/* =============================== #1222 ================================ */

/**
 * A stream whose peer goes quiet is reaped (#1222).
 *
 * Nothing else does it: `disconnectImplementation` runs only on a stop, a
 * shutdown or a lost connection, and a hung peer on a healthy connection
 * triggers none of them, so the call and its closures stayed pinned for the
 * life of the actor.  Each stream now carries an idle deadline — armed when it
 * opens, pushed back by every frame in either direction — that cancels the
 * call, reports one terminal frame and drops the registry entry.
 *
 * Time is a `ManualScheduler`'s, so "five minutes of silence" is an
 * `advance`, not a wait.  The cancel runs inside `advance`; only the frame to
 * the target crosses a mailbox and is awaited.
 */
type IdleHarness = Harness & { readonly system: ActorSystem; readonly scheduler: ManualScheduler };

async function bootIdle(name: string, options: GrpcClientOptionsBuilder, config?: ConfigObject): Promise<IdleHarness> {
  const scheduler = new ManualScheduler();
  const system = newSystem(name, config, scheduler);
  const harness = await boot(system, options);
  return { ...harness, system, scheduler };
}

function terminalFrames(target: CollectingTarget): GrpcInbound[] {
  return target.received.filter((frame) =>
    frame.kind === 'stream-error' || frame.kind === 'stream-end' || frame.kind === 'rpc-error' || frame.kind === 'reply');
}

describe('GrpcClientActor — a silent stream is reaped (#1222)', () => {
  test('a bidi stream that hears nothing for the timeout is cancelled, reported once and evicted', async () => {
    const h = await bootIdle('grpc-idle-bidi', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
      await awaitCondition(() => h.target.received.some((frame) => frame.kind === 'stream-started'), {
        label: 'the bidi handshake reached the target actor',
      });
      const call = h.actor.fakeClient.bidiCalls[0]!;

      h.scheduler.advance(999);
      expect(call.cancelled).toBe(0);
      h.scheduler.advance(1);
      expect(call.cancelled).toBe(1);
      expect(registryEntryFields(h.actor, 'bidiStreams')).toEqual([]);

      await awaitCondition(() => terminalFrames(h.target).length > 0, { label: 'the idle stream-error arrived' });
      // grpc-js answers its own cancel with an error; that one is not reported again.
      call.pushError(new Error('Cancelled on client'));
      call.pushData({ text: 'late' });
      h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.bidiCalls.length > 1, { label: 'a fence stream was opened' });
      await awaitCondition(() => h.target.received.filter((frame) => frame.kind === 'stream-started').length > 1, {
        label: 'the fence handshake reached the target actor',
      });

      const terminal = terminalFrames(h.target);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.kind).toBe('stream-error');
      expect((terminal[0] as StreamErrorMessage).error.message).toContain('idle');
      expect(h.target.received.some((frame) => frame.kind === 'stream-data')).toBe(false);
    } finally {
      await h.system.terminate();
    }
  });

  test('inbound data and the caller\'s own writes both push a bidi deadline back', async () => {
    const h = await bootIdle('grpc-idle-bidi-activity', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
      await awaitCondition(() => h.target.received.some((frame) => frame.kind === 'stream-started'), {
        label: 'the bidi handshake reached the target actor',
      });
      const call = h.actor.fakeClient.bidiCalls[0]!;
      const handle = publishedHandle(h.target);

      h.scheduler.advance(600);
      call.pushData({ text: 'server speaks' });
      h.scheduler.advance(600);
      expect(call.cancelled).toBe(0);

      h.clientRef.tell({ kind: 'bidiSend', handle, chunk: { text: 'caller speaks' } });
      await awaitCondition(() => call.writes.length > 0, { label: 'the caller write reached the call' });
      h.scheduler.advance(600);
      expect(call.cancelled).toBe(0);

      h.scheduler.advance(400);
      expect(call.cancelled).toBe(1);
    } finally {
      await h.system.terminate();
    }
  });

  test('a server stream that goes quiet is cancelled; one that keeps talking is not', async () => {
    const h = await bootIdle('grpc-idle-server-stream', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'serverStream', method: 'Watch', request: {}, target: h.targetRef });
      h.clientRef.tell({ kind: 'serverStream', method: 'Watch', request: {}, target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.serverStreamCalls.length > 1, {
        label: 'both server streams were opened',
      });
      const [quiet, chatty] = h.actor.fakeClient.serverStreamCalls as [FakeDuplexCall, FakeDuplexCall];

      for (let i = 0; i < 4; i++) {
        h.scheduler.advance(400);
        chatty.pushData({ tick: i });
      }
      expect(quiet.cancelled).toBe(1);
      expect(chatty.cancelled).toBe(0);

      await awaitCondition(() => terminalFrames(h.target).length > 0, { label: 'the idle stream-error arrived' });
      quiet.pushEnd();
      chatty.pushEnd();
      await awaitCondition(() => terminalFrames(h.target).length > 1, { label: 'the chatty stream ended' });
      expect(terminalFrames(h.target).map((frame) => frame.kind)).toEqual(['stream-error', 'stream-end']);
    } finally {
      await h.system.terminate();
    }
  });

  test('a client stream is reaped, including one half-closed whose reply never comes', async () => {
    const h = await bootIdle('grpc-idle-client-stream', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: h.targetRef });
      await awaitCondition(() => h.target.received.some((frame) => frame.kind === 'stream-started'), {
        label: 'the client-stream handshake reached the target actor',
      });
      const recorded = h.actor.fakeClient.clientStreamCalls[0]!;
      const handle = publishedHandle(h.target);

      h.scheduler.advance(600);
      h.clientRef.tell({ kind: 'clientStreamSend', handle, chunk: { value: 1 } });
      await awaitCondition(() => recorded.call.writes.length > 0, { label: 'the write reached the call' });
      h.scheduler.advance(600);
      expect(recorded.call.cancelled).toBe(0);

      h.clientRef.tell({ kind: 'clientStreamClose', handle });
      await awaitCondition(() => recorded.call.ended, { label: 'the caller half-closed' });
      h.scheduler.advance(1_000);
      expect(recorded.call.cancelled).toBe(1);

      await awaitCondition(() => terminalFrames(h.target).length > 0, { label: 'the idle rpc-error arrived' });
      // grpc-js answers its own cancel through the callback; it is not reported again.
      recorded.callback(new Error('Cancelled on client'), undefined);
      h.clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: h.targetRef });
      await awaitCondition(() => h.target.received.filter((frame) => frame.kind === 'stream-started').length > 1, {
        label: 'a fence stream was opened',
      });
      const terminal = terminalFrames(h.target);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.kind).toBe('rpc-error');
      expect((terminal[0] as RpcErrorMessage).error.message).toContain('idle');
    } finally {
      await h.system.terminate();
    }
  });

  test('a silent client stream that was never closed leaves the registry', async () => {
    const h = await bootIdle('grpc-idle-client-stream-evict', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.clientStreamCalls.length > 0, { label: 'the client stream opened' });
      expect(registryEntryFields(h.actor, 'clientStreams')).toHaveLength(1);

      h.scheduler.advance(1_000);
      expect(h.actor.fakeClient.clientStreamCalls[0]!.call.cancelled).toBe(1);
      expect(registryEntryFields(h.actor, 'clientStreams')).toEqual([]);
    } finally {
      await h.system.terminate();
    }
  });

  test('the built-in default is five minutes', async () => {
    const h = await bootIdle('grpc-idle-default', baseOptions());
    try {
      h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.bidiCalls.length > 0, { label: 'the bidi stream opened' });
      const call = h.actor.fakeClient.bidiCalls[0]!;

      h.scheduler.advance(DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS - 1);
      expect(call.cancelled).toBe(0);
      h.scheduler.advance(1);
      expect(call.cancelled).toBe(1);
      expect(DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
    } finally {
      await h.system.terminate();
    }
  });

  test('0 turns the timeout off, from the builder and from HOCON', async () => {
    const fromBuilder = await bootIdle('grpc-idle-off-builder', baseOptions().withStreamIdleTimeoutMs(0));
    const fromHocon = await bootIdle('grpc-idle-off-hocon', baseOptions(), {
      'actor-ts': { io: { broker: { grpc: { client: { 'stream-idle-timeout': 0 } } } } },
    });
    try {
      for (const h of [fromBuilder, fromHocon]) {
        h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
        await awaitCondition(() => h.actor.fakeClient.bidiCalls.length > 0, { label: 'the bidi stream opened' });
        h.scheduler.advance(24 * 3_600_000);
        expect(h.actor.fakeClient.bidiCalls[0]!.cancelled).toBe(0);
        expect(registryEntryFields(h.actor, 'bidiStreams')).toHaveLength(1);
      }
    } finally {
      await fromBuilder.system.terminate();
      await fromHocon.system.terminate();
    }
  });

  test('a HOCON stream-idle-timeout reaches the stream', async () => {
    const h = await bootIdle('grpc-idle-hocon', baseOptions(), {
      'actor-ts': { io: { broker: { grpc: { client: { 'stream-idle-timeout': '2s' } } } } },
    });
    try {
      h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.bidiCalls.length > 0, { label: 'the bidi stream opened' });
      const call = h.actor.fakeClient.bidiCalls[0]!;
      h.scheduler.advance(1_999);
      expect(call.cancelled).toBe(0);
      h.scheduler.advance(1);
      expect(call.cancelled).toBe(1);
    } finally {
      await h.system.terminate();
    }
  });

  test('a stopped client leaves no deadline behind to fire', async () => {
    const h = await bootIdle('grpc-idle-stop', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'serverStream', method: 'Watch', request: {}, target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.serverStreamCalls.length > 0, { label: 'the server stream opened' });
      const pendingBefore = h.scheduler.pendingCount;
      h.system.stop(h.clientRef);
      await awaitCondition(() => h.actor.fakeClient.closeCount > 0, { label: 'the client disconnected' });
      expect(h.scheduler.pendingCount).toBeLessThan(pendingBefore);
      h.scheduler.advance(1_000);
      expect(h.actor.fakeClient.serverStreamCalls[0]!.cancelled).toBe(0);
    } finally {
      await h.system.terminate();
    }
  });
});

/**
 * A stream that finishes normally takes its silence deadline with it.
 *
 * `idleWatches` is the one place every armed deadline is held, so a stream
 * whose end left its watch behind would leak one entry per stream for the
 * life of the actor, and every disconnect would walk the pile.  Read through
 * a cast for the same reason as the #1510 pins: the set is private.
 */
function armedIdleWatchCount(actor: FakeGrpcClientActor): number {
  const watches = (actor as unknown as Record<string, Set<object> | undefined>)['idleWatches'];
  if (!watches) throw new Error("GrpcClientActor has no 'idleWatches' set to read");
  return watches.size;
}

describe('GrpcClientActor — a stream that finishes releases its idle deadline (#1222)', () => {
  test('a server stream that ends, a replied client stream and a closed bidi stream leave no watch armed', async () => {
    const h = await bootIdle('grpc-idle-release', baseOptions().withStreamIdleTimeoutMs(1_000));
    try {
      h.clientRef.tell({ kind: 'serverStream', method: 'Watch', request: {}, target: h.targetRef });
      h.clientRef.tell({ kind: 'clientStreamStart', method: 'ReportReadings', target: h.targetRef });
      h.clientRef.tell({ kind: 'bidiStart', method: 'Chat', target: h.targetRef });
      await awaitCondition(() => h.actor.fakeClient.bidiCalls.length > 0, { label: 'all three streams opened' });
      expect(armedIdleWatchCount(h.actor)).toBe(3);

      h.actor.fakeClient.serverStreamCalls[0]!.pushEnd();
      h.actor.fakeClient.clientStreamCalls[0]!.callback(null, { total: 1 });
      h.actor.fakeClient.bidiCalls[0]!.pushEnd();
      await awaitCondition(() => terminalFrames(h.target).length === 3, { label: 'all three streams finished' });

      expect(terminalFrames(h.target).map((frame) => frame.kind).sort()).toEqual(['reply', 'stream-end', 'stream-end']);
      expect(armedIdleWatchCount(h.actor)).toBe(0);
    } finally {
      await h.system.terminate();
    }
  });
});
