import { describe, expect, test } from 'bun:test';
import { TcpSocketActor } from '../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../src/io/broker/TcpSocketOptions.js';

/**
 * Stand-in for the `node:net` socket, so the teardown half of a cap breach is
 * observable without IO.  Only the four methods the actor calls; a real
 * socket is what the integration suite is for.
 */
type FakeSocket = {
  listenersRemoved: boolean;
  destroyed: boolean;
  removeAllListeners(): void;
  destroy(): void;
  end(callback?: () => void): void;
};

// Exercise the private `lines` framing in isolation: construct the actor
// (no start → no socket/system), stub `deliver` + `handleConnectionLost`,
// drive `extractLines` directly.  Deterministic, no IO.
function makeActor() {
  const tcpOptions = TcpSocketOptions.create();
  const actor = new TcpSocketActor(tcpOptions) as unknown as {
    deliver: (f: unknown) => void;
    handleConnectionLost: (e: Error) => void;
    inboundBuffer: Uint8Array;
    socket: FakeSocket | null;
    extractLines: (delimiter: string, maxLineLen: number) => void;
    disconnectImplementation: () => Promise<void>;
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
  /** Give the actor a socket, so a teardown has something to be visible on. */
  const attachSocket = (): FakeSocket => {
    const socket: FakeSocket = {
      listenersRemoved: false,
      destroyed: false,
      removeAllListeners() { this.listenersRemoved = true; },
      destroy() { this.destroyed = true; },
      end(callback?: () => void) { callback?.(); },
    };
    actor.socket = socket;
    return socket;
  };
  return { actor, delivered, state, feed, feedChunk, pending, attachSocket };
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

// #578 — the half BRK-1 never covered.  Reporting the breach was inert on
// its own: the bytes stayed in the buffer and the socket stayed attached with
// its 'data' listener live, so the peer that tripped the cap simply carried
// on filling the buffer the cap had refused to clear.
describe('TcpSocketActor — what a breached cap actually costs (#578)', () => {
  test('an over-long UNTERMINATED line drains the buffer and destroys the socket', () => {
    const harness = makeActor();
    const socket = harness.attachSocket();
    harness.feed('x'.repeat(32));            // no delimiter, 32 > maxLineLen 8
    harness.actor.extractLines('\n', 8);
    expect(harness.state.lost).not.toBeNull();
    expect(harness.pending()).toBe('');       // the oversized bytes are gone
    expect(socket.destroyed).toBe(true);      // and so is the socket
    // Listeners first: 'close' fires from destroy() and would otherwise
    // report 'socket closed' over the real cause.
    expect(socket.listenersRemoved).toBe(true);
    expect(harness.actor.socket).toBeNull();
  });

  test('an over-long TERMINATED line costs the connection the same way', () => {
    const harness = makeActor();
    const socket = harness.attachSocket();
    harness.feed('x'.repeat(20) + '\n');
    harness.actor.extractLines('\n', 8);
    expect(harness.state.lost).not.toBeNull();
    expect(harness.pending()).toBe('');
    expect(socket.destroyed).toBe(true);
  });

  test('a breach with no socket attached still drains the buffer', () => {
    // The reconnect race: the socket can already be gone when the last chunk
    // is framed.  Nothing to destroy is not a reason to keep the bytes.
    const harness = makeActor();
    harness.feed('x'.repeat(32));
    harness.actor.extractLines('\n', 8);
    expect(harness.pending()).toBe('');
  });

  test('no bytes cross a reconnect boundary', async () => {
    // A peer that hangs up mid-line leaves a partial frame behind.  Splicing
    // it onto the first chunk of the NEXT connection would frame two peers'
    // bytes into one line.
    const harness = makeActor();
    const socket = harness.attachSocket();
    harness.feed('half-a-line');
    await harness.actor.disconnectImplementation();
    expect(harness.pending()).toBe('');
    expect(socket.listenersRemoved).toBe(true);

    // And again with the socket already gone — the path a cap breach leaves
    // behind, where `disconnectImplementation` returns early.
    harness.feed('more-bytes');
    await harness.actor.disconnectImplementation();
    expect(harness.pending()).toBe('');
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
