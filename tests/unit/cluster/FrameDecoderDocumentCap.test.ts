/**
 * `max-document-bytes` on the cluster wire (#880).
 *
 * The key shipped as "a ceiling on one document, checked before the bytes are
 * parsed", and both serializers honour it.  The cluster wire reaches neither
 * serializer — `FrameDecoder` calls `JSON.parse` and `decodeJsonTree` itself —
 * so on the one path in the framework whose bytes are chosen by an untrusted
 * peer the key did nothing at all.  Setting it to 1 MiB left a 16 MiB frame
 * fully parsed.
 *
 * The implementer's deviation note justified that with "the frame cap already
 * rejects on the 4-byte length prefix, which is strictly earlier".  Strictly
 * earlier and true of `remote.max-frame-bytes`, but it is a different number
 * with a different job — how many bytes this node will buffer for a transport
 * — and at its shipped 16 MiB it does not bound decode work at all.  A
 * deployment that wants "buffer what the transport needs, but never parse a
 * JSON document over 1 MiB" had no way to say so.
 *
 * So the ceiling is checked here on the same length prefix, which makes it the
 * earliest enforceable point in the whole framework: earlier than the
 * serializers' own check, which runs on bytes already assembled, and earlier
 * than the arrival of the payload it refuses.
 */
import { describe, expect, test } from 'bun:test';
import { FrameDecoder } from '../../../src/cluster/Protocol.js';

const HEADER_SIZE = 4;

/** A length-prefixed frame carrying `json` verbatim, as a peer would send it. */
function frameOf(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

/** Only the 4-byte prefix, claiming `length` payload bytes that never arrive. */
function headerClaiming(length: number): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  new DataView(header.buffer).setUint32(0, length, false);
  return header;
}

/** A frame body of roughly `bytes` bytes that is ordinary, valid JSON. */
const paddedJson = (bytes: number): string => JSON.stringify({ kind: 'ping', pad: 'x'.repeat(bytes) });

describe('FrameDecoder honours maxDocumentBytes', () => {
  test('a frame past the ceiling is refused, and the connection is terminated', () => {
    const decoder = new FrameDecoder(undefined, { maxDocumentBytes: 1024 });

    expect(() => decoder.push(frameOf(paddedJson(4096)))).toThrow(/exceeds maxDocumentBytes 1024/);
  });

  test('the refusal lands on the length prefix, before the payload is buffered', () => {
    // The property that makes this the earliest enforceable point, and the one
    // the serializers cannot have: they are handed bytes that already exist.
    // Four bytes of header and nothing else is enough to refuse.
    const decoder = new FrameDecoder(undefined, { maxDocumentBytes: 1024 });

    expect(() => decoder.push(headerClaiming(64 * 1024)))
      .toThrow(/exceeds maxDocumentBytes 1024/);
  });

  test('a frame inside the ceiling still decodes', () => {
    const decoder = new FrameDecoder(undefined, { maxDocumentBytes: 64 * 1024 });

    const messages = decoder.push(frameOf(JSON.stringify({ kind: 'ping', from: 'a@h:1' })));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'ping' });
  });

  test('the shipped default of 0 is off, and the frame cap alone governs', () => {
    // `0` is the documented "no ceiling of our own" spelling, and it is the
    // default, so nothing that decodes today stops decoding.
    const decoder = new FrameDecoder();

    expect(decoder.push(frameOf(paddedJson(256 * 1024)))).toHaveLength(1);
  });

  test('the frame cap still reports itself as the frame cap', () => {
    // Two bounds on one length prefix, and an operator has to be able to tell
    // which one fired: they are configured under different keys and mean
    // different things.
    const decoder = new FrameDecoder(2048, { maxDocumentBytes: 1024 });

    expect(() => decoder.push(headerClaiming(4096))).toThrow(/maxFrameBytes 2048/);
    expect(() => new FrameDecoder(8192, { maxDocumentBytes: 1024 }).push(headerClaiming(4096)))
      .toThrow(/exceeds maxDocumentBytes 1024/);
  });
});
