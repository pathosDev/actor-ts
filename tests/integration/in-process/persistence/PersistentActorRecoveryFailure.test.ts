import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import {
  ActorLifecycleEvent,
  ActorRestarted,
  ActorStopped,
  DeadLetter,
} from '../../../../src/SystemMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* --------------------------- shared types -------------------------------- */

type DepositCommand = { kind: 'deposit'; amount: number };
type BalanceCommand = { kind: 'balance' };

type Command = DepositCommand | BalanceCommand;

type DepositedEvent = { kind: 'deposited'; amount: number };
type Event = DepositedEvent;

type State = { balance: number };

/**
 * What the actor did, recorded outside it.  A hook that swallows its
 * error has nowhere else to report, and the instance is unreachable once
 * the actor stops — so every assertion here reads from this bag rather
 * than from the actor.
 */
type Observations = {
  failures: Error[];
  recovered: State[];
  handled: Command[];
  /** Bumped by the actor factory — the only observable for a restart loop. */
  incarnations: number;
};

const newObservations = (): Observations =>
  ({ failures: [], recovered: [], handled: [], incarnations: 0 });

class Account extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;
  constructor(persistenceId: string, protected readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
  }
  initialState(): State { return { balance: 0 }; }
  onEvent(state: State, event: Event): State {
    return { balance: state.balance + event.amount };
  }
  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }
  async onCommand(state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'deposit' }, (c) => this.onDeposit(c))
      .with({ kind: 'balance' }, () => this.onBalance(state))
      .exhaustive();
  }

  private async onDeposit(command: DepositCommand): Promise<void> {
    this.observations.handled.push(command);
    await this.persist({ kind: 'deposited', amount: command.amount });
  }

  private onBalance(state: State): void {
    this.observations.handled.push({ kind: 'balance' });
    void state;
  }
}

/** Records the failure and returns — the override shape this suite is about. */
class SwallowingAccount extends Account {
  override onRecoveryFailure(reason: Error): void { this.observations.failures.push(reason); }
}

/* ------------------------------ listeners -------------------------------- */

/**
 * `subscribe` happens in `preStart`, so a test must know the listener is
 * live before provoking the event — otherwise it races the very
 * publication it means to observe.
 */
type ListenerReady = { value: boolean };

class DeadLetterListener extends Actor<DeadLetter> {
  constructor(private readonly seen: DeadLetter[], private readonly ready: ListenerReady) { super(); }
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    this.ready.value = true;
  }
  override onReceive(letter: DeadLetter): void { this.seen.push(letter); }
}

/** One subscription takes Started / Stopped / Restarted — matching is by `instanceof`. */
class LifecycleListener extends Actor<ActorLifecycleEvent> {
  constructor(private readonly seen: ActorLifecycleEvent[], private readonly ready: ListenerReady) { super(); }
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, ActorLifecycleEvent);
    this.ready.value = true;
  }
  override onReceive(event: ActorLifecycleEvent): void { this.seen.push(event); }
}

/* ------------------------------- harness --------------------------------- */

function makeSystem(name: string): { system: ActorSystem; journal: InMemoryJournal; snapshots: InMemorySnapshotStore } {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(journal);
  extension.setSnapshotStore(snapshots);
  return { system, journal, snapshots };
}

/**
 * Make recovery fail on data alone.  A snapshot claiming a sequence
 * number far ahead of the journal is refused by
 * `assertTrustworthySnapshot`, so `replayState` throws *before*
 * `PersistentActor` assigns `_state` — which is precisely the window
 * under test.  No throwing-store fake needed.
 */
async function seedUnrecoverable(
  journal: InMemoryJournal,
  snapshots: InMemorySnapshotStore,
  persistenceId: string,
): Promise<void> {
  await journal.append<Event>(persistenceId, [{ kind: 'deposited', amount: 10 }], 0);
  await snapshots.save<State>(persistenceId, Number.MAX_SAFE_INTEGER, { balance: 99_999 });
}

async function spawnListeners(
  system: ActorSystem,
): Promise<{ deadLetters: DeadLetter[]; lifecycle: ActorLifecycleEvent[] }> {
  const deadLetters: DeadLetter[] = [];
  const lifecycle: ActorLifecycleEvent[] = [];
  const deadLetterReady: ListenerReady = { value: false };
  const lifecycleReady: ListenerReady = { value: false };
  system.spawn(() => new DeadLetterListener(deadLetters, deadLetterReady), 'dead-letters');
  system.spawn(() => new LifecycleListener(lifecycle, lifecycleReady), 'lifecycle');
  await awaitCondition(() => deadLetterReady.value && lifecycleReady.value, {
    label: 'both event-stream listeners subscribed',
  });
  return { deadLetters, lifecycle };
}

/* -------------------------------- tests ---------------------------------- */

describe('PersistentActor — a swallowed recovery failure', () => {
  test('sends a later command to dead letters instead of stashing it forever', async () => {
    const { system, journal, snapshots } = makeSystem('recovery-failure-dead-letter');
    await seedUnrecoverable(journal, snapshots, 'acct-dead-letter');
    const { deadLetters } = await spawnListeners(system);

    const observations = newObservations();
    const ref = system.spawn(
      () => new SwallowingAccount('acct-dead-letter', observations),
      'account',
    );
    await awaitCondition(() => observations.failures.length === 1, {
      label: 'the swallowing hook observed the recovery failure',
    });

    ref.tell({ kind: 'deposit', amount: 5 });

    // Whichever side of termination the command lands on, it is
    // published: still queued → drained by finalizeTermination, arriving
    // later → dead-lettered by postUserMessage.  Before the fix it was
    // stashed, and nothing was published at all.
    await awaitCondition(
      () => deadLetters.some((letter) => (letter.message as Command).kind === 'deposit'),
      { label: 'the post-failure command reached dead letters' },
    );
    expect(observations.handled).toEqual([]);
    expect(observations.recovered).toEqual([]);
    await system.terminate();
  });

  test('stops the actor without spinning through the restart budget', async () => {
    const { system, journal, snapshots } = makeSystem('recovery-failure-stops');
    await seedUnrecoverable(journal, snapshots, 'acct-stops');
    const { lifecycle } = await spawnListeners(system);

    const observations = newObservations();
    const ref = system.spawn(
      () => {
        observations.incarnations++;
        return new SwallowingAccount('acct-stops', observations);
      },
      'account',
    );

    await awaitCondition(
      () => lifecycle.some((e) => e instanceof ActorStopped && e.actor.equals(ref)),
      { label: 'the actor whose recovery failed stopped itself' },
    );
    // The hook handled the failure, so supervision never sees it — one
    // replay attempt, not a dozen.
    expect(observations.incarnations).toBe(1);
    expect(observations.failures.length).toBe(1);
    expect(lifecycle.filter((e) => e instanceof ActorRestarted && e.actor.equals(ref))).toEqual([]);
    await system.terminate();
  });
});

describe('PersistentActor — a throwing onRecoveryComplete', () => {
  test('is not reported as a recovery failure', async () => {
    const { system, journal } = makeSystem('recovery-complete-throws');
    // A perfectly healthy journal — recovery itself must succeed, so any
    // failure that surfaces belongs to the hook and nothing else.
    await journal.append<Event>('acct-hook', [{ kind: 'deposited', amount: 10 }], 0);
    await spawnListeners(system);

    const observations = newObservations();
    class ThrowingCompleteAccount extends Account {
      override onRecoveryFailure(reason: Error): void { this.observations.failures.push(reason); }
      override onRecoveryComplete(state: State): void {
        this.observations.recovered.push(state);
        // Only the first incarnation throws, so the restart converges and
        // the test does not depend on the retry budget.
        if (this.observations.recovered.length === 1) throw new Error('hook exploded');
      }
    }
    system.spawn(
      () => {
        observations.incarnations++;
        return new ThrowingCompleteAccount('acct-hook', observations);
      },
      'account',
    );

    await awaitCondition(() => observations.incarnations > 1, {
      label: 'supervision restarted the actor after the hook threw',
    });
    // The state recovered fine both times — blaming onRecoveryFailure
    // would have pointed at the journal for a bug in user code.
    expect(observations.failures).toEqual([]);
    expect(observations.recovered[0]).toEqual({ balance: 10 });
    await system.terminate();
  });
});

describe('PersistentActor — the default onRecoveryFailure', () => {
  test('still routes the failure to supervision', async () => {
    const { system, journal, snapshots } = makeSystem('recovery-failure-default');
    await seedUnrecoverable(journal, snapshots, 'acct-default');
    const { lifecycle } = await spawnListeners(system);

    const observations = newObservations();
    // No override — the default rethrows, so `preStart` rejects and
    // ActorCell turns it into an ActorInitializationError.
    const ref = system.spawn(
      () => {
        observations.incarnations++;
        return new Account('acct-default', observations);
      },
      'account',
    );

    // Deliberately not an exact count: pinning it would couple this test
    // to defaultStrategy's 10-per-60s budget.  Note ActorRestarted is
    // never published here — onRecreate publishes it only after
    // postRestart succeeds, and postRestart re-runs the failing preStart
    // — so the incarnation counter is the only observable.
    await awaitCondition(() => observations.incarnations > 1, {
      label: 'supervision restarted the actor after the recovery failure',
    });
    await awaitCondition(
      () => lifecycle.some((e) => e instanceof ActorStopped && e.actor.equals(ref)),
      { label: 'the restart budget ran out and the actor stopped', timeoutMs: 5_000 },
    );
    expect(observations.recovered).toEqual([]);
    await system.terminate();
  });
});
