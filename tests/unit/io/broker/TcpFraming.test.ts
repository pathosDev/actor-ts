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
  return { actor, delivered, state, feed, pending };
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
