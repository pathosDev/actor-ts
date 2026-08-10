import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../src/ActorRef.js';
import {
  buildGrpcMethodImplementation,
  type GrpcBidiCall,
  type GrpcClientStreamCall,
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

/** Stands in for grpc-js `ServerReadableStream` / `ServerDuplexStream`. */
function fakeReadableCall(): {
  call: {
    metadata?: { get?: (key: string) => string[] };
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

type ClientStreamImplementation = (call: unknown, cb: GrpcUnaryCallback) => void;
type ReadableImplementation = (call: unknown) => void;
type UnaryImplementation = (call: { request: unknown }, cb: GrpcUnaryCallback) => void;

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
