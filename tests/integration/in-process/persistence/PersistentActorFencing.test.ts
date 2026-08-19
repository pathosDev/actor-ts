import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import type { Lease } from '../../../../src/coordination/Lease.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/**
 * Fencing for `PersistentActor` (#1166).
 *
 * Two live instances of one persistence-id both recover and both accept
 * commands.  The conditional write keeps the *journal* sound — one of them
 * loses with `JournalConcurrencyError` — but the damage is outside the
 * journal: by the time the loser finds out it has already run `onCommand`,
 * and a non-replayable side effect there is not rolled back.  Worse, the
 * default supervision answer to that error is a restart, after which the
 * loser recovers the now-foreign head and carries on as if it owned the
 * entity.
 *
 * Two layers are tested here: the lease, which stops a non-owner becoming a
 * writer at all, and the backstop, which stops the loser of a race instead of
 * letting it restart into a zombie.
 */

type WriteCommand = { kind: 'write'; amount: number };

type Command = WriteCommand;

type WrittenEvent = { kind: 'written'; amount: number };

type Event = WrittenEvent;

type State = { total: number };

function makeSystem(name: string): { system: ActorSystem; journal: InMemoryJournal } {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  const ext = system.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(new InMemorySnapshotStore());
  return { system, journal };
}

/** Counts the side effect the issue is really about. */
let sideEffects = 0;

class Ledger extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;
  lastError: Error | null = null;
  /**
   * Recovery is the precondition every race below needs: a second instance
   * that recovers *after* the first write sees the moved head and no longer
   * loses.  A fixed sleep only guessed at it, so the flag makes the
   * precondition observable and the wait a poll on it (#418).
   */
  recovered = false;

  constructor(persistenceId: string, private readonly leaseImpl: Lease | null = null) {
    super();
    this.persistenceId = persistenceId;
  }

  override lease(): Lease | null { return this.leaseImpl; }

  /** `isLeaseHolder` is protected; re-expose it for assertions. */
  get holds(): boolean { return this.isLeaseHolder; }

  initialState(): State { return { total: 0 }; }

  override onRecoveryComplete(): void { this.recovered = true; }

  onEvent(state: State, event: Event): State {
    return match(event)
      .with({ kind: 'written' }, (e) => ({ total: state.total + e.amount }))
      .exhaustive();
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'write' }, (c) => this.onWrite(c))
      .exhaustive();
  }

  private async onWrite(command: WriteCommand): Promise<void> {
    try {
      // The non-replayable side effect the lease exists to protect.
      sideEffects++;
      await this.persist({ kind: 'written', amount: command.amount });
    } catch (e) {
      this.lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
}

/** A lease exactly one holder can take. */
class SingleHolderLease implements Lease {
  private static holders = new Set<string>();
  private lostHandlers: Array<(reason: string) => void> = [];
  held = false;
  constructor(private readonly key: string) {}

  static reset(): void { SingleHolderLease.holders.clear(); }

  async acquire(): Promise<boolean> {
    if (SingleHolderLease.holders.has(this.key)) return false;
    SingleHolderLease.holders.add(this.key);
    this.held = true;
    return true;
  }

  async release(): Promise<void> {
    if (this.held) SingleHolderLease.holders.delete(this.key);
    this.held = false;
  }

  checkAlive(): boolean { return this.held; }

  onLost(handler: (reason: string) => void): () => void {
    this.lostHandlers.push(handler);
    return () => { this.lostHandlers = this.lostHandlers.filter((h) => h !== handler); };
  }

  /** Simulate a TTL expiry / fence from elsewhere. */
  fence(reason: string): void {
    this.held = false;
    SingleHolderLease.holders.delete(this.key);
    for (const handler of this.lostHandlers) handler(reason);
  }
}

describe('PersistentActor fencing (#1166)', () => {
  test('without a lease, the loser of a race stops instead of restarting into a zombie', async () => {
    sideEffects = 0;
    const { system, journal } = makeSystem('fencing-none');

    // Two live instances of one persistence-id — the state a partition plus a
    // rebalance produces.
    const first = new Ledger('ledger-1');
    const second = new Ledger('ledger-1');
    const firstRef = system.spawn(() => first, 'first');
    const secondRef = system.spawn(() => second, 'second');
    await awaitCondition(() => first.recovered && second.recovered, {
      timeoutMs: 3_000,
      label: 'both instances recovered while the head was still at 0',
    });

    // The first write moves the head; the second instance still holds the old
    // sequence and loses its conditional append.  The head having moved is the
    // whole precondition, so wait on the journal rather than on a delay.
    firstRef.tell({ kind: 'write', amount: 10 });
    await awaitCondition(async () => (await journal.highestSeq('ledger-1')) === 1, {
      timeoutMs: 3_000,
      label: "the winner's write moved the head to 1",
    });
    secondRef.tell({ kind: 'write', amount: 5 });

    await awaitCondition(() => second.lastError !== null, {
      timeoutMs: 3_000,
      label: 'the losing instance saw its conflict',
    });
    expect(second.lastError?.name).toBe('JournalConcurrencyError');

    // The loser is gone rather than restarted — a restart would have it
    // recover the foreign head and keep serving.
    await awaitCondition(() => system._resolvePath(['user', 'second']).isNone(), {
      timeoutMs: 3_000,
      label: 'the losing instance stopped',
    });
    expect(system._resolvePath(['user', 'second']).isNone()).toBe(true);

    // The winner is untouched.
    expect(system._resolvePath(['user', 'first']).isSome()).toBe(true);

    await system.terminate();
  }, 10_000);

  test('with a lease, the non-owner never writes at all', async () => {
    sideEffects = 0;
    SingleHolderLease.reset();
    const { system, journal } = makeSystem('fencing-lease');

    const ownerLease = new SingleHolderLease('ledger-2');
    const intruderLease = new SingleHolderLease('ledger-2');
    const owner = new Ledger('ledger-2', ownerLease);
    const intruder = new Ledger('ledger-2', intruderLease);

    const ownerRef = system.spawn(() => owner, 'owner');
    await awaitCondition(() => ownerLease.held, { label: 'the owner took the lease' });
    const intruderRef = system.spawn(() => intruder, 'intruder');
    // An absence: the intruder must *never* take the lease, and a predicate over
    // `held === false` is already true at t=0, so there is nothing to poll (#418).
    await sleep(50);

    expect(intruderLease.held).toBe(false);

    ownerRef.tell({ kind: 'write', amount: 10 });
    await awaitCondition(async () => (await journal.highestSeq('ledger-2')) === 1, {
      timeoutMs: 3_000,
      label: "the owner's write moved the head to 1",
    });

    // The intruder refuses up front — this is the difference that matters:
    // it is turned away *before* the journal is touched, so an entity whose
    // `onCommand` charges a card would not have charged it twice.
    intruderRef.tell({ kind: 'write', amount: 5 });
    await awaitCondition(() => intruder.lastError !== null, {
      timeoutMs: 3_000,
      label: 'the non-owner was refused',
    });
    expect(intruder.lastError?.message).toContain('does not hold');
    expect(intruder.lastError?.name).not.toBe('JournalConcurrencyError');

    await system.terminate();
  }, 10_000);

  test('losing a held lease stops the actor by default', async () => {
    SingleHolderLease.reset();
    const { system } = makeSystem('fencing-lost');

    const lease = new SingleHolderLease('ledger-3');
    const ledger = new Ledger('ledger-3', lease);
    system.spawn(() => ledger, 'holder');
    await awaitCondition(() => lease.held, { label: 'the holder took the lease' });

    lease.fence('ttl expired');

    await awaitCondition(() => system._resolvePath(['user', 'holder']).isNone(), {
      timeoutMs: 3_000,
      label: 'the actor stopped after losing its lease',
    });
    expect(system._resolvePath(['user', 'holder']).isNone()).toBe(true);

    await system.terminate();
  }, 10_000);

  test('no lease configured keeps the previous behaviour', async () => {
    // The default must stay exactly as it was: `lease()` returns null, every
    // instance is its own writer, nothing acquires anything.
    const { system, journal } = makeSystem('fencing-default');
    const ledger = new Ledger('ledger-4');
    const ref = system.spawn(() => ledger, 'plain');
    await awaitCondition(() => ledger.recovered, {
      timeoutMs: 3_000,
      label: 'the plain instance recovered',
    });

    ref.tell({ kind: 'write', amount: 7 });
    ref.tell({ kind: 'write', amount: 3 });
    // Both writes are durable, or one of them recorded an error — either way the
    // outcome is settled, which is what the 100 ms was waiting for.
    await awaitCondition(
      async () => (await journal.highestSeq('ledger-4')) === 2 || ledger.lastError !== null,
      { timeoutMs: 3_000, label: 'both writes were answered' },
    );

    expect(ledger.lastError).toBeNull();
    expect(ledger.holds).toBe(true);

    await system.terminate();
  }, 10_000);
});
