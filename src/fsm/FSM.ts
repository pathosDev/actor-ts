import { match } from 'ts-pattern';
import { Actor } from '../Actor.js';

/**
 * Tuple returned from an FSM state handler: the next state name and the
 * updated state-data value.  `stay()` / `goto()` helpers construct these.
 */
export interface Transition<SName extends string, SData> {
  readonly kind: 'transition';
  readonly next: SName;
  readonly data: SData;
}

export interface StayTransition<SData> {
  readonly kind: 'stay';
  readonly data: SData;
}

export type FsmResult<SName extends string, SData> =
  | Transition<SName, SData>
  | StayTransition<SData>;

export type StateHandler<SName extends string, SData, Msg> =
  (data: SData, msg: Msg) => FsmResult<SName, SData> | Promise<FsmResult<SName, SData>>;

export type TransitionCallback<SName extends string, SData> =
  (from: SName, to: SName, data: SData) => void | Promise<void>;

/**
 * Finite-State-Machine DSL built on top of the OO `Actor` class.  Each
 * state has a name, an onReceive handler that returns the next transition,
 * and optional enter/exit callbacks.  Internally the FSM stores the
 * current state name, so it's friendlier than raw `become()` for
 * protocols with a small, named state set.
 *
 * Usage:
 *   class Door extends FSM<'closed'|'open', { openedAt?: number }, DoorCmd> {
 *     constructor() {
 *       super('closed', { });
 *       this.when('closed', (d, m) => m === 'open'
 *         ? this.goto('open', { openedAt: Date.now() })
 *         : this.stay(d));
 *       this.when('open', (d, m) => m === 'close' ? this.goto('closed', { }) : this.stay(d));
 *     }
 *   }
 */
export abstract class FSM<SName extends string, SData, Msg> extends Actor<Msg> {
  private currentState: SName;
  private currentData: SData;
  private readonly handlers = new Map<SName, StateHandler<SName, SData, Msg>>();
  private readonly onEntry = new Map<SName, (data: SData) => void | Promise<void>>();
  private readonly onExit = new Map<SName, (data: SData) => void | Promise<void>>();
  private readonly transitionListeners: TransitionCallback<SName, SData>[] = [];

  constructor(initialState: SName, initialData: SData) {
    super();
    this.currentState = initialState;
    this.currentData = initialData;
  }

  /** Register the handler for a state. */
  protected when(state: SName, handler: StateHandler<SName, SData, Msg>): void {
    this.handlers.set(state, handler);
  }

  /** Register an enter-hook for a state. */
  protected onEnter(state: SName, hook: (data: SData) => void | Promise<void>): void {
    this.onEntry.set(state, hook);
  }

  /** Register an exit-hook for a state. */
  protected onExitState(state: SName, hook: (data: SData) => void | Promise<void>): void {
    this.onExit.set(state, hook);
  }

  /** Subscribe to every transition — useful for logging/metrics. */
  protected onTransition(cb: TransitionCallback<SName, SData>): void {
    this.transitionListeners.push(cb);
  }

  protected goto(next: SName, data: SData): Transition<SName, SData> {
    return { kind: 'transition', next, data };
  }

  protected stay(data: SData): StayTransition<SData> {
    return { kind: 'stay', data };
  }

  /** Current state name — read-only. */
  protected get state(): SName { return this.currentState; }
  protected get data(): SData { return this.currentData; }

  override async onReceive(msg: Msg): Promise<void> {
    const handler = this.handlers.get(this.currentState);
    if (!handler) {
      this.log.warn(`FSM: no handler for state '${String(this.currentState)}' — dropping message`);
      return;
    }
    const result = await handler(this.currentData, msg);
    await match(result)
      .with({ kind: 'stay' }, (r) => { this.currentData = r.data; })
      .with({ kind: 'transition' }, (r) => this.transitionTo(r.next, r.data))
      .exhaustive();
  }

  private async transitionTo(next: SName, data: SData): Promise<void> {
    const from = this.currentState;
    // Exit hook for the old state
    const exitHook = this.onExit.get(from);
    if (exitHook) { try { await exitHook(this.currentData); } catch (e) { this.log.warn('onExit threw', e); } }

    this.currentState = next;
    this.currentData = data;

    // Entry hook for the new state.
    const entryHook = this.onEntry.get(next);
    if (entryHook) { try { await entryHook(data); } catch (e) { this.log.warn('onEnter threw', e); } }

    for (const cb of this.transitionListeners) {
      try { await cb(from, next, data); } catch { /* swallow */ }
    }
  }
}
