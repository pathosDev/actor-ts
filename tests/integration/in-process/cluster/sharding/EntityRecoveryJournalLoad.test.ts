/**
 * Paced entity recovery, observed where it matters: at the journal (#851).
 *
 * `actor-ts.sharding.entity-recovery.strategy = constant-rate` exists so that a
 * node handed thousands of remembered entities does not open one journal
 * replay per entity in the same tick.  The unit suite
 * (`tests/unit/cluster/sharding/EntityRecoveryPacing.test.ts`) pins the
 * *starts*; this one pins what the store sees — replay reads — through the
 * whole stack.  The keys come from HOCON, the coordinator loads the registry
 * from a remember-entities store and ships it once the shard is allocated, the
 * region paces it, and every entity is a `PersistentActor` whose recovery reads
 * an instrumented journal.
 *
 * ## The batches are fired by hand
 *
 * The frequency is an odd number of milliseconds that nothing else in a
 * single-node cluster schedules, and the system's scheduler captures the
 * one-shot armed with exactly that delay instead of scheduling it; every other
 * timer runs for real.  So the journal has seen every read of one window before
 * the next window can open, and "at most four reads per window" is a count
 * rather than a race against a clock.  That each captured one-shot carries the
 * configured delay is asserted as well: that delay *is* the window.
 *
 * ## The fence
 *
 * `shardRefFor` is answered once the region knows where the shard lives.  The
 * coordinator ships the shard's home and its registry in one turn, so a
 * *second* `shardRefFor` is answered only after the region has handled the
 * registry — or, later, a batch — and the shard then answers `GetShardStats`
 * only after every start the region sent it first.  The shard's entity index
 * is written in the same step as the spawn, so its answer is the exact set of
 * entities started so far.
 *
 * ## Two layers, two bounds
 *
 * Pacing bounds how fast replays *start*; a replay that outlasts its window
 * still overlaps the next one.  `actor-ts.persistence.max-concurrent-recoveries`
 * (#874) bounds how many are *in flight*.  The last two cases hold every read
 * open to make the difference visible: paced alone, the reads in flight grow
 * by a batch per window; with the permit, they stop at the permit.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Config } from '../../../../../src/config/Config.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { JournalRememberEntitiesStore } from '../../../../../src/cluster/sharding/RememberEntitiesStore.js';
import type { ShardStats } from '../../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent } from '../../../../../src/persistence/JournalTypes.js';
import type { PersistenceExtension } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../../src/persistence/index.js';
import { Scheduler, type Cancellable } from '../../../../../src/Scheduler.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const TYPE_NAME = 'meter';

/** One shard, so the registry is one message and its order is the store's. */
const SHARD = 0;

/**
 * The recovery frequency, in ms.  Odd on purpose: nothing else a single-node
 * cluster, its coordinator or its region schedules is armed with it, so the
 * scheduler below captures exactly the recovery one-shot.
 */
const CAPTURED_FREQUENCY_MS = 777_777;

/**
 * `constant-rate.number-of-entities`: entity starts, and so replays, per
 * window.  Deliberately not the shipped five, and the frequency above not the
 * shipped 100 ms, so a key that is never read cannot pass for one that is.
 */
const BATCH = 4;

/** Twenty remembered entities: five windows of four. */
const REMEMBERED = Array.from({ length: 20 }, (_, index) => `meter-${index}`);
const WINDOWS = REMEMBERED.length / BATCH;

/** The permit count of the case that bounds replays in flight; below the batch on purpose. */
const PERMITS = 3;

const ASK_TIMEOUT_MS = 2_000;

/** A whole case: five windows of setup, waits and fences, each wait well inside it. */
const CASE_TIMEOUT_MS = 15_000;

type RecordCommand = { readonly kind: 'record'; readonly id: string };

type Command = RecordCommand;

type RecordedEvent = { readonly kind: 'recorded' };

type Event = RecordedEvent;

type State = { readonly recorded: number };

/** Every entity id whose recovery completed, in completion order. */
let recovered: string[] = [];

class Meter extends PersistentActor<Command, Event, State> {
  override get persistenceId(): string { return `${TYPE_NAME}-${this.entityId}`; }

  initialState(): State { return { recorded: 0 }; }

  onEvent(state: State): State { return { recorded: state.recorded + 1 }; }

  onCommand(): void { /* recovery is the whole observation */ }

  override onRecoveryComplete(): void { recovered.push(this.entityId); }
}

/** One replay read, and the window it arrived in. */
type ReadArrival = { readonly persistenceId: string; readonly window: number };

/**
 * An `InMemoryJournal` whose `read` — the replay — is counted, attributed to
 * the window it arrived in, and on request held open until released, the way
 * a slow store holds it.
 */
class InstrumentedJournal implements Journal {
  private readonly inner = new InMemoryJournal();
  readonly reads: ReadArrival[] = [];
  /** The window the test has opened last; advanced before it fires each batch. */
  window = 0;
  inFlight = 0;
  peakInFlight = 0;
  private holding = false;
  private readonly held: Array<() => void> = [];

  /** Hold every read open from now on. */
  hold(): void { this.holding = true; }

  /** Let every held read finish, and every later one through at once. */
  release(): void {
    this.holding = false;
    for (const resume of this.held.splice(0)) resume();
  }

  /** The persistence ids read in `window`, sorted. */
  readIn(window: number): string[] {
    return this.reads.filter((read) => read.window === window).map((read) => read.persistenceId).sort();
  }

  append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.inner.append(persistenceId, entries, expectedSeq);
  }

  async read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    this.reads.push({ persistenceId, window: this.window });
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      if (this.holding) await new Promise<void>((resume) => { this.held.push(resume); });
      return await this.inner.read<E>(persistenceId, fromSeq, toSeq);
    } finally {
      this.inFlight--;
    }
  }

  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }

  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }

  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

/** One recovery batch the region armed, held back until the test fires it. */
type ArmedBatch = {
  readonly delayMs: number;
  readonly fire: () => void;
  fired: boolean;
};

/**
 * Captures the recovery one-shot instead of scheduling it, and schedules
 * everything else — gossip, the failure detector, register retries, recovery
 * timeouts — for real.
 */
class RecoveryBatchScheduler extends Scheduler {
  readonly armed: ArmedBatch[] = [];

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    if (delayMs !== CAPTURED_FREQUENCY_MS) return super.scheduleOnceFunction(delayMs, task);
    const batch: ArmedBatch = { delayMs, fire: task, fired: false };
    this.armed.push(batch);
    let cancelled = false;
    return {
      cancel: (): boolean => {
        if (cancelled || batch.fired) return false;
        cancelled = true;
        return true;
      },
      get isCancelled(): boolean { return cancelled || batch.fired; },
    };
  }

  /** Fire the batch the region armed last, as its timer would have. */
  fireNext(): void {
    const batch = this.armed[this.armed.length - 1];
    if (!batch || batch.fired) throw new Error('no recovery batch is armed');
    batch.fired = true;
    batch.fire();
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly journal: InstrumentedJournal;
  readonly scheduler: RecoveryBatchScheduler;
  readonly persistence: PersistenceExtension;
};

let running: Node | null = null;

afterEach(async () => {
  if (running) {
    running.journal.release();
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  recovered = [];
});

/** The two keys under test, spelled the way an operator writes them. */
function hoconFor(strategy: 'all' | 'constant-rate', maxConcurrentRecoveries: number): string {
  return [
    'actor-ts.sharding.entity-recovery {',
    `  strategy = ${strategy}`,
    `  constant-rate.frequency = ${CAPTURED_FREQUENCY_MS}ms`,
    `  constant-rate.number-of-entities = ${BATCH}`,
    '}',
    `actor-ts.persistence.max-concurrent-recoveries = ${maxConcurrentRecoveries}`,
  ].join('\n');
}

async function startNode(systemName: string, port: number, hocon: string): Promise<Node> {
  const scheduler = new RecoveryBatchScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(systemName, systemOptions);

  // Before anything spawns: a `PersistentActor` resolves its journal once, in
  // `preStart`.
  const journal = new InstrumentedJournal();
  const persistence = system.extension(PersistenceExtensionId);
  persistence.configure({ journal, snapshotStore: new InMemorySnapshotStore() });

  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const node: Node = { system, cluster, journal, scheduler, persistence };
  running = node;

  // The registry a previous incarnation of the cluster left behind — in its
  // own store, so its reads and writes never reach the journal under test.
  const store = new JournalRememberEntitiesStore(new InMemoryJournal());
  for (const entityId of REMEMBERED) {
    await store.append(TYPE_NAME, { kind: 'started', shardId: SHARD, entityId });
  }

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Meter)
    .withExtractEntityId((command) => command.id)
    .withNumShards(1)
    .withRememberEntities(true)
    .withRememberEntitiesStore(store)
    .withPassivationIdleMs(0);
  cluster.sharding.start<Command>(shardingOptions);
  await awaitCondition(() => cluster.sharding.isRegistered(TYPE_NAME), {
    timeoutMs: 4_000,
    label: 'the region registered with the coordinator',
  });
  return node;
}

/** Ask for the shard, which allocates it — and makes the coordinator ship its registry. */
async function allocate(node: Node): Promise<void> {
  await node.cluster.sharding.shardRefFor<Command>(TYPE_NAME, SHARD, ASK_TIMEOUT_MS);
}

/** The entities started so far, read behind everything the region was sent first. */
async function entitiesStarted(node: Node): Promise<string[]> {
  const shard = await node.cluster.sharding.shardRefFor<Command>(TYPE_NAME, SHARD, ASK_TIMEOUT_MS);
  const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, ASK_TIMEOUT_MS);
  return [...stats.entityIds].sort();
}

/** The persistence ids of `entityIds`, sorted — what the journal is read under. */
function persistenceIdsOf(entityIds: readonly string[]): string[] {
  return entityIds.map((entityId) => `${TYPE_NAME}-${entityId}`).sort();
}

/** Open window `window` and fire the batch armed for it. */
function openWindow(node: Node, window: number): void {
  node.journal.window = window;
  node.scheduler.fireNext();
}

describe('paced entity recovery, at the journal (#851)', () => {
  test('constant-rate: the journal sees the replays four per window, and every one completes', async () => {
    const node = await startNode('851-journal-paced', 45_590, hoconFor('constant-rate', 0));
    await allocate(node);

    let startedBefore: string[] = [];
    for (let window = 0; window < WINDOWS; window++) {
      if (window > 0) openWindow(node, window);
      const startedSoFar = await entitiesStarted(node);
      expect(startedSoFar).toHaveLength((window + 1) * BATCH);
      await awaitCondition(() => recovered.length === (window + 1) * BATCH, {
        timeoutMs: 4_000,
        label: `every replay of window ${window} completed`,
      });
      // Exactly the four entities this window started read the journal in it,
      // and nothing else did.
      const startedNow = startedSoFar.filter((entityId) => !startedBefore.includes(entityId));
      expect(startedNow).toHaveLength(BATCH);
      expect(node.journal.readIn(window)).toEqual(persistenceIdsOf(startedNow));
      startedBefore = startedSoFar;
    }

    // Every remembered entity was replayed exactly once and came back.
    expect(node.journal.reads.map((read) => read.persistenceId).sort()).toEqual(persistenceIdsOf(REMEMBERED));
    expect([...recovered].sort()).toEqual([...REMEMBERED].sort());
    // Each window between batches was the configured one, straight from HOCON,
    // and the region armed no batch once nothing was owed.
    expect(node.scheduler.armed.map((batch) => batch.delayMs)).toEqual(
      Array.from({ length: WINDOWS - 1 }, () => CAPTURED_FREQUENCY_MS),
    );
  }, CASE_TIMEOUT_MS);

  test('strategy = all: every replay reaches the journal in one burst', async () => {
    const node = await startNode('851-journal-burst', 45_591, hoconFor('all', 0));
    node.journal.hold();
    await allocate(node);

    expect(await entitiesStarted(node)).toEqual([...REMEMBERED].sort());
    // All twenty reads are open at once: nothing paced them.
    await awaitCondition(() => node.journal.inFlight === REMEMBERED.length, {
      timeoutMs: 4_000,
      label: 'every replay is open at the journal at once',
    });
    expect(node.scheduler.armed).toHaveLength(0);

    node.journal.release();
    await awaitCondition(() => recovered.length === REMEMBERED.length, {
      timeoutMs: 4_000,
      label: 'every remembered entity recovered',
    });
    expect(node.journal.peakInFlight).toBe(REMEMBERED.length);
  }, CASE_TIMEOUT_MS);

  test('constant-rate alone paces when replays start, not how many are in flight', async () => {
    const node = await startNode('851-journal-overlap', 45_592, hoconFor('constant-rate', 0));
    node.journal.hold();
    await allocate(node);

    // Replays slower than the window: each batch opens four more reads while
    // the earlier ones are still open.
    for (let window = 0; window < WINDOWS - 1; window++) {
      if (window > 0) openWindow(node, window);
      expect(await entitiesStarted(node)).toHaveLength((window + 1) * BATCH);
      await awaitCondition(() => node.journal.inFlight === (window + 1) * BATCH, {
        timeoutMs: 4_000,
        label: `the replays of windows 0..${window} are all open`,
      });
    }
    expect(node.journal.peakInFlight).toBe((WINDOWS - 1) * BATCH);

    node.journal.release();
    openWindow(node, WINDOWS - 1);
    await awaitCondition(() => recovered.length === REMEMBERED.length, {
      timeoutMs: 4_000,
      label: 'every remembered entity recovered',
    });
  }, CASE_TIMEOUT_MS);

  test('with max-concurrent-recoveries = k, the replays in flight never exceed k', async () => {
    const node = await startNode('851-journal-permits', 45_593, hoconFor('constant-rate', PERMITS));
    node.journal.hold();
    await allocate(node);
    const permits = node.persistence.recoveryPermits;
    if (permits === null) throw new Error('max-concurrent-recoveries did not install a permit');

    // Three windows of slow replays, as in the case above — but now the starts
    // the pacing lets through queue at the permit instead of at the journal.
    for (let window = 0; window < WINDOWS - 1; window++) {
      if (window > 0) openWindow(node, window);
      const started = (window + 1) * BATCH;
      expect(await entitiesStarted(node)).toHaveLength(started);
      await awaitCondition(() => node.journal.inFlight === PERMITS && permits.queued === started - PERMITS, {
        timeoutMs: 4_000,
        label: `window ${window}: ${PERMITS} replays open, ${started - PERMITS} waiting for a permit`,
      });
    }

    node.journal.release();
    await awaitCondition(() => recovered.length === (WINDOWS - 1) * BATCH, {
      timeoutMs: 4_000,
      label: 'every entity started so far recovered once the journal answered',
    });
    openWindow(node, WINDOWS - 1);
    await awaitCondition(() => recovered.length === REMEMBERED.length, {
      timeoutMs: 4_000,
      label: 'every remembered entity recovered',
    });

    // The bound held the whole way, at the journal and at the permit itself.
    expect(node.journal.peakInFlight).toBe(PERMITS);
    expect(permits.peakInFlight).toBe(PERMITS);
    expect(node.journal.reads.map((read) => read.persistenceId).sort()).toEqual(persistenceIdsOf(REMEMBERED));
  }, CASE_TIMEOUT_MS);
});
