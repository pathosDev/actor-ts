/**
 * PersistentFSM order-workflow demo (#52).
 *
 *   bun run examples/fsm/order-workflow.ts
 *
 * Shows:
 *
 *   - State machine with four states (`pending → paid → shipped`,
 *     plus `cancelled` reachable from the first two).
 *   - Each transition persists an event; recovery rebuilds the
 *     state + data deterministically.
 *   - Invalid transitions (e.g. `ship` from `pending`) are dropped
 *     by the framework — no event persists, no state mutates.
 *   - Run twice in one process: first to drive the order, then
 *     "restart" by spawning a fresh actor against the same journal
 *     and confirm the state is recovered.
 */
import {
  Actor,
  ActorSystem,
  Props,
  ask,
  PersistenceExtensionId,
  InMemoryJournal,
  PersistentFSM,
  type FsmStateData,
  type FsmTransitionMap,
} from '../../src/index.js';
import type { ActorRef } from '../../src/index.js';

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

class OrderFsm extends PersistentFSM<OrderCmd, OrderEvent, OrderState, OrderData> {
  readonly persistenceId = 'order-42';

  initialFsmState(): OrderState { return 'pending'; }
  initialData(): OrderData { return { amountPaid: 0, carrier: null, cancelReason: null }; }

  transitions: FsmTransitionMap<OrderState, OrderCmd, OrderEvent, OrderData> = {
    pending: {
      pay:    { event: (c) => ({ kind: 'paid', amount: c.amount }),   next: 'paid', guard: (c) => c.amount > 0 },
      cancel: { event: (c) => ({ kind: 'cancelled', reason: c.reason }), next: 'cancelled' },
    },
    paid: {
      ship:   { event: (c) => ({ kind: 'shipped', carrier: c.carrier }), next: 'shipped' },
      cancel: { event: (c) => ({ kind: 'cancelled', reason: c.reason }), next: 'cancelled' },
    },
  };

  applyEvent(_state: OrderState, data: OrderData, e: OrderEvent): FsmStateData<OrderState, OrderData> {
    if (e.kind === 'paid')      return { state: 'paid',      data: { ...data, amountPaid: e.amount } };
    if (e.kind === 'shipped')   return { state: 'shipped',   data: { ...data, carrier: e.carrier } };
    return { state: 'cancelled', data: { ...data, cancelReason: e.reason ?? null } };
  }

  override async onCommand(curr: FsmStateData<OrderState, OrderData>, cmd: OrderCmd): Promise<void> {
    if (cmd.kind === 'getState') {
      this.sender.toNullable()?.tell(curr);
      return;
    }
    return super.onCommand(curr, cmd);
  }
}

async function pretty(ref: ActorRef<OrderCmd>, label: string): Promise<void> {
  const s = await ask<OrderCmd, FsmStateData<OrderState, OrderData>>(ref, { kind: 'getState' }, 500);
  console.log(`${label}: state=${s.state} amountPaid=${s.data.amountPaid} carrier=${s.data.carrier ?? '-'}`);
}

async function main(): Promise<void> {
  const journal = new InMemoryJournal();

  // --- run 1: drive the workflow ---
  const sys1 = ActorSystem.create('order-demo-1');
  sys1.extension(PersistenceExtensionId).setJournal(journal);

  const ref1 = sys1.actorOf(Props.create(() => new OrderFsm()), 'order');
  await pretty(ref1, 'initial');

  ref1.tell({ kind: 'ship', carrier: 'fedex' });   // invalid — ignored, state unchanged
  await pretty(ref1, 'after illegal ship');

  ref1.tell({ kind: 'pay', amount: 199 });
  await pretty(ref1, 'after pay');

  ref1.tell({ kind: 'ship', carrier: 'fedex' });
  await pretty(ref1, 'after ship');

  await sys1.terminate();

  // --- run 2: brand-new system, same journal — verify recovery ---
  console.log('\n--- restart, recovering from journal ---');
  const sys2 = ActorSystem.create('order-demo-2');
  sys2.extension(PersistenceExtensionId).setJournal(journal);

  const ref2 = sys2.actorOf(Props.create(() => new OrderFsm()), 'order');
  await pretty(ref2, 'recovered');

  await sys2.terminate();
}

void main();
