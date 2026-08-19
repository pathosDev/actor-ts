import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import type { Journal } from '../../../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent } from '../../../../src/persistence/JournalTypes.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/**
 * The acceptance criterion #433 leads with: **captured letters survive a
 * restart**.  A restart is modelled the only way it can be in-process — two
 * `ActorSystem`s with the same name, one after the other, over one journal —
 * which is exactly what a redeploy looks like from the store's side.
 *
 * The system name matters and is not incidental: the durable stream is
 * derived from it, so a queue only rejoins its own letters.
 */
const SYSTEM_NAME = 'dlq-restart';

function newSystem(journal: Journal, deadLetters: ConfigObject): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withPersistence({ journal })
    .withConfig({ 'actor-ts': { 'dead-letters': { store: 'persistent', ...deadLetters } } });
  return ActorSystem.create(SYSTEM_NAME, sysOptions);
}

class Nothing extends Actor<unknown> { override onReceive(_m: unknown): void {} }

/**
 * A journal whose `append` takes a measurable moment, so that a burst of
 * captures leaves writes genuinely **outstanding** when the shutdown starts.
 *
 * Needed because `InMemoryJournal.append` resolves promptly enough that the
 * queue's serialized write chain drains by itself, which makes every
 * durability assertion in this file pass whether the shutdown flush works or
 * not.  Only `append` is delayed: the point is to widen the window between
 * "the letter was captured" and "the letter is in the journal", which is the
 * only window a shutdown flush exists to close.
 */
class SlowAppendJournal implements Journal {
  constructor(
    private readonly delegate: Journal,
    private readonly appendDelayMs: number,
  ) {}

  async append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    // The elapsed time IS the point here — this is injected latency, not a
    // wait for something that could be polled for.  Nothing has happened yet
    // that a condition could observe: the delay is the slow journal being
    // simulated, and it is what leaves the queue's write chain outstanding
    // when the shutdown starts.  Poll instead and there is no backlog left to
    // assert on.
    await sleep(this.appendDelayMs);
    return this.delegate.append(persistenceId, entries, expectedSeq);
  }

  read<E = unknown>(
    persistenceId: string,
    fromSeq: number,
    toSeq?: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.delegate.read(persistenceId, fromSeq, toSeq);
  }

  highestSeq(persistenceId: string): Promise<number> {
    return this.delegate.highestSeq(persistenceId);
  }

  delete(persistenceId: string, toSeq: number): Promise<void> {
    return this.delegate.delete(persistenceId, toSeq);
  }

  persistenceIds(): Promise<string[]> {
    return this.delegate.persistenceIds();
  }
}

/** Produce one genuine dead letter addressed to `/user/<name>`. */
async function deadLetterTo(system: ActorSystem, name: string, message: unknown): Promise<void> {
  const ref = system.spawn(Nothing, name);
  ref.stop();
  await awaitCondition(() => system._resolvePath(['user', name]).isNone(), {
    timeoutMs: 4_000,
    label: `the actor '${name}' reached the terminated state`,
  });
  ref.tell(message);
}

describe('DeadLetterQueue — persistent store across a restart', () => {
  test('a letter captured before shutdown is there after it', async () => {
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', { kind: 'order', id: 7 });
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    // terminate() settles the durable writes on its way out — that is the
    // half of "survives restart" the queue owns.
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const entries = await second.deadLetterQueue.list();
      expect(entries.length).toBe(1);
      expect(entries[0]!.recipientPath).toBe(`actor-ts://${SYSTEM_NAME}/user/worker`);
      expect(entries[0]!.payload).toEqual({
        kind: 'captured',
        message: { kind: 'order', id: 7 },
      });
    } finally {
      await second.terminate();
    }
  });

  test('a replayed letter does not come back on the next start', async () => {
    // The tombstone half of the log.  Eviction is a prefix trim, but a
    // replay punches a hole above the oldest surviving entry, and without a
    // record of it the restore would resurrect a letter that was already
    // handed back — a duplicate delivery on every restart.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', 'work');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    const [entry] = await first.deadLetterQueue.list();
    first.spawn(Nothing, 'worker');
    expect((await first.deadLetterQueue.replay(entry!.id)).kind).toBe('replayed');
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      expect(await second.deadLetterQueue.list()).toEqual([]);
    } finally {
      await second.terminate();
    }
  });

  test('a restored letter replays, and the recipient gets the original payload', async () => {
    // AC1 x AC2 — the crossing an operator actually performs after an
    // incident, and the one the rest of this suite never reached: the
    // letters survive a restart (proved above) and replay redelivers the
    // payload untouched (proved in the unit suite), but each half was only
    // ever shown on its own.  A `persistent` payload makes the round trip
    // through the tagged-JSON codec, so "untouched" is a claim about a
    // decode here, not about an object reference that never left memory.
    const journal = new InMemoryJournal();
    const sent = { kind: 'order', id: 7, lines: ['a', 'b'], paid: false };

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', sent);
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const received: unknown[] = [];
      class Recorder extends Actor<unknown> {
        override onReceive(m: unknown): void { received.push(m); }
      }
      const [restored] = await second.deadLetterQueue.list();
      expect(restored!.payload.kind).toBe('captured');

      second.spawn(Recorder, 'worker');
      expect((await second.deadLetterQueue.replay(restored!.id)).kind).toBe('replayed');
      await awaitCondition(() => received.length === 1, {
        timeoutMs: 4_000,
        label: 'the restored letter was redelivered',
      });
      // Structurally equal to what was originally sent, nested values and
      // the `false` included — a codec that dropped a falsy field or
      // flattened the array would still have "delivered something".
      expect(received[0]).toEqual(sent);
      expect(await second.deadLetterQueue.list()).toEqual([]);
    } finally {
      await second.terminate();
    }
  });

  test('a restored letter can be replayed to an alternate recipient', async () => {
    // The redirect over the durable path.  Worth its own case because the
    // restored entry's `recipientPath` came back through a decode, and the
    // redirect deliberately never resolves it — so a queue that had lost or
    // mangled that field would still redirect correctly here while failing
    // every replay to the original.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', 'work');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const received: unknown[] = [];
      class Recorder extends Actor<unknown> {
        override onReceive(m: unknown): void { received.push(m); }
      }
      const [restored] = await second.deadLetterQueue.list();
      // '/user/worker' is never respawned in this run.
      second.spawn(Recorder, 'standby');
      const standbyPath = `actor-ts://${SYSTEM_NAME}/user/standby`;

      const result = await second.deadLetterQueue.replay(restored!.id, standbyPath);
      expect(result).toEqual({ kind: 'replayed', recipientPath: standbyPath });
      await awaitCondition(() => received.includes('work'), {
        timeoutMs: 4_000,
        label: 'the restored letter reached the alternate recipient',
      });
    } finally {
      await second.terminate();
    }
  });

  test('an unserialisable payload is kept as provenance and refuses replay', async () => {
    // The degraded branch.  The tagged-JSON encoder refuses a function
    // rather than degrading it silently, so a queue that must not lose the
    // letter has to give up the payload instead — and then say so, rather
    // than redelivering a placeholder.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', { kind: 'callback', run: () => 1 });
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    // In memory it is still whole — only the durable copy gives it up.
    expect((await first.deadLetterQueue.list())[0]!.payload.kind).toBe('captured');
    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const [entry] = await second.deadLetterQueue.list();
      expect(entry!.payload.kind).toBe('degraded');
      expect(entry!.recipientPath).toBe(`actor-ts://${SYSTEM_NAME}/user/worker`);
      expect((await second.deadLetterQueue.replay(entry!.id)).kind).toBe('degraded-payload');
    } finally {
      await second.terminate();
    }
  });

  test('a letter captured before anything inspected the queue still persists', async () => {
    // `append` enforces optimistic concurrency, so a write issued before the
    // previous run's log has been read would collide with it and be dropped.
    // The second run below never calls `list()` — it only produces a letter
    // and shuts down, which is precisely the shape a crash-and-restart loop
    // has, and the shape that lost letters silently.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'one', 'first');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the first letter reached the queue',
    });
    await first.terminate();

    const second = newSystem(journal, {});
    await deadLetterTo(second, 'two', 'second');
    await Bun.sleep(30);
    await second.terminate();

    const third = newSystem(journal, {});
    try {
      const messages = (await third.deadLetterQueue.list())
        .map((e) => (e.payload as { message: unknown }).message);
      expect(messages.sort()).toEqual(['first', 'second']);
    } finally {
      await third.terminate();
    }
  });

  test('the first append after a restart does not compact the restored letters', async () => {
    // The durable log is trimmed by a prefix delete bounded on the oldest
    // sequence still held.  A restored entry whose sequence was forgotten is
    // invisible to that bound, so the next append would compact the whole
    // restored prefix away — losing, on the restart after that, everything
    // the previous run had kept.
    const journal = new InMemoryJournal();

    const first = newSystem(journal, {});
    await deadLetterTo(first, 'one', 'first');
    await deadLetterTo(first, 'two', 'second');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 2, {
      timeoutMs: 4_000,
      label: 'both letters reached the queue',
    });
    await first.terminate();

    const second = newSystem(journal, {});
    await deadLetterTo(second, 'three', 'third');
    await awaitCondition(async () => (await second.deadLetterQueue.list()).length === 3, {
      timeoutMs: 4_000,
      label: 'the third letter joined the two restored ones',
    });
    await second.terminate();

    const third = newSystem(journal, {});
    try {
      const messages = (await third.deadLetterQueue.list())
        .map((e) => (e.payload as { message: unknown }).message);
      expect(messages.sort()).toEqual(['first', 'second', 'third']);
    } finally {
      await third.terminate();
    }
  });

  test('the shutdown settles a whole outstanding write backlog, not just one append', async () => {
    // What "durable" actually means here, pinned against a journal slow
    // enough for the claim to have content.
    //
    // Writes are fire-and-forget onto a SERIALIZED chain: `tell` is
    // synchronous and cannot wait for a journal, so a burst captured faster
    // than the journal accepts it leaves a backlog of up to N un-settled
    // appends — not one.  The guarantee is that a graceful shutdown settles
    // that whole backlog.
    //
    // Against `InMemoryJournal` this is untestable and every other case in
    // this file is silent about it: its `append` resolves so promptly that
    // the chain drains on its own before `terminate()` gets anywhere, so the
    // suite stays green even with `flush()` stubbed out to do nothing.  The
    // delay below is what makes the backlog real at shutdown time, and it is
    // why this case exists separately from the four above.
    //
    // Scope of the binding, measured rather than assumed: stubbing `flush()`
    // out entirely fails this case and only this case.  Reducing it to a
    // SINGLE `await this.writeTail` does not fail anything — the two flush
    // call sites (the CoordinatedShutdown task and the drain after the actor
    // tree is down) each await once, so the second round inside `flush` is
    // defence in depth rather than load-bearing.  Do not read this test as
    // covering it.
    const journal = new SlowAppendJournal(new InMemoryJournal(), 4);
    const count = 20;
    const names = Array.from({ length: count }, (_, index) => `worker-${index}`);

    const first = newSystem(journal, {});
    // Every actor stopped first, then every letter sent in one tight loop —
    // a burst, rather than 20 separately-settled writes.  Awaiting anything
    // between the sends would drain the chain incrementally and hand the
    // shutdown nothing to do, which is the shape that made the other cases
    // pass vacuously.
    const refs = names.map((name) => first.spawn(Nothing, name));
    for (const ref of refs) ref.stop();
    await awaitCondition(
      () => names.every((name) => first._resolvePath(['user', name]).isNone()),
      { timeoutMs: 4_000, label: 'every recipient reached the terminated state' },
    );
    for (const [index, ref] of refs.entries()) ref.tell(`letter-${index}`);

    await first.terminate();

    const second = newSystem(journal, {});
    try {
      const messages = (await second.deadLetterQueue.list())
        .map((e) => (e.payload as { message: unknown }).message)
        .sort();
      const expected = Array.from({ length: count }, (_, index) => `letter-${index}`).sort();
      expect(messages).toEqual(expected);
    } finally {
      await second.terminate();
    }
  });

  test('a queue with a different system name does not adopt the letters', async () => {
    const journal = new InMemoryJournal();
    const first = newSystem(journal, {});
    await deadLetterTo(first, 'worker', 'work');
    await awaitCondition(async () => (await first.deadLetterQueue.list()).length === 1, {
      timeoutMs: 4_000,
      label: 'the letter reached the queue',
    });
    await first.terminate();

    const otherOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withPersistence({ journal })
      .withConfig({ 'actor-ts': { 'dead-letters': { store: 'persistent' } } });
    const other = ActorSystem.create('someone-else', otherOptions);
    try {
      expect(await other.deadLetterQueue.list()).toEqual([]);
    } finally {
      await other.terminate();
    }
  });
});
