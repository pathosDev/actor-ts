import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  frameByteLength,
  normalizeInbound,
  utf8ByteLength,
  type WebsocketFrame,
} from '../../../../src/http/websocket/types.js';

describe('utf8ByteLength', () => {
  test('ASCII is one byte per char', () => {
    expect(utf8ByteLength('hello')).toBe(5);
    expect(utf8ByteLength('')).toBe(0);
  });

  test('2-byte sequences (Latin-1 supplement)', () => {
    // 'ä' = U+00E4 → 2 bytes; 'ü' = U+00FC → 2 bytes
    expect(utf8ByteLength('ä')).toBe(2);
    expect(utf8ByteLength('äü')).toBe(4);
  });

  test('3-byte sequences (BMP beyond Latin)', () => {
    // '€' = U+20AC → 3 bytes
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('a€b')).toBe(5);
  });

  test('surrogate pairs count as 4 bytes', () => {
    // '😀' = U+1F600, one code point, surrogate pair in UTF-16 → 4 bytes
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('a😀b')).toBe(6);
  });

  test('matches TextEncoder for mixed input', () => {
    const samples = ['plain', 'café', 'naïve €5', '😀🎉 mixed αβγ', 'ascii-only-123'];
    const enc = new TextEncoder();
    for (const s of samples) {
      expect(utf8ByteLength(s)).toBe(enc.encode(s).length);
    }
  });
});

describe('frameByteLength', () => {
  test('text uses UTF-8 length', () => {
    expect(frameByteLength({ kind: 'text', data: '€' })).toBe(3);
  });
  test('binary uses byteLength', () => {
    expect(frameByteLength({ kind: 'binary', data: new Uint8Array(10) })).toBe(10);
  });
});

describe('normalizeInbound', () => {
  test('string → text frame', () => {
    expect(normalizeInbound('hi')).toEqual({ kind: 'text', data: 'hi' });
  });

  test('ArrayBuffer → binary frame', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const frame = normalizeInbound(buf) as Extract<WebsocketFrame, { kind: 'binary' }>;
    expect(frame.kind).toBe('binary');
    expect([...frame.data]).toEqual([1, 2, 3]);
  });

  test('Uint8Array passes through', () => {
    const u8 = new Uint8Array([9, 8]);
    const frame = normalizeInbound(u8) as Extract<WebsocketFrame, { kind: 'binary' }>;
    expect(frame.kind).toBe('binary');
    expect(frame.data).toBe(u8);
  });

  test('fragmented Array<Uint8Array> merges into one binary frame', () => {
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const frame = normalizeInbound(parts) as Extract<WebsocketFrame, { kind: 'binary' }>;
    expect(frame.kind).toBe('binary');
    expect([...frame.data]).toEqual([1, 2, 3, 4, 5]);
  });

  test('unrecognised shapes → null', () => {
    expect(normalizeInbound(42)).toBeNull();
    expect(normalizeInbound({})).toBeNull();
    expect(normalizeInbound(null)).toBeNull();
  });
});

test('default frame cap is 1 MiB', () => {
  expect(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES).toBe(1024 * 1024);
});
