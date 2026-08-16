import { match } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { SystemGroups } from '../../internal/SystemPaths.js';
import { metricsOf } from '../../metrics/MetricsExtension.js';
import type { PersistentEvent } from '../JournalTypes.js';
import {
  type Offset,
  type PersistenceQuery,
  type TaggedEvent,
  offsetStart,
  tagFilterCursorKey,
} from '../query/PersistenceQuery.js';
import { InMemoryOffsetStore, type OffsetStore } from './OffsetStore.js';
import {
  ProjectionOptionsValidator,
  defaultProjectionRecoveryOptions,
} from './ProjectionOptions.js';
import type {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
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

/** Projection settings after the recovery defaults have been merged in. */
type ResolvedProjectionOptions<E> = ProjectionOptionsType<E> & ProjectionRecoveryOptionsType;
type ResolvedByPersistenceIdOptions<E> =
  ByPersistenceIdProjectionOptionsType<E> & ProjectionRecoveryOptionsType;
type ResolvedByTagOptions<E> = ByTagProjectionOptionsType<E> & ProjectionRecoveryOptionsType;

/** Which side of a projection tick failed — the `reason` label of the failure counter. */
type ProjectionFailureReason = 'handler' | 'poll';

abstract class BaseProjectionActor<E> extends Actor<InternalTickMessage> {
  protected readonly offsetStore: OffsetStore;
  protected pollTimer: Cancellable | null = null;
  protected stopped = false;
  /** Resolves when the in-flight handler completes — preserved across stop. */
  protected currentHandle: Promise<void> = Promise.resolve();
  /**
   * Consecutive failed attempts at the *same* event.  Drives the recovery
   * strategy, and is reset by a successful handler call or by a skip — the
   * retry budget is per poison event, not per lifetime.
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
  }

  override async preStart(): Promise<void> {
    // Publish the healthy value once so the series exists for a running
    // projection — an alert on `== 1` is useless if the gauge only appears
    // at the moment it is already too late.
    this.setStalled(false);
    await this.loadCursor();
    // Kick the loop off immediately — we don't want to wait
    // pollIntervalMs to deliver the *first* batch of historic events.
    this.self.tell(TICK);
  }

  override async postStop(): Promise<void> {
    this.stopped = true;
    this.pollTimer?.cancel();
    // Make sure any in-flight handler call finishes before the
    // mailbox shuts down — otherwise we'd lose the just-saved cursor.
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
      : (this.options.liveOptions?.pollIntervalMs ?? 1_000);
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
   */
  protected async deliver(event: PersistentEvent<E>): Promise<boolean> {
    try {
      const handled = Promise.resolve(this.options.handle(event));
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
    this.logHandlerFailure(event, error, action);
    this.notifyFailure({
      projection: this.options.name,
      event,
      error,
      attempt: this.handlerFailures,
      action,
    });
    if (action === 'stop') {
      // Stop explicitly instead of letting the error escape `onReceive`.
      // `persistence/projection` has no entry in `SystemPaths`' group
      // policies, so it inherits the restarting default: an escaped error
      // would re-run `preStart`, reload the same cursor and fail on the same
      // event — a restart loop, which is louder than the spin it replaced
      // and no more useful.
      this.stopped = true;
      this.pollTimer?.cancel();
      this.context.stopSelf();
      return false;
    }
    if (action === 'skip') {
      this.handlerFailures = 0;
      this.tickFailures = 0;
      this.tickFailed = false;
      this.reportSkipped(event);
      return true;
    }
    return false;
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
   */
  private logHandlerFailure(
    event: PersistentEvent<E>,
    error: unknown,
    action: ProjectionFailureAction,
  ): void {
    const where = `${event.persistenceId}#${event.sequenceNr}`;
    if (action === 'stop') {
      this.log.error(
        `projection ${this.options.name} stopped at ${where} after `
        + `${this.handlerFailures} failed attempt(s)`, error,
      );
      return;
    }
    if (action === 'skip') {
      this.log.warn(
        `projection ${this.options.name} skipped ${where} after `
        + `${this.handlerFailures} failed attempt(s) — published as a dead letter`, error,
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
   * can subscribe to what its read model is missing.  The in-memory stream is
   * the sink that exists today; a durable one (#433) would slot in behind the
   * same publication without changing this call.
   */
  private reportSkipped(event: PersistentEvent<E>): void {
    metricsOf(this.system).counter(
      'persistence_projection_events_skipped_total', { projection: this.options.name },
      { help: 'Events a projection gave up on and stepped past, published as dead letters.' },
    ).inc();
    this.system.deadLetters.tell(event, this.self);
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
}

/* ------------------------------ by pid -------------------------------- */

class ByPersistenceIdProjectionActor<E> extends BaseProjectionActor<E> {
  private cursor = 0;
  constructor(private readonly config: ResolvedByPersistenceIdOptions<E>) { super(config); }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadSequence(this.config.name, this.config.persistenceId);
  }

  protected async runOnce(): Promise<void> {
    const events = await this.config.query.currentEventsByPersistenceId<E>(
      this.config.persistenceId, this.cursor + 1,
    );
    for (const ev of events) {
      // A false directive leaves the cursor where it is, so the next tick
      // re-reads this same event — the retry, and the stop, both need that.
      if (!await this.deliver(ev)) return;
      this.cursor = ev.sequenceNr;
      await this.offsetStore.saveSequence(this.config.name, this.config.persistenceId, this.cursor);
      if (this.stopped) return;
    }
  }
}

/* ------------------------------ by tag -------------------------------- */

class ByTagProjectionActor<E> extends BaseProjectionActor<E> {
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
    for (const te of events) {
      // Skip the event we already committed last round (the cursor
      // is inclusive on load to support fresh-start replay, but on
      // subsequent rounds we want strictly-after).
      if (te.offset.timestamp === this.cursor.timestamp
        && te.offset.persistenceId === this.cursor.persistenceId
        && te.offset.sequenceNr === this.cursor.sequenceNr) continue;
      // A false directive leaves the cursor where it is, so the next tick
      // re-reads this same event — the retry, and the stop, both need that.
      if (!await this.deliver(te.event)) return;
      this.cursor = te.offset;
      await this.offsetStore.saveOffset(this.config.name, this.cursorKey, this.cursor);
      if (this.stopped) return;
    }
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
 *   3. **handle** — call the user `handler` on each event.  The
 *      handler MUST be idempotent — see at-least-once below.
 *   4. **commit** — save the cursor to the offset store.
 *   5. **repeat**.
 *
 * **At-least-once.**  If the projection crashes between step 3 and
 * step 4, the next start replays from the saved cursor and the
 * just-handled event will be re-handled.  Handlers must therefore
 * either:
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
 * A skipped event is published on the system dead-letter stream, so
 * nothing is dropped without a trace.  Every failure also reaches
 * `onFailure` with the offending event, moves
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
    const resolvedOptions: ResolvedByPersistenceIdOptions<E> = {
      ...given,
      ...recoveryDefaultsFor(given),
    };
    validateProjectionOptions(resolvedOptions);
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
    const resolvedOptions: ResolvedByTagOptions<E> = {
      ...given,
      ...recoveryDefaultsFor(given),
    };
    validateProjectionOptions(resolvedOptions);
    return system._spawnSystemActor(
      () => new ByTagProjectionActor<E>(resolvedOptions) as unknown as Actor<unknown>,
      SystemGroups.persistenceProjection,
      `${resolvedOptions.name}-tag-${sanitize(tagFilterCursorKey(resolvedOptions.tag))}`,
    );
  }
}

/** Built-in recovery defaults, with anything the caller set taking precedence. */
function recoveryDefaultsFor<E>(options: ProjectionOptionsType<E>): ProjectionRecoveryOptionsType {
  return {
    recoveryStrategy: options.recoveryStrategy ?? defaultProjectionRecoveryOptions.recoveryStrategy,
    maxRetries: options.maxRetries ?? defaultProjectionRecoveryOptions.maxRetries,
    retryBackoffMs: options.retryBackoffMs ?? defaultProjectionRecoveryOptions.retryBackoffMs,
    maxRetryBackoffMs:
      options.maxRetryBackoffMs ?? defaultProjectionRecoveryOptions.maxRetryBackoffMs,
  };
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
 * its options over, and it is synchronous.
 */
function validateProjectionOptions<E>(options: ProjectionOptionsType<E>): void {
  new ProjectionOptionsValidator<E>().validate(options);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
}
