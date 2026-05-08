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
type PayCmd =
  | { kind: 'authorize'; amount: number }
  | { kind: 'capture' }
  | { kind: 'getState' };
type PayEvent =
  | { kind: 'authorized'; amount: number }
  | { kind: 'captured' }
  | { kind: 'expired' };
interface PayData { amount: number }

class PaymentFsm extends PersistentFSM<PayCmd, PayEvent, PayState, PayData> {
  readonly persistenceId: string;
  /** Tunable so individual tests pick their own timeout window. */
  private readonly afterMs: number;
  /** When set, only fires the timeout if data.amount > 0. */
  private readonly guarded: boolean;

  constructor(pid: string, afterMs: number, opts: { guarded?: boolean } = {}) {
    super();
    this.persistenceId = pid;
    this.afterMs = afterMs;
    this.guarded = opts.guarded ?? false;
  }

  initialFsmState(): PayState { return 'pending'; }
  initialData(): PayData { return { amount: 0 }; }

  // The `transitions` field is captured at construction time (typical
  // FSM idiom in this codebase) — we evaluate `this.afterMs` lazily by
  // declaring it as a getter so subclasses can vary the window.
  get transitions(): FsmTransitionMap<PayState, PayCmd, PayEvent, PayData> {
    return {
      pending: {
        authorize: {
          event: (cmd): PayEvent => ({ kind: 'authorized', amount: cmd.amount }),
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
  set transitions(_v: FsmTransitionMap<PayState, PayCmd, PayEvent, PayData>) { /* noop — getter is canonical */ }

  applyEvent(state: PayState, data: PayData, ev: PayEvent): FsmStateData<PayState, PayData> {
    if (ev.kind === 'authorized') return { state: 'authorized', data: { amount: ev.amount } };
    if (ev.kind === 'captured')   return { state: 'captured',   data };
    return { state: 'expired', data };
  }

  override async onCommand(curr: FsmStateData<PayState, PayData>, cmd: PayCmd): Promise<void> {
    if (cmd.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, cmd);
  }
}

describe('PersistentFSM — stateTimeout (#65)', () => {
  test('timer fires when no command transitions out within afterMs', async () => {
    const { sys, journal } = buildSystem('fsm-timeout-fires');
    try {
      const ref = sys.actorOf(Props.create(() => new PaymentFsm('pay-1', 80)), 'pay');
      ref.tell({ kind: 'authorize', amount: 100 });
      // Wait > afterMs so the armed timer fires.
      await sleep(200);

      const final = await ask<PayCmd, FsmStateData<PayState, PayData>>(
        ref, { kind: 'getState' }, 1_000,
      );
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
      const ref = sys.actorOf(Props.create(() => new PaymentFsm('pay-2', 80)), 'pay');
      ref.tell({ kind: 'authorize', amount: 50 });
      // Capture before the timer fires — the FSM must transition to
      // 'captured' and the armed timer must be cancelled.
      await sleep(20);
      ref.tell({ kind: 'capture' });
      // Wait long enough that the original 80ms timer would have
      // fired if it weren't cancelled.
      await sleep(150);

      const final = await ask<PayCmd, FsmStateData<PayState, PayData>>(
        ref, { kind: 'getState' }, 1_000,
      );
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
      const ref = sys.actorOf(Props.create(() => new PaymentFsm('pay-3', 60)), 'pay');
      ref.tell({ kind: 'authorize', amount: 10 });
      ref.tell({ kind: 'capture' });
      await sleep(200);

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
      const ref = sys.actorOf(
        Props.create(() => new PaymentFsm('pay-4', 60, { guarded: true })),
        'pay',
      );
      ref.tell({ kind: 'authorize', amount: 0 });
      await sleep(200);

      const final = await ask<PayCmd, FsmStateData<PayState, PayData>>(
        ref, { kind: 'getState' }, 1_000,
      );
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
      const ref1 = sys1.actorOf(Props.create(() => new PaymentFsm('pay-5', 80)), 'pay');
      ref1.tell({ kind: 'authorize', amount: 200 });
      await sleep(20);
      // Stop before the timer fires — the persisted state is 'authorized'.
    } finally {
      await sys1.terminate();
    }

    const sys2 = ActorSystem.create('fsm-recovery-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys2.extension(PersistenceExtensionId).setJournal(journal);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snaps);
    try {
      const ref2 = sys2.actorOf(Props.create(() => new PaymentFsm('pay-5', 80)), 'pay');
      // After recovery, the timer arms fresh.  Wait > afterMs.
      await sleep(200);
      const final = await ask<PayCmd, FsmStateData<PayState, PayData>>(
        ref2, { kind: 'getState' }, 1_000,
      );
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
type AuditCmd =
  | { kind: 'pay'; amount: number }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'getState' };
type AuditEvent =
  | { kind: 'paid'; amount: number }
  | { kind: 'audit-logged' }
  | { kind: 'cancelled'; reason?: string };
interface AuditData { amountPaid: number; audited: boolean; cancelReason: string | null }

class AuditingFsm extends PersistentFSM<AuditCmd, AuditEvent, AuditState, AuditData> {
  readonly persistenceId: string;
  /** Toggle so a single test class covers literal-array, function-array, and empty-array. */
  private readonly mode: 'array' | 'fnArray' | 'emptyArray';

  constructor(pid: string, mode: 'array' | 'fnArray' | 'emptyArray' = 'array') {
    super();
    this.persistenceId = pid;
    this.mode = mode;
  }

  initialFsmState(): AuditState { return 'pending'; }
  initialData(): AuditData { return { amountPaid: 0, audited: false, cancelReason: null }; }

  get transitions(): FsmTransitionMap<AuditState, AuditCmd, AuditEvent, AuditData> {
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
          event: (cmd, _data): AuditEvent[] => [
            { kind: 'paid', amount: cmd.amount },
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
          event: (cmd): AuditEvent => ({ kind: 'cancelled', reason: cmd.reason }),
          next: 'cancelled',
        },
      },
    };
  }
  set transitions(_v: FsmTransitionMap<AuditState, AuditCmd, AuditEvent, AuditData>) { /* noop */ }

  applyEvent(state: AuditState, data: AuditData, ev: AuditEvent): FsmStateData<AuditState, AuditData> {
    if (ev.kind === 'paid')          return { state: 'paid', data: { ...data, amountPaid: ev.amount } };
    if (ev.kind === 'audit-logged')  return { state, data: { ...data, audited: true } };
    return { state: 'cancelled', data: { ...data, cancelReason: ev.reason ?? null } };
  }

  override async onCommand(curr: FsmStateData<AuditState, AuditData>, cmd: AuditCmd): Promise<void> {
    if (cmd.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, cmd);
  }
}

describe('PersistentFSM — multiple events per command (#66)', () => {
  test('function-array: both events persist atomically and applyEvent runs for each', async () => {
    const { sys, journal } = buildSystem('fsm-multi-fn');
    try {
      const ref = sys.actorOf(
        Props.create(() => new AuditingFsm('audit-1', 'fnArray')),
        'audit',
      );
      ref.tell({ kind: 'pay', amount: 250 });
      await sleep(50);

      const final = await ask<AuditCmd, FsmStateData<AuditState, AuditData>>(
        ref, { kind: 'getState' }, 1_000,
      );
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
      const ref = sys.actorOf(
        Props.create(() => new AuditingFsm('audit-2', 'array')),
        'audit',
      );
      ref.tell({ kind: 'pay', amount: 0 });
      await sleep(50);

      const final = await ask<AuditCmd, FsmStateData<AuditState, AuditData>>(
        ref, { kind: 'getState' }, 1_000,
      );
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
      const ref = sys.actorOf(
        Props.create(() => new AuditingFsm('audit-3', 'emptyArray')),
        'audit',
      );
      ref.tell({ kind: 'pay', amount: 99 }); // resolves to []
      await sleep(50);

      const final = await ask<AuditCmd, FsmStateData<AuditState, AuditData>>(
        ref, { kind: 'getState' }, 1_000,
      );
      // Stayed in 'pending' — no events persisted.
      expect(final.state).toBe('pending');
      const events = await journal.read('audit-3', 0);
      expect(events).toHaveLength(0);
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
      const ref1 = sys1.actorOf(
        Props.create(() => new AuditingFsm('audit-4', 'fnArray')),
        'audit',
      );
      ref1.tell({ kind: 'pay', amount: 500 });
      await sleep(50);
    } finally {
      await sys1.terminate();
    }

    const sys2 = ActorSystem.create('fsm-multi-recover-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys2.extension(PersistenceExtensionId).setJournal(journal);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snaps);
    try {
      const ref2 = sys2.actorOf(
        Props.create(() => new AuditingFsm('audit-4', 'fnArray')),
        'audit',
      );
      const recovered = await ask<AuditCmd, FsmStateData<AuditState, AuditData>>(
        ref2, { kind: 'getState' }, 1_000,
      );
      expect(recovered.state).toBe('paid');
      expect(recovered.data.amountPaid).toBe(500);
      expect(recovered.data.audited).toBe(true);
    } finally {
      await sys2.terminate();
    }
  });
});
