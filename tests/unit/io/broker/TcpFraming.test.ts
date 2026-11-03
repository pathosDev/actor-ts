import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_FRAME_BYTES,
  extractFrames,
  findFramingViolation,
  type TcpFraming,
} from '../../../../src/io/broker/TcpFraming.js';
import { TcpSocketActor } from '../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../src/io/broker/TcpSocketOptions.js';
import type { TcpSocketOptionsType } from '../../../../src/io/broker/TcpSocketOptions.js';
import type { TcpInboundBuffer } from '../../../../src/io/broker/TcpInboundBuffer.js';

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

// Exercise the `lines` framing in isolation: construct the actor (no start →
// no socket/system), stub `deliver` + `handleConnectionLost`, and drive
// `handleData` — the method the socket's 'data' listener calls.
// Deterministic, no IO.
//
// `BrokerActor.options` throws before `preStart`, and starting the actor would
// mean a real connection, so the resolved settings are defined onto the
// instance.  Same trick as the two stubs below, one property further up.
function makeActor(maxLineBytes = 8) {
  const tcpOptions = TcpSocketOptions.create();
  const actor = new TcpSocketActor(tcpOptions) as unknown as {
    deliver: (f: unknown) => void;
    handleConnectionLost: (e: Error) => void;
    inbound: TcpInboundBuffer;
    socket: FakeSocket | null;
    handleData: (chunk: Uint8Array) => void;
    disconnectImplementation: () => Promise<void>;
  };
  const resolved: TcpSocketOptionsType = { framing: { kind: 'lines', maxLineBytes } };
  Object.defineProperty(actor, 'options', { value: resolved });
  const delivered: unknown[] = [];
  const state = { lost: null as Error | null };
  actor.deliver = (f) => delivered.push(f);
  actor.handleConnectionLost = (e) => { state.lost = e; };
  /**
   * One inbound chunk, the way `handleData` sees it: append, then extract.
   * Bytes, not a string, because a chunk boundary is free to fall inside a
   * multi-byte character — which is the whole point of the tests below.
   */
  const feedChunk = (chunk: Uint8Array): void => { actor.handleData(chunk); };
  const feed = (s: string): void => { feedChunk(new TextEncoder().encode(s)); };
  /**
   * Bytes still buffered.  A count rather than their content: the buffer keeps
   * them in a slab it reuses across chunks (#610), and what the tests are
   * about is whether they are still held — the content is proven by feeding
   * the delimiter and seeing the line come out whole.
   */
  const pendingBytes = (): number => actor.inbound.pendingBytes();
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
  return { actor, delivered, state, feed, feedChunk, pendingBytes, attachSocket };
}

// security audit BRK-1 — a delimiter-free stream must not grow the inbound
// buffer without bound; an over-long line is dropped and the connection lost.
describe('TcpSocketActor — lines framing bounds (BRK-1)', () => {
  test('an over-long UNTERMINATED line is not buffered — connection lost', () => {
    const harness = makeActor();
    harness.feed('x'.repeat(32));           // no delimiter, 32 > maxLineBytes 8
    expect(harness.state.lost).not.toBeNull();
    expect(harness.delivered.length).toBe(0);
  });

  test('an over-long TERMINATED line is rejected too', () => {
    const harness = makeActor();
    harness.feed('x'.repeat(20) + '\n');
    expect(harness.state.lost).not.toBeNull();
    expect(harness.delivered.length).toBe(0);
  });

  test('valid lines deliver; a short pending remainder is retained', () => {
    const harness = makeActor();
    harness.feed('a\nbb\nccc');
    expect(harness.state.lost).toBeNull();
    expect(harness.delivered).toEqual(['a', 'bb']);
    expect(harness.pendingBytes()).toBe(3);  // 3 ≤ 8 — kept for the next chunk
    harness.feed('\n');                      // and kept intact, not just counted
    expect(harness.delivered).toEqual(['a', 'bb', 'ccc']);
  });

  test('a short unterminated buffer is retained without error', () => {
    const harness = makeActor();
    harness.feed('partial');                 // 7 ≤ 8
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
    harness.feed('x'.repeat(32));            // no delimiter, 32 > maxLineBytes 8
    expect(harness.state.lost).not.toBeNull();
    expect(harness.pendingBytes()).toBe(0);   // the oversized bytes are gone
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
    expect(harness.state.lost).not.toBeNull();
    expect(harness.pendingBytes()).toBe(0);
    expect(socket.destroyed).toBe(true);
  });

  test('a breach with no socket attached still drains the buffer', () => {
    // The reconnect race: the socket can already be gone when the last chunk
    // is framed.  Nothing to destroy is not a reason to keep the bytes.
    const harness = makeActor();
    harness.feed('x'.repeat(32));
    expect(harness.pendingBytes()).toBe(0);
  });

  test('no bytes cross a reconnect boundary', async () => {
    // A peer that hangs up mid-line leaves a partial frame behind.  Splicing
    // it onto the first chunk of the NEXT connection would frame two peers'
    // bytes into one line.  A roomy cap here on purpose: what is dropped is a
    // legitimate partial line, not one that breached anything.
    const harness = makeActor(64);
    const socket = harness.attachSocket();
    harness.feed('half-a-line');
    expect(harness.pendingBytes()).toBe(11);
    await harness.actor.disconnectImplementation();
    expect(harness.pendingBytes()).toBe(0);
    expect(socket.listenersRemoved).toBe(true);

    // And again with the socket already gone — the path a cap breach leaves
    // behind, where `disconnectImplementation` returns early.
    harness.feed('more-bytes');
    await harness.actor.disconnectImplementation();
    expect(harness.pendingBytes()).toBe(0);
  });
});

// The actor half of #610: the scan position lives on the actor, so the
// extractor's incremental contract only holds if `handleData`'s path carries
// it from chunk to chunk.  These drive chunk by chunk, which nothing did.
describe('TcpSocketActor — lines framing across chunks (#610)', () => {
  test('a character split across two chunks is not corrupted', () => {
    const harness = makeActor(64);
    // 'ä' is C3 A4 — the chunk boundary falls between the two bytes.
    harness.feedChunk(new Uint8Array([0x61, 0x0a, 0xc3]));   // 'a\n' + lead byte
    expect(harness.delivered).toEqual(['a']);
    harness.feedChunk(new Uint8Array([0xa4, 0x0a]));         // continuation + '\n'
    expect(harness.delivered).toEqual(['a', 'ä']);
    expect(harness.state.lost).toBeNull();
    expect(harness.pendingBytes()).toBe(0);
  });

  test('a line assembled from many chunks arrives once, whole', () => {
    const harness = makeActor(64);
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
    expect(harness.pendingBytes()).toBe(0);
  });
});

/** A `length-prefixed` header announcing `length` payload bytes, and no payload. */
function lengthHeader(length: number): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, length, false);
  return header;
}

// The dispatch every TCP actor and `TcpInboundBuffer` go through.  The cap is
// checked against the declared length, so a header past it is refused before
// any payload is waited for — but only if the cap handed to the extractor is
// the configured one.  Read off a field that no longer exists, or not read at
// all, it is the 16 MiB default, and every frame below that is taken.
describe('extractFrames — a length-prefixed framing applies its own maxFrameBytes', () => {
  test('a declared length past the configured cap is refused, though the default would take it', () => {
    const extraction = extractFrames(lengthHeader(100), { kind: 'length-prefixed', maxFrameBytes: 64 });
    expect(extraction.overflow).toBe('frame exceeds maxFrameBytes=64');
    expect(extraction.frames).toEqual([]);
    expect(extraction.consumed).toBe(0);
    expect(100).toBeLessThan(DEFAULT_MAX_FRAME_BYTES);
  });

  test('a frame at the configured cap is taken', () => {
    const frame = new Uint8Array(4 + 64);
    frame.set(lengthHeader(64));
    const extraction = extractFrames(frame, { kind: 'length-prefixed', maxFrameBytes: 64 });
    expect(extraction.overflow).toBeUndefined();
    expect(extraction.frames).toHaveLength(1);
    expect(extraction.consumed).toBe(68);
  });

  test('an unset cap is the shipped default', () => {
    const atDefault = extractFrames(lengthHeader(DEFAULT_MAX_FRAME_BYTES), { kind: 'length-prefixed' });
    expect(atDefault.overflow).toBeUndefined();
    const pastDefault = extractFrames(lengthHeader(DEFAULT_MAX_FRAME_BYTES + 1), { kind: 'length-prefixed' });
    expect(pastDefault.overflow).toBe(`frame exceeds maxFrameBytes=${DEFAULT_MAX_FRAME_BYTES}`);
  });
});

/**
 * A framing object TypeScript never saw: parsed from JSON, built in plain
 * JavaScript, or cast.  The compiler's excess-property check covers a fresh
 * literal only, so these are the shapes that reach a validator unchecked.
 */
function fromJson(json: string): TcpFraming {
  return JSON.parse(json) as TcpFraming;
}

// #1443 renamed the two caps' fields along with their HOCON leaves.  An object
// that still carries an old field used to start the actor with the field
// ignored and the default cap in force; it is refused instead, by the rule both
// TCP options validators share.
describe('findFramingViolation — a retired cap field or an unknown kind is refused', () => {
  test.each([
    { json: '{"kind":"length-prefixed","maxFrameLen":64}', field: 'framing.maxFrameLen', current: 'maxFrameBytes' },
    { json: '{"kind":"lines","maxLineLen":64}', field: 'framing.maxLineLen', current: 'maxLineBytes' },
    // Under the other kind too: the field is gone whichever strategy it sits beside.
    { json: '{"kind":"lines","maxFrameLen":64}', field: 'framing.maxFrameLen', current: 'maxFrameBytes' },
    { json: '{"kind":"bytes","maxLineLen":64}', field: 'framing.maxLineLen', current: 'maxLineBytes' },
    // Beside its replacement as well, which it would otherwise pass for.
    {
      json: '{"kind":"length-prefixed","maxFrameBytes":64,"maxFrameLen":64}',
      field: 'framing.maxFrameLen',
      current: 'maxFrameBytes',
    },
  ])('$json names $field and its replacement', ({ json, field, current }) => {
    const violation = findFramingViolation(fromJson(json));
    expect(violation?.field).toBe(field);
    expect(violation?.reason).toContain(current);
    expect(violation?.value).toBe(64);
  });

  test('a retired field holding undefined sets nothing, and is not refused', () => {
    const framing = { kind: 'length-prefixed', maxFrameBytes: 64, maxFrameLen: undefined } as unknown as TcpFraming;
    expect(findFramingViolation(framing)).toBeUndefined();
  });

  test.each(['line', 'length_prefixed', 'lengthPrefixed', 'Bytes', '', 'toString'])(
    'kind %p is refused, naming the kinds there are',
    (kind) => {
      const violation = findFramingViolation(fromJson(JSON.stringify({ kind })));
      expect(violation?.field).toBe('framing.kind');
      expect(violation?.reason).toContain("'bytes', 'lines' or 'length-prefixed'");
      expect(violation?.value).toBe(kind);
    },
  );

  test('a missing or non-string kind is refused too', () => {
    expect(findFramingViolation(fromJson('{}'))?.field).toBe('framing.kind');
    expect(findFramingViolation(fromJson('{"kind":1}'))?.field).toBe('framing.kind');
  });

  test('the three kinds there are pass', () => {
    for (const json of ['{"kind":"bytes"}', '{"kind":"lines"}', '{"kind":"length-prefixed"}']) {
      expect(findFramingViolation(fromJson(json))).toBeUndefined();
    }
  });
});
