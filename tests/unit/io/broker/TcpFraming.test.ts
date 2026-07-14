import { describe, expect, test } from 'bun:test';
import { TcpSocketActor } from '../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../src/io/broker/TcpSocketOptions.js';

// Exercise the private `lines` framing in isolation: construct the actor
// (no start → no socket/system), stub `deliver` + `handleConnectionLost`,
// drive `extractLines` directly.  Deterministic, no IO.
function makeActor() {
  const actor = new TcpSocketActor(TcpSocketOptions.create()) as unknown as {
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
  return { actor, delivered, state, feed, pending };
}

// security audit BRK-1 — a delimiter-free stream must not grow the inbound
// buffer without bound; an over-long line is dropped and the connection lost.
describe('TcpSocketActor — lines framing bounds (BRK-1)', () => {
  test('an over-long UNTERMINATED line is not buffered — connection lost', () => {
    const h = makeActor();
    h.feed('x'.repeat(32));           // no delimiter, 32 > maxLineLen 8
    h.actor.extractLines('\n', 8);
    expect(h.state.lost).not.toBeNull();
    expect(h.delivered.length).toBe(0);
  });

  test('an over-long TERMINATED line is rejected too', () => {
    const h = makeActor();
    h.feed('x'.repeat(20) + '\n');
    h.actor.extractLines('\n', 8);
    expect(h.state.lost).not.toBeNull();
    expect(h.delivered.length).toBe(0);
  });

  test('valid lines deliver; a short pending remainder is retained', () => {
    const h = makeActor();
    h.feed('a\nbb\nccc');
    h.actor.extractLines('\n', 8);
    expect(h.state.lost).toBeNull();
    expect(h.delivered).toEqual(['a', 'bb']);
    expect(h.pending()).toBe('ccc');   // 3 ≤ 8 — kept for the next chunk
  });

  test('a short unterminated buffer is retained without error', () => {
    const h = makeActor();
    h.feed('partial');                 // 7 ≤ 8
    h.actor.extractLines('\n', 8);
    expect(h.state.lost).toBeNull();
    expect(h.delivered.length).toBe(0);
  });
});
