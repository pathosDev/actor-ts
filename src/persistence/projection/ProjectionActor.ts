import { match } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { DeadLetter } from '../../SystemMessages.js';
import { SystemGroups } from '../../internal/SystemPaths.js';
import { metricsOf } from '../../metrics/MetricsExtension.js';
import { DEFAULT_LIVE_QUERY_POLL_INTERVAL_MS } from '../Constants.js';
import type { PersistentEvent } from '../JournalTypes.js';
import {
  type LiveQueryOptions,
  type Offset,
  type PersistenceQuery,
  type TaggedEvent,
  offsetCompare,
  offsetStart,
  tagFilterCursorKey,
} from '../query/PersistenceQuery.js';
import { InMemoryOffsetStore, type OffsetStore } from './OffsetStore.js';
import {
  DEFAULT_PROJECTION_GROUP_AFTER_ENVELOPES,
  ProjectionOptionsValidator,
  defaultProjectionRecoveryOptions,
  readProjectionOptionsFromConfig,
} from './ProjectionOptions.js';
import type {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
  ProjectionConfigDefaults,
  ProjectionFailure,
  ProjectionFailureAction,
  ProjectionOptionsType,
  ProjectionRecoveryOptionsType,
  ByPersistenceIdProjectionOptionsType,
  ByTagProjectionOptionsType,
} from './ProjectionOptions.js';

/* ============================ implementation ========================== */

type InternalTickMessage = { readonly _: 'projection-tick' };
const TICK: InternalTickMessage = { _: 'projection-tick' };

/**
 * The tick cadence after the merge.  Required rather than optional, so the
 * actor reads it without a fallback: every construction site goes through a
 * static factory, and each one resolves the field across all three layers.
 */
type ResolvedLiveOptions = { readonly liveOptions: Required<LiveQueryOptions> };

/** Projection settings after the recovery defaults have been merged in. */
type ResolvedProjectionOptions<E> =
  ProjectionOptionsType<E> & ProjectionRecoveryOptionsType & ResolvedLiveOptions;
type ResolvedByPersistenceIdOptions<E> =
  ByPersistenceIdProjectionOptionsType<E> & ProjectionRecoveryOptionsType & ResolvedLiveOptions;
type ResolvedByTagOptions<E> =
  ByTagProjectionOptionsType<E> & ProjectionRecoveryOptionsType & ResolvedLiveOptions;

/** Which side of a projection tick failed — the `reason` label of the failure counter. */
type ProjectionFailureReason = 'handler' | 'poll';

/**
 * One event and the cursor position a commit past it stores — the envelope
 * `groupAfterEnvelopes` counts.  `P` is the cursor's type: the `sequenceNr`
 * of a by-persistence-id projection, or the {@link Offset} of a by-tag one,
 * where a `TaggedEvent` already is an envelope.
 */
type ProjectionEnvelope<E, P> = {
  readonly event: PersistentEvent<E>;
  readonly offset: P;
};

/**
 * The handler slot as the actor calls it.  The factory's validator has
 * already refused a projection with neither handler and one with both, so
 * the actor holds one shape and never re-checks two optional fields per call.
 */
type ProjectionHandler<E> = PerEventHandler<E> | GroupHandler<E>;

type PerEventHandler<E> = {
  readonly kind: 'per-event';
  readonly handle: (event: PersistentEvent<E>) => void | Promise<void>;
};

type GroupHandler<E> = {
  readonly kind: 'group';
  readonly handleGroup: (events: ReadonlyArray<PersistentEvent<E>>) => void | Promise<void>;
  readonly groupAfterEnvelopes: number;
};

/**
 * What the actor does about one failed handler call: one of the reported
 * {@link ProjectionFailureAction}s, or `split` — a group its strategy would
 * have skipped, delivered again one event per call instead.  `split` is
 * reported as `retry`, since every event of the group is tried again next.
 */
type HandlerFailureOutcome = ProjectionFailureAction | 'split';

/** How one `handleGroup` call ended, for the loop that delivers the groups. */
type GroupOutcome = 'delivered' | 'retry' | 'stop' | 'split';

abstract class BaseProjectionActor<E, P> extends Actor<InternalTickMessage> {
  protected readonly offsetStore: OffsetStore;
  protected pollTimer: Cancellable | null = null;
  protected stopped = false;
  /** Resolves when the in-flight handler call — one event or one group — completes; preserved across stop. */
  protected currentHandle: Promise<void> = Promise.resolve();
  /** The user's handler, resolved once from the validated options. */
  protected readonly handler: ProjectionHandler<E>;
  /**
   * One event to the user: `handle`, or `handleGroup` with a group of one —
   * which is how a `handleGroup` projection delivers a split range.
   */
  private readonly handleOne: (event: PersistentEvent<E>) => void | Promise<void>;
  /**
   * The last position of a group that is being delivered one event per call,
   * because its strategy would have skipped it; `null` while delivery is
   * grouped.
   *
   * Actor state rather than a local of the tick, because a per-event retry
   * inside the range ends the tick.  The next tick has to know the range is
   * still split, or it would form the same group again and fail it again.
   */
  private splitThrough: P | null = null;
  /**
   * Consecutive failed attempts at the *same* event or group — whatever the
   * cursor is waiting on.  Drives the recovery strategy, and is reset by a
   * successful handler call, by a skip and by a split — the retry budget is
   * per poison event, not per lifetime.
   */
  private handlerFailures = 0;
  /**
   * Consecutive failed ticks of any kind.  Drives the backoff delay and the
   * log deduplication.  Kept apart from {@link handlerFailures} on purpose: a
   * flaky journal must not burn the retry budget of an event whose handler
   * has not been reached, which is exactly what one shared counter would do.
   */
  private tickFailures = 0;
  /** Set by either failure path; read by the tick epilogue to reset the streak. */
  private tickFailed = false;
  /** Last value written to the stalled gauge — `null` until the first write. */
  private stalled: boolean | null = null;

  constructor(protected readonly options: ResolvedProjectionOptions<E>) {
    super();
    this.offsetStore = options.offsetStore ?? new InMemoryOffsetStore();
    const handler = projectionHandlerOf(options);
    this.handler = handler;
    this.handleOne = handler.kind === 'group'
      ? (event) => handler.handleGroup([event])
      : handler.handle;
  }

  override async preStart(): Promise<void> {
    // Publish the healthy value once so the series exists for a running
    // projection — an alert on `== 1` is useless if the gauge only appears
    // at the moment it is already too late.
    this.setStalled(false);
    try {
      await this.loadCursor();
    } catch (error) {
      this.onCursorLoadFailure(error);
      throw error;
    }
    // Kick the loop off immediately — we don't want to wait
    // pollIntervalMs to deliver the *first* batch of historic events.
    this.self.tell(TICK);
  }

  /**
   * The cursor load threw — the offset store was unreachable, or it refused
   * the composite key it would have had to write (#1507).
   *
   * Reported here rather than left to the throw, because a failure that
   * escapes `preStart` reaches nothing a projection operator watches.  It
   * becomes an `ActorInitializationError`; `ActorCell` logs one generic
   * `Actor initialization failed` whose *message* names no projection (the
   * name is in the record's source, sanitized and truncated to 64
   * characters); the ten restarts `defaultStrategy` then spends log nothing
   * at all, because `completeRecreate` fails to its parent without a line;
   * and the gauge the stock-metrics page calls "the alert" is left at the 0
   * published three lines above.  Measured on the composite-key case: 11
   * load attempts, 2 log records, gauge 0.  A projection that could never
   * start read as a healthy one, which is worse than reading as absent.
   *
   * `reason: 'poll'` rather than a third label value.  The stock-metrics page
   * defines `poll` as the query layer or the offset store throwing — which is
   * exactly this — and promises those two values and no others.
   *
   * The healthy 0 above is deliberately left where it is: it is what makes
   * the series exist for every projection that starts, and a load that fails
   * writes 1 over it in the same turn, so the value an operator scrapes is
   * still the right one.
   *
   * The error is rethrown by the caller, so supervision is unchanged — this
   * adds the signal, it does not take the failure over.
   */
  private onCursorLoadFailure(error: unknown): void {
    this.countFailure('poll');
    this.setStalled(true);
    this.log.error(
      `projection ${this.options.name} could not load its offset cursor and did not start`,
      error,
    );
  }

  override async postStop(): Promise<void> {
    this.stopped = true;
    this.pollTimer?.cancel();
    // Make sure any in-flight handler call — one event or one group —
    // finishes before the mailbox shuts down; otherwise we'd lose the
    // just-saved cursor.
    await this.currentHandle;
  }

  override async onReceive(_message: InternalTickMessage): Promise<void> {
    if (this.stopped) return;
    this.tickFailed = false;
    try {
      await this.runOnce();
    } catch (error) {
      this.onPollFailure(error);
    } finally {
      if (!this.tickFailed) this.onTickSucceeded();
      if (!this.stopped) this.scheduleNextTick();
    }
  }

  protected scheduleNextTick(): void {
    const delay = this.tickFailures > 0
      ? this.retryDelayMs()
      : this.options.liveOptions.pollIntervalMs;
    this.pollTimer?.cancel();
    this.pollTimer = this.system.scheduler.scheduleOnceFunction(delay, () => {
      this.self.tell(TICK);
    });
  }

  /**
   * Exponential backoff on the consecutive-failure count, capped.
   *
   * `2 ** n` reaches `Infinity` long before a projection could, and
   * `Math.min` folds that onto the cap, so a very long streak needs no
   * special case.
   */
  private retryDelayMs(): number {
    return Math.min(
      this.options.maxRetryBackoffMs,
      this.options.retryBackoffMs * 2 ** (this.tickFailures - 1),
    );
  }

  /* ------------------------- handler dispatch ------------------------- */

  /**
   * Run the user handler for one event and apply the recovery strategy if it
   * throws.  Returns whether the caller may commit the cursor past `event`:
   * `true` on success *and* on a skip — stepping over the poison event is
   * what a skip is — and `false` when the same event must be retried or the
   * projection is stopping.
   *
   * The per-event path of a `handleGroup` projection as well: a split range,
   * and a group of one, go through here as `handleGroup([event])`, so they
   * get exactly the budget, the actions and the report a `handle` event gets.
   */
  protected async deliver(event: PersistentEvent<E>): Promise<boolean> {
    try {
      const handled = Promise.resolve(this.handleOne(event));
      this.currentHandle = handled;
      await handled;
    } catch (error) {
      // Replace the rejected promise before anything else can await it:
      // `postStop` awaits `currentHandle`, and a rejection there would
      // escape actor shutdown rather than the strategy handling it here.
      this.currentHandle = Promise.resolve();
      return this.onHandlerFailure(event, error);
    }
    this.onHandlerSuccess();
    return true;
  }

  /* -------------------------- group delivery -------------------------- */

  /**
   * Deliver one tick's envelopes as groups of at most `groupAfterEnvelopes`,
   * in order, committing once per successful group — to its last position,
   * because the saves in between would carry nothing a monotonic cursor
   * needs.
   *
   * Every group the tick's result yields goes out in this tick.  Nothing is
   * held back to fill a group, so the poll interval is the window and no
   * held state can ever sit ahead of the cursor.  A group that fails ends
   * the tick with the cursor before it (a retry re-forms it next tick, a
   * stop leaves it there), or is split: its envelopes go out one per call
   * through {@link deliver}, one commit each — and if a per-event retry ends
   * the tick first, the next tick delivers the rest of the range the same
   * way, until it is behind the cursor.
   *
   * Every pass of the loop moves `index` forward or returns, so a query that
   * breaks its ordering contract can misplace a group boundary but cannot
   * make a tick spin: the split group is walked by index, not found again by
   * comparing positions.
   */
  protected async deliverGroups(
    envelopes: ReadonlyArray<ProjectionEnvelope<E, P>>,
    handler: GroupHandler<E>,
  ): Promise<void> {
    let index = 0;
    while (index < envelopes.length) {
      const envelope = envelopes[index]!;
      // One event per call inside a split range an earlier tick started —
      // and for a group of one, which already is one event per call: a
      // failed group attempt there would only be split into the very call
      // it just made.
      const end = this.isSplit(envelope.offset)
        ? index + 1
        : Math.min(index + handler.groupAfterEnvelopes, envelopes.length);
      if (end - index === 1) {
        if (!await this.deliverAlone(envelope)) return;
        index++;
        continue;
      }
      const group = envelopes.slice(index, end);
      const last = group[group.length - 1]!;
      const outcome = await this.deliverGroup(group.map((each) => each.event), handler);
      if (outcome === 'split') {
        // Recorded before the walk, because a per-event retry inside it ends
        // the tick and the next one has to find the range still open.
        this.splitThrough = last.offset;
        for (const each of group) {
          if (!await this.deliverAlone(each)) return;
        }
        index = end;
        continue;
      }
      // A retry and a stop both leave the cursor before the group.
      if (outcome !== 'delivered') return;
      await this.commit(last.offset);
      if (this.stopped) return;
      index = end;
    }
  }

  /**
   * One envelope through the per-event path, then its own commit — taken
   * after a skip too, since stepping past the event is what a skip is.
   * Returns whether delivery may go on in this tick.
   */
  private async deliverAlone(envelope: ProjectionEnvelope<E, P>): Promise<boolean> {
    // A false directive leaves the cursor before this event, so the next
    // tick reads it again — still inside the split range, if it was in one.
    if (!await this.deliver(envelope.event)) return false;
    await this.commit(envelope.offset);
    if (this.splitThrough !== null && this.comparePositions(envelope.offset, this.splitThrough) >= 0) {
      // The range is behind the cursor; delivery is grouped again from here.
      this.splitThrough = null;
    }
    return !this.stopped;
  }

  private isSplit(position: P): boolean {
    return this.splitThrough !== null && this.comparePositions(position, this.splitThrough) <= 0;
  }

  /**
   * Run `handleGroup` for one group and apply the recovery strategy if it
   * throws — the group counterpart of {@link deliver}: one call, one attempt
   * against the same handler-failure budget.
   */
  private async deliverGroup(
    group: ReadonlyArray<PersistentEvent<E>>,
    handler: GroupHandler<E>,
  ): Promise<GroupOutcome> {
    try {
      const handled = Promise.resolve(handler.handleGroup(group));
      this.currentHandle = handled;
      await handled;
    } catch (error) {
      // As in `deliver`: `postStop` must never await a rejected promise.
      this.currentHandle = Promise.resolve();
      return this.onGroupFailure(group, error);
    }
    this.onHandlerSuccess();
    return 'delivered';
  }

  private onHandlerSuccess(): void {
    if (this.handlerFailures === 0) return;
    this.log.info(
      `projection ${this.options.name} recovered after ${this.handlerFailures} failed attempt(s)`,
    );
    this.handlerFailures = 0;
  }

  private onHandlerFailure(event: PersistentEvent<E>, error: unknown): boolean {
    this.handlerFailures++;
    this.tickFailures++;
    this.tickFailed = true;
    const action = this.decideFailureAction();
    this.countFailure('handler');
    this.setStalled(action !== 'skip');
    this.logHandlerFailure(`${event.persistenceId}#${event.sequenceNr}`, error, action);
    this.notifyFailure({
      projection: this.options.name,
      event,
      error,
      attempt: this.handlerFailures,
      action,
    });
    if (action === 'stop') {
      this.stopOnFailure();
      return false;
    }
    if (action === 'skip') {
      this.clearFailureStreak();
      this.reportSkipped(event);
      return true;
    }
    return false;
  }

  /**
   * A failed `handleGroup` call.  It spends the same budget and goes through
   * the same strategy as an event, with one exception: a group is never
   * skipped, because that would drop the good events in it along with the
   * bad one.  Where the strategy would skip, the group is split instead —
   * handed to one-event-per-call delivery, where the per-event strategy
   * skips exactly the event that fails.  So `fail` and `retry-and-fail`
   * never split, and a split is never a stall: it is the projection moving.
   */
  private onGroupFailure(group: ReadonlyArray<PersistentEvent<E>>, error: unknown): GroupOutcome {
    this.handlerFailures++;
    this.tickFailures++;
    this.tickFailed = true;
    const action = this.decideFailureAction();
    const outcome = action === 'skip' ? 'split' : action;
    this.countFailure('handler');
    this.setStalled(outcome !== 'split');
    this.logHandlerFailure(describeGroup(group), error, outcome);
    this.notifyFailure({
      projection: this.options.name,
      // The event the cursor is waiting on; the group says what else failed with it.
      event: group[0]!,
      group,
      error,
      attempt: this.handlerFailures,
      action: outcome === 'split' ? 'retry' : outcome,
    });
    if (outcome === 'stop') this.stopOnFailure();
    // Each event of a split group starts a budget of its own.
    if (outcome === 'split') this.clearFailureStreak();
    return outcome;
  }

  private stopOnFailure(): void {
    // Stop explicitly instead of letting the error escape `onReceive`.
    // `persistence/projection` has no entry in `SystemPaths`' group
    // policies, so it inherits the restarting default: an escaped error
    // would re-run `preStart`, reload the same cursor and fail on the same
    // event — a restart loop, which is louder than the spin it replaced
    // and no more useful.
    this.stopped = true;
    this.pollTimer?.cancel();
    this.context.stopSelf();
  }

  /**
   * Nothing is owed to the event or group that was failing any more — a skip
   * stepped past it, a split gives each of its events a fresh attempt — so
   * neither the retry budget nor the backoff streak may carry over.
   */
  private clearFailureStreak(): void {
    this.handlerFailures = 0;
    this.tickFailures = 0;
    this.tickFailed = false;
  }

  /**
   * The strategy reduced against the attempt count.  A match on internal
   * state that computes a value, so it stays inline.
   */
  private decideFailureAction(): ProjectionFailureAction {
    const budgetLeft = this.handlerFailures <= this.options.maxRetries;
    return match(this.options.recoveryStrategy)
      .with('fail', (): ProjectionFailureAction => 'stop')
      .with('skip', (): ProjectionFailureAction => 'skip')
      .with('retry-and-fail', (): ProjectionFailureAction => (budgetLeft ? 'retry' : 'stop'))
      .with('retry-and-skip', (): ProjectionFailureAction => (budgetLeft ? 'retry' : 'skip'))
      .exhaustive();
  }

  /**
   * A failure that was not the user handler's — the query layer or the
   * offset store threw.  There is no event to hand to the strategy (one was
   * never read), so the only responses available are to keep polling and to
   * stop shouting: the streak still backs off, and the log still dedups.
   */
  private onPollFailure(error: unknown): void {
    this.tickFailures++;
    this.tickFailed = true;
    this.countFailure('poll');
    this.setStalled(true);
    if (this.tickFailures === 1) {
      this.log.error(`projection ${this.options.name} tick failed`, error);
    } else {
      this.log.debug(
        `projection ${this.options.name} tick failed (attempt ${this.tickFailures})`, error,
      );
    }
  }

  private onTickSucceeded(): void {
    if (this.tickFailures === 0) return;
    this.tickFailures = 0;
    // A tick that reached the end without a single failure has nothing
    // pending, so the per-event budget is spent on nobody.  Normally
    // `onHandlerSuccess` already cleared it; this covers the case where the
    // event that was failing is no longer in the query's result at all.
    this.handlerFailures = 0;
    this.setStalled(false);
  }

  /* ---------------------------- reporting ----------------------------- */

  /**
   * At most two error-level lines per poison event, whatever the retry
   * budget: one when the streak starts and one when it ends.  The retries in
   * between go to `debug`, because a projection retrying on its own backoff
   * curve is working as configured — it was the unconditional error per poll
   * that made a single bad event fill a day of logs.
   *
   * `where` is `pid#seq` for one event and the range for a group, so a group
   * that fails and is then split shows two streaks: the group's, which a
   * warning closes when it splits, and the failing event's own.
   */
  private logHandlerFailure(
    where: string,
    error: unknown,
    outcome: HandlerFailureOutcome,
  ): void {
    if (outcome === 'stop') {
      this.log.error(
        `projection ${this.options.name} stopped at ${where} after `
        + `${this.handlerFailures} failed attempt(s)`, error,
      );
      return;
    }
    if (outcome === 'skip') {
      this.log.warn(
        `projection ${this.options.name} skipped ${where} after `
        + `${this.handlerFailures} failed attempt(s) — published as a dead letter`, error,
      );
      return;
    }
    if (outcome === 'split') {
      this.log.warn(
        `projection ${this.options.name} split ${where} after `
        + `${this.handlerFailures} failed attempt(s) — delivering its events one per call, `
        + 'so that only the one that fails is skipped', error,
      );
      return;
    }
    if (this.handlerFailures === 1) {
      this.log.error(`projection ${this.options.name} handler failed at ${where}`, error);
    } else {
      this.log.debug(
        `projection ${this.options.name} handler failed at ${where} `
        + `(attempt ${this.handlerFailures})`, error,
      );
    }
  }

  /**
   * Hand a skipped event to the system dead-letter stream, so an application
   * can subscribe to what its read model is missing.
   *
   * The wrap is explicit because the two-argument `tell` put `self` in the
   * *sender* slot, which is the wrong end: nothing sent this event to the
   * projection, the projection failed to apply it.  Recipient `self` says
   * which projection is missing the event — the fact a reader needs, and the
   * one a per-recipient filter or counter keys on (#433).
   */
  private reportSkipped(event: PersistentEvent<E>): void {
    metricsOf(this.system).counter(
      'persistence_projection_events_skipped_total', { projection: this.options.name },
      { help: 'Events a projection gave up on and stepped past, published as dead letters.' },
    ).inc();
    this.system.deadLetters.tell(new DeadLetter(event, null, this.self));
  }

  private notifyFailure(failure: ProjectionFailure<E>): void {
    const onFailure = this.options.onFailure;
    if (!onFailure) return;
    try {
      onFailure(failure);
    } catch (hookError) {
      // A reporter that throws must not become the projection's failure.
      this.log.error(`projection ${this.options.name} onFailure hook threw`, hookError);
    }
  }

  private countFailure(reason: ProjectionFailureReason): void {
    metricsOf(this.system).counter(
      'persistence_projection_failures_total', { projection: this.options.name, reason },
      { help: 'Projection ticks that failed, split by whether the handler or the query threw.' },
    ).inc();
  }

  /**
   * The "this projection is wedged" signal.  Written only on a change so an
   * idle projection does not touch the registry once per poll.
   */
  private setStalled(stalled: boolean): void {
    if (this.stalled === stalled) return;
    this.stalled = stalled;
    metricsOf(this.system).gauge(
      'persistence_projection_stalled', { projection: this.options.name },
      { help: 'Set to 1 while a projection is blocked on an event whose handler failed.' },
    ).set(stalled ? 1 : 0);
  }

  /* ----- subclass contract ----- */

  protected abstract loadCursor(): Promise<void>;
  protected abstract runOnce(): Promise<void>;
  /** Move the cursor to `position` and save it. */
  protected abstract commit(position: P): Promise<void>;
  /** Journal order on cursor positions — negative, zero or positive. */
  protected abstract comparePositions(a: P, b: P): number;
}

/* ------------------------------ by pid -------------------------------- */

class ByPersistenceIdProjectionActor<E> extends BaseProjectionActor<E, number> {
  private cursor = 0;
  constructor(private readonly config: ResolvedByPersistenceIdOptions<E>) { super(config); }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadSequence(this.config.name, this.config.persistenceId);
  }

  protected async runOnce(): Promise<void> {
    const events = await this.config.query.currentEventsByPersistenceId<E>(
      this.config.persistenceId, this.cursor + 1,
    );
    const handler = this.handler;
    if (handler.kind === 'group') {
      await this.deliverGroups(events.map((event) => ({ event, offset: event.sequenceNr })), handler);
      return;
    }
    for (const ev of events) {
      // A false directive leaves the cursor where it is, so the next tick
      // re-reads this same event — the retry, and the stop, both need that.
      if (!await this.deliver(ev)) return;
      await this.commit(ev.sequenceNr);
      if (this.stopped) return;
    }
  }

  protected async commit(sequenceNr: number): Promise<void> {
    this.cursor = sequenceNr;
    await this.offsetStore.saveSequence(this.config.name, this.config.persistenceId, sequenceNr);
  }

  protected comparePositions(a: number, b: number): number {
    return a - b;
  }
}

/* ------------------------------ by tag -------------------------------- */

class ByTagProjectionActor<E> extends BaseProjectionActor<E, Offset> {
  private cursor: Offset = offsetStart;
  /**
   * `OffsetStore` is keyed by string, while `tag` may now be a filter object.
   * Derived once: it must be identical on every load and save, or the
   * projection would reload a cursor it never wrote.  For a bare string this
   * *is* the string, so cursors persisted before filters were accepted keep
   * resolving.
   */
  private readonly cursorKey: string;
  constructor(private readonly config: ResolvedByTagOptions<E>) {
    super(config);
    this.cursorKey = tagFilterCursorKey(config.tag);
  }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadOffset(this.config.name, this.cursorKey);
  }

  protected async runOnce(): Promise<void> {
    const events: TaggedEvent<E>[] = await this.config.query.currentEventsByTag<E>(
      this.config.tag, this.cursor,
    );
    const handler = this.handler;
    if (handler.kind === 'group') {
      // The same skip as below, taken before the events are cut into groups:
      // delivered again, or merely counted into a group's size, the event
      // committed last would shift every group boundary behind it.
      await this.deliverGroups(events.filter((te) => !this.isCursor(te.offset)), handler);
      return;
    }
    for (const te of events) {
      // Skip the event we already committed last round (the cursor
      // is inclusive on load to support fresh-start replay, but on
      // subsequent rounds we want strictly-after).
      if (this.isCursor(te.offset)) continue;
      // A false directive leaves the cursor where it is, so the next tick
      // re-reads this same event — the retry, and the stop, both need that.
      if (!await this.deliver(te.event)) return;
      await this.commit(te.offset);
      if (this.stopped) return;
    }
  }

  protected async commit(offset: Offset): Promise<void> {
    this.cursor = offset;
    await this.offsetStore.saveOffset(this.config.name, this.cursorKey, offset);
  }

  protected comparePositions(a: Offset, b: Offset): number {
    return offsetCompare(a, b);
  }

  /** Whether `offset` is the one the cursor holds — the event committed last. */
  private isCursor(offset: Offset): boolean {
    return offset.timestamp === this.cursor.timestamp
      && offset.persistenceId === this.cursor.persistenceId
      && offset.sequenceNr === this.cursor.sequenceNr;
  }
}

/* ============================ public API ============================== */

import type { ActorSystem } from '../../ActorSystem.js';

/**
 * Actor wrapper around a projection.  Owns the polling loop, the
 * offset cursor, and the at-least-once delivery contract:
 *
 *   1. **preStart** — load the cursor from {@link OffsetStore}.
 *   2. **loop** — poll the {@link PersistenceQuery} for new events
 *      from the cursor onwards.
 *   3. **handle** — call the user's `handle` with each event, or its
 *      `handleGroup` with each group of up to `groupAfterEnvelopes`
 *      events — every group the poll returned, in that same tick.
 *      Either one MUST be idempotent — see at-least-once below.
 *   4. **commit** — save the cursor to the offset store: after each
 *      event, or once per group, to the group's last event.
 *   5. **repeat**.
 *
 * **At-least-once.**  If the projection crashes between step 3 and
 * step 4, the next start replays from the saved cursor and the
 * just-handled event will be re-handled — with `handleGroup`, the
 * whole group that contained it, since a group commits as one.
 * Handlers must therefore either:
 *   - be idempotent (e.g. UPSERT into the read model);
 *   - or do their own dedup via some unique key on the event.
 *
 * **Two query shapes are supported via the static factories:**
 *
 *   - `ProjectionActor.byPersistenceId(...)` — one cursor per pid.
 *     Use this for "give me everything an entity ever did".  The
 *     cursor is the entity's `sequenceNr`.
 *   - `ProjectionActor.byTag(...)` — one cursor per tag.  Use this
 *     for "give me every event labelled X across the whole journal".
 *     The cursor is an `Offset` (timestamp + tiebreakers).
 *
 * **When the handler throws.**  The cursor only advances after a
 * successful `handle`, so a failure is head-of-line blocking by
 * construction — every later event waits behind the one that failed.
 * `recoveryStrategy` decides how long that lasts:
 *
 *   - `retry-and-fail` (default) — retry `maxRetries` times on an
 *     exponential backoff, then stop the projection.
 *   - `retry-and-skip` — retry, then step past the event.
 *   - `fail` / `skip` — do that immediately, without retrying.
 *
 * A failed group goes through the same strategy as a group — retried
 * whole, or stopped before its first event — except that it is never
 * skipped: where the strategy would skip, the group is split, and its
 * events are delivered again one per call through the per-event path,
 * which skips exactly the event that fails.
 *
 * Those four, and the poll cadence, also have process-wide defaults under
 * `actor-ts.projection.*`.  Precedence is the project's usual three layers:
 * what this projection sets explicitly wins, then HOCON, then the built-in
 * default.
 *
 * A skipped event is published on the system dead-letter stream, so
 * nothing is dropped without a trace.  Every failure also reaches
 * `onFailure` with the offending event — for a failed group, its first
 * event and the whole group — moves
 * `persistence_projection_failures_total`, and raises
 * `persistence_projection_stalled` for as long as the projection
 * cannot get past it.
 *
 * **Stopping**: the standard `actorRef.stop()` triggers `postStop`
 * which cancels the polling timer; the in-flight handler call (if
 * any) is awaited before the actor exits.  A `fail` strategy stops
 * the actor the same way rather than letting the error escape — the
 * group's supervisor would restart it into the same failure.
 */
export class ProjectionActor {
  /** Spawn a per-persistenceId projection.  Returns the actor ref. */
  static byPersistenceId<E>(
    system: ActorSystem,
    options: ByPersistenceIdProjectionOptions<E>,
  ): ActorRef<unknown> {
    const given = options as ByPersistenceIdProjectionOptionsType<E>;
    const fromConfig = readProjectionOptionsFromConfig(system.config);
    const resolvedOptions: ResolvedByPersistenceIdOptions<E> = {
      ...given,
      ...recoveryDefaultsFor(given, fromConfig),
      liveOptions: liveOptionsFor(given, fromConfig),
      groupAfterEnvelopes: groupAfterEnvelopesFor(given),
    };
    validateProjectionOptions(resolvedOptions, 'persistenceId');
    return system._spawnSystemActor(
      () => new ByPersistenceIdProjectionActor<E>(resolvedOptions) as unknown as Actor<unknown>,
      SystemGroups.persistenceProjection,
      `${resolvedOptions.name}-${sanitize(resolvedOptions.persistenceId)}`,
    );
  }

  /** Spawn a per-tag projection.  Returns the actor ref. */
  static byTag<E>(
    system: ActorSystem,
    options: ByTagProjectionOptions<E>,
  ): ActorRef<unknown> {
    const given = options as ByTagProjectionOptionsType<E>;
    const fromConfig = readProjectionOptionsFromConfig(system.config);
    const resolvedOptions: ResolvedByTagOptions<E> = {
      ...given,
      ...recoveryDefaultsFor(given, fromConfig),
      liveOptions: liveOptionsFor(given, fromConfig),
      groupAfterEnvelopes: groupAfterEnvelopesFor(given),
    };
    validateProjectionOptions(resolvedOptions, 'tag');
    return system._spawnSystemActor(
      () => new ByTagProjectionActor<E>(resolvedOptions) as unknown as Actor<unknown>,
      SystemGroups.persistenceProjection,
      `${resolvedOptions.name}-tag-${sanitize(tagFilterCursorKey(resolvedOptions.tag))}`,
    );
  }
}

/**
 * The project's three layers for the recovery fields: what the caller set
 * wins, then `actor-ts.projection.*`, then the built-in default.
 *
 * A plain `??` chain rather than `mergeOptions` because that is already the
 * semantics wanted here — an explicit `undefined` falls through to the next
 * layer instead of shadowing it — and because each field is read once.
 */
function recoveryDefaultsFor<E>(
  options: ProjectionOptionsType<E>,
  fromConfig: ProjectionConfigDefaults,
): ProjectionRecoveryOptionsType {
  const builtIn = defaultProjectionRecoveryOptions;
  return {
    recoveryStrategy:
      options.recoveryStrategy ?? fromConfig.recoveryStrategy ?? builtIn.recoveryStrategy,
    maxRetries: options.maxRetries ?? fromConfig.maxRetries ?? builtIn.maxRetries,
    retryBackoffMs: options.retryBackoffMs ?? fromConfig.retryBackoffMs ?? builtIn.retryBackoffMs,
    maxRetryBackoffMs:
      options.maxRetryBackoffMs ?? fromConfig.maxRetryBackoffMs ?? builtIn.maxRetryBackoffMs,
  };
}

/**
 * The same three layers for the poll cadence, merged **per field** rather than
 * on the `liveOptions` object as a whole.
 *
 * There are two ways to get that wrong and they fail on different call shapes,
 * which is why neither one alone was enough.  Taking `options.liveOptions`
 * whole when it is present lets `withLiveOptions({})` — an object that says
 * nothing — put the cadence back to the built-in default.  Spreading it over
 * the configured one instead handles `{}` fine, and then lets an own
 * `pollIntervalMs: undefined` survive the spread and overwrite the configured
 * value.  The field-by-field chain reads both as "not set", which is what
 * `undefined` on a higher layer means everywhere else in this project.
 *
 * Despite the name, `liveOptions` on a projection is *only* the tick cadence:
 * `runOnce` calls `currentEventsByPersistenceId` / `currentEventsByTag`
 * without an options argument, so nothing here ever reaches a live query.
 */
function liveOptionsFor<E>(
  options: ProjectionOptionsType<E>,
  fromConfig: ProjectionConfigDefaults,
): Required<LiveQueryOptions> {
  return {
    pollIntervalMs: options.liveOptions?.pollIntervalMs
      ?? fromConfig.pollIntervalMs
      ?? DEFAULT_LIVE_QUERY_POLL_INTERVAL_MS,
  };
}

/**
 * The group size, defaulted only where there is a group to size.  On a
 * `handle` projection the field stays exactly what the caller wrote, so the
 * validator refuses an explicit size there rather than a default this
 * function put in itself.
 */
function groupAfterEnvelopesFor<E>(options: ProjectionOptionsType<E>): number | undefined {
  if (options.handleGroup === undefined) return options.groupAfterEnvelopes;
  return options.groupAfterEnvelopes ?? DEFAULT_PROJECTION_GROUP_AFTER_ENVELOPES;
}

/**
 * The handler slot as the actor calls it.  Only the two factories construct
 * a projection actor, and both validate first — so exactly one handler is
 * set here, and a `handleGroup` projection's size is already resolved.  The
 * two casts state that, rather than re-checking what cannot be otherwise.
 */
function projectionHandlerOf<E>(options: ProjectionOptionsType<E>): ProjectionHandler<E> {
  const handleGroup = options.handleGroup;
  if (handleGroup === undefined) {
    return { kind: 'per-event', handle: options.handle as PerEventHandler<E>['handle'] };
  }
  return { kind: 'group', handleGroup, groupAfterEnvelopes: options.groupAfterEnvelopes as number };
}

/** A group as the log lines name it: `group pid#4..pid#6 (3 events)`. */
function describeGroup<E>(group: ReadonlyArray<PersistentEvent<E>>): string {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  return `group ${first.persistenceId}#${first.sequenceNr}..${last.persistenceId}#${last.sequenceNr} `
    + `(${group.length} events)`;
}

/**
 * Validate the merged settings *here*, in the static factory, rather than in
 * the actor's constructor as most consumers do.
 *
 * A projection actor is constructed when its cell processes the `create`
 * message, long after `byTag` has returned — so a throw in the constructor is
 * a supervised failure, not a caller-visible one.  `persistence/projection`
 * has no policy entry in `SystemPaths`, which means the restarting default:
 * the bad value would be re-read on every restart and the caller would see a
 * ref that never works.  The factory is the point where the application hands
 * its options over, and it is synchronous — and it runs before the actor name
 * is computed from `persistenceId` / `tag`, so a missing one is refused by name
 * rather than surfacing as a `TypeError` out of `sanitize`.
 */
function validateProjectionOptions<E>(
  options: ProjectionOptionsType<E>,
  cursorField: 'persistenceId' | 'tag',
): void {
  new ProjectionOptionsValidator<E>(cursorField).validate(options);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
}
