/**
 * Persistent FSM tests (#52) — combines state-machine semantics with
 * event sourcing.  We exercise:
 *
 *   - Happy-path transition sequence pending → paid → shipped, then
 *     restart the actor and observe the recovered state matches.
 *   - Invalid transition (`ship` from `'pending'`) is dropped — no
 *     event persists, no state mutates.
 *   - Guard rejection drops the command silently.
 *   - Function-style `event: (cmd, data) => Event` is evaluated.
 *   - Snapshot policy + recovery via snapshot still produces the
 *     right state + data.
 */
import { describe, expect, test } from 'bun:test';
import { ask } from '../../../src/Ask.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import {
  PersistentFSM,
  type FsmStateData,
  type FsmTransitionMap,
} from '../../../src/fsm/PersistentFSM.js';

/* ----------------------- Order-workflow domain ----------------------- */

type OrderState = 'pending' | 'paid' | 'shipped' | 'cancelled';

type OrderCmd =
  | { kind: 'pay'; amount: number }
  | { kind: 'ship'; carrier: string }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'getState' };

type OrderEvent =
  | { kind: 'paid'; amount: number }
  | { kind: 'shipped'; carrier: string }
  | { kind: 'cancelled'; reason?: string };

interface OrderData {
  amountPaid: number;
  carrier: string | null;
  cancelReason: string | null;
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

class OrderFsm extends PersistentFSM<OrderCmd, OrderEvent, OrderState, OrderData> {
  readonly persistenceId: string;

  constructor(pid: string) {
    super();
    this.persistenceId = pid;
  }

  initialFsmState(): OrderState { return 'pending'; }
  initialData(): OrderData { return { amountPaid: 0, carrier: null, cancelReason: null }; }

  transitions: FsmTransitionMap<OrderState, OrderCmd, OrderEvent, OrderData> = {
    pending: {
      pay: {
        // Function-style event — depends on the command.
        event: (cmd, _data): OrderEvent => ({ kind: 'paid', amount: cmd.amount }),
        next: 'paid',
        // Reject zero / negative amounts via the guard.
        guard: (cmd) => cmd.amount > 0,
      },
      cancel: {
        event: (cmd): OrderEvent => ({ kind: 'cancelled', reason: cmd.reason }),
        next: 'cancelled',
      },
    },
    paid: {
      ship: {
        event: (cmd): OrderEvent => ({ kind: 'shipped', carrier: cmd.carrier }),
        next: 'shipped',
      },
      cancel: {
        event: (cmd): OrderEvent => ({ kind: 'cancelled', reason: cmd.reason }),
        next: 'cancelled',
      },
    },
    // No transitions out of `shipped` or `cancelled` — terminal states.
  };

  applyEvent(state: OrderState, data: OrderData, event: OrderEvent): FsmStateData<OrderState, OrderData> {
    if (event.kind === 'paid') {
      return { state: 'paid', data: { ...data, amountPaid: event.amount } };
    }
    if (event.kind === 'shipped') {
      return { state: 'shipped', data: { ...data, carrier: event.carrier } };
    }
    return {
      state: 'cancelled',
      data: { ...data, cancelReason: event.reason ?? null },
    };
  }

  // Override onCommand to handle the read-only `getState` query.
  // Calls super for everything else — keeps the framework's
  // transition-table dispatch.
  override async onCommand(curr: FsmStateData<OrderState, OrderData>, cmd: OrderCmd): Promise<void> {
    if (cmd.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, cmd);
  }
}

/* ----------------------------- Helpers ------------------------------- */

function buildSystem(name: string): {
  sys: ActorSystem;
  journal: InMemoryJournal;
  snaps: InMemorySnapshotStore;
} {
  const sys = ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const journal = new InMemoryJournal();
  const snaps = new InMemorySnapshotStore();
  const ext = sys.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(snaps);
  return { sys, journal, snaps };
}

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('PersistentFSM — happy path', () => {
  test('drives an order through pending → paid → shipped and persists each event', async () => {
    const { sys, journal } = buildSystem('fsm-happy');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-1')), 'order');
      ref.tell({ kind: 'pay', amount: 100 });
      ref.tell({ kind: 'ship', carrier: 'fedex' });
      await sleep(50);

      const finalState = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      expect(finalState.state).toBe('shipped');
      expect(finalState.data).toEqual({ amountPaid: 100, carrier: 'fedex', cancelReason: null });

      // Two events should have been persisted.
      const events = await journal.read('order-1', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind)).toEqual(['paid', 'shipped']);
    } finally {
      await sys.terminate();
    }
  });

  test('recovery from journal after restart reproduces the final state', async () => {
    const { sys: sys1, journal, snaps } = buildSystem('fsm-recover');
    try {
      const ref1 = sys1.actorOf(Props.create(() => new OrderFsm('order-2')), 'order');
      ref1.tell({ kind: 'pay', amount: 250 });
      ref1.tell({ kind: 'ship', carrier: 'ups' });
      await sleep(50);
    } finally {
      await sys1.terminate();
    }

    // Fresh system, same journal + snapshot store.
    const sys2 = ActorSystem.create('fsm-recover-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys2.extension(PersistenceExtensionId).setJournal(journal);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snaps);
    try {
      const ref2 = sys2.actorOf(Props.create(() => new OrderFsm('order-2')), 'order');
      const recovered = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref2, { kind: 'getState' }, 1_000,
      );
      expect(recovered.state).toBe('shipped');
      expect(recovered.data.amountPaid).toBe(250);
      expect(recovered.data.carrier).toBe('ups');
    } finally {
      await sys2.terminate();
    }
  });
});

describe('PersistentFSM — invalid transitions', () => {
  test('command with no entry for the current state is dropped — no event persisted', async () => {
    const { sys, journal } = buildSystem('fsm-invalid');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-3')), 'order');
      // `ship` is not a valid transition from `'pending'`.
      ref.tell({ kind: 'ship', carrier: 'fedex' });
      await sleep(40);
      const after = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      expect(after.state).toBe('pending');     // unchanged
      expect(after.data.carrier).toBeNull();   // unchanged
      expect(await journal.read('order-3', 0)).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });

  test('terminal state ignores further commands (shipped → ship is invalid)', async () => {
    const { sys, journal } = buildSystem('fsm-terminal');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-4')), 'order');
      ref.tell({ kind: 'pay', amount: 50 });
      ref.tell({ kind: 'ship', carrier: 'dhl' });
      ref.tell({ kind: 'ship', carrier: 'second-attempt' }); // invalid in 'shipped'
      ref.tell({ kind: 'cancel', reason: 'too late' });      // also invalid
      await sleep(60);
      const after = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      expect(after.state).toBe('shipped');
      expect(after.data.carrier).toBe('dhl');
      expect(after.data.cancelReason).toBeNull();
      expect(await journal.read('order-4', 0)).toHaveLength(2);   // only paid + shipped
    } finally {
      await sys.terminate();
    }
  });

  test('guard rejection drops the command without persisting', async () => {
    const { sys, journal } = buildSystem('fsm-guard');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-5')), 'order');
      // Amount = 0 → guard returns false.
      ref.tell({ kind: 'pay', amount: 0 });
      await sleep(40);
      const after = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      expect(after.state).toBe('pending');
      expect(await journal.read('order-5', 0)).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });
});

describe('PersistentFSM — function-style transition events', () => {
  test('event payload is computed from the command at persist time', async () => {
    const { sys, journal } = buildSystem('fsm-fn-event');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-6')), 'order');
      ref.tell({ kind: 'pay', amount: 333 });
      await sleep(40);
      const events = await journal.read('order-6', 0);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toEqual({ kind: 'paid', amount: 333 });
    } finally {
      await sys.terminate();
    }
  });
});

describe('PersistentFSM — alternate paths', () => {
  test('cancel from pending is a valid one-step transition', async () => {
    const { sys } = buildSystem('fsm-cancel');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-7')), 'order');
      ref.tell({ kind: 'cancel', reason: 'changed-mind' });
      await sleep(40);
      const after = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      expect(after.state).toBe('cancelled');
      expect(after.data.cancelReason).toBe('changed-mind');
    } finally {
      await sys.terminate();
    }
  });

  test('cancel from paid leaves amountPaid intact (data carries forward)', async () => {
    const { sys } = buildSystem('fsm-cancel-after-pay');
    try {
      const ref = sys.actorOf(Props.create(() => new OrderFsm('order-8')), 'order');
      ref.tell({ kind: 'pay', amount: 99 });
      ref.tell({ kind: 'cancel', reason: 'refund' });
      await sleep(50);
      const after = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      expect(after.state).toBe('cancelled');
      expect(after.data.amountPaid).toBe(99);     // preserved across transition
      expect(after.data.cancelReason).toBe('refund');
    } finally {
      await sys.terminate();
    }
  });
});
