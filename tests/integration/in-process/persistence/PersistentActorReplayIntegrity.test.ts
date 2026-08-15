/**
 * A real `PersistentActor` over a journal that breaks its read contract
 * (#122).
 *
 * The unit tests next door pin the checks themselves; what needs an
 * actor is the consequence.  Before the checks, a shuffled read left
 * `lastSequenceNr` on the last event *delivered* rather than the highest
 * one, so recovery "succeeded" against a state that never existed and
 * the first `persist` afterwards died with a `JournalConcurrencyError`
 * pointing at a perfectly healthy journal — an error one restart away
 * from its cause.  Now the failure lands in `onRecoveryFailure`, naming
 * the journal and the offending sequence number.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { Journal } from '../../../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent } from '../../../../src/persistence/JournalTypes.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  JournalIntegrityError,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type AppendCommand = { kind: 'append'; value: number };
type ReportCommand = { kind: 'report' };
type Command = AppendCommand | ReportCommand;

type AppendedEvent = { kind: 'appended'; value: number };
type State = { total: number };

/**
 * Delegates to a real journal and rewrites only what `read` returns —
 * the seam every misbehaviour in #122 sits on, whether it comes from a
 * missing `ORDER BY`, a half-written append or a tampered store.
 */
class RewritingJournal implements Journal {
  constructor(
    private readonly underlying: InMemoryJournal,
    private readonly rewrite: (events: PersistentEvent<unknown>[]) => PersistentEvent<unknown>[],
  ) {}

  append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.underlying.append<E>(persistenceId, entries, expectedSeq);
  }

  async read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const events = await this.underlying.read<unknown>(persistenceId, fromSeq, toSeq);
    return this.rewrite(events) as PersistentEvent<E>[];
  }

  highestSeq(persistenceId: string): Promise<number> {
    return this.underlying.highestSeq(persistenceId);
  }

  delete(persistenceId: string, toSeq: number): Promise<void> {
    return this.underlying.delete(persistenceId, toSeq);
  }

  persistenceIds(): Promise<string[]> { return this.underlying.persistenceIds(); }
}

/**
 * Captures the recovery failure instead of rethrowing it.  Swallowing is
 * the documented "you own it now" path, and it keeps supervision noise
 * out of a test whose subject is the reason, not the restart policy.
 */
class Ledger extends PersistentActor<Command, AppendedEvent, State> {
  constructor(
    readonly persistenceId: string,
    private readonly onFailure: (reason: Error) => void,
    private readonly replyTo: (total: number) => void,
  ) {
    super();
  }

  initialState(): State { return { total: 0 }; }
  onEvent(state: State, event: AppendedEvent): State { return { total: state.total + event.value }; }

  override onRecoveryFailure(reason: Error): void { this.onFailure(reason); }

  async onCommand(state: State, command: Command): Promise<void> {
    if (command.kind === 'append') {
      await this.persist({ kind: 'appended', value: command.value }, (s) => this.replyTo(s.total));
      return;
    }
    this.replyTo(state.total);
  }
}

type Fixture = {
  system: ActorSystem;
  underlying: InMemoryJournal;
  failures: Error[];
  totals: number[];
};

function makeSystem(
  name: string,
  rewrite: (events: PersistentEvent<unknown>[]) => PersistentEvent<unknown>[],
): Fixture {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  const underlying = new InMemoryJournal();
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(new RewritingJournal(underlying, rewrite));
  extension.setSnapshotStore(new InMemorySnapshotStore());
  return { system, underlying, failures: [], totals: [] };
}

/** Seed the backing journal directly — no actor, so no replay involved. */
async function seed(journal: InMemoryJournal, persistenceId: string, values: number[]): Promise<void> {
  let expected = 0;
  for (const value of values) {
    await journal.append<AppendedEvent>(persistenceId, [{ event: { kind: 'appended', value } }], expected);
    expected += 1;
  }
}

const identity = (events: PersistentEvent<unknown>[]): PersistentEvent<unknown>[] => events;

describe('recovery over a journal that breaks its read contract (#122)', () => {
  test('a shuffled read fails recovery instead of producing a phantom concurrency error', async () => {
    const swap = (events: PersistentEvent<unknown>[]): PersistentEvent<unknown>[] => {
      const shuffled = [...events];
      if (shuffled.length >= 3) [shuffled[1], shuffled[2]] = [shuffled[2]!, shuffled[1]!];
      return shuffled;
    };
    const fixture = makeSystem('replay-integrity-shuffled', swap);
    await seed(fixture.underlying, 'ledger-shuffled', [1, 2, 3]);

    const ledger = fixture.system.spawn(
      () => new Ledger('ledger-shuffled', (e) => fixture.failures.push(e), (t) => fixture.totals.push(t)),
      'shuffled',
    );
    // The actor stops itself once the hook returns, so the append can
    // only ever reach dead letters — the point is that it never answers
    // from a state assembled in the wrong order.
    ledger.tell({ kind: 'append', value: 10 });

    await awaitCondition(() => fixture.failures.length === 1, {
      timeoutMs: 4_000,
      label: 'recovery over a shuffled journal failed',
    });
    expect(fixture.failures[0]).toBeInstanceOf(JournalIntegrityError);
    expect(fixture.failures[0]!.message).toMatch(/expected sequenceNr=2, got 3/);
    expect(fixture.totals).toEqual([]);
    // The journal itself is untouched: the phantom error the report
    // chased was never the journal's fault.
    expect(await fixture.underlying.highestSeq('ledger-shuffled')).toBe(3);

    await fixture.system.terminate();
  });

  test('a hole in the stream fails recovery', async () => {
    const dropSecond = (events: PersistentEvent<unknown>[]): PersistentEvent<unknown>[] =>
      events.filter((event) => event.sequenceNr !== 2);
    const fixture = makeSystem('replay-integrity-hole', dropSecond);
    await seed(fixture.underlying, 'ledger-hole', [1, 2, 3]);

    fixture.system.spawn(
      () => new Ledger('ledger-hole', (e) => fixture.failures.push(e), (t) => fixture.totals.push(t)),
      'hole',
    );

    await awaitCondition(() => fixture.failures.length === 1, {
      timeoutMs: 4_000,
      label: 'recovery over a holed journal failed',
    });
    expect(fixture.failures[0]).toBeInstanceOf(JournalIntegrityError);
    expect(fixture.failures[0]!.message).toMatch(/gap: expected sequenceNr=2, got 3/);

    await fixture.system.terminate();
  });

  test('a compacted prefix with no covering snapshot fails recovery', async () => {
    // Reachable through the public API — `deleteHistory` on an actor
    // that never snapshotted.  It used to recover the surviving tail
    // onto `initialState()` and call that the current balance.
    const fixture = makeSystem('replay-integrity-compacted', identity);
    await seed(fixture.underlying, 'ledger-compacted', [1, 2, 3]);
    await fixture.underlying.delete('ledger-compacted', 1);

    fixture.system.spawn(
      () => new Ledger('ledger-compacted', (e) => fixture.failures.push(e), (t) => fixture.totals.push(t)),
      'compacted',
    );

    await awaitCondition(() => fixture.failures.length === 1, {
      timeoutMs: 4_000,
      label: 'recovery over a snapshot-less compaction failed',
    });
    expect(fixture.failures[0]!.message).toMatch(/cannot be reconstructed/);

    await fixture.system.terminate();
  });

  test('a well-behaved journal recovers and keeps persisting', async () => {
    // The control: the checks must be invisible on every legitimate path.
    const fixture = makeSystem('replay-integrity-control', identity);
    await seed(fixture.underlying, 'ledger-control', [1, 2, 3]);

    const ledger = fixture.system.spawn(
      () => new Ledger('ledger-control', (e) => fixture.failures.push(e), (t) => fixture.totals.push(t)),
      'control',
    );
    ledger.tell({ kind: 'report' });
    ledger.tell({ kind: 'append', value: 10 });

    await awaitCondition(() => fixture.totals.length === 2, {
      timeoutMs: 4_000,
      label: 'the recovered ledger reported and appended',
    });
    expect(fixture.failures).toEqual([]);
    expect(fixture.totals).toEqual([6, 16]);
    expect(await fixture.underlying.highestSeq('ledger-control')).toBe(4);

    await fixture.system.terminate();
  });
});
