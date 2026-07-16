/**
 * Persistent counter for scenario 11 (Event-Sourcing + Recovery).
 *
 * Event-sourced actor:
 *   - State:  `{ count: number }`
 *   - Events: `{ kind: 'incremented' }` (only one event type for now)
 *   - Cmds:   `inc` (persists an event), `get-state` (reads current state)
 *   - Snapshot: every 3 events via `everyNEvents(3)` — verifies that the
 *     snapshot-load path is exercised on recovery.
 *
 * The actor is bound to an `InMemoryJournal` per cluster node (wired
 * in node-runner).  Killing the actor with PoisonPill stops the
 * Actor instance; the journal entries stay in memory.  Re-spawning
 * with the same `persistenceId` replays events (with snapshot
 * shortcut) and rebuilds the state — that's the integration test.
 */

import type { ActorRef } from '../../../src/ActorRef.js';
import { PersistentActor, everyNEvents } from '../../../src/persistence/PersistentActor.js';
import type { SnapshotPolicy } from '../../../src/persistence/PersistentActor.js';

export interface CounterIncrement { readonly kind: 'inc' }
export interface CounterGetState {
  readonly kind: 'get-state';
  readonly replyTo: ActorRef<CounterStateReply>;
}
export type CounterCommand = CounterIncrement | CounterGetState;

export type CounterEvent = { readonly kind: 'incremented' };

export interface CounterState { count: number }

export interface CounterStateReply {
  readonly kind: 'state';
  readonly count: number;
}

/**
 * The persistent counter — one instance per `persistenceId`.  The
 * journal accumulates `Incremented` events; snapshot every 3
 * triggers a `SnapshotSaved`.  On recovery (i.e. preStart after
 * respawn), the framework loads the most recent snapshot and
 * replays subsequent events to rebuild state.
 */
export class PersistentCounter extends PersistentActor<CounterCommand, CounterEvent, CounterState> {
  constructor(public readonly persistenceId: string) { super(); }

  override initialState(): CounterState {
    return { count: 0 };
  }

  override onEvent(state: CounterState, e: CounterEvent): CounterState {
    if (e.kind === 'incremented') return { count: state.count + 1 };
    return state;
  }

  override onCommand(state: CounterState, cmd: CounterCommand): void {
    if (cmd.kind === 'inc') {
      this.persist({ kind: 'incremented' }, () => {
        // No reply on inc — fire-and-forget.
      });
    } else if (cmd.kind === 'get-state') {
      cmd.replyTo.tell({ kind: 'state', count: state.count });
    }
  }

  override snapshotPolicy(): SnapshotPolicy<CounterState, CounterEvent> {
    return everyNEvents(3);
  }
}
