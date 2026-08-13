import { describe, expect, test } from 'bun:test';
import { TcpSocketActor } from '../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../src/io/broker/TcpSocketOptions.js';

// Exercise the private `lines` framing in isolation: construct the actor
// (no start → no socket/system), stub `deliver` + `handleConnectionLost`,
// drive `extractLines` directly.  Deterministic, no IO.
function makeActor() {
  const tcpOptions = TcpSocketOptions.create();
  const actor = new TcpSocketActor(tcpOptions) as unknown as {
    deliver: (f: unknown) => void;
    handleConnectionLost: (e: Error) => void;
    inboundBuffer: Uint8Array;
    extractLines: (delimiter: string, maxLineLen: number) => void;
  };
  const delivered: unknown[] = [];
  const state = { lost: null as Error | null };
  actor.deliver = (f) => delivered.push(f);
  actor.handleConnectionLost = (e) => { state.lost = e; };
  const feed = (s: string): void => { actor.inboundBuffer = new TextEncoder().encode(s); };
  const pending = (): string => new TextDecoder().decode(actor.inboundBuffer);
  /**
   * One inbound chunk, the way `handleData` sees it: append, then extract.
   * Bytes, not a string, because a chunk boundary is free to fall inside a
   * multi-byte character — which is the whole point of the tests below.
   */
  const feedChunk = (chunk: Uint8Array, delimiter = '\n', maxLineLen = 64): void => {
    const merged = new Uint8Array(actor.inboundBuffer.length + chunk.length);
    merged.set(actor.inboundBuffer, 0);
    merged.set(chunk, actor.inboundBuffer.length);
    actor.inboundBuffer = merged;
    actor.extractLines(delimiter, maxLineLen);
  };
  return { actor, delivered, state, feed, feedChunk, pending };
}

// security audit BRK-1 — a delimiter-free stream must not grow the inbound
// buffer without bound; an over-long line is dropped and the connection lost.
describe('TcpSocketActor — lines framing bounds (BRK-1)', () => {
  test('an over-long UNTERMINATED line is not buffered — connection lost', () => {
    const harness = makeActor();
    harness.feed('x'.repeat(32));           // no delimiter, 32 > maxLineLen 8
    harness.actor.extractLines('\n', 8);
    expect(harness.state.lost).not.toBeNull();
    expect(harness.delivered.length).toBe(0);
  });

  test('an over-long TERMINATED line is rejected too', () => {
    const harness = makeActor();
    harness.feed('x'.repeat(20) + '\n');
    harness.actor.extractLines('\n', 8);
    expect(harness.state.lost).not.toBeNull();
    expect(harness.delivered.length).toBe(0);
  });

  test('valid lines deliver; a short pending remainder is retained', () => {
    const harness = makeActor();
    harness.feed('a\nbb\nccc');
    harness.actor.extractLines('\n', 8);
    expect(harness.state.lost).toBeNull();
    expect(harness.delivered).toEqual(['a', 'bb']);
    expect(harness.pending()).toBe('ccc');   // 3 ≤ 8 — kept for the next chunk
  });

  test('a short unterminated buffer is retained without error', () => {
    const harness = makeActor();
    harness.feed('partial');                 // 7 ≤ 8
    harness.actor.extractLines('\n', 8);
    expect(harness.state.lost).toBeNull();
    expect(harness.delivered.length).toBe(0);
  });
});

// The actor half of #610: the scan position lives on the actor, so the
// extractor's incremental contract only holds if `handleData`'s path carries
// it from chunk to chunk.  These drive chunk by chunk, which nothing did.
describe('TcpSocketActor — lines framing across chunks (#610)', () => {
  test('a character split across two chunks is not corrupted', () => {
    const harness = makeActor();
    // 'ä' is C3 A4 — the chunk boundary falls between the two bytes.
    harness.feedChunk(new Uint8Array([0x61, 0x0a, 0xc3]));   // 'a\n' + lead byte
    expect(harness.delivered).toEqual(['a']);
    harness.feedChunk(new Uint8Array([0xa4, 0x0a]));         // continuation + '\n'
    expect(harness.delivered).toEqual(['a', 'ä']);
    expect(harness.state.lost).toBeNull();
    expect(harness.pending()).toBe('');
  });

  test('a line assembled from many chunks arrives once, whole', () => {
    const harness = makeActor();
    const encoder = new TextEncoder();
    let chunks = 0;
    for (const part of ['ab', 'cd', 'ef', 'gh']) {
      harness.feedChunk(encoder.encode(part));
      chunks++;
      expect(harness.delivered.length).toBe(0);   // no delimiter yet
    }
    expect(chunks).toBe(4);
    harness.feedChunk(encoder.encode('\n'));
    expect(harness.delivered).toEqual(['abcdefgh']);
    expect(harness.pending()).toBe('');
  });
});
