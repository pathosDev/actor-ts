/**
 * A command's `kind` is whatever its sender put there, and the transition
 * table it is looked up in is the developer's object literal, which inherits
 * every member of `Object.prototype`.  Read through the prototype chain, a
 * kind such as `toString` or `constructor` found an inherited function where
 * a transition belonged: `onInvalidTransition` never ran and the command was
 * lost without a word.  The same holds one level up, for a state the table
 * has no entry for whose name an `Object.prototype` member shares.
 *
 * The list is literal so a runtime cannot shrink it, and the first test holds
 * it to the runtime's own `Object.prototype` so it cannot fall behind either.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import {
  PersistentFSM,
  type FsmStateData,
  type FsmTransitionMap,
} from '../../../src/fsm/PersistentFSM.js';

const OBJECT_PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const;

/** Any kind at all — the point is what the sender may put there. */
type DoorCommand = { readonly kind: string };
type DoorEvent = { readonly kind: 'opened' };
type DoorData = { readonly opened: number };

/** Answers with the current state and data; never looked up in the table. */
const INSPECT = 'inspect';

class DoorFsm extends PersistentFSM<DoorCommand, DoorEvent, string, DoorData> {
  readonly persistenceId: string;
  private readonly initial: string;
  private readonly invalid: string[];

  constructor(persistenceId: string, initial: string, invalid: string[]) {
    super();
    this.persistenceId = persistenceId;
    this.initial = initial;
    this.invalid = invalid;
  }

  initialFsmState(): string { return this.initial; }
  initialData(): DoorData { return { opened: 0 }; }

  transitions: FsmTransitionMap<string, DoorCommand, DoorEvent, DoorData> = {
    closed: {
      open: { event: { kind: 'opened' }, next: 'open' },
    },
  };

  applyEvent(_state: string, data: DoorData, _event: DoorEvent): FsmStateData<string, DoorData> {
    return { state: 'open', data: { opened: data.opened + 1 } };
  }

  override async onCommand(curr: FsmStateData<string, DoorData>, command: DoorCommand): Promise<void> {
    if (command.kind === INSPECT) {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, command);
  }

  protected override onInvalidTransition(state: string, command: DoorCommand): void {
    this.invalid.push(`${state}:${command.kind}`);
  }
}

function buildSystem(name: string): { sys: ActorSystem; journal: InMemoryJournal } {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(name, sysOptions);
  const journal = new InMemoryJournal();
  const ext = sys.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(new InMemorySnapshotStore());
  return { sys, journal };
}

describe('the fixture', () => {
  test('names every own member of Object.prototype on this runtime', () => {
    for (const member of Object.getOwnPropertyNames(Object.prototype)) {
      expect(OBJECT_PROTOTYPE_NAMES as readonly string[]).toContain(member);
    }
  });
});

describe('PersistentFSM — a kind the transition table only inherits', () => {
  test('a command named after an Object.prototype member reaches onInvalidTransition and persists nothing', async () => {
    const { sys, journal } = buildSystem('fsm-prototype-kinds');
    try {
      const invalid: string[] = [];
      const ref = sys.spawn(() => new DoorFsm('door-kinds', 'closed', invalid), 'door');
      for (const [index, name] of OBJECT_PROTOTYPE_NAMES.entries()) {
        ref.tell({ kind: name });
        // Ordered behind the tell, so it answers only after the command has been through the FSM.
        const after = await ref.ask<FsmStateData<string, DoorData>>({ kind: INSPECT }, 2_000);

        const expected = OBJECT_PROTOTYPE_NAMES.slice(0, index + 1).map((sent) => `closed:${sent}`);
        expect({ name, invalid }).toEqual({ name, invalid: expected });
        expect(after).toEqual({ state: 'closed', data: { opened: 0 } });
      }
      expect(await journal.read('door-kinds', 0)).toEqual([]);

      // The transition the table does declare still runs.
      ref.tell({ kind: 'open' });
      const opened = await ref.ask<FsmStateData<string, DoorData>>({ kind: INSPECT }, 2_000);
      expect(opened).toEqual({ state: 'open', data: { opened: 1 } });
      expect((await journal.read('door-kinds', 0)).map((entry) => entry.event)).toEqual([{ kind: 'opened' }]);
    } finally {
      await sys.terminate();
    }
  });

  test('a state named after an Object.prototype member has no transitions the table does not declare', async () => {
    const { sys, journal } = buildSystem('fsm-prototype-states');
    try {
      // `name` is an own member of every function on `Object.prototype` and of
      // `Object` itself, and `toString` one of `Object.prototype`, so between
      // them each inherited value has a member a kind can name.
      const kinds = ['name', 'toString'] as const;
      for (const [index, state] of OBJECT_PROTOTYPE_NAMES.entries()) {
        const invalid: string[] = [];
        const persistenceId = `door-state-${index}`;
        const ref = sys.spawn(() => new DoorFsm(persistenceId, state, invalid), `door-${index}`);
        for (const kind of kinds) ref.tell({ kind });
        const after = await ref.ask<FsmStateData<string, DoorData>>({ kind: INSPECT }, 2_000);

        expect({ state, invalid }).toEqual({ state, invalid: kinds.map((kind) => `${state}:${kind}`) });
        expect(after.state).toBe(state);
        expect(await journal.read(persistenceId, 0)).toEqual([]);
      }
    } finally {
      await sys.terminate();
    }
  });
});
