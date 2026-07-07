import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import type { PersistentEvent } from '../JournalTypes.js';
import {
  type LiveQueryOptions,
  type Offset,
  type PersistenceQuery,
  type TaggedEvent,
  offsetStart,
} from '../query/PersistenceQuery.js';
import { InMemoryOffsetStore, type OffsetStore } from './OffsetStore.js';
import type { ByPidProjectionOptions, ByTagProjectionOptions } from './ProjectionOptions.js';

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
 * **Stopping**: the standard `actorRef.stop()` triggers `postStop`
 * which cancels the polling timer; the in-flight handler call (if
 * any) is awaited before the actor exits.
 */
export interface ProjectionSettings<E> {
  /** Logical name — used as the offset-store key prefix. */
  readonly name: string;
  /** The query layer (one of `InMemoryQuery`, `SqliteQuery`, …). */
  readonly query: PersistenceQuery;
  /** Where to persist the cursor.  Default: in-memory (lost on restart). */
  readonly offsetStore?: OffsetStore;
  /** User handler — runs once per event.  Must be idempotent. */
  readonly handle: (event: PersistentEvent<E>) => void | Promise<void>;
  /** Tunables passed to the underlying live query. */
  readonly liveOptions?: LiveQueryOptions;
}

export interface ByPidSettings<E> extends ProjectionSettings<E> {
  readonly persistenceId: string;
}

export interface ByTagSettings<E> extends ProjectionSettings<E> {
  readonly tag: string;
}

/* ============================ implementation ========================== */

interface InternalTickMsg { readonly _: 'projection-tick' }
const TICK: InternalTickMsg = { _: 'projection-tick' };

abstract class BaseProjectionActor<E> extends Actor<InternalTickMsg> {
  protected readonly offsetStore: OffsetStore;
  protected pollTimer: Cancellable | null = null;
  protected stopped = false;
  /** Resolves when the in-flight handler completes — preserved across stop. */
  protected currentHandle: Promise<void> = Promise.resolve();

  constructor(protected readonly settings: ProjectionSettings<E>) {
    super();
    this.offsetStore = settings.offsetStore ?? new InMemoryOffsetStore();
  }

  override async preStart(): Promise<void> {
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

  override async onReceive(_msg: InternalTickMsg): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error(`projection ${this.settings.name} tick failed`, err);
    } finally {
      if (!this.stopped) this.scheduleNextTick();
    }
  }

  protected scheduleNextTick(): void {
    const delay = this.settings.liveOptions?.pollIntervalMs ?? 1_000;
    this.pollTimer?.cancel();
    this.pollTimer = this.system.scheduler.scheduleOnceFn(delay, () => {
      this.self.tell(TICK);
    });
  }

  /* ----- subclass contract ----- */

  protected abstract loadCursor(): Promise<void>;
  protected abstract runOnce(): Promise<void>;
}

/* ------------------------------ by pid -------------------------------- */

class ByPidProjectionActor<E> extends BaseProjectionActor<E> {
  private cursor = 0;
  constructor(private readonly cfg: ByPidSettings<E>) { super(cfg); }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadSequence(this.cfg.name, this.cfg.persistenceId);
  }

  protected async runOnce(): Promise<void> {
    const events = await this.cfg.query.currentEventsByPersistenceId<E>(
      this.cfg.persistenceId, this.cursor + 1,
    );
    for (const ev of events) {
      this.currentHandle = Promise.resolve(this.cfg.handle(ev));
      await this.currentHandle;
      this.cursor = ev.sequenceNr;
      await this.offsetStore.saveSequence(this.cfg.name, this.cfg.persistenceId, this.cursor);
      if (this.stopped) return;
    }
  }
}

/* ------------------------------ by tag -------------------------------- */

class ByTagProjectionActor<E> extends BaseProjectionActor<E> {
  private cursor: Offset = offsetStart;
  constructor(private readonly cfg: ByTagSettings<E>) { super(cfg); }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadOffset(this.cfg.name, this.cfg.tag);
  }

  protected async runOnce(): Promise<void> {
    const events: TaggedEvent<E>[] = await this.cfg.query.currentEventsByTag<E>(
      this.cfg.tag, this.cursor,
    );
    for (const te of events) {
      // Skip the event we already committed last round (the cursor
      // is inclusive on load to support fresh-start replay, but on
      // subsequent rounds we want strictly-after).
      if (te.offset.timestamp === this.cursor.timestamp
        && te.offset.persistenceId === this.cursor.persistenceId
        && te.offset.sequenceNr === this.cursor.sequenceNr) continue;
      this.currentHandle = Promise.resolve(this.cfg.handle(te.event));
      await this.currentHandle;
      this.cursor = te.offset;
      await this.offsetStore.saveOffset(this.cfg.name, this.cfg.tag, this.cursor);
      if (this.stopped) return;
    }
  }
}

/* ============================ public API ============================== */

import { Props } from '../../Props.js';
import type { ActorSystem } from '../../ActorSystem.js';

export class ProjectionActor {
  /** Spawn a per-persistenceId projection.  Returns the actor ref. */
  static byPersistenceId<E>(
    system: ActorSystem,
    options: ByPidProjectionOptions<E> | Partial<ByPidSettings<E>>,
  ): ActorRef<unknown> {
    const settings = options as ByPidSettings<E>;
    return system.spawn(
      Props.create(() => new ByPidProjectionActor<E>(settings) as unknown as Actor<unknown>),
      `projection-${settings.name}-${sanitize(settings.persistenceId)}`,
    );
  }

  /** Spawn a per-tag projection.  Returns the actor ref. */
  static byTag<E>(
    system: ActorSystem,
    options: ByTagProjectionOptions<E> | Partial<ByTagSettings<E>>,
  ): ActorRef<unknown> {
    const settings = options as ByTagSettings<E>;
    return system.spawn(
      Props.create(() => new ByTagProjectionActor<E>(settings) as unknown as Actor<unknown>),
      `projection-${settings.name}-tag-${sanitize(settings.tag)}`,
    );
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
}
