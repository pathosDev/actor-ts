import { describe, expect, test } from 'bun:test';
import { MqttPayload } from '../../../../../src/io/broker/MqttMessages.js';
import {
  mqttJsonCodec,
  MqttDecodeError,
  MqttEncodeError,
  type MqttCodec,
} from '../../../../../src/io/broker/MqttCodec.js';

const enc = new TextEncoder();

describe('mqttJsonCodec', () => {
  test('round-trips objects, arrays, strings, numbers', () => {
    const codec = mqttJsonCodec();
    for (const value of [{ a: 1, b: 'x' }, [1, 2, 3], 'hello', 42, true]) {
      const bytes = codec.encode(value);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(codec.decode(bytes)).toEqual(value);
    }
  });

  test('encode(undefined) throws MqttEncodeError', () => {
    const codec = mqttJsonCodec();
    expect(() => codec.encode(undefined)).toThrow(MqttEncodeError);
  });

  test('decode of non-JSON throws MqttDecodeError carrying the bytes', () => {
    const codec = mqttJsonCodec();
    const bytes = enc.encode('not json {');
    try {
      codec.decode(bytes);
      throw new Error('expected decode to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MqttDecodeError);
      expect((e as MqttDecodeError).bytes).toEqual(bytes);
    }
  });

  test('validate hook: pass-through and throw-wrapping', () => {
    const ok = mqttJsonCodec<{ n: number }>({
      validate: (v) => {
        if (typeof v !== 'object' || v === null || typeof (v as { n?: unknown }).n !== 'number') {
          throw new Error('bad shape');
        }
        return v as { n: number };
      },
    });
    expect(ok.decode(enc.encode('{"n":1}'))).toEqual({ n: 1 });
    expect(() => ok.decode(enc.encode('{"n":"x"}'))).toThrow(MqttDecodeError);
  });
});

describe('MqttPayload', () => {
  test('bytes are exposed verbatim; byteLength matches', () => {
    const bytes = enc.encode('abc');
    const payload = new MqttPayload(bytes, mqttJsonCodec());
    expect(payload.bytes).toBe(bytes);
    expect(payload.byteLength).toBe(3);
  });

  test('text() UTF-8 decodes and caches', () => {
    const payload = new MqttPayload(enc.encode('grüße'), mqttJsonCodec());
    expect(payload.text()).toBe('grüße');
    expect(payload.text()).toBe('grüße'); // second call from cache
    expect(payload.toString()).toBe('grüße');
  });

  test('entity() decodes via the codec', () => {
    const payload = new MqttPayload<{ a: number }>(enc.encode('{"a":1}'), mqttJsonCodec());
    const value = payload.entity();
    expect(value).toEqual({ a: 1 });
  });

  test('entity() caches — decode runs exactly once across repeated calls', () => {
    let decodeCalls = 0;
    const spy: MqttCodec = {
      name: 'spy',
      encode: (v) => enc.encode(JSON.stringify(v)),
      decode: (b) => {
        decodeCalls++;
        return JSON.parse(new TextDecoder().decode(b));
      },
    };
    const payload = new MqttPayload<{ a: number }>(enc.encode('{"a":1}'), spy);
    const first = payload.entity();
    const second = payload.entity<{ a: number }>(); // type-assertion variant, same cache
    expect(first).toEqual({ a: 1 });
    expect(second).toBe(first);
    expect(decodeCalls).toBe(1);
  });

  test('entity() on malformed payload throws MqttDecodeError with topic + bytes, re-throwable', () => {
    const bytes = enc.encode('{ broken');
    const payload = new MqttPayload(bytes, mqttJsonCodec(), 'sensors/1/temp');
    let first: unknown;
    try {
      payload.entity();
      throw new Error('expected entity() to throw');
    } catch (e) {
      first = e;
      expect(e).toBeInstanceOf(MqttDecodeError);
      expect((e as MqttDecodeError).topic).toBe('sensors/1/temp');
      expect((e as MqttDecodeError).bytes).toEqual(bytes);
    }
    // Errors are not cached: a second call re-throws an equivalent error.
    let second: unknown;
    try {
      payload.entity();
    } catch (e) {
      second = e;
    }
    expect(second).toBeInstanceOf(MqttDecodeError);
    expect(second).not.toBe(first);
  });

  test('entity() wraps a non-MqttDecodeError codec throw', () => {
    const throwing: MqttCodec = {
      name: 'throwing',
      encode: () => enc.encode(''),
      decode: () => {
        throw new TypeError('kaboom');
      },
    };
    const payload = new MqttPayload(enc.encode('x'), throwing, 't/1');
    try {
      payload.entity();
      throw new Error('expected entity() to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MqttDecodeError);
      expect((e as MqttDecodeError).topic).toBe('t/1');
    }
  });
});
