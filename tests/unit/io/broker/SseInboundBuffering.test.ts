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

  test('an exact drain leaves no seam for the next chunk to hide behind', () => {
    // The residual path with nothing left over.  A buffer that kept an empty
    // residual as a part would offer a `''` seam, and the very next newline
    // would then have to be checked against it — this pins that a drained
    // buffer starts the next event clean.
    const buffer = new SseEventBuffer();
    expect(buffer.push('data: a\n\n')).toEqual(['data: a']);
    expect(buffer.pendingLength()).toBe(0);

    expect(buffer.push('\n')).toEqual([]);
    expect(buffer.pendingLength()).toBe(1);
    expect(buffer.push('\n')).toEqual(['']);
    expect(buffer.pendingLength()).toBe(0);
  });
});
