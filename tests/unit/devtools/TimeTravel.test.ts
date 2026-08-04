import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { PersistentActor } from '../../../src/persistence/PersistentActor.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { replayState, SnapshotIntegrityError } from '../../../src/persistence/Replay.js';
import { ReplayRegistry } from '../../../src/devtools/replay/ReplayRegistry.js';
import { TimeTravelMethods } from '../../../src/devtools/replay/TimeTravelMethods.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';
import type {
  DevToolsRequestMethod,
  JournalIdentifiersResult,
  JournalReadResult,
  ReplayCapabilitiesResult,
  ReplayDiffResult,
  ReplayStateResult,
} from '../../../src/devtools/protocol/index.js';

type CounterEvent = { readonly kind: 'added'; readonly amount: number };
type CounterState = { readonly total: number };

const foldCounter = (state: CounterState, event: CounterEvent): CounterState =>
  ({ total: state.total + event.amount });

/** Write `count` events straight into a journal — no actor involved. */
async function seed(journal: InMemoryJournal, persistenceId: string, amounts: number[]): Promise<void> {
  let expected = 0;
  for (const amount of amounts) {
    await journal.append<CounterEvent>(persistenceId, [{ kind: 'added', amount }], expected);
    expected += 1;
  }
}

describe('replayState', () => {
  test('folds a journal from nothing', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, 'counter', [1, 2, 3]);

    const result = await replayState<CounterEvent, CounterState>({
      journal,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
    });
    expect(result.state).toEqual({ total: 6 });
    expect(result.sequenceNr).toBe(3);
    expect(result.eventsApplied).toBe(3);
    expect(result.fromSnapshotSequenceNr).toBeNull();
  });

  test('stops at a requested sequence number', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, 'counter', [1, 2, 3, 4]);

    const result = await replayState<CounterEvent, CounterState>({
      journal,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
      toSequenceNr: 2,
    });
    expect(result.state).toEqual({ total: 3 });
    expect(result.sequenceNr).toBe(2);
  });

  test('sequence 0 is the initial state', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, 'counter', [5]);

    const result = await replayState<CounterEvent, CounterState>({
      journal,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
      toSequenceNr: 0,
    });
    expect(result.state).toEqual({ total: 0 });
    expect(result.eventsApplied).toBe(0);
  });

  test('starts from a snapshot when one is available', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'counter', [1, 1, 1, 1]);
    await snapshots.save('counter', 3, { total: 3 });

    const result = await replayState<CounterEvent, CounterState>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
    });
    expect(result.state).toEqual({ total: 4 });
    expect(result.fromSnapshotSequenceNr).toBe(3);
    // Only the one event after the snapshot was folded.
    expect(result.eventsApplied).toBe(1);
  });

  test('a snapshot newer than the target is skipped, not misapplied', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'counter', [1, 1, 1, 1]);
    await snapshots.save('counter', 4, { total: 4 });

    const result = await replayState<CounterEvent, CounterState>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
      toSequenceNr: 2,
    });
    expect(result.state).toEqual({ total: 2 });
    expect(result.fromSnapshotSequenceNr).toBeNull();
  });

  test('refuses a snapshot with a malformed sequence number', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'counter', [1]);
    await snapshots.save('counter', Number.NaN, { total: 999 });

    await expect(replayState<CounterEvent, CounterState>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
    })).rejects.toThrow(SnapshotIntegrityError);
  });

  test('refuses a snapshot claiming to be ahead of the journal', async () => {
    // The classic tamper: pump the sequence so replay skips every event.
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'counter', [1, 1]);
    await snapshots.save('counter', 9_999, { total: 0 });

    await expect(replayState<CounterEvent, CounterState>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
    })).rejects.toThrow(/refusing to recover/);
  });

  test('an empty journal with a snapshot is legitimate', async () => {
    // State-only snapshots survive a compaction or a migration.
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await snapshots.save('counter', 42, { total: 42 });

    const result = await replayState<CounterEvent, CounterState>({
      journal,
      snapshotStore: snapshots,
      persistenceId: 'counter',
      initialState: () => ({ total: 0 }),
      fold: foldCounter,
    });
    expect(result.state).toEqual({ total: 42 });
  });
});

/* ------------------------------- the panel ------------------------------- */

class CounterActor extends PersistentActor<string, CounterEvent, CounterState> {
  readonly persistenceId = 'live-counter';
  initialState(): CounterState { return { total: 0 }; }
  onEvent(state: CounterState, event: CounterEvent): CounterState { return foldCounter(state, event); }
  async onCommand(_state: CounterState, command: string): Promise<void> {
    if (command.startsWith('add:')) {
      await this.persist({ kind: 'added', amount: Number(command.slice(4)) });
    }
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string, journal: InMemoryJournal, snapshots: InMemorySnapshotStore): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withPersistence({ journal, snapshotStore: snapshots });
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

function fakeServer(): {
  server: DevToolsServer;
  invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown) => Promise<T>;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown): Promise<T> => {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`not registered: ${method}`);
      return handler(parameters) as Promise<T>;
    },
  };
}

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TimeTravelMethods', () => {
  test('lists persistence ids with their highest sequence', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'alpha', [1, 2]);
    await seed(journal, 'beta', [7]);
    const system = newSystem('tt-ids', journal, snapshots);

    const { server, invoke } = fakeServer();
    const registry = new ReplayRegistry(system, [], true);
    new TimeTravelMethods(system.extension(PersistenceExtensionId), registry).install(server);

    const result = await invoke<JournalIdentifiersResult>('journal.ids');
    expect(result.total).toBe(2);
    expect(result.identifiers.map((entry) => entry.persistenceId)).toEqual(['alpha', 'beta']);
    expect(result.identifiers[0]!.highestSequenceNumber).toBe(2);
    // No actor is running and no fold is registered.
    expect(result.identifiers[0]!.capability).toBe('events-only');
  });

  test('pages the event log and reports the total', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'alpha', [1, 2, 3, 4, 5]);
    const system = newSystem('tt-read', journal, snapshots);

    const { server, invoke } = fakeServer();
    new TimeTravelMethods(
      system.extension(PersistenceExtensionId),
      new ReplayRegistry(system, [], true),
    ).install(server);

    const page = await invoke<JournalReadResult>('journal.read', {
      persistenceId: 'alpha', fromSequenceNumber: 2, limit: 2,
    });
    expect(page.events.map((e) => e.sequenceNumber)).toEqual([2, 3]);
    expect(page.highestSequenceNumber).toBe(5);
    expect(page.events[0]!.payload).toEqual({ kind: 'added', amount: 2 });
    // A raw (non-enveloped) payload reports no manifest rather than a
    // made-up one.
    expect(page.events[0]!.manifest).toBeNull();
  });

  test('reconstructs state at a point in the past from a registered fold', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'alpha', [10, 20, 30]);
    const system = newSystem('tt-registered', journal, snapshots);

    const { server, invoke } = fakeServer();
    const registry = new ReplayRegistry(system, [{
      match: (id) => id === 'alpha',
      initialState: () => ({ total: 0 }),
      fold: (state, event) => foldCounter(state as CounterState, event as CounterEvent),
    }], false);
    new TimeTravelMethods(system.extension(PersistenceExtensionId), registry).install(server);

    expect((await invoke<ReplayCapabilitiesResult>('replay.capabilities', {
      persistenceId: 'alpha',
    }))).toEqual({ persistenceId: 'alpha', capability: 'state', foldSource: 'registered' });

    const atTwo = await invoke<ReplayStateResult>('replay.state', {
      persistenceId: 'alpha', toSequenceNumber: 2,
    });
    expect(atTwo.state).toEqual({ total: 30 });
    expect(atTwo.sequenceNumber).toBe(2);
  });

  test('diff returns both endpoints whole', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    await seed(journal, 'alpha', [10, 20, 30]);
    const system = newSystem('tt-diff', journal, snapshots);

    const { server, invoke } = fakeServer();
    const registry = new ReplayRegistry(system, [{
      match: () => true,
      initialState: () => ({ total: 0 }),
      fold: (state, event) => foldCounter(state as CounterState, event as CounterEvent),
    }], false);
    new TimeTravelMethods(system.extension(PersistenceExtensionId), registry).install(server);

    const diff = await invoke<ReplayDiffResult>('replay.diff', {
      persistenceId: 'alpha', fromSequenceNumber: 1, toSequenceNumber: 3,
    });
    expect(diff.from.state).toEqual({ total: 10 });
    expect(diff.to.state).toEqual({ total: 60 });
  });

  test('borrows the fold from a live PersistentActor', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    const system = newSystem('tt-auto', journal, snapshots);
    const ref = system.spawn(() => new CounterActor(), 'counter');
    ref.tell('add:5');
    ref.tell('add:7');
    await settle(150);

    const { server, invoke } = fakeServer();
    const registry = new ReplayRegistry(system, [], true);
    new TimeTravelMethods(system.extension(PersistenceExtensionId), registry).install(server);

    const capability = await invoke<ReplayCapabilitiesResult>('replay.capabilities', {
      persistenceId: 'live-counter',
    });
    expect(capability).toEqual({
      persistenceId: 'live-counter', capability: 'state', foldSource: 'auto-captured',
    });

    const atOne = await invoke<ReplayStateResult>('replay.state', {
      persistenceId: 'live-counter', toSequenceNumber: 1,
    });
    expect(atOne.state).toEqual({ total: 5 });
  });

  test('auto-capture can be switched off, leaving raw events only', async () => {
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    const system = newSystem('tt-noauto', journal, snapshots);
    const ref = system.spawn(() => new CounterActor(), 'counter');
    ref.tell('add:5');
    await settle(150);

    const { server, invoke } = fakeServer();
    new TimeTravelMethods(
      system.extension(PersistenceExtensionId),
      new ReplayRegistry(system, [], false),
    ).install(server);

    expect((await invoke<ReplayCapabilitiesResult>('replay.capabilities', {
      persistenceId: 'live-counter',
    })).capability).toBe('events-only');
    await expect(invoke('replay.state', {
      persistenceId: 'live-counter', toSequenceNumber: 1,
    })).rejects.toThrow(/no fold known/);
  });

  test('rejects malformed parameters', async () => {
    const journal = new InMemoryJournal();
    const system = newSystem('tt-bad', journal, new InMemorySnapshotStore());
    const { server, invoke } = fakeServer();
    new TimeTravelMethods(
      system.extension(PersistenceExtensionId),
      new ReplayRegistry(system, [], true),
    ).install(server);

    await expect(invoke('journal.read', {})).rejects.toThrow(/persistenceId/);
    await expect(invoke('journal.read', { persistenceId: 'a', fromSequenceNumber: -1 }))
      .rejects.toThrow(/fromSequenceNumber/);
    await expect(invoke('replay.state', { persistenceId: 'a', toSequenceNumber: 1.5 }))
      .rejects.toThrow(/toSequenceNumber/);
  });
});
