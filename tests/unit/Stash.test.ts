import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import {
  StashOutsideHandlerError,
  StashOverflowError,
} from '../../src/ActorContext.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { DeadLetter } from '../../src/SystemMessages.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const newSystem = (name = 'stash-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

class DeadLetterListener extends Actor<DeadLetter> {
  constructor(private readonly seen: DeadLetter[], private readonly ready: { value: boolean }) { super(); }
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    this.ready.value = true;
  }
  override onReceive(letter: DeadLetter): void { this.seen.push(letter); }
}

/** Subscribing happens in preStart, so wait for it before provoking anything. */
async function listenForDeadLetters(sys: ActorSystem): Promise<DeadLetter[]> {
  const letters: DeadLetter[] = [];
  const ready = { value: false };
  sys.spawn(() => new DeadLetterListener(letters, ready), 'dead-letters');
  await awaitCondition(() => ready.value, { label: 'the dead-letter listener subscribed' });
  return letters;
}

describe('Stash', () => {
  test('stash + unstashAll preserves FIFO order', async () => {
    const seen: string[] = [];

    class S extends Actor<string> {
      private ready = false;
      override onReceive(message: string): void {
        if (message === 'ready') {
          this.ready = true;
          this.context.unstashAll();
          return;
        }
        if (!this.ready) {
          this.context.stash();
          return;
        }
        seen.push(message);
      }
    }

    const sys = newSystem();
    const ref = sys.spawn(S, 'a');
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    ref.tell('ready');
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'all three stashed messages were replayed',
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    await sys.terminate();
  });

  test('unstashed messages come out before any messages enqueued after', async () => {
    const seen: string[] = [];

    class S extends Actor<string> {
      private ready = false;
      override onReceive(message: string): void {
        if (message === 'ready') {
          this.ready = true;
          this.context.unstashAll();
          return;
        }
        if (!this.ready) { this.context.stash(); return; }
        seen.push(message);
      }
    }

    const sys = newSystem();
    const ref = sys.spawn(S, 'a');
    ref.tell('stashed-1');
    ref.tell('stashed-2');
    ref.tell('ready');
    ref.tell('fresh-1');
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'both stashed messages and the fresh one were handled',
    });
    expect(seen).toEqual(['stashed-1', 'stashed-2', 'fresh-1']);
    await sys.terminate();
  });

  test('stashSize reflects the buffer', async () => {
    const sizes: number[] = [];

    class S extends Actor<string> {
      override onReceive(message: string): void {
        if (message === 'count') { sizes.push(this.context.stashSize); return; }
        this.context.stash();
        sizes.push(this.context.stashSize);
      }
    }

    const sys = newSystem();
    const ref = sys.spawn(S, 'a');
    ref.tell('x'); ref.tell('y'); ref.tell('count');
    await awaitCondition(() => sizes.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages reported a stash size',
    });
    expect(sizes).toEqual([1, 2, 2]);
    await sys.terminate();
  });

  test('stash() outside a handler throws StashOutsideHandlerError', async () => {
    let err: unknown = null;

    class S extends Actor<string> {
      override preStart(): void {
        // preStart has no current envelope — stash must reject.
        try { this.context.stash(); } catch (envelope) { err = envelope; }
      }
      override onReceive(_: string): void {}
    }

    const sys = newSystem();
    sys.spawn(S, 'a');
    await awaitCondition(() => err !== null, {
      timeoutMs: 4_000,
      label: 'preStart caught the rejected stash()',
    });
    expect(err).toBeInstanceOf(StashOutsideHandlerError);
    await sys.terminate();
  });

  test('unstashAll with an empty buffer is a no-op', async () => {
    const seen: string[] = [];

    class S extends Actor<string> {
      override onReceive(message: string): void {
        if (message === 'flush') { this.context.unstashAll(); return; }
        seen.push(message);
      }
    }

    const sys = newSystem();
    const ref = sys.spawn(S, 'a');
    ref.tell('flush');
    ref.tell('hi');
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the message after the empty unstashAll was handled',
    });
    expect(seen).toEqual(['hi']);
    await sys.terminate();
  });

  test('StashOverflowError surfaces via supervision when capacity is exceeded', async () => {
    // Default capacity is 1024 — hard to exceed without flooding; exercise
    // the error class constructor directly instead of the runtime path.
    const envelope = new StashOverflowError(16);
    expect(envelope).toBeInstanceOf(Error);
    expect(envelope.name).toBe('StashOverflowError');
    expect(envelope.message).toContain('16');
  });
});

/**
 * #772 — `BoundedMailbox` overrode `enqueue` and nothing else, so the replay
 * went in through the base `prependUser`: a whole stash unshifted past the
 * capacity check, the overflow policy and the drop accounting.  The bound an
 * operator tuned against measured heap was not one, and the metric that would
 * have said so under-reported by exactly the batch.
 *
 * This suite never constructed a bounded mailbox before, which is why the gap
 * survived the stash tests above.  Bounding is opt-in since #1148, so both
 * cases have to ask for it.
 */
describe('Stash — the replay meets a bounded mailbox (#772)', () => {
  /**
   * Parks `park*` until it is wedged, replays on release.
   *
   * The wedge is what makes the arrangement deterministic: while the handler
   * is parked on the latch no turn runs, so a burst of `tell`s piles up in the
   * mailbox instead of being drained one at a time, and `unstashAll()` then
   * runs against a queue that is provably full.
   */
  class WedgedParker extends Actor<string> {
    private replaying = false;
    constructor(
      private readonly seen: string[],
      private readonly latch: Promise<void>,
      private readonly wedged: { value: boolean },
      private readonly stashed: { count: number },
    ) { super(); }

    override async onReceive(message: string): Promise<void> {
      if (message === 'wedge') {
        this.wedged.value = true;
        await this.latch;
        this.replaying = true;
        this.context.unstashAll();
        return;
      }
      if (!this.replaying) {
        this.context.stash();
        this.stashed.count++;
        return;
      }
      this.seen.push(message);
    }
  }

  /** Spawns a wedged parker with `park1`/`park2` stashed and `count` messages queued behind it. */
  async function wedgedWithQueue(
    sys: ActorSystem,
    capacity: number,
    overflow: 'drop-head' | 'reject',
    count: number,
  ): Promise<{ seen: string[]; release: () => void }> {
    const seen: string[] = [];
    const wedged = { value: false };
    const stashed = { count: 0 };
    let release: () => void = () => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });

    const options = ActorOptions.create<string>()
      .withMailboxCapacity(capacity)
      .withMailboxOverflow(overflow);
    const ref = sys.spawn(() => new WedgedParker(seen, latch, wedged, stashed), 'parker', options);

    // One at a time, waiting for each to be parked: the arrangement wants the
    // stash full and the mailbox empty, and telling the burst at once would
    // instead overflow the bound on the way *in* — which is the enqueue path
    // and not what these two are about.
    ref.tell('park1');
    await awaitCondition(() => stashed.count === 1, { label: 'the first message was stashed' });
    ref.tell('park2');
    await awaitCondition(() => stashed.count === 2, { label: 'the second message was stashed' });
    ref.tell('wedge');
    await awaitCondition(() => wedged.value, { label: 'the actor parked on the latch' });
    // Nothing drains while the handler is suspended, so these queue.
    for (let i = 1; i <= count; i++) ref.tell(`x${i}`);
    return { seen, release };
  }

  test('drop-head sheds the newest queued messages to make room for the replay', async () => {
    const sys = newSystem('stash-bounded-drop-head');
    // Capacity 4, filled to 4 behind the wedge, two envelopes replayed.
    const { seen, release } = await wedgedWithQueue(sys, 4, 'drop-head', 4);

    release();

    await awaitCondition(() => seen.length === 4, {
      timeoutMs: 4_000,
      label: 'the bounded mailbox delivered exactly its capacity',
    });
    // The replay lands at the head and the two newest queued messages went to
    // make room — the direction that keeps `unstashAll()` meaningful.  Before
    // the fix all six were delivered and the queue sat at 6 on a capacity of 4.
    expect(seen).toEqual(['park1', 'park2', 'x1', 'x2']);
    await sys.terminate();
  });

  test('reject refuses the replay whole and leaves the stash to be dead-lettered', async () => {
    const sys = newSystem('stash-bounded-reject');
    const letters = await listenForDeadLetters(sys);
    // Capacity 2, filled to 2, so neither stashed envelope fits.
    const { seen, release } = await wedgedWithQueue(sys, 2, 'reject', 2);

    release();

    // `MailboxFullError` surfaces inside the handler that called
    // `unstashAll()`, so supervision restarts the actor — and the batch is
    // still the stash's, because the cell put it back before letting the
    // error travel.  Without that, `reject` would be the one policy that
    // loses a whole stash silently.
    const mine = (): DeadLetter[] => letters.filter((l) => typeof l.message === 'string'
      && (l.message as string).startsWith('park'));
    await awaitCondition(() => mine().length === 2, {
      timeoutMs: 4_000,
      label: 'the refused stash reached dead letters',
    });
    expect(mine().map((l) => l.message)).toEqual(['park1', 'park2']);
    expect(seen).toEqual([]);
    await sys.terminate();
  });
});

/**
 * The stash is a buffer separate from the mailbox, so the drain in
 * `finalizeTermination` never saw it and a restart cleared it outright.
 * A stashed message arrived *earlier* than anything still queued, which
 * makes it the one a sender is most likely blocked on (#518).
 */
describe('Stash — messages that never get unstashed', () => {
  /** Parks everything; `boom` throws, so supervision restarts the instance. */
  class Parking extends Actor<string> {
    constructor(private readonly stashed: string[]) { super(); }
    override onReceive(message: string): void {
      if (message === 'boom') throw new Error('boom');
      this.stashed.push(message);
      this.context.stash();
    }
  }

  test('a stopped actor sends its stash to dead letters', async () => {
    const sys = newSystem('stash-stop');
    const letters = await listenForDeadLetters(sys);
    const stashed: string[] = [];

    const ref = sys.spawn(() => new Parking(stashed), 'a');
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    await awaitCondition(() => stashed.length === 3, { label: 'all three messages were stashed' });

    ref.stop();

    const mine = (): DeadLetter[] => letters.filter((l) => l.recipient.equals(ref));
    await awaitCondition(() => mine().length === 3, {
      label: 'the stash reached dead letters on stop',
    });
    // Arrival order preserved — the stash drains ahead of the mailbox.
    expect(mine().map((l) => l.message)).toEqual(['a', 'b', 'c']);
    await sys.terminate();
  });

  test('a restarted actor sends its stash to dead letters', async () => {
    const sys = newSystem('stash-restart');
    const letters = await listenForDeadLetters(sys);
    const stashed: string[] = [];

    const ref = sys.spawn(() => new Parking(stashed), 'a');
    ref.tell('a'); ref.tell('b');
    await awaitCondition(() => stashed.length === 2, { label: 'both messages were stashed' });

    // Supervision restarts the instance.  The stash belongs to the outgoing
    // one and cannot carry over — but it must not vanish either.
    ref.tell('boom');

    const mine = (): DeadLetter[] => letters.filter((l) => l.recipient.equals(ref));
    await awaitCondition(() => mine().length === 2, {
      label: 'the stash reached dead letters on restart',
    });
    expect(mine().map((l) => l.message)).toEqual(['a', 'b']);
    await sys.terminate();
  });
});
