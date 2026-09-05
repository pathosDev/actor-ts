/**
 * What one inbound chunk *costs* the SSE client, and what it must still parse
 * correctly afterwards (#749).
 *
 * The defect: `consume` accumulated into a `string` with `buffer += chunk` and
 * searched it with `buffer.indexOf('\n\n')` from index 0 on every read, so a
 * server that dribbles bytes and never sends the blank line makes each read
 * cost the whole pending buffer — and the cap that bounds that buffer is a
 * mebibyte, so it sets the ceiling rather than lowering it.
 *
 * **Why characters touched and not milliseconds.**  A wall-clock budget over a
 * scan loop is a flake generator: it moves with the machine, the runtime and
 * whatever else the box is doing.  The quantity the defect is about is
 * characters the implementation makes the engine touch, and that is
 * measurable without a clock — every candidate implementation reaches the
 * accumulation through `String.prototype.indexOf`, `String.prototype.slice` or
 * `Array.prototype.join`, so wrapping those three counts it.
 *
 * **Why `indexOf` is charged its receiver's whole length** and not the window
 * after its `fromIndex`.  That is the honest cost, and it is the half of the
 * fix a naive scan offset misses.  `buffer += chunk` leaves a rope behind, and
 * the first method call that reaches into it flattens the entire accumulation
 * before it looks at anything — so passing an offset narrows what is searched
 * while the string under it is still materialised, once per read.  Charging
 * the receiver is what makes this file able to tell the two apart; charging
 * the window would score the offset-only fix as linear and bind nothing.
 * `slice` and `join` are charged what they produce, which is what they copy.
 *
 * The budget is over-generous on purpose: the difference at stake is between
 * "a small multiple of what arrived" and "a multiple of the read count", which
 * is three orders of magnitude here, not a tight constant.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { SseActor } from '../../../../src/io/broker/SseActor.js';
import type { SseEvent } from '../../../../src/io/broker/SseActor.js';
import { SseEventBuffer } from '../../../../src/io/broker/SseEventBuffer.js';
import type { SseOptionsType } from '../../../../src/io/broker/SseOptions.js';

/**
 * An SSE actor with resolved options but no system, no connection and no
 * start.
 *
 * `BrokerActor.options` throws before `preStart`, and starting the actor would
 * mean a real `fetch` — so the resolved settings are supplied by overriding
 * the accessor.  `consume` is the read loop `connectImplementation` hands the
 * response body to, and it is what these tests drive; the loss report it makes
 * on its way out is captured rather than turned into a reconnect cycle, which
 * needs a running system.
 */
class ProbeSseActor extends SseActor {
  readonly lost: string[] = [];
  private readonly resolved: SseOptionsType;

  constructor(resolved: SseOptionsType) {
    super(resolved);
    this.resolved = resolved;
  }

  protected override get options(): SseOptionsType {
    return this.resolved;
  }

  protected override handleConnectionLost(cause?: Error): void {
    this.lost.push(cause?.message ?? '<no cause>');
  }

  /** Run the read loop over `stream` to completion, as a live connect does. */
  async consumeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const internals = this as unknown as {
      streamRunning: boolean;
      consume(source: ReadableStream<Uint8Array>): Promise<void>;
    };
    internals.streamRunning = true;
    await internals.consume(stream);
  }
}

/** Collects what the actor pushes at its `target`, without an ActorSystem. */
function collectingTarget(received: SseEvent[]): ActorRef<SseEvent> {
  return { tell: (message: SseEvent) => { received.push(message); } } as unknown as ActorRef<SseEvent>;
}

/** A response body that hands out `chunks` and then ends, exactly as `fetch` does. */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * A body that produces `chunk` on demand, at most `count` times, and reports
 * how many times it was asked.
 *
 * Enqueuing up front the way {@link streamOf} does cannot answer the question
 * the cap tests need answered — a queued chunk exists whether or not the read
 * loop ever asks for it — and "the loop stopped early" is the whole claim.  The
 * default queuing strategy reads one chunk ahead, so `pulled()` is the read
 * count plus at most one; every assertion below is an upper bound for that
 * reason.
 */
function pullStreamOf(chunk: Uint8Array, count: number): {
  readonly stream: ReadableStream<Uint8Array>;
  pulled(): number;
} {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (pulls >= count) { controller.close(); return; }
      pulls++;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulled: (): number => pulls };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Characters touched through the string primitives while `body` runs.
 *
 * The patch is installed and removed around an awaited body, which the
 * synchronous version of this helper in `TcpInboundBuffering.test.ts` avoids —
 * a read loop cannot be driven synchronously.  It is safe here for a narrower
 * reason: every wrapper delegates faithfully, so nothing observes different
 * behaviour, and the stream is entirely in memory, so each `read()` settles on
 * the microtask queue without a turn of the event loop in which foreign work
 * could run.  Any that did could only inflate the count, and the budget below
 * has three orders of magnitude of room.
 */
async function countTouchedCharacters(body: () => Promise<void>): Promise<number> {
  const originalIndexOf = String.prototype.indexOf;
  const originalSlice = String.prototype.slice;
  const originalJoin = Array.prototype.join;
  let touched = 0;
  String.prototype.indexOf = function (this: string, search: string, from?: number): number {
    touched += this.length;
    return originalIndexOf.call(this, search, from);
  };
  String.prototype.slice = function (this: string, start?: number, end?: number): string {
    const result = originalSlice.call(this, start, end);
    touched += result.length;
    return result;
  };
  Array.prototype.join = function (this: unknown[], separator?: string): string {
    const result = originalJoin.call(this, separator);
    touched += result.length;
    return result;
  } as typeof Array.prototype.join;
  try {
    await body();
  } finally {
    String.prototype.indexOf = originalIndexOf;
    String.prototype.slice = originalSlice;
    Array.prototype.join = originalJoin;
  }
  return touched;
}

const CHUNK_CHARS = 64;
const CHUNK_COUNT = 4_096;
const STREAM_CHARS = CHUNK_CHARS * CHUNK_COUNT;   // 256 KiB, well under the 1 MiB cap

describe('SseActor — what a delimiter-free stream costs (#749)', () => {
  test('scanning is linear in the characters received, not quadratic', async () => {
    // 256 KiB of delimiter-free characters in 64-character chunks — a feed
    // that never terminates an event, staying inside the 1 MiB cap the whole
    // way, so nothing here is a cap breach.  Re-searching the accumulation per
    // read touches 64 * (1+2+…+4096) characters, i.e. ~512 MiB to receive
    // 256 KiB.  Searching only the arriving chunk plus its seam touches each
    // character once — measured at 1.02x.
    const received: SseEvent[] = [];
    const actor = new ProbeSseActor({ target: collectingTarget(received) });
    const chunk = encode('x'.repeat(CHUNK_CHARS));
    const stream = streamOf(Array.from({ length: CHUNK_COUNT }, () => chunk));

    const touched = await countTouchedCharacters(async () => {
      await actor.consumeStream(stream);
    });

    // No event can have completed — there is no delimiter in the stream.
    expect(received).toEqual([]);
    // Sanity floor: every character has to be looked at at least once, so a
    // counter that observed nothing fails here rather than passing the budget
    // below vacuously.
    expect(touched).toBeGreaterThanOrEqual(STREAM_CHARS);
    // The budget.  Linear scanning lands at 1.02x; the rescan was 2048x.
    expect(touched).toBeLessThanOrEqual(STREAM_CHARS * 20);
    // And the stream ending is still reported, once.
    expect(actor.lost).toEqual(['SSE stream ended']);
  });

  test('a delimiter split across two reads still ends the event', async () => {
    // The seam, and the reason a scan offset must resume one character *before*
    // the join: `\n\n` arriving as a `\n` at the end of one read and a `\n` at
    // the start of the next is invisible to a search that restarts at the
    // previous length.  Both events here are delimited exactly that way, so an
    // off-by-one in the resume point delivers neither.
    const received: SseEvent[] = [];
    const actor = new ProbeSseActor({ target: collectingTarget(received) });

    await actor.consumeStream(streamOf([
      encode('data: first\n'),
      encode('\ndata: second\n'),
      encode('\n'),
    ]));

    expect(received).toEqual([
      { event: 'message', data: 'first', id: undefined },
      { event: 'message', data: 'second', id: undefined },
    ]);
  });

  test('and a whole event arriving one character at a time still parses once', async () => {
    // The other shape of the same hazard: every seam is a chunk boundary, so
    // the delimiter is straddled and the fields are split mid-token too.
    const received: SseEvent[] = [];
    const actor = new ProbeSseActor({ target: collectingTarget(received) });
    const wire = 'event: tick\ndata: {"n":1}\nid: 100\n\n';

    await actor.consumeStream(streamOf([...wire].map(encode)));

    expect(received).toEqual([{ event: 'tick', data: '{"n":1}', id: '100' }]);
  });
});

/**
 * The actor's own bound on `SseEventBuffer`, mirrored.
 *
 * Kept as a literal rather than exported from `SseActor.ts`: the assertions
 * below match the refusal message *including this number*, so a change to the
 * constant fails these tests naming the value it moved to, which is what keeps
 * the mirror honest without widening the module's surface for a test.
 */
const SSE_MAX_BUFFER_CHARS = 1_048_576;

const CAP_BREACH_MESSAGE =
  `SSE event buffer exceeded ${SSE_MAX_BUFFER_CHARS} chars without a delimiter`;

describe('SseActor — the pending-buffer cap (BRK-2)', () => {
  test('a feed that never delimits is cut off at the cap, not read to the end', async () => {
    // The BRK-2 shape: a hostile or MITM'd endpoint streams bytes and never
    // sends the blank line, so `pendingLength()` grows with every read.  The
    // cap is what turns an unbounded allocation into a lost connection the
    // reconnect machinery can act on — and #749 only bounded the *work* spent
    // reaching it, so nothing here is subsumed by the linearity test above.
    const chunkChars = 64 * 1024;
    const chunksToTheCap = SSE_MAX_BUFFER_CHARS / chunkChars;   // 16
    const received: SseEvent[] = [];
    const actor = new ProbeSseActor({ target: collectingTarget(received) });
    // Four times the cap on offer, so "it stopped" and "it ran out of body"
    // cannot be confused.
    const body = pullStreamOf(encode('x'.repeat(chunkChars)), chunksToTheCap * 4);

    await actor.consumeStream(body.stream);

    expect(actor.lost).toEqual([CAP_BREACH_MESSAGE]);
    // The read loop left the rest of the body on the wire.  `+ 2` is the
    // read-ahead plus the chunk that trips the cap; the point is that it is
    // nowhere near the 64 on offer.
    expect(body.pulled()).toBeLessThanOrEqual(chunksToTheCap + 2);
    expect(received).toEqual([]);
  });

  test('a single chunk larger than the cap is refused before any of it is buffered', async () => {
    // The cap is measured on what the arriving chunk *would* make pending —
    // `pendingLength() + text.length` — and not on what is already there.
    // Dropping the second term still bounds the buffer eventually, but it lets
    // one attacker-chosen chunk through first: the endpoint picks the chunk
    // size, so "eventually" is a number it controls, not one this actor does.
    const received: SseEvent[] = [];
    const actor = new ProbeSseActor({ target: collectingTarget(received) });
    const body = pullStreamOf(encode('x'.repeat(SSE_MAX_BUFFER_CHARS + 1)), 4);

    await actor.consumeStream(body.stream);

    expect(actor.lost).toEqual([CAP_BREACH_MESSAGE]);
    // One read reached the loop; the read-ahead may have produced a second.
    // What matters is that the breach was reported on the chunk that caused
    // it, rather than after it had been added to the buffer.
    expect(body.pulled()).toBeLessThanOrEqual(2);
  });
});

/**
 * Characters *copied* while `body` runs — what `slice` and `join` produce, and
 * nothing else.
 *
 * A narrower model than {@link countTouchedCharacters} on purpose, and the two
 * are not interchangeable.  That one charges `indexOf` its receiver's whole
 * length, which is the honest cost of the rope `buffer += chunk` leaves behind
 * and the only way to tell a scan offset from the fix — but the shipped cut
 * *also* calls `indexOf` on the whole accumulation, once per block, so under
 * that model the moving start index and the per-block re-slice score the same
 * and it binds neither.  What separates them is copying: the cut below
 * produces each character exactly once, a re-slice of the remainder produces
 * the tail again per block.
 */
function countCopiedCharacters(body: () => void): number {
  const originalSlice = String.prototype.slice;
  const originalJoin = Array.prototype.join;
  let copied = 0;
  String.prototype.slice = function (this: string, start?: number, end?: number): string {
    const result = originalSlice.call(this, start, end);
    copied += result.length;
    return result;
  };
  Array.prototype.join = function (this: unknown[], separator?: string): string {
    const result = originalJoin.call(this, separator);
    copied += result.length;
    return result;
  } as typeof Array.prototype.join;
  try {
    body();
  } finally {
    String.prototype.slice = originalSlice;
    Array.prototype.join = originalJoin;
  }
  return copied;
}

const ONE_EVENT = 'data: 0123456789\n\n';        // 18 chars, delimiter included

describe('SseEventBuffer — what cutting an event out of the buffer copies', () => {
  test('one chunk carrying many events copies each character once', () => {
    // The half of #749 that lives in the cut rather than in the search.  The
    // JSDoc on `splitCompletedBlocks` says re-slicing the remainder per block
    // "would put the quadratic back for a chunk carrying many events" — this is
    // that chunk.  Measured: the moving start index copies 0.89x the arriving
    // characters (the delimiters are cut out rather than copied); re-slicing
    // the remainder copies 2000x at this event count, because every block
    // rebuilds the whole tail behind it.
    const eventCount = 4_000;
    const chunk = ONE_EVENT.repeat(eventCount);
    const buffer = new SseEventBuffer();
    let blocks: string[] = [];

    const copied = countCopiedCharacters(() => { blocks = buffer.push(chunk); });

    expect(blocks).toHaveLength(eventCount);
    expect(blocks[0]).toBe('data: 0123456789');
    expect(blocks.at(-1)).toBe('data: 0123456789');
    // Sanity floor: every completed block is a copy, so a counter that
    // observed nothing fails here rather than passing the budget vacuously.
    expect(copied).toBeGreaterThanOrEqual(chunk.length / 2);
    expect(copied).toBeLessThanOrEqual(chunk.length * 2);
  });

  test('a feed that drains exactly on every event copies each character once', () => {
    // The ordinary shape of a well-behaved server: one write per event, so
    // every read completes exactly one block and leaves an empty residual.
    // Dropping the residual entirely rather than keeping `['']` as a part is
    // what holds this at one copy per character — a buffer that kept the empty
    // seam has two parts on the next read, so the cut joins them and copies
    // the whole chunk a second time before cutting it.  Measured: 0.89x kept,
    // 1.89x with `this.parts = [residual]` unconditionally.
    const reads = 2_000;
    const buffer = new SseEventBuffer();

    const copied = countCopiedCharacters(() => {
      for (let read = 0; read < reads; read++) {
        if (buffer.push(ONE_EVENT).length !== 1) throw new Error('expected one block per read');
      }
    });

    expect(buffer.pendingLength()).toBe(0);
    expect(copied).toBeGreaterThan(0);
    expect(copied).toBeLessThanOrEqual(reads * ONE_EVENT.length);
  });
});

describe('SseEventBuffer', () => {
  test('accumulates chunks in order, whatever the boundaries', () => {
    const buffer = new SseEventBuffer();
    for (const part of ['data: a', 'b', 'c']) {
      expect(buffer.push(part)).toEqual([]);
    }
    expect(buffer.pendingLength()).toBe(9);
    expect(buffer.push('\n\n')).toEqual(['data: abc']);
    expect(buffer.pendingLength()).toBe(0);
  });

  test('one chunk carrying several events yields them all, in order', () => {
    const buffer = new SseEventBuffer();
    expect(buffer.push('a\n\nb\n\nc')).toEqual(['a', 'b']);
    // The trailing partial event stays pending, and nothing before it does.
    expect(buffer.pendingLength()).toBe(1);
  });

  test('an empty chunk changes nothing', () => {
    // `TextDecoder.decode` returns `''` for a chunk that is entirely the lead
    // bytes of a multi-byte character, and that must not disturb the seam.
    const buffer = new SseEventBuffer();
    buffer.push('data: a\n');
    expect(buffer.push('')).toEqual([]);
    expect(buffer.pendingLength()).toBe(8);
    expect(buffer.push('\n')).toEqual(['data: a']);
  });

  test('an exact drain restarts the delimiter search cleanly', () => {
    // The residual path with nothing left over: a drained buffer must treat
    // the next `\n` as the *first* character of a delimiter and not as the
    // second half of the one that just drained.
    //
    // What this does NOT pin is `splitCompletedBlocks`' `residual.length === 0
    // ? [] : [residual]` — keeping `['']` as a part yields the same `''` seam
    // (`''[-1] ?? ''`) and the same `pendingLength()`, so this test passes
    // either way.  That guard is a copying decision, and the test that
    // discriminates it counts copied characters, above.
    const buffer = new SseEventBuffer();
    expect(buffer.push('data: a\n\n')).toEqual(['data: a']);
    expect(buffer.pendingLength()).toBe(0);

    expect(buffer.push('\n')).toEqual([]);
    expect(buffer.pendingLength()).toBe(1);
    expect(buffer.push('\n')).toEqual(['']);
    expect(buffer.pendingLength()).toBe(0);
  });
});
