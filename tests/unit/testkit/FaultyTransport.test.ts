import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport, type Transport, type WireHandler } from '../../../src/cluster/Transport.js';
import { FaultyTransport } from '../../../src/testkit/FaultyTransport.js';
import { FaultyTransportOptions } from '../../../src/testkit/FaultyTransportOptions.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #1023 — the fault-injection layer, driven against a recording transport.
 *
 * The decorator's whole promise is that a failing chaos run reproduces from
 * its seed, so most of what is asserted here is *determinism*: the same seed
 * must produce the same losses, and a different seed must produce different
 * ones. A generator that ignored its seed would satisfy the first half alone,
 * which is why both directions are checked every time.
 *
 * The inner transport is a recorder rather than a real one because the subject
 * is which frames are handed on, in which order, at which time — and a real
 * transport would answer that question through a microtask, adding a second
 * source of ordering to a test about ordering.
 */

const address = (name: string): NodeAddress => new NodeAddress(name, '127.0.0.1', 2552);

const frame = (seq: number): WireMessage => ({
  kind: 'heartbeat',
  from: { systemName: 'a', host: '127.0.0.1', port: 2552 },
  seq,
  ts: 0,
});

/** Records what reached it, in the order it reached it. */
class RecordingTransport implements Transport {
  readonly delivered: Array<{ to: string; seq: number }> = [];
  handler: WireHandler = () => { /* no-op */ };
  shutdownCount = 0;

  constructor(readonly self: NodeAddress) {}

  setHandler(handler: WireHandler): void { this.handler = handler; }
  async start(): Promise<void> { /* nothing to open */ }
  async shutdown(): Promise<void> { this.shutdownCount++; }
  send(to: NodeAddress, message: WireMessage): void {
    this.delivered.push({ to: to.toString(), seq: (message as { seq: number }).seq });
  }
  disconnect(): void { /* stateless */ }
  peers(): NodeAddress[] { return []; }

  /** The `seq` numbers delivered to `peer`, in arrival order. */
  seqsTo(peer: NodeAddress): number[] {
    return this.delivered.filter((row) => row.to === peer.toString()).map((row) => row.seq);
  }
}

/** Send `count` frames through a link and report what the inner transport saw. */
function run(
  options: Parameters<typeof FaultyTransport.prototype.send> extends never ? never
    : ConstructorParameters<typeof FaultyTransport>[1],
  count = 100,
  peer = address('b'),
): { inner: RecordingTransport; link: FaultyTransport; seqs: number[] } {
  const inner = new RecordingTransport(address('a'));
  const link = new FaultyTransport(inner, options);
  for (let seq = 0; seq < count; seq++) link.send(peer, frame(seq));
  link.flush();
  return { inner, link, seqs: inner.seqsTo(peer) };
}

describe('a clean link changes nothing', () => {
  test('every frame is handed on, once, in order', () => {
    const { seqs } = run({});
    expect(seqs).toEqual(Array.from({ length: 100 }, (_unused, index) => index));
  });

  test('a link configured with all-zero faults is still clean', () => {
    // The defaults spelled out. This is the case the fast path in `send`
    // takes, and it must be indistinguishable from the undecorated transport.
    const { seqs, link } = run(FaultyTransportOptions.create()
      .withDropProbability(0)
      .withDuplicateProbability(0)
      .withReorderWindow(0)
      .withLatencyMs(0));
    expect(link.hasFaults).toBe(false);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_unused, index) => index));
  });

  test('the decorator forwards the rest of the contract to the inner transport', () => {
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner);
    expect(link.self).toBe(inner.self);
    const handler: WireHandler = () => { /* no-op */ };
    link.setHandler(handler);
    expect(inner.handler).toBe(handler);
  });
});

describe('loss', () => {
  test('a drop probability loses roughly that fraction', () => {
    const { seqs } = run({ dropProbability: 0.3, seed: 7 }, 1_000);
    // A wide band on purpose: this asserts the knob is connected and points
    // the right way, not that mulberry32 is uniform — which is a property of
    // the generator, not of this repository.
    expect(seqs.length).toBeGreaterThan(600);
    expect(seqs.length).toBeLessThan(800);
  });

  test('the same seed loses exactly the same frames', () => {
    const first = run({ dropProbability: 0.3, seed: 7 }, 200);
    const second = run({ dropProbability: 0.3, seed: 7 }, 200);
    expect(second.seqs).toEqual(first.seqs);
  });

  test('a different seed loses different ones', () => {
    // Without this the test above is satisfied by a generator that ignores the
    // seed entirely, which is the failure that turns a chaos test into a
    // constant.
    const first = run({ dropProbability: 0.3, seed: 7 }, 200);
    const other = run({ dropProbability: 0.3, seed: 8 }, 200);
    expect(other.seqs).not.toEqual(first.seqs);
  });

  test('a drop probability of 1 is a severed link, and of 0 is a clean one', () => {
    expect(run({ dropProbability: 1 }, 50).seqs).toEqual([]);
    expect(run({ dropProbability: 0 }, 50).seqs).toHaveLength(50);
  });
});

describe('duplication', () => {
  test('some frames arrive twice and none is lost', () => {
    const { seqs } = run({ duplicateProbability: 0.5, seed: 11 }, 200);
    expect(seqs.length).toBeGreaterThan(200);
    // Duplication must not lose anything: every original is still there.
    expect(new Set(seqs).size).toBe(200);
  });

  test('a duplicate probability of 1 delivers everything exactly twice', () => {
    const { seqs } = run({ duplicateProbability: 1 }, 20);
    expect(seqs).toHaveLength(40);
    expect(seqs.filter((seq) => seq === 3)).toHaveLength(2);
  });
});

describe('reordering', () => {
  test('a window permutes the order without losing or inventing frames', () => {
    const { seqs } = run({ reorderWindow: 4, seed: 3 }, 60);
    expect(seqs).not.toEqual(Array.from({ length: 60 }, (_unused, index) => index));
    expect([...seqs].sort((a, b) => a - b))
      .toEqual(Array.from({ length: 60 }, (_unused, index) => index));
  });

  test('the window bounds how far a frame can be displaced', () => {
    // The reason it is a window and not a shuffle: a frame cannot be permuted
    // to the end of the run and leave a test waiting for it.
    const window = 4;
    const { seqs } = run({ reorderWindow: window, seed: 3 }, 60);
    for (const [position, seq] of seqs.entries()) {
      expect(Math.abs(position - seq)).toBeLessThan(window);
    }
  });

  test('a window of zero keeps strict send order', () => {
    const { seqs } = run({ reorderWindow: 0 }, 30);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_unused, index) => index));
  });

  test('flush releases what the window is still holding', () => {
    // Without the flush the last `window` frames sit in the buffer, which is
    // correct behaviour for a depth and a hang for a test that stops sending.
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, { reorderWindow: 4 });
    for (let seq = 0; seq < 10; seq++) link.send(address('b'), frame(seq));
    expect(inner.seqsTo(address('b'))).toHaveLength(8);
    link.flush();
    expect(inner.seqsTo(address('b'))).toHaveLength(10);
  });
});

describe('latency', () => {
  test('nothing arrives until the scheduler is advanced past it', () => {
    const scheduler = new ManualScheduler();
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, { latencyMs: 50, scheduler });

    link.send(address('b'), frame(1));
    expect(inner.delivered).toHaveLength(0);

    scheduler.advance(49);
    expect(inner.delivered).toHaveLength(0);

    scheduler.advance(1);
    expect(inner.seqsTo(address('b'))).toEqual([1]);
  });

  test('a slow link and a clean one to different peers are independently timed', () => {
    // The case a failure detector exists for: one peer slow, one peer fine.
    const scheduler = new ManualScheduler();
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, {
      scheduler,
      perPeer: { [address('slow').toString()]: { latencyMs: 100 } },
    });

    link.send(address('slow'), frame(1));
    link.send(address('fast'), frame(2));
    expect(inner.seqsTo(address('fast'))).toEqual([2]);
    expect(inner.seqsTo(address('slow'))).toEqual([]);

    scheduler.advance(100);
    expect(inner.seqsTo(address('slow'))).toEqual([1]);
  });

  test('a frame in flight when the transport shuts down is not delivered', async () => {
    // A node that went away must not still be heard from, which is exactly
    // what a crash test asserts.
    const scheduler = new ManualScheduler();
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, { latencyMs: 50, scheduler });

    link.send(address('b'), frame(1));
    await link.shutdown();
    scheduler.advance(100);

    expect(inner.delivered).toEqual([]);
    expect(inner.shutdownCount).toBe(1);
  });
});

describe('per-peer profiles', () => {
  test('a named peer uses its own profile and the others use the top-level one', () => {
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, {
      dropProbability: 1,
      perPeer: { [address('spared').toString()]: { dropProbability: 0 } },
    });

    link.send(address('doomed'), frame(1));
    link.send(address('spared'), frame(2));

    expect(inner.seqsTo(address('doomed'))).toEqual([]);
    expect(inner.seqsTo(address('spared'))).toEqual([2]);
  });

  test('a per-peer profile replaces the top-level one rather than merging', () => {
    // Stated as a test because the other choice is defensible and this one is
    // what the options document: a link's profile is readable in one place.
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, {
      duplicateProbability: 1,
      perPeer: { [address('b').toString()]: { dropProbability: 0 } },
    });

    link.send(address('b'), frame(1));
    // If the profiles merged, the top-level duplicate would still apply here.
    expect(inner.seqsTo(address('b'))).toEqual([1]);
  });

  test("one link's reorder window does not delay another peer's frames", () => {
    const inner = new RecordingTransport(address('a'));
    const link = new FaultyTransport(inner, {
      perPeer: { [address('slowed').toString()]: { reorderWindow: 8 } },
    });

    link.send(address('slowed'), frame(1));
    link.send(address('other'), frame(2));

    expect(inner.seqsTo(address('other'))).toEqual([2]);
    expect(inner.seqsTo(address('slowed'))).toEqual([]);
  });
});

describe('the options refuse what cannot work', () => {
  test.each([
    ['a drop probability above 1', { dropProbability: 20 }],
    ['a negative drop probability', { dropProbability: -0.5 }],
    ['a duplicate probability above 1', { duplicateProbability: 2 }],
    ['a fractional reorder window', { reorderWindow: 1.5 }],
    ['a negative reorder window', { reorderWindow: -1 }],
    ['a negative latency', { latencyMs: -1 }],
  ])('%s is refused', (_label, options) => {
    expect(() => new FaultyTransport(new RecordingTransport(address('a')), options))
      .toThrow(OptionsError);
  });

  test('a percentage written as a probability is refused rather than read as a partition', () => {
    // `withDropProbability(20)` meaning "20 %" would drop every frame and
    // present as a severed link — the one thing this decorator exists to tell
    // apart from a loss rate.
    expect(() => new FaultyTransport(new RecordingTransport(address('a')), { dropProbability: 20 }))
      .toThrow(/dropProbability/);
  });

  test('a latency with no scheduler is refused rather than taken from the wall clock', () => {
    expect(() => new FaultyTransport(new RecordingTransport(address('a')), { latencyMs: 10 }))
      .toThrow(/scheduler/);
  });

  test('a bad per-peer profile names the peer it came from', () => {
    expect(() => new FaultyTransport(new RecordingTransport(address('a')), {
      perPeer: { 'b@127.0.0.1:2552': { dropProbability: 5 } },
    })).toThrow(/b@127\.0\.0\.1:2552/);
  });
});

describe('it decorates any transport, which is why it is a decorator', () => {
  test('an InMemoryTransport gains the controls without growing a line', async () => {
    // The acceptance criterion of #1023: `InMemoryTransport` had no fault hook
    // at all, and still has none — the controls come from the wrapper.
    const receiver = new InMemoryTransport(new NodeAddress('receiver', '127.0.0.1', 2662));
    const received: number[] = [];
    receiver.setHandler((_from, message) => { received.push((message as { seq: number }).seq); });
    await receiver.start();

    const sender = new InMemoryTransport(new NodeAddress('sender', '127.0.0.1', 2663));
    await sender.start();
    const link = new FaultyTransport(sender, { dropProbability: 1 });

    link.send(receiver.self, frame(1));
    await Promise.resolve();
    expect(received).toEqual([]);

    // And the same transport, undecorated, still delivers — so the empty
    // result above is the wrapper's doing and not a broken fixture.
    sender.send(receiver.self, frame(2));
    await awaitCondition(() => received.length > 0, {
      timeoutMs: 5_000,
      intervalMs: 1,
      label: 'the undecorated transport delivered its frame',
    });
    expect(received).toEqual([2]);

    await sender.shutdown();
    await receiver.shutdown();
    // A declared cap, because the poll above carries a 5 000 ms budget and
    // bun's undeclared default is also 5 000 — so the budget could never
    // report, and `AwaitConditionBudgets` says so.
  }, 15_000);

  test('the seed is readable, so a failure can name what reproduces it', () => {
    const link = new FaultyTransport(new RecordingTransport(address('a')), { seed: 4_242 });
    expect(link.seed).toBe(4_242);
  });
});
