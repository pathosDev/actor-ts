import { describe, expect, test } from 'bun:test';
import { jsonCodec, rawCodec, WebsocketDecodeError, WebsocketEncodeError } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/types.js';

type Out = { kind: 'pong'; n: number };
type In = { kind: 'ping'; n: number };

describe('jsonCodec', () => {
  test('encodes to a text frame', () => {
    const codec = jsonCodec<Out, In>();
    expect(codec.encode({ kind: 'pong', n: 7 })).toEqual({ kind: 'text', data: '{"kind":"pong","n":7}' });
  });

  test('round-trips through encode/decode', () => {
    const codec = jsonCodec<In, In>();
    const frame = codec.encode({ kind: 'ping', n: 3 });
    expect(codec.decode(frame)).toEqual({ kind: 'ping', n: 3 });
  });

  test('decodes JSON delivered as a binary frame (UTF-8)', () => {
    const codec = jsonCodec<Out, In>();
    const bytes = new TextEncoder().encode('{"kind":"ping","n":9}');
    expect(codec.decode({ kind: 'binary', data: bytes })).toEqual({ kind: 'ping', n: 9 });
  });

  test('invalid JSON throws WebsocketDecodeError carrying the frame', () => {
    const codec = jsonCodec<Out, In>();
    const frame: WebsocketFrame = { kind: 'text', data: 'not json{' };
    expect(() => codec.decode(frame)).toThrow(WebsocketDecodeError);
    try {
      codec.decode(frame);
    } catch (e) {
      expect(e).toBeInstanceOf(WebsocketDecodeError);
      expect((e as WebsocketDecodeError).frame).toBe(frame);
    }
  });

  test('validate hook transforms the parsed value', () => {
    const codec = jsonCodec<Out, In>({
      validate: (v): In => {
        const obj = v as { kind?: unknown; n?: unknown };
        if (obj.kind !== 'ping' || typeof obj.n !== 'number') throw new Error('bad shape');
        return { kind: 'ping', n: obj.n };
      },
    });
    expect(codec.decode({ kind: 'text', data: '{"kind":"ping","n":1}' })).toEqual({ kind: 'ping', n: 1 });
  });

  test('validate failure surfaces as WebsocketDecodeError', () => {
    const codec = jsonCodec<Out, In>({
      validate: (): In => { throw new Error('schema mismatch'); },
    });
    expect(() => codec.decode({ kind: 'text', data: '{"kind":"nope"}' })).toThrow(WebsocketDecodeError);
  });

  test('non-serialisable outbound message throws WebsocketEncodeError', () => {
    const codec = jsonCodec<unknown, In>();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => codec.encode(circular)).toThrow(WebsocketEncodeError);
    // A bare function stringifies to undefined → also an encode error.
    expect(() => codec.encode(() => 0)).toThrow(WebsocketEncodeError);
  });
});

describe('rawCodec', () => {
  test('passes frames through untouched in both directions', () => {
    const codec = rawCodec();
    const text: WebsocketFrame = { kind: 'text', data: 'hi' };
    const bin: WebsocketFrame = { kind: 'binary', data: new Uint8Array([1, 2, 3]) };
    expect(codec.encode(text)).toBe(text);
    expect(codec.decode(bin)).toBe(bin);
  });
});
