import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Actor } from '../../../../src/Actor.js';
import {
  DurableStateActor,
  DurableStateOptions,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { ActorLifecycleEvent, ActorStopped } from '../../../../src/SystemMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* --------------------------- shared fixtures ----------------------------- */

type DepositCommand = { kind: 'deposit'; amount: number };
type Command = DepositCommand;

type DepositedEvent = { kind: 'deposited'; amount: number };
type Event = DepositedEvent;

type State = { balance: number };

/**
 * What the actor did, recorded outside it — an actor whose `preStart`
 * throws is unreachable, so every assertion reads from this bag.
 */
type Observations = {
  incarnations: number;
  recovered: State[];
  recoveryFailures: Error[];
};

const newObservations = (): Observations =>
  ({ incarnations: 0, recovered: [], recoveryFailures: [] });

class Account extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;
  constructor(persistenceId: string, private readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
  }
  initialState(): State { return { balance: 0 }; }
  onEvent(state: State, event: Event): State {
    return { balance: state.balance + event.amount };
  }
  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }
  /**
   * Records instead of rethrowing — the point of the test below is that a
   * rejected id never reaches this hook, and a hook that rethrew would
   * make "never reached" and "reached and rethrew" indistinguishable.
   */
  override onRecoveryFailure(reason: Error): void { this.observations.recoveryFailures.push(reason); }
  async onCommand(_state: State, command: Command): Promise<void> {
    await this.persist({ kind: 'deposited', amount: command.amount });
  }
}

type SetCommand = { kind: 'set'; value: string };

class Setting extends DurableStateActor<SetCommand, { value: string }> {
  override async onCommand(command: SetCommand): Promise<void> {
    await this.persist({ value: command.value });
  }
}

const settingOptions = (persistenceId: string): DurableStateOptions<{ value: string }> =>
  DurableStateOptions.create<{ value: string }>()
    .withPersistenceId(persistenceId)
    .withStore(new InMemoryDurableStateStore())
    .withEmptyState(() => ({ value: '' }));

class LifecycleListener extends Actor<ActorLifecycleEvent> {
  constructor(private readonly seen: ActorLifecycleEvent[], private readonly ready: { value: boolean }) {
    super();
  }
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, ActorLifecycleEvent);
    this.ready.value = true;
  }
  override onReceive(event: ActorLifecycleEvent): void { this.seen.push(event); }
}

function makeSystem(name: string): { system: ActorSystem; journal: InMemoryJournal } {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(journal);
  extension.setSnapshotStore(new InMemorySnapshotStore());
  return { system, journal };
}

/* ------------------------------- journals -------------------------------- */

describe('journal append — the last line of defence', () => {
  test('refuses an id with a path separator and writes nothing', async () => {
    const journal = new InMemoryJournal();
    await expect(journal.append('tenant/../root', [{ kind: 'deposited', amount: 1 }], 0))
      .rejects.toThrow(/path separator/);
    expect(await journal.highestSeq('tenant/../root')).toBe(0);
    expect(await journal.read('tenant/../root', 1)).toEqual([]);
  });

  test('refuses an empty id, which every stream would otherwise share', async () => {
    const journal = new InMemoryJournal();
    await expect(journal.append('', [{ kind: 'deposited', amount: 1 }], 0))
      .rejects.toThrow(/non-empty string/);
  });

  test('leaves the READ path open, so pre-existing data stays reachable', async () => {
    // The escape hatch that makes the tightening adoptable: events written
    // before these rules existed must stay copyable to a corrected id, so
    // `read` and `highestSeq` answer for an id `append` now refuses rather
    // than throwing at it.
    const journal = new InMemoryJournal();
    await expect(journal.read('tenant/legacy', 1)).resolves.toEqual([]);
    await expect(journal.highestSeq('tenant/legacy')).resolves.toBe(0);
  });

  test('accepts the pipe-separated id the chat example ships', async () => {
    const journal = new InMemoryJournal();
    const written = await journal.append(
      'dm-channel-alice|bob', [{ kind: 'deposited', amount: 1 }], 0,
    );
    expect(written.map((e) => e.sequenceNr)).toEqual([1]);
  });
});

/* ---------------------------- PersistentActor ---------------------------- */

describe('PersistentActor — an id that cannot be a storage key', () => {
  test('fails at preStart without ever reaching onRecoveryFailure', async () => {
    const { system } = makeSystem('persistence-id-rejected');
    const lifecycle: ActorLifecycleEvent[] = [];
    const ready = { value: false };
    system.spawn(() => new LifecycleListener(lifecycle, ready), 'lifecycle');
    await awaitCondition(() => ready.value, { label: 'the lifecycle listener subscribed' });

    const observations = newObservations();
    const ref = system.spawn(
      () => {
        observations.incarnations++;
        return new Account('snapshots/../../etc', observations);
      },
      'account',
    );

    // The assert sits outside the recovery guard, so supervision — not the
    // hook — owns the failure, and the restart budget eventually stops it.
    await awaitCondition(() => observations.incarnations > 1, {
      label: 'supervision restarted the actor with the rejected id',
    });
    await awaitCondition(
      () => lifecycle.some((e) => e instanceof ActorStopped && e.actor.equals(ref)),
      { label: 'the restart budget ran out and the actor stopped', timeoutMs: 5_000 },
    );
    // An id this class refuses is a bug in the class, not a journal
    // failure — routing it through the recovery hook would let an override
    // that swallows journal errors swallow this too.
    expect(observations.recoveryFailures).toEqual([]);
    expect(observations.recovered).toEqual([]);
    await system.terminate();
  });

  test('recovers normally with the pipe-separated id the chat example ships', async () => {
    const { system, journal } = makeSystem('persistence-id-pipe');
    await journal.append<Event>('dm-channel-alice|bob', [{ kind: 'deposited', amount: 3 }], 0);

    const observations = newObservations();
    system.spawn(() => new Account('dm-channel-alice|bob', observations), 'channel');
    await awaitCondition(() => observations.recovered.length === 1, {
      label: 'the DM channel recovered its journal',
    });
    expect(observations.recovered[0]).toEqual({ balance: 3 });
    await system.terminate();
  });
});

/* --------------------------- DurableStateActor --------------------------- */

describe('DurableStateActor — the id arrives as an option', () => {
  test('rejects it as an OptionsError, at construction', () => {
    // Reported against the field, like every other XOptionsValidator —
    // and before the actor is wired to a store, which is earlier than a
    // preStart check could manage.
    let caught: unknown = null;
    try { new Setting(settingOptions('cart/../admin')); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('persistenceId');
    expect((caught as Error).message).toMatch(/path separator/);
  });

  test('rejects an empty id the builder happily accepted', () => {
    expect(() => new Setting(settingOptions(''))).toThrow(OptionsError);
  });

  test('accepts an ordinary id', () => {
    expect(() => new Setting(settingOptions('cart-user-42'))).not.toThrow();
  });
});
