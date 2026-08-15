/**
 * Persistent FSM tests (#52) — combines state-machine semantics with
 * event sourcing.  We exercise:
 *
 *   - Happy-path transition sequence pending → paid → shipped, then
 *     restart the actor and observe the recovered state matches.
 *   - Invalid transition (`ship` from `'pending'`) is dropped — no
 *     event persists, no state mutates.
 *   - Guard rejection drops the command silently.
 *   - Function-style `event: (command, data) => Event` is evaluated.
 *   - Snapshot policy + recovery via snapshot still produces the
 *     right state + data.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorLifecycleEvent, ActorStopped } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import type { Journal } from '../../../src/persistence/Journal.js';
import type { JournalEntry } from '../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import {
  PersistentFSM,
  type FsmStateData,
  type FsmTransitionMap,
} from '../../../src/fsm/PersistentFSM.js';

/* ----------------------- Order-workflow domain ----------------------- */

type OrderState = 'pending' | 'paid' | 'shipped' | 'cancelled';

type OrderCommand =
  | { kind: 'pay'; amount: number }
  | { kind: 'ship'; carrier: string }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'getState' };

type OrderEvent =
  | { kind: 'paid'; amount: number }
  | { kind: 'shipped'; carrier: string }
  | { kind: 'cancelled'; reason?: string };

type OrderData = {
  amountPaid: number;
  carrier: string | null;
  cancelReason: string | null;
};

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * Wait until the journal holds exactly `count` events for `persistenceId`.
 *
 * The journal is the strongest thing these tests can observe: a transition is
 * not complete until its events are written, and every assertion here reads
 * either the journal or a state derived from it.  A `getState` ask is ordered
 * behind the tells that precede it, so where the *only* assertion is on state
 * the ask is itself the synchronisation point and no wait is needed at all.
 */
const awaitJournalLength = (
  journal: InMemoryJournal,
  persistenceId: string,
  count: number,
): Promise<void> =>
  awaitCondition(async () => (await journal.read(persistenceId, 0)).length === count, {
    timeoutMs: 4_000,
    label: `${persistenceId} reached ${count} persisted event(s)`,
  });

class OrderFsm extends PersistentFSM<OrderCommand, OrderEvent, OrderState, OrderData> {
  readonly persistenceId: string;

  constructor(persistenceId: string) {
    super();
    this.persistenceId = persistenceId;
  }

  initialFsmState(): OrderState { return 'pending'; }
  initialData(): OrderData { return { amountPaid: 0, carrier: null, cancelReason: null }; }

  transitions: FsmTransitionMap<OrderState, OrderCommand, OrderEvent, OrderData> = {
    pending: {
      pay: {
        // Function-style event — depends on the command.
        event: (command, _data): OrderEvent => ({ kind: 'paid', amount: command.amount }),
        next: 'paid',
        // Reject zero / negative amounts via the guard.
        guard: (command) => command.amount > 0,
      },
      cancel: {
        event: (command): OrderEvent => ({ kind: 'cancelled', reason: command.reason }),
        next: 'cancelled',
      },
    },
    paid: {
      ship: {
        event: (command): OrderEvent => ({ kind: 'shipped', carrier: command.carrier }),
        next: 'shipped',
      },
      cancel: {
        event: (command): OrderEvent => ({ kind: 'cancelled', reason: command.reason }),
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
  override async onCommand(curr: FsmStateData<OrderState, OrderData>, command: OrderCommand): Promise<void> {
    if (command.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, command);
  }
}

/* ----------------------------- Helpers ------------------------------- */

function buildSystem(name: string): {
  sys: ActorSystem;
  journal: InMemoryJournal;
  snaps: InMemorySnapshotStore;
} {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(name, sysOptions);
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
      const ref = sys.spawn(() => new OrderFsm('order-1'), 'order');
      ref.tell({ kind: 'pay', amount: 100 });
      ref.tell({ kind: 'ship', carrier: 'fedex' });
      await awaitJournalLength(journal, 'order-1', 2);

      const finalState = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
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
      const ref1 = sys1.spawn(() => new OrderFsm('order-2'), 'order');
      ref1.tell({ kind: 'pay', amount: 250 });
      ref1.tell({ kind: 'ship', carrier: 'ups' });
      // The events have to be on disk before the system goes away — a
      // terminate that races the persist drains the mailbox to dead letters.
      await awaitJournalLength(journal, 'order-2', 2);
    } finally {
      await sys1.terminate();
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    // Fresh system, same journal + snapshot store.
    const sys2 = ActorSystem.create('fsm-recover-2', sysOptions);
    sys2.extension(PersistenceExtensionId).setJournal(journal);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snaps);
    try {
      const ref2 = sys2.spawn(() => new OrderFsm('order-2'), 'order');
      const recovered = await ref2.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
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
      const ref = sys.spawn(() => new OrderFsm('order-3'), 'order');
      // `ship` is not a valid transition from `'pending'`.
      ref.tell({ kind: 'ship', carrier: 'fedex' });
      // No wait: the ask below is queued behind the tell, so it cannot answer
      // before the command has been through the FSM.
      const after = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
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
      const ref = sys.spawn(() => new OrderFsm('order-4'), 'order');
      ref.tell({ kind: 'pay', amount: 50 });
      ref.tell({ kind: 'ship', carrier: 'dhl' });
      ref.tell({ kind: 'ship', carrier: 'second-attempt' }); // invalid in 'shipped'
      ref.tell({ kind: 'cancel', reason: 'too late' });      // also invalid
      const after = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
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
      const ref = sys.spawn(() => new OrderFsm('order-5'), 'order');
      // Amount = 0 → guard returns false.
      ref.tell({ kind: 'pay', amount: 0 });
      const after = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
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
      const ref = sys.spawn(() => new OrderFsm('order-6'), 'order');
      ref.tell({ kind: 'pay', amount: 333 });
      await awaitJournalLength(journal, 'order-6', 1);
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
      const ref = sys.spawn(() => new OrderFsm('order-7'), 'order');
      ref.tell({ kind: 'cancel', reason: 'changed-mind' });
      const after = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
      expect(after.state).toBe('cancelled');
      expect(after.data.cancelReason).toBe('changed-mind');
    } finally {
      await sys.terminate();
    }
  });

  test('cancel from paid leaves amountPaid intact (data carries forward)', async () => {
    const { sys } = buildSystem('fsm-cancel-after-pay');
    try {
      const ref = sys.spawn(() => new OrderFsm('order-8'), 'order');
      ref.tell({ kind: 'pay', amount: 99 });
      ref.tell({ kind: 'cancel', reason: 'refund' });
      const after = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 1_000,);
      expect(after.state).toBe('cancelled');
      expect(after.data.amountPaid).toBe(99);     // preserved across transition
      expect(after.data.cancelReason).toBe('refund');
    } finally {
      await sys.terminate();
    }
  });
});

/* ============================================================== */
/* State timeout (#65)                                            */
/* ============================================================== */

/**
 * Payment-flow domain: `pending → authorized → captured` happy path,
 * `authorized → expired` after a state-timeout.  The `_timeout` lives
 * on `authorized` only — that's the realistic "auto-cancel after N
 * minutes if the merchant doesn't capture" scenario.
 */
type PayState = 'pending' | 'authorized' | 'captured' | 'expired';
type PayCommand =
  | { kind: 'authorize'; amount: number }
  | { kind: 'capture' }
  | { kind: 'getState' };
type PayEvent =
  | { kind: 'authorized'; amount: number }
  | { kind: 'captured' }
  | { kind: 'expired' };
type PayData = { amount: number };

class PaymentFsm extends PersistentFSM<PayCommand, PayEvent, PayState, PayData> {
  readonly persistenceId: string;
  /** Tunable so individual tests pick their own timeout window. */
  private readonly afterMs: number;
  /** When set, only fires the timeout if data.amount > 0. */
  private readonly guarded: boolean;

  constructor(persistenceId: string, afterMs: number, options: { guarded?: boolean } = {}) {
    super();
    this.persistenceId = persistenceId;
    this.afterMs = afterMs;
    this.guarded = options.guarded ?? false;
  }

  initialFsmState(): PayState { return 'pending'; }
  initialData(): PayData { return { amount: 0 }; }

  // The `transitions` field is captured at construction time (typical
  // FSM idiom in this codebase) — we evaluate `this.afterMs` lazily by
  // declaring it as a getter so subclasses can vary the window.
  get transitions(): FsmTransitionMap<PayState, PayCommand, PayEvent, PayData> {
    return {
      pending: {
        authorize: {
          event: (command): PayEvent => ({ kind: 'authorized', amount: command.amount }),
          next: 'authorized',
        },
      },
      authorized: {
        capture: {
          event: { kind: 'captured' } as const,
          next: 'captured',
        },
        _timeout: {
          afterMs: this.afterMs,
          event: { kind: 'expired' } as const,
          next: 'expired',
          ...(this.guarded ? { guard: (data: PayData): boolean => data.amount > 0 } : {}),
        },
      },
    };
  }
  set transitions(_v: FsmTransitionMap<PayState, PayCommand, PayEvent, PayData>) { /* noop — getter is canonical */ }

  applyEvent(state: PayState, data: PayData, ev: PayEvent): FsmStateData<PayState, PayData> {
    if (ev.kind === 'authorized') return { state: 'authorized', data: { amount: ev.amount } };
    if (ev.kind === 'captured')   return { state: 'captured',   data };
    return { state: 'expired', data };
  }

  override async onCommand(curr: FsmStateData<PayState, PayData>, command: PayCommand): Promise<void> {
    if (command.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, command);
  }
}

describe('PersistentFSM — stateTimeout (#65)', () => {
  test('timer fires when no command transitions out within afterMs', async () => {
    const { sys, journal } = buildSystem('fsm-timeout-fires');
    try {
      const ref = sys.spawn(() => new PaymentFsm('pay-1', 80), 'pay');
      ref.tell({ kind: 'authorize', amount: 100 });
      // The 80 ms window is the FSM's to honour; what this waits for is the
      // 'expired' event it produces.
      await awaitJournalLength(journal, 'pay-1', 2);

      const final = await ref.ask<FsmStateData<PayState, PayData>>({ kind: 'getState' }, 1_000,);
      expect(final.state).toBe('expired');

      // Exactly two events in the journal: 'authorized' + 'expired'.
      const events = await journal.read('pay-1', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['authorized', 'expired']);
    } finally {
      await sys.terminate();
    }
  });

  test('command transitions cancel the timer — no expired event persists', async () => {
    const { sys, journal } = buildSystem('fsm-timeout-cancelled');
    try {
      const ref = sys.spawn(() => new PaymentFsm('pay-2', 80), 'pay');
      ref.tell({ kind: 'authorize', amount: 50 });
      // Capture before the timer fires — the FSM must transition to
      // 'captured' and the armed timer must be cancelled.
      ref.tell({ kind: 'capture' });
      // Wait long enough that the original 80ms timer would have
      // fired if it weren't cancelled.
      await sleep(150);

      const final = await ref.ask<FsmStateData<PayState, PayData>>({ kind: 'getState' }, 1_000,);
      expect(final.state).toBe('captured');
      const events = await journal.read('pay-2', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['authorized', 'captured']);
    } finally {
      await sys.terminate();
    }
  });

  test('terminal state with no _timeout entry leaves no armed timer', async () => {
    // After the FSM lands in `captured` (no `_timeout`), the timer
    // must not refire — verifies arm/cancel pairing on the
    // post-transition path.
    const { sys, journal } = buildSystem('fsm-timeout-terminal');
    try {
      const ref = sys.spawn(() => new PaymentFsm('pay-3', 60), 'pay');
      ref.tell({ kind: 'authorize', amount: 10 });
      ref.tell({ kind: 'capture' });
      await awaitJournalLength(journal, 'pay-3', 2);
      // The 60 ms timer must not refire on top of the terminal state, so the
      // settle outlives it — that half cannot be expressed by polling.
      await sleep(100);

      const events = await journal.read('pay-3', 0);
      expect(events).toHaveLength(2);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['authorized', 'captured']);
    } finally {
      await sys.terminate();
    }
  });

  test('guard rejection skips the timeout fire silently', async () => {
    // The guarded variant only fires when amount > 0.  We authorize
    // with amount=0 so the guard rejects; the timer fires but the
    // FSM stays in `authorized`.
    const { sys, journal } = buildSystem('fsm-timeout-guarded');
    try {
      const ref = sys.spawn(
        () => new PaymentFsm('pay-4', 60, { guarded: true }),
        'pay',
      );
      ref.tell({ kind: 'authorize', amount: 0 });
      await sleep(200);

      const final = await ref.ask<FsmStateData<PayState, PayData>>({ kind: 'getState' }, 1_000,);
      expect(final.state).toBe('authorized');
      const events = await journal.read('pay-4', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['authorized']);
    } finally {
      await sys.terminate();
    }
  });

  test('recovery re-arms the timer relative to wall-clock at recovery completion', async () => {
    // Persist `authorized` in one ActorSystem, restart, give the new
    // FSM enough time post-recovery for its fresh timer to fire.
    // Verifies the recovery-side arm path AND that the timer does
    // NOT fire during replay (no double-expired event).
    const { sys: sys1, journal, snaps } = buildSystem('fsm-timeout-recovery');
    try {
      const ref1 = sys1.spawn(() => new PaymentFsm('pay-5', 80), 'pay');
      ref1.tell({ kind: 'authorize', amount: 200 });
      await awaitJournalLength(journal, 'pay-5', 1);
      // Stop before the timer fires — the persisted state is 'authorized'.
    } finally {
      await sys1.terminate();
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys2 = ActorSystem.create('fsm-recovery-2', sysOptions);
    sys2.extension(PersistenceExtensionId).setJournal(journal);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snaps);
    try {
      const ref2 = sys2.spawn(() => new PaymentFsm('pay-5', 80), 'pay');
      // After recovery the timer arms fresh; the 'expired' event is what says
      // it fired, and the journal length says it fired exactly once.
      await awaitJournalLength(journal, 'pay-5', 2);
      const final = await ref2.ask<FsmStateData<PayState, PayData>>({ kind: 'getState' }, 1_000,);
      expect(final.state).toBe('expired');

      // Exactly two events in the journal across both lives:
      // 'authorized' (persisted by sys1) + 'expired' (persisted by sys2).
      const events = await journal.read('pay-5', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['authorized', 'expired']);
    } finally {
      await sys2.terminate();
    }
  });
});

/* ============================================================== */
/* Multi-event transitions (#66)                                  */
/* ============================================================== */

/**
 * Mini-domain that emits TWO events per `pay` (a `paid` plus an
 * `audit-logged`), using `event: [...]`.  The data carries a
 * separate `audited` flag so we can verify the second event landed
 * on top of the first.  Mirrors the realistic "transactional decision
 * fans out into multiple journal records" use case.
 */
type AuditState = 'pending' | 'paid' | 'cancelled';
type AuditCommand =
  | { kind: 'pay'; amount: number }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'getState' };
type AuditEvent =
  | { kind: 'paid'; amount: number }
  | { kind: 'audit-logged' }
  | { kind: 'cancelled'; reason?: string };
type AuditData = { amountPaid: number; audited: boolean; cancelReason: string | null };

class AuditingFsm extends PersistentFSM<AuditCommand, AuditEvent, AuditState, AuditData> {
  readonly persistenceId: string;
  /** Toggle so a single test class covers literal-array, function-array, and empty-array. */
  private readonly mode: 'array' | 'fnArray' | 'emptyArray';

  constructor(persistenceId: string, mode: 'array' | 'fnArray' | 'emptyArray' = 'array') {
    super();
    this.persistenceId = persistenceId;
    this.mode = mode;
  }

  initialFsmState(): AuditState { return 'pending'; }
  initialData(): AuditData { return { amountPaid: 0, audited: false, cancelReason: null }; }

  get transitions(): FsmTransitionMap<AuditState, AuditCommand, AuditEvent, AuditData> {
    return {
      pending: {
        pay: this.mode === 'array' ? {
          // Literal-array form — 'paid' first, 'audit-logged' second.
          // Final state must match `next` (the post-audit-logged state).
          event: [
            { kind: 'paid', amount: 0 } as AuditEvent, // amount baked in
            { kind: 'audit-logged' } as AuditEvent,
          ],
          next: 'paid',
        } : this.mode === 'fnArray' ? {
          event: (command, _data): AuditEvent[] => [
            { kind: 'paid', amount: command.amount },
            { kind: 'audit-logged' },
          ],
          next: 'paid',
        } : {
          // Empty-array form — verifies the no-op path.  An empty
          // array MUST drop without persisting or transitioning.
          event: (): AuditEvent[] => [],
          next: 'paid',
        },
        cancel: {
          event: (command): AuditEvent => ({ kind: 'cancelled', reason: command.reason }),
          next: 'cancelled',
        },
      },
    };
  }
  set transitions(_v: FsmTransitionMap<AuditState, AuditCommand, AuditEvent, AuditData>) { /* noop */ }

  applyEvent(state: AuditState, data: AuditData, ev: AuditEvent): FsmStateData<AuditState, AuditData> {
    if (ev.kind === 'paid')          return { state: 'paid', data: { ...data, amountPaid: ev.amount } };
    if (ev.kind === 'audit-logged')  return { state, data: { ...data, audited: true } };
    return { state: 'cancelled', data: { ...data, cancelReason: ev.reason ?? null } };
  }

  override async onCommand(curr: FsmStateData<AuditState, AuditData>, command: AuditCommand): Promise<void> {
    if (command.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, command);
  }
}

describe('PersistentFSM — multiple events per command (#66)', () => {
  test('function-array: both events persist atomically and applyEvent runs for each', async () => {
    const { sys, journal } = buildSystem('fsm-multi-fn');
    try {
      const ref = sys.spawn(
        () => new AuditingFsm('audit-1', 'fnArray'),
        'audit',
      );
      ref.tell({ kind: 'pay', amount: 250 });
      await awaitJournalLength(journal, 'audit-1', 2);

      const final = await ref.ask<FsmStateData<AuditState, AuditData>>({ kind: 'getState' }, 1_000,);
      expect(final.state).toBe('paid');
      expect(final.data.amountPaid).toBe(250);
      expect(final.data.audited).toBe(true);

      // Both events in the journal in the declared order.
      const events = await journal.read('audit-1', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['paid', 'audit-logged']);
    } finally {
      await sys.terminate();
    }
  });

  test('literal-array: events apply in order, final-state check matches next', async () => {
    const { sys, journal } = buildSystem('fsm-multi-literal');
    try {
      const ref = sys.spawn(
        () => new AuditingFsm('audit-2', 'array'),
        'audit',
      );
      ref.tell({ kind: 'pay', amount: 0 });
      await awaitJournalLength(journal, 'audit-2', 2);

      const final = await ref.ask<FsmStateData<AuditState, AuditData>>({ kind: 'getState' }, 1_000,);
      expect(final.state).toBe('paid');
      expect(final.data.audited).toBe(true);
      const events = await journal.read('audit-2', 0);
      expect(events).toHaveLength(2);
    } finally {
      await sys.terminate();
    }
  });

  test('empty-array event: drops cleanly with no events persisted, no state change', async () => {
    const { sys, journal } = buildSystem('fsm-multi-empty');
    try {
      const ref = sys.spawn(
        () => new AuditingFsm('audit-3', 'emptyArray'),
        'audit',
      );
      ref.tell({ kind: 'pay', amount: 99 }); // resolves to []

      const final = await ref.ask<FsmStateData<AuditState, AuditData>>({ kind: 'getState' }, 1_000,);
      // Stayed in 'pending' — no events persisted.
      expect(final.state).toBe('pending');
      const events = await journal.read('audit-3', 0);
      expect(events).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });

  test('a multi-event transition tags each event by its own kind (#631)', async () => {
    // The concrete reproduction path: an FSM's array transition is the one
    // place in the repo that routinely persists differently-shaped events in
    // one batch.  `persistAll` used to hand the journal a single tag list
    // taken from events[0], so `audit-logged` was filed under 'payment' and
    // an audit projection saw nothing.
    class TaggingAuditingFsm extends AuditingFsm {
      override tagsFor(event: AuditEvent): readonly string[] | undefined {
        return event.kind === 'audit-logged' ? ['audit'] : ['payment'];
      }
    }
    const { sys, journal } = buildSystem('fsm-multi-tags');
    try {
      const ref = sys.spawn(() => new TaggingAuditingFsm('audit-tags', 'fnArray'), 'audit');
      ref.tell({ kind: 'pay', amount: 250 });
      await awaitJournalLength(journal, 'audit-tags', 2);

      const events = await journal.read('audit-tags', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind)).toEqual(['paid', 'audit-logged']);
      expect(events.map((e) => e.tags)).toEqual([['payment'], ['audit']]);
    } finally {
      await sys.terminate();
    }
  });

  test('recovery: array events replay deterministically', async () => {
    // Persist the 2-event transition in one ActorSystem, restart,
    // and verify both events come back in order with the correct
    // final state + data.
    const { sys: sys1, journal, snaps } = buildSystem('fsm-multi-recover');
    try {
      const ref1 = sys1.spawn(
        () => new AuditingFsm('audit-4', 'fnArray'),
        'audit',
      );
      ref1.tell({ kind: 'pay', amount: 500 });
      await awaitJournalLength(journal, 'audit-4', 2);
    } finally {
      await sys1.terminate();
    }

    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys2 = ActorSystem.create('fsm-multi-recover-2', sysOptions);
    sys2.extension(PersistenceExtensionId).setJournal(journal);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snaps);
    try {
      const ref2 = sys2.spawn(
        () => new AuditingFsm('audit-4', 'fnArray'),
        'audit',
      );
      const recovered = await ref2.ask<FsmStateData<AuditState, AuditData>>({ kind: 'getState' }, 1_000,);
      expect(recovered.state).toBe('paid');
      expect(recovered.data.amountPaid).toBe(500);
      expect(recovered.data.audited).toBe(true);
    } finally {
      await sys2.terminate();
    }
  });
});

describe('PersistentFSM — recovery failure', () => {
  test('a swallowed recovery failure stops the FSM instead of leaving it stuck', async () => {
    const { sys, journal, snaps } = buildSystem('fsm-recovery-failure');
    try {
      // A snapshot claiming a sequence number ahead of the journal is
      // refused by assertTrustworthySnapshot, so replay throws before
      // the base class assigns its state.
      await journal.append<OrderEvent>('order-broken', [{ event: { kind: 'paid', amount: 100 } }], 0);
      await snaps.save('order-broken', Number.MAX_SAFE_INTEGER, {
        state: 'shipped', data: { amountPaid: 0, carrier: null, cancelReason: null },
      });

      const failures: Error[] = [];
      const stopped: ActorLifecycleEvent[] = [];
      const ready = { value: false };
      class Listener extends Actor<ActorLifecycleEvent> {
        override preStart(): void {
          this.system.eventStream.subscribe(this.self, ActorLifecycleEvent);
          ready.value = true;
        }
        override onReceive(event: ActorLifecycleEvent): void { stopped.push(event); }
      }
      sys.spawn(Listener, 'lifecycle');
      await awaitCondition(() => ready.value, { label: 'the lifecycle listener subscribed' });

      class SwallowingOrderFsm extends OrderFsm {
        override onRecoveryFailure(reason: Error): void { failures.push(reason); }
      }
      const ref = sys.spawn(() => new SwallowingOrderFsm('order-broken'), 'order');

      await awaitCondition(() => failures.length === 1, {
        label: 'the swallowing hook observed the recovery failure',
      });
      // Without the stop, the FSM would sit on an undefined state while
      // its own onReceive routes __fsm_state_timeout__ around the
      // recovering guard straight into an unguarded this.state read.
      await awaitCondition(
        () => stopped.some((e) => e instanceof ActorStopped && e.actor.equals(ref)),
        { label: 'the FSM whose recovery failed stopped itself' },
      );
    } finally {
      await sys.terminate();
    }
  });
});

/**
 * `onReceive` intercepts the state-timeout fire *before* delegating to
 * the base class, so that branch bypasses the `_recovering` guard every
 * ordinary command goes through — and `this.state` is unassigned until
 * replay succeeds (#519).
 */
describe('PersistentFSM — a state-timeout fire during recovery', () => {
  /**
   * Parks `read` until the test opens it, so recovery is provably still
   * in flight while the fire is delivered.  Without this the fire and the
   * end of recovery race, and the test would pass for the wrong reason.
   */
  class GatedJournal implements Journal {
    private release!: () => void;
    private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
    /** True once replay has actually parked — the point of no ambiguity. */
    reading = false;
    constructor(private readonly inner: InMemoryJournal) {}
    open(): void { this.release(); }
    append<E>(persistenceId: string, entries: ReadonlyArray<JournalEntry<E>>, expectedSeq: number) {
      return this.inner.append<E>(persistenceId, entries, expectedSeq);
    }
    async read<E>(persistenceId: string, fromSeq: number, toSeq?: number) {
      this.reading = true;
      await this.gate;
      return this.inner.read<E>(persistenceId, fromSeq, toSeq);
    }
    highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
    delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
    persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
  }

  test('is dropped instead of dereferencing an unassigned state', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('fsm-timeout-during-recovery', sysOptions);
    const gated = new GatedJournal(new InMemoryJournal());
    sys.extension(PersistenceExtensionId).setJournal(gated);
    sys.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());

    const delivered: unknown[] = [];
    let incarnations = 0;
    try {
      // Starting recovery without awaiting it is the one way user code can
      // reach `onReceive` while `_recovering` is still true — and it is
      // exactly the trap the next intercept added here would fall into.
      class RacyFsm extends OrderFsm {
        override async preStart(): Promise<void> { void super.preStart(); }
        override async onReceive(message: OrderCommand): Promise<void> {
          delivered.push(message);
          await super.onReceive(message);
        }
      }
      const ref = sys.spawn(
        () => { incarnations++; return new RacyFsm('order-racy'); },
        'order',
      );
      await awaitCondition(() => gated.reading, { label: 'replay parked inside journal.read' });

      // The internal self-tell an armed timer would have produced.
      (ref as ActorRef<unknown>).tell({ kind: '__fsm_state_timeout__', stateAtArm: 'pending' });
      await awaitCondition(() => delivered.length === 1, {
        label: 'the timeout fire was dequeued while recovery was still parked',
      });

      // Pre-fix, dereferencing the unassigned state threw a TypeError from
      // inside the handler, which supervision turns into a restart — so the
      // incarnation count is what separates "dropped" from "blew up".  The
      // FSM must also still answer once recovery lands.
      gated.open();
      const state = await ref.ask<FsmStateData<OrderState, OrderData>>({ kind: 'getState' }, 2_000);
      expect(state.state).toBe('pending');
      expect(incarnations).toBe(1);
    } finally {
      await sys.terminate();
    }
  });
});

/* ============================================================== */
/* State-timeout superseded by a re-arm (#143)                    */
/* ============================================================== */

/**
 * Idle-session domain — the canonical `_timeout` use case.  The FSM sits
 * in `active` with an idle timeout and a `heartbeat` that keeps it there.
 * The heartbeat staying in the *same* state is the whole point: it is the
 * shape a `_timeout` typically guards, and the one where confirming the
 * state name cannot tell a live fire from a superseded one.
 */
type SessionState = 'active' | 'paused' | 'expired';
type SessionCommand =
  | { kind: 'heartbeat' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'getState' };
type SessionEvent =
  | { kind: 'touched' }
  | { kind: 'paused' }
  | { kind: 'resumed' }
  | { kind: 'timedOut' };
type SessionData = { touches: number };

class SessionFsm extends PersistentFSM<SessionCommand, SessionEvent, SessionState, SessionData> {
  readonly persistenceId: string;
  private readonly afterMs: number;

  constructor(persistenceId: string, afterMs: number) {
    super();
    this.persistenceId = persistenceId;
    this.afterMs = afterMs;
  }

  initialFsmState(): SessionState { return 'active'; }
  initialData(): SessionData { return { touches: 0 }; }

  get transitions(): FsmTransitionMap<SessionState, SessionCommand, SessionEvent, SessionData> {
    return {
      active: {
        // Same-state transition — "keep the session alive".
        heartbeat: { event: { kind: 'touched' } as const, next: 'active' },
        pause: { event: { kind: 'paused' } as const, next: 'paused' },
        _timeout: {
          afterMs: this.afterMs,
          event: { kind: 'timedOut' } as const,
          next: 'expired',
        },
      },
      // A paused session does not idle out — no `_timeout` here, which is
      // what lets the A→B→A round trip leave the state name untouched.
      paused: {
        resume: { event: { kind: 'resumed' } as const, next: 'active' },
      },
    };
  }
  set transitions(_v: FsmTransitionMap<SessionState, SessionCommand, SessionEvent, SessionData>) { /* noop — getter is canonical */ }

  applyEvent(state: SessionState, data: SessionData, event: SessionEvent): FsmStateData<SessionState, SessionData> {
    if (event.kind === 'touched') return { state: 'active', data: { touches: data.touches + 1 } };
    if (event.kind === 'paused')  return { state: 'paused', data };
    if (event.kind === 'resumed') return { state: 'active', data };
    return { state: 'expired', data };
  }

  override async onCommand(curr: FsmStateData<SessionState, SessionData>, command: SessionCommand): Promise<void> {
    if (command.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, command);
  }
}

describe('PersistentFSM — a state-timeout fire superseded by a re-arm (#143)', () => {
  /**
   * Parks the actor inside one chosen `append` so the timer can be fired
   * while a command is provably mid-persist.  The fire then queues up
   * *behind* that command — the ordering the race needs, and the one
   * thing a sleep cannot pin down.
   */
  class AppendGatedJournal implements Journal {
    private release: (() => void) | null = null;
    private gate: Promise<void> | null = null;
    /** True once an append has actually parked — the point of no ambiguity. */
    parked = false;
    constructor(private readonly inner: InMemoryJournal) {}

    /** Arm the gate: the next `append` blocks until `open()` releases it. */
    parkNextAppend(): void {
      this.gate = new Promise<void>((resolve) => { this.release = resolve; });
    }

    open(): void {
      this.release?.();
      this.release = null;
      this.gate = null;
    }

    async append<E>(persistenceId: string, entries: ReadonlyArray<JournalEntry<E>>, expectedSeq: number) {
      const gate = this.gate;
      if (gate) {
        this.parked = true;
        await gate;
      }
      return this.inner.append<E>(persistenceId, entries, expectedSeq);
    }
    read<E>(persistenceId: string, fromSeq: number, toSeq?: number) {
      return this.inner.read<E>(persistenceId, fromSeq, toSeq);
    }
    highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
    delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
    persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
  }

  test('a same-state heartbeat invalidates the fire already sitting in the mailbox', async () => {
    const scheduler = new ManualScheduler();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withScheduler(scheduler);
    const sys = ActorSystem.create('fsm-timeout-rearm-race', sysOptions);
    const inner = new InMemoryJournal();
    const gated = new AppendGatedJournal(inner);
    sys.extension(PersistenceExtensionId).setJournal(gated);
    sys.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());

    try {
      const ref = sys.spawn(() => new SessionFsm('session-1', 1_000), 'session');
      // Stashed until recovery completes, so an answer proves
      // `onRecoveryComplete` ran — i.e. the first timer is armed.
      const initial = await ref.ask<FsmStateData<SessionState, SessionData>>({ kind: 'getState' }, 2_000);
      expect(initial.state).toBe('active');

      // Park the heartbeat inside its persist.  While it sits there the
      // actor dequeues nothing, so whatever arrives next stacks up behind
      // it instead of racing it.
      gated.parkNextAppend();
      ref.tell({ kind: 'heartbeat' });
      await awaitCondition(() => gated.parked, { label: 'the heartbeat parked inside journal.append' });

      // Virtual time crosses afterMs right here: the armed timer fires and
      // self-tells, so the fire is in the mailbox behind the heartbeat.
      scheduler.advance(1_000);

      // Heartbeat completes → same state, timer re-armed → the queued fire
      // is stale.  Pre-fix the fire carried only `stateAtArm`, so
      // `curr.state === stateAtArm` still held (both 'active') and the
      // session expired despite the heartbeat.
      gated.open();

      // Queued behind the fire, so an answer proves the fire was handled.
      const after = await ref.ask<FsmStateData<SessionState, SessionData>>({ kind: 'getState' }, 2_000);
      expect(after.state).toBe('active');
      expect(after.data.touches).toBe(1);

      const events = await inner.read('session-1', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind)).toEqual(['touched']);
    } finally {
      await sys.terminate();
    }
  });

  test('an A→B→A round trip invalidates it too, though the state name comes back', async () => {
    // The reproduction the issue reports.  `pause` then `resume` puts the
    // FSM back in 'active', so `stateAtArm` matches again by the time the
    // fire is dequeued — the state name simply cannot express "this
    // window was replaced".
    const scheduler = new ManualScheduler();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withScheduler(scheduler);
    const sys = ActorSystem.create('fsm-timeout-rearm-roundtrip', sysOptions);
    const inner = new InMemoryJournal();
    const gated = new AppendGatedJournal(inner);
    sys.extension(PersistenceExtensionId).setJournal(gated);
    sys.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());

    try {
      const ref = sys.spawn(() => new SessionFsm('session-3', 1_000), 'session');
      const initial = await ref.ask<FsmStateData<SessionState, SessionData>>({ kind: 'getState' }, 2_000);
      expect(initial.state).toBe('active');

      // Park inside `pause`'s persist; `resume` then queues behind it, and
      // the fire behind that — so both commands are processed before the
      // fire is ever looked at.
      gated.parkNextAppend();
      ref.tell({ kind: 'pause' });
      await awaitCondition(() => gated.parked, { label: 'the pause parked inside journal.append' });
      ref.tell({ kind: 'resume' });
      scheduler.advance(1_000);
      gated.open();

      const after = await ref.ask<FsmStateData<SessionState, SessionData>>({ kind: 'getState' }, 2_000);
      expect(after.state).toBe('active');
      const events = await inner.read('session-3', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['paused', 'resumed']);
    } finally {
      await sys.terminate();
    }
  });

  test('an undisturbed fire still fires — the generation check is not a blanket suppressor', async () => {
    // The mirror image of the test above, and the one that would catch a
    // fix that invalidates the generation from inside the timer callback:
    // nothing supersedes this fire, so it must go through.
    const scheduler = new ManualScheduler();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withScheduler(scheduler);
    const sys = ActorSystem.create('fsm-timeout-rearm-clean', sysOptions);
    const journal = new InMemoryJournal();
    sys.extension(PersistenceExtensionId).setJournal(journal);
    sys.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());

    try {
      const ref = sys.spawn(() => new SessionFsm('session-2', 1_000), 'session');
      const initial = await ref.ask<FsmStateData<SessionState, SessionData>>({ kind: 'getState' }, 2_000);
      expect(initial.state).toBe('active');

      // One heartbeat, fully settled — the re-arm it triggers is the
      // generation the next fire must be measured against.
      ref.tell({ kind: 'heartbeat' });
      await awaitJournalLength(journal, 'session-2', 1);

      scheduler.advance(1_000);
      await awaitJournalLength(journal, 'session-2', 2);

      const after = await ref.ask<FsmStateData<SessionState, SessionData>>({ kind: 'getState' }, 2_000);
      expect(after.state).toBe('expired');
      const events = await journal.read('session-2', 0);
      expect(events.map((e) => (e.event as { kind: string }).kind))
        .toEqual(['touched', 'timedOut']);
    } finally {
      await sys.terminate();
    }
  });
});
