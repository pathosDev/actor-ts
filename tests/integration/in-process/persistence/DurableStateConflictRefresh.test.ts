/**
 * A `DurableStateActor` that loses a write to a second writer must not stay
 * wedged at the revision it lost with (#963).
 *
 * Before the fix, `persist` refreshed `_record` only on success, so after the
 * first `DurableStateConcurrencyError` every later `persist` sent the same
 * stale `expectedRevision`, was rejected with the byte-identical error, and the
 * actor kept serving the stale state for the rest of its life.  The fix reloads
 * the record on a conflict and then rethrows: the failing call still learns its
 * write lost, and the next command starts from what the store holds.
 *
 * Run against the reference store and two CAS-based ones that answer a
 * conflict differently — SQLite reports the store's current revision, the
 * object-storage store reports `-1` ("load() will fetch the truth") after an
 * etag mismatch — so the reload cannot lean on the error's `currentRevision`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  DurableStateActor,
  DurableStateConcurrencyError,
  DurableStateOptions,
  InMemoryDurableStateStore,
  SqliteDurableStateStore,
  SqliteDurableStateStoreOptions,
  type DurableStateStore,
} from '../../../../src/persistence/index.js';
import { FilesystemObjectStorageBackend } from '../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type Counter = { readonly n: number };

type IncrementCommand = { readonly kind: 'increment'; readonly replyTo: ActorRef<Outcome> };
type Command = IncrementCommand;

type PersistedOutcome = { readonly kind: 'persisted'; readonly revision: number; readonly n: number };
type ConflictOutcome = {
  readonly kind: 'conflict';
  readonly revision: number;
  readonly n: number;
  readonly error: unknown;
};
type Outcome = PersistedOutcome | ConflictOutcome;

/**
 * Catches its own conflict and reports what it sees afterwards, so the test
 * observes the actor's view without a supervision restart reloading it — a
 * restart re-runs `preStart`, which is exactly the recovery the defect lacked.
 */
class CounterActor extends DurableStateActor<Command, Counter> {
  override async onCommand(command: Command): Promise<void> {
    try {
      await this.persist({ n: this.state.n + 1 });
      command.replyTo.tell({ kind: 'persisted', revision: this.revision, n: this.state.n });
    } catch (error) {
      command.replyTo.tell({ kind: 'conflict', revision: this.revision, n: this.state.n, error });
    }
  }
}

class Sink extends Actor<Outcome> {
  constructor(private readonly outcomes: Outcome[]) { super(); }
  override onReceive(outcome: Outcome): void { this.outcomes.push(outcome); }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory !== '') rmSync(directory, { recursive: true, force: true });
  }
});

type StoreCase = { readonly label: string; readonly make: () => DurableStateStore };

const storeCases: StoreCase[] = [
  { label: 'InMemoryDurableStateStore', make: () => new InMemoryDurableStateStore() },
  {
    label: 'SqliteDurableStateStore',
    make: () => {
      const storeOptions = SqliteDurableStateStoreOptions.create().withPath(':memory:');
      return new SqliteDurableStateStore(storeOptions);
    },
  },
  {
    label: 'ObjectStorageDurableStateStore',
    make: () => {
      const directory = mkdtempSync(join(tmpdir(), 'actor-ts-ds-conflict-'));
      temporaryDirectories.push(directory);
      const backendOptions = FilesystemObjectStorageOptions.create().withDir(directory);
      const backend = new FilesystemObjectStorageBackend(backendOptions);
      const storeOptions = ObjectStorageDurableStateStoreOptions.create().withBackend(backend);
      return new ObjectStorageDurableStateStore(storeOptions);
    },
  },
];

describe.each(storeCases)('DurableStateActor after a concurrency conflict — $label', ({ make }) => {
  test('the conflict is reported, the record is refreshed, and the next persist succeeds', async () => {
    const store = make();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('ds-conflict', systemOptions);
    try {
      const outcomes: Outcome[] = [];
      const sink = system.spawnAnonymous(() => new Sink(outcomes));
      const durableStateOptions = DurableStateOptions.create<Counter>()
        .withPersistenceId('counter-1')
        .withStore(store)
        .withEmptyState(() => ({ n: 0 }));
      const counter = system.spawnAnonymous(() => new CounterActor(durableStateOptions));

      counter.tell({ kind: 'increment', replyTo: sink });
      await awaitCondition(() => outcomes.length === 1, { timeoutMs: 4_000, label: 'the first persist answered' });
      expect(outcomes[0]).toEqual({ kind: 'persisted', revision: 1, n: 1 });

      // The second writer: moves the record past the actor's revision.
      await store.upsert('counter-1', 1, { n: 99 });

      counter.tell({ kind: 'increment', replyTo: sink });
      await awaitCondition(() => outcomes.length === 2, { timeoutMs: 4_000, label: 'the conflicting persist answered' });
      const conflict = outcomes[1]!;
      expect(conflict.kind).toBe('conflict');
      // Still reported to the caller of the failing persist — the reload must
      // not swallow it.
      expect((conflict as ConflictOutcome).error).toBeInstanceOf(DurableStateConcurrencyError);
      // …and the actor's view is now the store's, not the one it lost with.
      expect({ revision: conflict.revision, n: conflict.n }).toEqual({ revision: 2, n: 99 });

      counter.tell({ kind: 'increment', replyTo: sink });
      await awaitCondition(() => outcomes.length === 3, { timeoutMs: 4_000, label: 'the persist after the conflict answered' });
      expect(outcomes[2]).toEqual({ kind: 'persisted', revision: 3, n: 100 });
      expect((await store.load<Counter>('counter-1')).toNullable()?.state).toEqual({ n: 100 });
    } finally {
      await system.terminate();
      await store.close?.();
    }
  });
});

/** Answers the start-up load, then refuses every later one. */
class LoadsOnceStore extends InMemoryDurableStateStore {
  loads = 0;
  override async load<S>(...parameters: Parameters<InMemoryDurableStateStore['load']>) {
    this.loads++;
    if (this.loads > 1) throw new Error('store unreachable');
    return super.load<S>(...parameters);
  }
}

describe('DurableStateActor — a refresh that fails', () => {
  test('still reports the conflict, not the refresh error, and keeps the old view', async () => {
    const store = new LoadsOnceStore();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('ds-conflict-refresh-fails', systemOptions);
    try {
      const outcomes: Outcome[] = [];
      const sink = system.spawnAnonymous(() => new Sink(outcomes));
      const durableStateOptions = DurableStateOptions.create<Counter>()
        .withPersistenceId('counter-2')
        .withStore(store)
        .withEmptyState(() => ({ n: 0 }));
      const counter = system.spawnAnonymous(() => new CounterActor(durableStateOptions));
      counter.tell({ kind: 'increment', replyTo: sink });
      await awaitCondition(() => outcomes.length === 1, { timeoutMs: 4_000, label: 'the first persist answered' });
      await store.upsert('counter-2', 1, { n: 99 });

      counter.tell({ kind: 'increment', replyTo: sink });
      await awaitCondition(() => outcomes.length === 2, { timeoutMs: 4_000, label: 'the conflicting persist answered' });
      const conflict = outcomes[1] as ConflictOutcome;
      expect(store.loads).toBe(2);
      expect(conflict.error).toBeInstanceOf(DurableStateConcurrencyError);
      expect({ revision: conflict.revision, n: conflict.n }).toEqual({ revision: 1, n: 1 });
    } finally {
      await system.terminate();
    }
  });
});
