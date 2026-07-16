import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import {
  type Offset,
  type PersistenceQuery,
  type TaggedEvent,
  offsetStart,
} from '../query/PersistenceQuery.js';
import { InMemoryOffsetStore, type OffsetStore } from './OffsetStore.js';
import type {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
  ProjectionOptionsType,
  ByPersistenceIdProjectionOptionsType,
  ByTagProjectionOptionsType,
} from './ProjectionOptions.js';

/* ============================ implementation ========================== */

interface InternalTickMessage { readonly _: 'projection-tick' }
const TICK: InternalTickMessage = { _: 'projection-tick' };

abstract class BaseProjectionActor<E> extends Actor<InternalTickMessage> {
  protected readonly offsetStore: OffsetStore;
  protected pollTimer: Cancellable | null = null;
  protected stopped = false;
  /** Resolves when the in-flight handler completes — preserved across stop. */
  protected currentHandle: Promise<void> = Promise.resolve();

  constructor(protected readonly options: ProjectionOptionsType<E>) {
    super();
    this.offsetStore = options.offsetStore ?? new InMemoryOffsetStore();
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

  override async onReceive(_message: InternalTickMessage): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error(`projection ${this.options.name} tick failed`, err);
    } finally {
      if (!this.stopped) this.scheduleNextTick();
    }
  }

  protected scheduleNextTick(): void {
    const delay = this.options.liveOptions?.pollIntervalMs ?? 1_000;
    this.pollTimer?.cancel();
    this.pollTimer = this.system.scheduler.scheduleOnceFunction(delay, () => {
      this.self.tell(TICK);
    });
  }

  /* ----- subclass contract ----- */

  protected abstract loadCursor(): Promise<void>;
  protected abstract runOnce(): Promise<void>;
}

/* ------------------------------ by pid -------------------------------- */

class ByPersistenceIdProjectionActor<E> extends BaseProjectionActor<E> {
  private cursor = 0;
  constructor(private readonly config: ByPersistenceIdProjectionOptionsType<E>) { super(config); }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadSequence(this.config.name, this.config.persistenceId);
  }

  protected async runOnce(): Promise<void> {
    const events = await this.config.query.currentEventsByPersistenceId<E>(
      this.config.persistenceId, this.cursor + 1,
    );
    for (const ev of events) {
      this.currentHandle = Promise.resolve(this.config.handle(ev));
      await this.currentHandle;
      this.cursor = ev.sequenceNr;
      await this.offsetStore.saveSequence(this.config.name, this.config.persistenceId, this.cursor);
      if (this.stopped) return;
    }
  }
}

/* ------------------------------ by tag -------------------------------- */

class ByTagProjectionActor<E> extends BaseProjectionActor<E> {
  private cursor: Offset = offsetStart;
  constructor(private readonly config: ByTagProjectionOptionsType<E>) { super(config); }

  protected async loadCursor(): Promise<void> {
    this.cursor = await this.offsetStore.loadOffset(this.config.name, this.config.tag);
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
      this.currentHandle = Promise.resolve(this.config.handle(te.event));
      await this.currentHandle;
      this.cursor = te.offset;
      await this.offsetStore.saveOffset(this.config.name, this.config.tag, this.cursor);
      if (this.stopped) return;
    }
  }
}

/* ============================ public API ============================== */

import { Props } from '../../Props.js';
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
 * **Stopping**: the standard `actorRef.stop()` triggers `postStop`
 * which cancels the polling timer; the in-flight handler call (if
 * any) is awaited before the actor exits.
 */
export class ProjectionActor {
  /** Spawn a per-persistenceId projection.  Returns the actor ref. */
  static byPersistenceId<E>(
    system: ActorSystem,
    options: ByPersistenceIdProjectionOptions<E>,
  ): ActorRef<unknown> {
    const resolvedOptions = options as ByPersistenceIdProjectionOptionsType<E>;
    return system.spawn(
      Props.create(() => new ByPersistenceIdProjectionActor<E>(resolvedOptions) as unknown as Actor<unknown>),
      `projection-${resolvedOptions.name}-${sanitize(resolvedOptions.persistenceId)}`,
    );
  }

  /** Spawn a per-tag projection.  Returns the actor ref. */
  static byTag<E>(
    system: ActorSystem,
    options: ByTagProjectionOptions<E>,
  ): ActorRef<unknown> {
    const resolvedOptions = options as ByTagProjectionOptionsType<E>;
    return system.spawn(
      Props.create(() => new ByTagProjectionActor<E>(resolvedOptions) as unknown as Actor<unknown>),
      `projection-${resolvedOptions.name}-tag-${sanitize(resolvedOptions.tag)}`,
    );
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
}
