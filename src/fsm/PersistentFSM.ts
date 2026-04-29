import { PersistentActor } from '../persistence/PersistentActor.js';

/**
 * Persistent finite-state machine (#52) — the durable counterpart to
 * {@link FSM}.  Combines:
 *
 *   - **State machine semantics** — a small named state set, a
 *     transition table, and pure event-application.
 *   - **Event sourcing** — every transition is a persisted event;
 *     recovery replays them through `applyEvent` to rebuild both
 *     the state name and the domain data.
 *
 * Natural fit for order workflows, reservation flows, payment
 * adjudication, claim pipelines — anything that's "current state +
 * transition events" instead of "current state + arbitrary mutation".
 *
 *   type State = 'pending' | 'paid' | 'shipped' | 'cancelled';
 *   type Event = { kind: 'paid' } | { kind: 'shipped' } | { kind: 'cancelled' };
 *   type Cmd   = { kind: 'pay' } | { kind: 'ship' } | { kind: 'cancel' };
 *   interface Data { items: string[]; total: number }
 *
 *   class OrderFsm extends PersistentFSM<Cmd, Event, State, Data> {
 *     readonly persistenceId = 'order-1';
 *     initialFsmState() { return 'pending' as const; }
 *     initialData(): Data { return { items: [], total: 0 }; }
 *
 *     transitions = {
 *       pending: {
 *         pay:    { event: { kind: 'paid' } as const,      next: 'paid' as const },
 *         cancel: { event: { kind: 'cancelled' } as const, next: 'cancelled' as const },
 *       },
 *       paid: {
 *         ship: { event: { kind: 'shipped' } as const, next: 'shipped' as const },
 *       },
 *     };
 *
 *     applyEvent(state: State, data: Data, e: Event) {
 *       if (e.kind === 'paid')      return { state: 'paid' as State,      data };
 *       if (e.kind === 'shipped')   return { state: 'shipped' as State,   data };
 *       if (e.kind === 'cancelled') return { state: 'cancelled' as State, data };
 *       return { state, data };
 *     }
 *   }
 *
 * **What the base class does for you.**
 *
 *   - On a command, looks up `transitions[currentFsmState][cmd.kind]`.
 *     If no entry: **invalid transition** — logged at warn, no event
 *     persisted, no state change.
 *   - If the entry has a `guard` and the guard returns false: same
 *     outcome — logged at debug, no event persisted.
 *   - Otherwise, evaluates the entry's `event` (literal or function),
 *     persists it, and applies it via `applyEvent`.
 *   - `applyEvent` is the source of truth for state + data updates;
 *     it runs both at command time and during recovery, so the FSM
 *     is rebuilt deterministically.
 *
 * **Snapshots / event adapter / encryption.**  Inherited from
 * `PersistentActor` — override `snapshotPolicy`, `eventAdapter`,
 * `compression`, etc. exactly as you would on a plain
 * `PersistentActor`.  The combined `{ state, data }` is what gets
 * snapshotted.
 *
 * **Out of scope (per issue).**
 *
 *   - Time-based transitions (`stateTimeout` à la Akka) — separate
 *     issue if requested.
 *   - Multiple events per command — drop down to overriding
 *     `onCommand` directly and call `persistAll([...])`.
 */

/** Combined state held by the underlying `PersistentActor`. */
export interface FsmStateData<S extends string, D> {
  readonly state: S;
  readonly data: D;
}

/** One entry in the transition table. */
export interface FsmTransition<
  SName extends string,
  Cmd,
  Event,
  Data,
> {
  /**
   * Event to persist when this transition fires.  Either a literal
   * (`{ kind: 'paid' }`) or a function `(cmd, data) => event` for
   * cases where the event payload depends on the command's data.
   */
  readonly event: Event | ((cmd: Cmd, data: Data) => Event);
  /**
   * State name the FSM moves to after the event applies.  Mainly
   * informational — `applyEvent` is what actually drives the
   * transition; the base class verifies the post-apply state
   * matches `next` and logs a warning on mismatch.
   */
  readonly next: SName;
  /**
   * Optional pre-check — if it returns `false`, the transition
   * is skipped (no event persisted, no state change).  Use for
   * conditional dispatch like "pay only if amount > 0".  Logged
   * at debug.
   */
  readonly guard?: (cmd: Cmd, data: Data) => boolean;
}

/**
 * Transition table — `state` × `cmd.kind` → transition entry.  The
 * mapped type narrows `Cmd` to the matching variant inside each
 * entry so the entry's callbacks see the right command shape.
 */
export type FsmTransitionMap<
  SName extends string,
  Cmd extends { readonly kind: string },
  Event,
  Data,
> = {
  readonly [state in SName]?: {
    readonly [K in Cmd['kind']]?: FsmTransition<SName, Extract<Cmd, { kind: K }>, Event, Data>;
  };
};

/* ============================== base class ============================== */

export abstract class PersistentFSM<
  Cmd extends { readonly kind: string },
  Event,
  SName extends string,
  Data,
> extends PersistentActor<Cmd, Event, FsmStateData<SName, Data>> {
  /** Starting state name when no events have been replayed. */
  abstract initialFsmState(): SName;

  /** Starting data when no events have been replayed. */
  abstract initialData(): Data;

  /**
   * Pure event-application — updates both state name and data.
   * Runs at persist-time (forward) AND at recovery-time (replay),
   * so it MUST be deterministic and free of side effects.
   */
  abstract applyEvent(
    state: SName, data: Data, event: Event,
  ): FsmStateData<SName, Data>;

  /**
   * Transition table.  Implementations typically declare it as a
   * class field so the type-narrowing in `FsmTransitionMap` works
   * at the call site (`transitions[state][cmdKind]`).
   */
  abstract transitions: FsmTransitionMap<SName, Cmd, Event, Data>;

  /**
   * Hook invoked when a command has no matching transition for the
   * current state.  Default: warn + drop (no event persisted).
   * Override to throw, send a reply, etc.
   */
  protected onInvalidTransition(state: SName, cmd: Cmd): void | Promise<void> {
    this.log.warn(
      `PersistentFSM: no transition for cmd '${cmd.kind}' in state '${state}' — dropped`,
    );
  }

  /**
   * Hook invoked when a transition's `guard` returns false.  Default
   * is a debug log + drop.
   */
  protected onGuardRejected(state: SName, cmd: Cmd): void | Promise<void> {
    this.log.debug(
      `PersistentFSM: guard rejected cmd '${cmd.kind}' in state '${state}' — dropped`,
    );
  }

  /* --------------------------- read-only views -------------------------- */

  /** Current FSM state name.  Reliable after recovery. */
  protected get currentFsmState(): SName { return this.state.state; }

  /** Current FSM data.  Reliable after recovery. */
  protected get currentData(): Data { return this.state.data; }

  /* --------------- PersistentActor hooks (implemented for you) --------------- */

  initialState(): FsmStateData<SName, Data> {
    return { state: this.initialFsmState(), data: this.initialData() };
  }

  onEvent(curr: FsmStateData<SName, Data>, event: Event): FsmStateData<SName, Data> {
    return this.applyEvent(curr.state, curr.data, event);
  }

  async onCommand(curr: FsmStateData<SName, Data>, cmd: Cmd): Promise<void> {
    const stateEntry = this.transitions[curr.state];
    const transition = stateEntry?.[cmd.kind as Cmd['kind']] as
      FsmTransition<SName, Cmd, Event, Data> | undefined;
    if (!transition) {
      await this.onInvalidTransition(curr.state, cmd);
      return;
    }
    if (transition.guard && !transition.guard(cmd, curr.data)) {
      await this.onGuardRejected(curr.state, cmd);
      return;
    }
    const event = typeof transition.event === 'function'
      ? (transition.event as (c: Cmd, d: Data) => Event)(cmd, curr.data)
      : transition.event;

    await this.persist(event, (next: FsmStateData<SName, Data>) => {
      // Sanity check: the user's `applyEvent` and the table's `next`
      // should agree on the target state.  A mismatch is almost
      // always a bug — surface it loud rather than silently letting
      // the FSM drift away from its declared graph.
      if (next.state !== transition.next) {
        this.log.warn(
          `PersistentFSM: applyEvent for cmd '${cmd.kind}' in state '${curr.state}' `
          + `produced state '${next.state}' but transition declared 'next: ${transition.next}'`,
        );
      }
    });
  }
}
