import { describe, expect, test } from 'bun:test';
import { jsonCodec, rawCodec, WebsocketDecodeError, WebsocketEncodeError } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/types.js';

type Out = { kind: 'pong'; n: number };
type In = { kind: 'ping'; n: number };

describe('jsonCodec', () => {
  test('encodes to a text frame', () => {
    const c = jsonCodec<Out, In>();
    expect(c.encode({ kind: 'pong', n: 7 })).toEqual({ kind: 'text', data: '{"kind":"pong","n":7}' });
  });

  test('round-trips through encode/decode', () => {
    const c = jsonCodec<In, In>();
    const frame = c.encode({ kind: 'ping', n: 3 });
    expect(c.decode(frame)).toEqual({ kind: 'ping', n: 3 });
  });

  test('decodes JSON delivered as a binary frame (UTF-8)', () => {
    const c = jsonCodec<Out, In>();
    const bytes = new TextEncoder().encode('{"kind":"ping","n":9}');
    expect(c.decode({ kind: 'binary', data: bytes })).toEqual({ kind: 'ping', n: 9 });
  });

  test('invalid JSON throws WebsocketDecodeError carrying the frame', () => {
    const c = jsonCodec<Out, In>();
    const frame: WebsocketFrame = { kind: 'text', data: 'not json{' };
    expect(() => c.decode(frame)).toThrow(WebsocketDecodeError);
    try {
      c.decode(frame);
    } catch (e) {
      expect(e).toBeInstanceOf(WebsocketDecodeError);
      expect((e as WebsocketDecodeError).frame).toBe(frame);
    }
  });

  test('validate hook transforms the parsed value', () => {
    const c = jsonCodec<Out, In>({
      validate: (v): In => {
        const o = v as { kind?: unknown; n?: unknown };
        if (o.kind !== 'ping' || typeof o.n !== 'number') throw new Error('bad shape');
        return { kind: 'ping', n: o.n };
      },
    });
    expect(c.decode({ kind: 'text', data: '{"kind":"ping","n":1}' })).toEqual({ kind: 'ping', n: 1 });
  });

  test('validate failure surfaces as WebsocketDecodeError', () => {
    const c = jsonCodec<Out, In>({
      validate: (): In => { throw new Error('schema mismatch'); },
    });
    expect(() => c.decode({ kind: 'text', data: '{"kind":"nope"}' })).toThrow(WebsocketDecodeError);
  });

  test('non-serialisable outbound message throws WebsocketEncodeError', () => {
    const c = jsonCodec<unknown, In>();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => c.encode(circular)).toThrow(WebsocketEncodeError);
    // A bare function stringifies to undefined → also an encode error.
    expect(() => c.encode(() => 0)).toThrow(WebsocketEncodeError);
  });
});

describe('rawCodec', () => {
  test('passes frames through untouched in both directions', () => {
    const c = rawCodec();
    const text: WebsocketFrame = { kind: 'text', data: 'hi' };
    const bin: WebsocketFrame = { kind: 'binary', data: new Uint8Array([1, 2, 3]) };
    expect(c.encode(text)).toBe(text);
    expect(c.decode(bin)).toBe(bin);
  });
});
