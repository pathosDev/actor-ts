import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../src/ActorRef.js';
import {
  buildGrpcMethodImplementation,
  type GrpcBidiCall,
  type GrpcCallMetadata,
  type GrpcClientStreamCall,
  type GrpcHandler,
  type GrpcRequestStreamInbound,
  type GrpcServerStreamCall,
  type GrpcUnaryCall,
  type GrpcUnaryCallback,
} from '../../../../src/io/broker/GrpcServerActor.js';
import { createGrpcStreamHandle } from '../../../../src/io/broker/GrpcClientActor.js';

/**
 * Server-side call shapes for all four gRPC call classes (#5).
 *
 * `@grpc/grpc-js` is not installed for the unit suite — it exists only
 * inside the Dockerized broker-integration image — so nothing here can
 * drive a real RPC.  What it *can* drive is the seam in between:
 * `buildGrpcMethodImplementation` is a free function over a handler
 * descriptor, so a fake call object plus a fake `ActorRef` exercise the
 * whole call → handler → reply path with no module, socket or actor
 * system.  The live path is covered by
 * `tests/integration/brokers/grpc/`.
 */

/** Records everything the implementation tells the handler actor. */
function recordingRef<T>(sink: T[]): ActorRef<T> {
  return { tell: (message: T) => { sink.push(message); } } as unknown as ActorRef<T>;
}

/**
 * Stands in for grpc-js `Metadata` — the one method the server reads.
 * The value type is `unknown` on purpose: grpc-js answers with a `Buffer`
 * for every `-bin` key, and a fake that could not express that would not
 * be able to prove those keys are dropped.
 */
function grpcMetadata(headers: Record<string, unknown>): GrpcCallMetadata {
  return { getMap: () => headers };
}

/** Stands in for grpc-js `ServerReadableStream` / `ServerDuplexStream`. */
function fakeReadableCall(metadata?: GrpcCallMetadata): {
  call: {
    metadata?: GrpcCallMetadata;
    on(event: 'data', listener: (chunk: unknown) => void): void;
    on(event: 'end', listener: () => void): void;
    write(chunk: unknown): void;
    end(): void;
    emit(event: 'error', err: { code: number; message: string }): void;
  };
  pushData(chunk: unknown): void;
  pushEnd(): void;
  written: unknown[];
  ended: boolean[];
  errors: Array<{ code: number; message: string }>;
} {
  const dataListeners: Array<(chunk: unknown) => void> = [];
  const endListeners: Array<() => void> = [];
  const written: unknown[] = [];
  const ended: boolean[] = [];
  const errors: Array<{ code: number; message: string }> = [];
  return {
    call: {
      ...(metadata ? { metadata } : {}),
      on: ((event: 'data' | 'end', listener: ((chunk: unknown) => void) & (() => void)): void => {
        if (event === 'data') dataListeners.push(listener);
        else endListeners.push(listener);
      }) as never,
      write: (chunk: unknown) => { written.push(chunk); },
      end: () => { ended.push(true); },
      emit: (_event: 'error', err: { code: number; message: string }) => { errors.push(err); },
    },
    pushData: (chunk) => { for (const listener of dataListeners) listener(chunk); },
    pushEnd: () => { for (const listener of endListeners) listener(); },
    written,
    ended,
    errors,
  };
}

type ClientStreamImplementation = (call: unknown, callback: GrpcUnaryCallback) => void;
type ReadableImplementation = (call: unknown) => void;
type UnaryImplementation = (
  call: { request: unknown; metadata?: GrpcCallMetadata },
  callback: GrpcUnaryCallback,
) => void;

describe('buildGrpcMethodImplementation — client-stream (#5)', () => {
  test('hands the handler a call with the method name and no request message', () => {
    const calls: GrpcClientStreamCall[] = [];
    const implementation = buildGrpcMethodImplementation(
      'Collect', { kind: 'clientStream', target: recordingRef(calls) },
    ) as ClientStreamImplementation;
    const fake = fakeReadableCall();

    implementation(fake.call, () => { /* unused */ });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('Collect');
    // Empty because *this* fake carries no metadata, not because the
    // field is a stub — see the `metadata` block below (#611).
    expect(calls[0]!.metadata).toEqual({});
    // A client-streaming RPC has no single request message — that is
    // precisely what separates it from a unary call.
    expect('request' in calls[0]!).toBe(false);
  });

  test('replays chunks that arrived before the handler subscribed', () => {
    const calls: GrpcClientStreamCall[] = [];
    const implementation = buildGrpcMethodImplementation(
      'Collect', { kind: 'clientStream', target: recordingRef(calls) },
    ) as ClientStreamImplementation;
    const fake = fakeReadableCall();
    implementation(fake.call, () => { /* unused */ });

    // The real handler actor runs a turn later, so grpc-js can push
    // before `onData` ever happens.  Those chunks are the request.
    fake.pushData({ text: 'first' });
    fake.pushData({ text: 'second' });

    const received: GrpcRequestStreamInbound[] = [];
    calls[0]!.onData(recordingRef(received));
    expect(received).toEqual([
      { kind: 'chunk', chunk: { text: 'first' } },
      { kind: 'chunk', chunk: { text: 'second' } },
    ]);

    fake.pushData({ text: 'third' });
    fake.pushEnd();
    expect(received).toEqual([
      { kind: 'chunk', chunk: { text: 'first' } },
      { kind: 'chunk', chunk: { text: 'second' } },
      { kind: 'chunk', chunk: { text: 'third' } },
      { kind: 'end' },
    ]);
  });

  test('respond answers the unary callback exactly once', () => {
    const calls: GrpcClientStreamCall[] = [];
    const implementation = buildGrpcMethodImplementation(
      'Collect', { kind: 'clientStream', target: recordingRef(calls) },
    ) as ClientStreamImplementation;
    const answers: Array<[unknown, unknown]> = [];
    implementation(fakeReadableCall().call, (err, response) => { answers.push([err, response]); });

    calls[0]!.respond({ total: 3 });
    calls[0]!.respond({ total: 99 });
    calls[0]!.respondError('too late');

    expect(answers).toEqual([[null, { total: 3 }]]);
  });

  test('respondError defaults to INTERNAL and honours an explicit code', () => {
    const failing: GrpcClientStreamCall[] = [];
    const defaulted = buildGrpcMethodImplementation(
      'Collect', { kind: 'clientStream', target: recordingRef(failing) },
    ) as ClientStreamImplementation;
    const defaultedAnswers: unknown[] = [];
    defaulted(fakeReadableCall().call, (err) => { defaultedAnswers.push(err); });
    failing[0]!.respondError('boom');
    expect(defaultedAnswers).toEqual([{ code: 13, message: 'boom' }]);

    const explicit: GrpcClientStreamCall[] = [];
    const coded = buildGrpcMethodImplementation(
      'Collect', { kind: 'clientStream', target: recordingRef(explicit) },
    ) as ClientStreamImplementation;
    const codedAnswers: unknown[] = [];
    coded(fakeReadableCall().call, (err) => { codedAnswers.push(err); });
    explicit[0]!.respondError('nope', 7);
    expect(codedAnswers).toEqual([{ code: 7, message: 'nope' }]);
  });
});

describe('buildGrpcMethodImplementation — the other three call classes still hold', () => {
  test('unary forwards the request and replies through the callback', () => {
    const calls: GrpcUnaryCall[] = [];
    const implementation = buildGrpcMethodImplementation(
      'Get', { kind: 'unary', target: recordingRef(calls) },
    ) as UnaryImplementation;
    const answers: Array<[unknown, unknown]> = [];

    implementation({ request: { id: 'rt-7' } }, (err, response) => { answers.push([err, response]); });
    expect(calls[0]!.request).toEqual({ id: 'rt-7' });
    calls[0]!.respond({ label: 'sensor' });
    expect(answers).toEqual([[null, { label: 'sensor' }]]);
  });

  test('server-stream sends chunks and completes once', () => {
    const calls: GrpcServerStreamCall[] = [];
    const implementation = buildGrpcMethodImplementation(
      'Watch', { kind: 'serverStream', target: recordingRef(calls) },
    ) as ReadableImplementation;
    const fake = fakeReadableCall();

    implementation({ ...fake.call, request: { limit: 2 } });
    calls[0]!.send({ value: 1 });
    calls[0]!.complete();
    calls[0]!.send({ value: 2 });
    calls[0]!.complete();

    expect(fake.written).toEqual([{ value: 1 }]);
    expect(fake.ended).toHaveLength(1);
  });

  test('bidi buffers pre-subscription chunks the same way client-stream does', () => {
    const calls: GrpcBidiCall[] = [];
    const implementation = buildGrpcMethodImplementation(
      'Chat', { kind: 'bidi', target: recordingRef(calls) },
    ) as ReadableImplementation;
    const fake = fakeReadableCall();

    implementation(fake.call);
    fake.pushData({ text: 'early' });

    const received: GrpcRequestStreamInbound[] = [];
    calls[0]!.onData(recordingRef(received));
    expect(received).toEqual([{ kind: 'chunk', chunk: { text: 'early' } }]);

    calls[0]!.send({ text: 'echo' });
    calls[0]!.complete();
    expect(fake.written).toEqual([{ text: 'echo' }]);
    expect(fake.ended).toHaveLength(1);
  });
});

/**
 * One call class, reduced to the only thing this block cares about:
 * drive it with `metadata` attached and hand back what the handler saw.
 * All four exist because the stub was wired at all four call sites, so a
 * fix that reached only the unary path would still leave three
 * authorisation checks passing vacuously (#611).
 */
type CallClassCase = {
  readonly kind: GrpcHandler['kind'];
  readonly observe: (metadata?: GrpcCallMetadata) => Readonly<Record<string, string>>;
};

const CALL_CLASSES: CallClassCase[] = [
  {
    kind: 'unary',
    observe: (metadata) => {
      const calls: GrpcUnaryCall[] = [];
      const implementation = buildGrpcMethodImplementation(
        'Get', { kind: 'unary', target: recordingRef(calls) },
      ) as UnaryImplementation;
      implementation({ request: { id: 'rt-7' }, ...(metadata ? { metadata } : {}) }, () => { /* unused */ });
      return calls[0]!.metadata;
    },
  },
  {
    kind: 'serverStream',
    observe: (metadata) => {
      const calls: GrpcServerStreamCall[] = [];
      const implementation = buildGrpcMethodImplementation(
        'Watch', { kind: 'serverStream', target: recordingRef(calls) },
      ) as ReadableImplementation;
      implementation({ ...fakeReadableCall(metadata).call, request: { limit: 2 } });
      return calls[0]!.metadata;
    },
  },
  {
    kind: 'clientStream',
    observe: (metadata) => {
      const calls: GrpcClientStreamCall[] = [];
      const implementation = buildGrpcMethodImplementation(
        'Collect', { kind: 'clientStream', target: recordingRef(calls) },
      ) as ClientStreamImplementation;
      implementation(fakeReadableCall(metadata).call, () => { /* unused */ });
      return calls[0]!.metadata;
    },
  },
  {
    kind: 'bidi',
    observe: (metadata) => {
      const calls: GrpcBidiCall[] = [];
      const implementation = buildGrpcMethodImplementation(
        'Chat', { kind: 'bidi', target: recordingRef(calls) },
      ) as ReadableImplementation;
      implementation(fakeReadableCall(metadata).call);
      return calls[0]!.metadata;
    },
  },
];

describe('buildGrpcMethodImplementation — request metadata (#611)', () => {
  test('the table covers every call class', () => {
    expect(CALL_CLASSES.map((c) => c.kind)).toEqual(['unary', 'serverStream', 'clientStream', 'bidi']);
  });

  test.each([...CALL_CLASSES])('$kind hands the handler the real request headers', ({ observe }) => {
    const seen = observe(grpcMetadata({ authorization: 'Bearer t0ken', 'x-tenant': 'acme' }));

    expect(seen).toEqual({ authorization: 'Bearer t0ken', 'x-tenant': 'acme' });
    // The point of the whole issue: a header check must be able to fail.
    expect(seen['authorization']).toBe('Bearer t0ken');
  });

  test.each([...CALL_CLASSES])('$kind yields an empty record when the call carries no metadata', ({ observe }) => {
    expect(observe()).toEqual({});
    expect(observe(grpcMetadata({}))).toEqual({});
    // A `Metadata` without the method the server reads must not throw.
    expect(observe({})).toEqual({});
  });

  test('binary (`-bin`) headers are dropped, text headers beside them survive', () => {
    const seen = CALL_CLASSES[0]!.observe(grpcMetadata({
      'x-trace-bin': Buffer.from([0x01, 0x02]),
      'x-trace': 'readable',
    }));

    // `Readonly<Record<string, string>>` cannot hold a Buffer, so carrying
    // the key would make the declared type a lie.
    expect(seen).toEqual({ 'x-trace': 'readable' });
    expect('x-trace-bin' in seen).toBe(false);

    // The omission is keyed on the *name*, not on what the value happens
    // to be: the docs promise `-bin` headers are absent, and that has to
    // hold even if some grpc-js release hands one back already decoded.
    expect(CALL_CLASSES[0]!.observe(grpcMetadata({ 'x-trace-bin': 'already-text' }))).toEqual({});
  });

  test('a non-string value under a text key is dropped too', () => {
    // Belt and braces: the `-bin` suffix is the protocol's rule, but the
    // type contract must hold whatever a grpc-js release hands back.
    const seen = CALL_CLASSES[0]!.observe(grpcMetadata({ ok: 'yes', weird: Buffer.from('x'), missing: undefined }));

    expect(seen).toEqual({ ok: 'yes' });
  });

  test('a client-sent `__proto__` header is carried as data and pollutes nothing', () => {
    // Built with `JSON.parse`, NOT an object literal: `{ __proto__: … }`
    // is the literal's prototype-setter syntax, so it never produces the
    // own property this test is about — a fake written that way asserts
    // nothing at all.
    const headers = JSON.parse(
      '{"__proto__":"from-the-wire","constructor":"from-the-wire","authorization":"Bearer t0ken"}',
    ) as Record<string, unknown>;
    const seen = CALL_CLASSES[0]!.observe(grpcMetadata(headers));

    // On a plain `{}` target this assignment reaches the inherited
    // `__proto__` setter, which ignores a string — so the header would
    // vanish without a trace instead of arriving as data.
    expect(Object.keys(seen)).toContain('__proto__');
    expect(seen['__proto__']).toBe('from-the-wire');
    expect(seen['constructor']).toBe('from-the-wire');
    expect(seen['authorization']).toBe('Bearer t0ken');
    // …and nothing may leak into every other object in the process.
    expect(({} as Record<string, unknown>)['authorization']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  test('a header nobody sent reads as undefined, including Object.prototype member names', () => {
    const seen = CALL_CLASSES[0]!.observe(grpcMetadata({ authorization: 'Bearer t0ken' }));

    // The record has no prototype, so `metadata[name]` is a pure header
    // lookup.  On a plain `{}` these three would be truthy on every call
    // — a check keyed on a configurable header name would pass vacuously,
    // which is the failure mode #611 is about.
    expect(Object.getPrototypeOf(seen)).toBeNull();
    expect(seen['constructor']).toBeUndefined();
    expect(seen['toString']).toBeUndefined();
    expect(seen['hasOwnProperty']).toBeUndefined();
    expect(seen['x-absent']).toBeUndefined();
  });
});

describe('createGrpcStreamHandle — the client-stream write capability (#5)', () => {
  test('carries the correlation id and a fresh unguessable token', () => {
    const first = createGrpcStreamHandle(4);
    const second = createGrpcStreamHandle(4);

    expect(first.streamId).toBe(4);
    expect(second.streamId).toBe(4);
    // Same id, different capability: the token is what authorises a
    // write, so two handles for the same stream number must not collide.
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[0-9a-f]{16}$/);
  });

  test('tokens do not repeat across a batch', () => {
    const tokens = new Set(Array.from({ length: 500 }, (_, i) => createGrpcStreamHandle(i).token));
    expect(tokens.size).toBe(500);
  });
});
