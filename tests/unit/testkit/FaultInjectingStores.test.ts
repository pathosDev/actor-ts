import { describe, expect, test } from 'bun:test';
import type { Journal } from '../../../src/persistence/Journal.js';
import { InMemoryJournal, InMemorySnapshotStore } from '../../../src/persistence/index.js';
import {
  FaultInjectingJournal,
  FaultInjectingJournalOptions,
  FaultInjectingSnapshotStore,
  FaultInjectingSnapshotStoreOptions,
  InjectedFaultError,
  type JournalOperation,
} from '../../../src/testkit/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * The fault-injecting store decorators themselves (#1024): the script decides
 * exactly which call fails, and a call it does not fail behaves as the
 * wrapped store's would.  The actor-level consequences live in
 * `PersistentActorStoreFailure.test.ts`.
 */

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to reject');
}

async function seeded(events: number): Promise<InMemoryJournal> {
  const journal = new InMemoryJournal();
  await journal.append('p', Array.from({ length: events }, (_, i) => ({ event: i + 1 })), 0);
  return journal;
}

describe('FaultInjectingJournal — the script', () => {
  test('passes every call through when nothing is scripted', async () => {
    const inner = await seeded(2);
    const journal = new FaultInjectingJournal(inner);
    await journal.append('p', [{ event: 3 }], 2);
    expect((await journal.read<number>('p', 1)).map((e) => e.event)).toEqual([1, 2, 3]);
    expect(await journal.highestSeq('p')).toBe(3);
    expect(journal.failuresInjected).toBe(0);
  });

  test('fails only the scripted operation, with an InjectedFaultError naming it', async () => {
    const journalFaults = FaultInjectingJournalOptions.create().withFailOn('append');
    const journal = new FaultInjectingJournal(await seeded(1), journalFaults);
    const error = await rejection(journal.append('p', [{ event: 2 }], 1));
    expect(error).toBeInstanceOf(InjectedFaultError);
    expect((error as InjectedFaultError).operation).toBe('append');
    expect((error as InjectedFaultError).callNumber).toBe(1);
    expect(await journal.highestSeq('p')).toBe(1);
    expect((await journal.read('p', 1)).length).toBe(1);
  });

  test('lets failAfterCalls scripted calls through, then fails every later one', async () => {
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('read')
      .withFailAfterCalls(2);
    const journal = new FaultInjectingJournal(await seeded(1), journalFaults);
    await journal.read('p', 1);
    await journal.read('p', 1);
    await rejection(journal.read('p', 1));
    await rejection(journal.read('p', 1));
    expect(journal.failuresInjected).toBe(2);
    expect(journal.callsTo('read')).toBe(4);
  });

  test('counts failAfterCalls across every scripted operation together', async () => {
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('read', 'highestSeq')
      .withFailAfterCalls(1);
    const journal = new FaultInjectingJournal(await seeded(1), journalFaults);
    await journal.read('p', 1);
    const error = await rejection(journal.highestSeq('p'));
    expect((error as InjectedFaultError).operation).toBe('highestSeq');
  });

  test('failOnce fails one call and passes every later one', async () => {
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('highestSeq')
      .withFailOnce();
    const journal = new FaultInjectingJournal(await seeded(1), journalFaults);
    await rejection(journal.highestSeq('p'));
    expect(await journal.highestSeq('p')).toBe(1);
    expect(await journal.highestSeq('p')).toBe(1);
    expect(journal.failuresInjected).toBe(1);
  });

  test('rejects with the error the factory builds', async () => {
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('delete')
      .withError((operation: JournalOperation) => new RangeError(`no ${operation} today`));
    const journal = new FaultInjectingJournal(await seeded(2), journalFaults);
    const error = await rejection(journal.delete('p', 1));
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe('no delete today');
    expect((await journal.read('p', 1)).length).toBe(2);
  });

  test("'after-operation' performs the append and still rejects — the lost acknowledgement", async () => {
    const inner = await seeded(1);
    const journalFaults = FaultInjectingJournalOptions.create()
      .withFailOn('append')
      .withFailurePoint('after-operation');
    const journal = new FaultInjectingJournal(inner, journalFaults);
    await rejection(journal.append('p', [{ event: 2 }], 1));
    expect(await inner.highestSeq('p')).toBe(2);
  });
});

describe('FaultInjectingJournal — the gapped stream', () => {
  test('hides the event after gapAfterSeq from every read and leaves the head alone', async () => {
    const journalFaults = FaultInjectingJournalOptions.create().withGapAfterSeq(2);
    const journal = new FaultInjectingJournal(await seeded(4), journalFaults);
    expect((await journal.read('p', 1)).map((e) => e.sequenceNr)).toEqual([1, 2, 4]);
    expect((await journal.read('p', 3)).map((e) => e.sequenceNr)).toEqual([4]);
    expect(await journal.highestSeq('p')).toBe(4);
  });
});

describe('FaultInjectingJournal — what it forwards', () => {
  test('forwards optional members and leaves out the ones the wrapped journal leaves out', async () => {
    const inner = await seeded(2);
    const wrapped = new FaultInjectingJournal(inner);
    expect(wrapped.raiseCompactionMark).toBeDefined();
    expect(wrapped.events).toBe(inner.events);
    inner.storageLocality = 'shared';
    expect(wrapped.storageLocality).toBe('shared');
    expect(await wrapped.persistenceIds()).toEqual(['p']);

    // A minimal journal without the optional compaction mark: the decorator
    // must not invent one, because its absence is meaningful.
    const minimal: Journal = {
      append: (persistenceId, entries, expectedSeq) => inner.append(persistenceId, entries, expectedSeq),
      read: (persistenceId, fromSeq, toSeq) => inner.read(persistenceId, fromSeq, toSeq),
      highestSeq: (persistenceId) => inner.highestSeq(persistenceId),
      delete: (persistenceId, toSeq) => inner.delete(persistenceId, toSeq),
      persistenceIds: () => inner.persistenceIds(),
    };
    const wrappedMinimal = new FaultInjectingJournal(minimal);
    expect(wrappedMinimal.raiseCompactionMark).toBeUndefined();
    expect(wrappedMinimal.close).toBeUndefined();
  });
});

describe('FaultInjectingJournalOptionsValidator', () => {
  test('refuses an operation the journal does not have', () => {
    const journalFaults = { failOn: ['write' as JournalOperation] };
    expect(() => new FaultInjectingJournal(new InMemoryJournal(), journalFaults)).toThrow(OptionsError);
  });

  test('refuses a negative or fractional count and an unknown failure point', () => {
    const inner = new InMemoryJournal();
    expect(() => new FaultInjectingJournal(inner, { failAfterCalls: -1 })).toThrow(OptionsError);
    expect(() => new FaultInjectingJournal(inner, { gapAfterSeq: 1.5 })).toThrow(OptionsError);
    expect(() => new FaultInjectingJournal(inner, { failurePoint: 'during' as never })).toThrow(OptionsError);
  });
});

describe('FaultInjectingSnapshotStore', () => {
  test('fails a scripted save before it reaches the store', async () => {
    const inner = new InMemorySnapshotStore();
    const snapshotFaults = FaultInjectingSnapshotStoreOptions.create().withFailOn('save');
    const store = new FaultInjectingSnapshotStore(inner, snapshotFaults);
    const error = await rejection(store.save('p', 3, { n: 1 }));
    expect((error as InjectedFaultError).operation).toBe('save');
    expect((await inner.loadLatest('p')).isSome()).toBe(false);
    // Loads are not scripted, so they keep working.
    expect((await store.loadLatest('p')).isSome()).toBe(false);
    expect(store.callsTo('save')).toBe(1);
  });

  test("'after-operation' writes the snapshot and still rejects", async () => {
    const inner = new InMemorySnapshotStore();
    const snapshotFaults = FaultInjectingSnapshotStoreOptions.create()
      .withFailOn('save')
      .withFailurePoint('after-operation');
    const store = new FaultInjectingSnapshotStore(inner, snapshotFaults);
    await rejection(store.save('p', 3, { n: 1 }));
    const latest = await inner.loadLatest('p');
    expect(latest.isSome() && latest.value.sequenceNr).toBe(3);
  });

  test('scripts loadLatest, loadBefore and delete, once each with failOnce', async () => {
    const inner = new InMemorySnapshotStore();
    await inner.save('p', 2, { n: 2 });
    const snapshotFaults = FaultInjectingSnapshotStoreOptions.create()
      .withFailOn('loadLatest', 'loadBefore', 'delete')
      .withFailAfterCalls(1)
      .withFailOnce();
    const store = new FaultInjectingSnapshotStore(inner, snapshotFaults);
    expect((await store.loadLatest('p')).isSome()).toBe(true);
    const error = await rejection(store.loadBefore('p', 5));
    expect((error as InjectedFaultError).operation).toBe('loadBefore');
    await store.delete('p', 2);
    expect((await store.loadLatest('p')).isSome()).toBe(false);
    expect(store.failuresInjected).toBe(1);
  });

  test('forwards the capability declaration the start-up check reads', () => {
    const inner = new InMemorySnapshotStore();
    const store = new FaultInjectingSnapshotStore(inner);
    expect(store.persistenceOptionSupport).toBe(inner.persistenceOptionSupport);
    expect(store.storageLocality).toBe('node-local');
  });

  test('refuses an operation the store does not have', () => {
    const snapshotFaults = { failOn: ['append' as never] };
    expect(() => new FaultInjectingSnapshotStore(new InMemorySnapshotStore(), snapshotFaults)).toThrow(OptionsError);
  });
});
