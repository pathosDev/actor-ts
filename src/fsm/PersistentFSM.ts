import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
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
 * **State timeouts (#65).**  An entry may declare a special
 * `_timeout: { afterMs, event, next, guard? }` field that arms a
 * one-shot timer when the FSM enters the state.  If `afterMs` elapses
 * before any command transitions out, the FSM auto-fires the timeout
 * event through the same persist-then-apply pipeline.  See
 * {@link FsmStateTimeout}.  Fresh-armed on every state transition;
 * cancelled when the FSM transitions away (or stops).  Recovery
 * re-arms the timer relative to the wall-clock at recovery
 * completion — i.e., a long-stopped FSM gets a fresh `afterMs`
 * window after restart, deliberately conservative to avoid spurious
 * "already-expired" fires.
 *
 * **Snapshots / event adapter / encryption.**  Inherited from
 * `PersistentActor` — override `snapshotPolicy`, `eventAdapter`,
 * `compression`, etc. exactly as you would on a plain
 * `PersistentActor`.  The combined `{ state, data }` is what gets
 * snapshotted.
 *
 * **Out of scope (per issue).**
 *
 *   - Multiple events per command — drop down to overriding
 *     `onCommand` directly and call `persistAll([...])`.
 *   - Per-transition timeouts (the timeout is a per-state property,
 *     not a per-transition one).
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
   * Event(s) to persist when this transition fires.  Three shapes:
   *
   *   - **Literal** — `{ kind: 'paid' }`: a single event persisted
   *     atomically as one journal entry.
   *   - **Array** — `[evtA, evtB]`: multiple events persisted in
   *     one `persistAll` call (#66) so they share a logical
   *     transaction; `applyEvent` runs once per event and the
   *     post-apply final state is checked against `next`.  An
   *     empty array is treated as a no-op transition (no events
   *     persisted, no state change) — use a `guard` instead if
   *     "skip on this condition" is the actual intent.
   *   - **Function** — `(cmd, data) => Event | Event[]`: lazily
   *     evaluated when the transition fires; otherwise behaves
   *     exactly like the literal / array forms above.
   */
  readonly event:
    | Event
    | Event[]
    | ((cmd: Cmd, data: Data) => Event | Event[]);
  /**
   * State name the FSM moves to after every event applies.  When
   * `event` is an array, only the **final** post-replay state is
   * compared against `next` — intermediate transitions inside the
   * array don't have to match.  Mainly informational; `applyEvent`
   * is what actually drives the transition.
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
 * Time-based transition for a state (#65).  Declared under the magic
 * `_timeout` key in a state's transition map; cannot collide with a
 * real command kind because `kind: '_timeout'` is reserved.
 *
 * On entering the state the FSM arms a one-shot timer for `afterMs`.
 * If the timer fires while still in the state (no command transitioned
 * the FSM out in the meantime, and the optional `guard` accepts), the
 * declared `event` is persisted and `applyEvent` runs as if a real
 * command had triggered it.
 */
export interface FsmStateTimeout<SName extends string, Event, Data> {
  /** How long to wait before auto-firing the event.  Required. */
  readonly afterMs: number;
  /**
   * Event(s) to persist when the timer fires.  Same shape as a
   * regular transition (#66) — single literal, array, or function
   * returning either.  An empty array is a no-op fire (timer
   * cancelled, no transition, no events persisted).
   */
  readonly event: Event | Event[] | ((data: Data) => Event | Event[]);
  /** Target state.  Verified against `applyEvent`'s output, like {@link FsmTransition}. */
  readonly next: SName;
  /** Optional pre-fire guard — `false` cancels the timeout silently. */
  readonly guard?: (data: Data) => boolean;
}

/** Reserved key under which {@link FsmStateTimeout} lives in a state's config. */
export const FSM_TIMEOUT_KEY = '_timeout' as const;

/**
 * Transition table — `state` × `cmd.kind` → transition entry.  The
 * mapped type narrows `Cmd` to the matching variant inside each
 * entry so the entry's callbacks see the right command shape.  An
 * optional `_timeout` field declares the per-state timeout (#65).
 */
export type FsmTransitionMap<
  SName extends string,
  Cmd extends { readonly kind: string },
  Event,
  Data,
> = {
  readonly [state in SName]?: {
    readonly [K in Cmd['kind']]?: FsmTransition<SName, Extract<Cmd, { kind: K }>, Event, Data>;
  } & {
    readonly _timeout?: FsmStateTimeout<SName, Event, Data>;
  };
};

/* ---------------------- internal: timer fire signal --------------------- */

/**
 * Magic self-tell payload used to route a fired timeout back through
 * the actor mailbox so it serialises cleanly with concurrent commands.
 * Carries `stateAtArm` so the handler can confirm the FSM is still in
 * the same state — a command that snuck in between the timer firing
 * and the message being processed must cancel the timeout.
 */
interface FsmTimeoutFire<SName extends string> {
  readonly kind: '__fsm_state_timeout__';
  readonly stateAtArm: SName;
}

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

  /* ----------------------- internal: timeout state ---------------------- */

  /** Currently-armed timer, if any.  Cancelled on transition or stop. */
  private _timeoutTimer: Cancellable | null = null;

  /* --------------- PersistentActor hooks (implemented for you) --------------- */

  initialState(): FsmStateData<SName, Data> {
    return { state: this.initialFsmState(), data: this.initialData() };
  }

  onEvent(curr: FsmStateData<SName, Data>, event: Event): FsmStateData<SName, Data> {
    return this.applyEvent(curr.state, curr.data, event);
  }

  override onRecoveryComplete(_state: FsmStateData<SName, Data>): void | Promise<void> {
    // Arm the timer fresh after recovery — we deliberately don't try
    // to recompute "remaining time" from the original state-entry
    // moment.  Restarted FSMs get a fresh `afterMs` window; spurious
    // immediate-fires are worse than a slightly-extended timeout.
    this.armTimerForCurrentState();
  }

  override async postStop(): Promise<void> {
    this.cancelTimer();
  }

  /**
   * Intercept the internal `__fsm_state_timeout__` self-tell that the
   * armed timer routes through the mailbox.  Real user commands
   * delegate straight to `super.onReceive` (which handles recovery
   * stash + persist gating + dispatch to {@link onCommand}).
   */
  override async onReceive(message: Cmd): Promise<void> {
    const tagged = message as unknown as FsmTimeoutFire<SName>;
    if (tagged.kind === '__fsm_state_timeout__') {
      await this.fireTimeoutTransition(tagged.stateAtArm);
      return;
    }
    await super.onReceive(message);
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
    const evaluated = typeof transition.event === 'function'
      ? (transition.event as (c: Cmd, d: Data) => Event | Event[])(cmd, curr.data)
      : transition.event;
    const events: Event[] = Array.isArray(evaluated) ? evaluated : [evaluated];
    if (events.length === 0) {
      // Empty array → no events to persist, no state change.  Treat
      // as a "guard returned false" outcome from the user's POV.
      this.log.debug(
        `PersistentFSM: cmd '${cmd.kind}' in state '${curr.state}' produced an empty event array — dropped`,
      );
      return;
    }

    await this.persistAll(events, (next: FsmStateData<SName, Data>) => {
      // Sanity check: the user's `applyEvent` and the table's `next`
      // should agree on the target state after the FINAL event.  A
      // mismatch is almost always a bug — surface it loud rather
      // than silently letting the FSM drift away from its declared
      // graph.  Intermediate states (events[0]..[N-2] applied) are
      // not checked.
      if (next.state !== transition.next) {
        this.log.warn(
          `PersistentFSM: applyEvent for cmd '${cmd.kind}' in state '${curr.state}' `
          + `produced state '${next.state}' but transition declared 'next: ${transition.next}'`,
        );
      }
      // Re-arm the timer for the new state — cancels any previously-
      // armed timer first, schedules the new one if the new state
      // has a `_timeout` entry.
      this.armTimerForCurrentState();
    });
  }

  /* ---------------------- internal: timer plumbing ---------------------- */

  /**
   * Cancel any in-flight timer and, if the current state has a
   * `_timeout` config, arm a fresh one.  Called after every state
   * transition (forward, recovery, and timeout-driven).
   */
  private armTimerForCurrentState(): void {
    this.cancelTimer();
    const state = this.currentFsmState;
    const timeout = this.transitions[state]?.[FSM_TIMEOUT_KEY];
    if (!timeout) return;
    const stateAtArm = state;
    this._timeoutTimer = this.system.scheduler.scheduleOnceFn(
      timeout.afterMs,
      () => {
        this._timeoutTimer = null;
        // Route through the mailbox so the fire interleaves cleanly
        // with regular commands — `onReceive` intercepts it.
        const fire: FsmTimeoutFire<SName> = {
          kind: '__fsm_state_timeout__',
          stateAtArm,
        };
        (this.self as ActorRef<unknown>).tell(fire);
      },
    );
  }

  private cancelTimer(): void {
    if (this._timeoutTimer) {
      this._timeoutTimer.cancel();
      this._timeoutTimer = null;
    }
  }

  /**
   * Apply a `_timeout` transition: re-validate state (no-op if a
   * command already transitioned the FSM out), evaluate the event,
   * persist + re-arm.  Same shape as {@link onCommand}'s persist
   * dance — keeps the post-apply state-name verification.
   */
  private async fireTimeoutTransition(stateAtArm: SName): Promise<void> {
    const curr = this.state;
    if (curr.state !== stateAtArm) {
      // A command transitioned us out before the timer message landed
      // in the mailbox — the user's command takes precedence.  Re-arm
      // for the new state (in case the new state itself has a timeout
      // and we're catching up after a flurry of late mailbox traffic).
      this.armTimerForCurrentState();
      return;
    }
    const timeout = this.transitions[curr.state]?.[FSM_TIMEOUT_KEY];
    if (!timeout) return;
    if (timeout.guard && !timeout.guard(curr.data)) {
      this.log.debug(
        `PersistentFSM: state-timeout guard rejected fire in state '${curr.state}' — dropped`,
      );
      this.armTimerForCurrentState();
      return;
    }
    const evaluated = typeof timeout.event === 'function'
      ? (timeout.event as (d: Data) => Event | Event[])(curr.data)
      : timeout.event;
    const events: Event[] = Array.isArray(evaluated) ? evaluated : [evaluated];
    if (events.length === 0) {
      this.log.debug(
        `PersistentFSM: state-timeout in state '${curr.state}' produced an empty event array — dropped`,
      );
      this.armTimerForCurrentState();
      return;
    }
    await this.persistAll(events, (next: FsmStateData<SName, Data>) => {
      if (next.state !== timeout.next) {
        this.log.warn(
          `PersistentFSM: applyEvent for state-timeout in state '${curr.state}' `
          + `produced state '${next.state}' but timeout declared 'next: ${timeout.next}'`,
        );
      }
      this.armTimerForCurrentState();
    });
  }
}
