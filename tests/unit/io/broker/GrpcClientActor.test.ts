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
} from '../../../../src/io/broker/GrpcClientActor.js';
import {
  GrpcClientOptions,
  type GrpcChannelOptions,
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
 * Recording stand-in for grpc-js's `ClientDuplexStream`.
 *
 * `pushData` / `pushEnd` are the *server's* half — they let a test drive
 * an inbound chunk, which is the only way to show that a server message
 * cannot be mistaken for the handshake now that the handshake has its
 * own frame.  The `'error'` listener the actor registers is accepted and
 * never fired; nothing here needs a failing stream.
 */
class FakeDuplexCall {
  readonly writes: unknown[] = [];
  ended = false;
  private readonly dataListeners: Array<(chunk: unknown) => void> = [];
  private readonly endListeners: Array<() => void> = [];

  on(event: 'data' | 'end' | 'error', listener: (chunk: never) => void): void {
    if (event === 'data') this.dataListeners.push(listener as (chunk: unknown) => void);
    else if (event === 'end') this.endListeners.push(listener as () => void);
  }

  write(chunk: unknown): void { this.writes.push(chunk); }
  end(): void { this.ended = true; }

  pushData(chunk: unknown): void { for (const listener of this.dataListeners) listener(chunk); }
  pushEnd(): void { for (const listener of this.endListeners) listener(); }
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
