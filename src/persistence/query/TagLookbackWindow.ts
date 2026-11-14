import type { PersistentEvent } from '../JournalTypes.js';
import { offsetCompare, offsetOfEvent, offsetStart, type Offset, type TaggedEvent } from './PersistenceQuery.js';

/**
 * The newest event a by-tag consumer delivered for one persistence id inside
 * its lookback window — the unit of the window's deduplication state.
 *
 * `timestamp` is that event's own stamp, kept so the mark can be dropped once
 * it falls behind the window: nothing older is ever re-read, so nothing older
 * needs remembering.
 */
export type DeliveredEventMark = {
  readonly persistenceId: string;
  readonly sequenceNr: number;
  readonly timestamp: number;
};

/**
 * A by-tag consumer's resumable position: the {@link Offset} it has delivered
 * up to, plus what it remembers about the lookback window behind it (#957).
 *
 * Structurally an `Offset` — a plain offset *is* a valid `TagCursor` — so an
 * `OffsetStore` that persists the object as it is handed over (both in-tree
 * stores do: the in-memory one keeps the object, the durable-state one stores
 * it as JSON) carries the window across a restart without knowing about it.
 *
 *   - `delivered` — per persistence id, the newest event delivered inside the
 *     window.  An array, not a record keyed on the id: the ids are
 *     application data, and a JSON object keyed on them would turn an id
 *     spelled `__proto__` into a prototype write on load.
 *   - `floor` — everything at or before this offset counts as delivered.  Set
 *     when the cursor was resumed from a plain offset (a cursor written before
 *     the window existed, or by a store that kept only the three offset
 *     fields): such a cursor says nothing about which events behind it were
 *     handled, and treating them all as handled is what the projection did
 *     before.  Dropped once it falls behind the window.
 *
 * A cursor with neither field resumes exactly as an offset always has.
 */
export type TagCursor = Offset & {
  readonly delivered?: ReadonlyArray<DeliveredEventMark>;
  readonly floor?: Offset;
};

/**
 * Whether an event at the floor itself counts as delivered: `true` for a
 * projection cursor (the event at the cursor was handled and committed),
 * `false` for a live stream's start offset (which is inclusive — the event at
 * it is still to be delivered).
 */
type FloorBound = 'inclusive' | 'exclusive';

/**
 * The lookback window plus deduplication behind every by-tag consumer
 * (#957, maintainer decision D-1).
 *
 * **The defect it closes.**  Every journal stamps an event with `Date.now()`
 * before its write commits, while a by-tag `Offset` orders on that stamp.  So
 * a slow writer's event can become visible after a consumer has moved past
 * its stamp, and a consumer that reads forward from its position never sees
 * it — permanently, since the position is what a restart resumes from.
 *
 * **The fix.**  Each read starts `windowMs` behind the newest delivered stamp
 * instead of at it, and what the window already delivered is dropped.  No
 * backend has to change: every one answers `currentEventsByTag` from an
 * arbitrary offset, so the window works identically everywhere, which a
 * commit-ordered column would not (Cassandra, DynamoDB and D1 cannot assign
 * one).
 *
 * **Why one mark per persistence id is enough.**  Within one persistence id
 * the journal appends serially — an append names the head it expects and is
 * refused otherwise — so a later sequence number never becomes visible before
 * an earlier one.  "Delivered" for an id therefore reduces to "at or below
 * the highest sequence number delivered for it", and the state is one entry
 * per id written inside the window rather than one per event.  The one way an
 * id's events can arrive out of sequence order in a single read is a wall
 * clock stepping backwards between two of its appends; {@link admit} restores
 * per-id sequence order inside each read so that case delivers both events
 * instead of skipping the earlier one.
 *
 * **Bounded.**  A mark is dropped once its stamp falls behind the window,
 * because no read reaches that far back again.  So the state holds one entry
 * per persistence id with a delivered event in the last `windowMs`, and no
 * more.  The trade is explicit: an event whose commit lags its stamp by more
 * than the window is still missed — the window is sized to make that a
 * deployment error, not a normal case.
 */
export class TagLookbackWindow {
  /** Newest delivered position — what the window trails behind. */
  private highWater: Offset;
  private floor: Offset | null;
  /**
   * Insertion-ordered by last update, so the oldest marks sit at the front and
   * {@link prune} can stop at the first one still inside the window.
   */
  private readonly marks = new Map<string, DeliveredEventMark>();

  private constructor(
    private readonly windowMs: number,
    highWater: Offset,
    floor: Offset | null,
    private readonly floorBound: FloorBound,
    marks: ReadonlyArray<DeliveredEventMark>,
  ) {
    this.highWater = highWater;
    this.floor = floor;
    for (const mark of marks) this.marks.set(mark.persistenceId, mark);
    this.prune();
  }

  /**
   * Resume a projection from the cursor its offset store returned.  A cursor
   * without `delivered` — written before the window existed, by a store that
   * kept only the offset, or the fresh-start sentinel — becomes an inclusive
   * floor: nothing at or behind it is delivered again.
   */
  static resuming(cursor: TagCursor, windowMs: number): TagLookbackWindow {
    const highWater = plainOffset(cursor);
    if (!Array.isArray(cursor.delivered)) {
      return new TagLookbackWindow(windowMs, highWater, highWater, 'inclusive', []);
    }
    const floor = isOffset(cursor.floor) ? plainOffset(cursor.floor) : null;
    return new TagLookbackWindow(windowMs, highWater, floor, 'inclusive', cursor.delivered.filter(isMark));
  }

  /**
   * Start a live stream at `fromOffset`, inclusive.  Nothing before it is
   * delivered, late or not — the caller asked to start there.
   */
  static startingAt(fromOffset: Offset, windowMs: number): TagLookbackWindow {
    const start = plainOffset(fromOffset);
    return new TagLookbackWindow(windowMs, start, start, 'exclusive', []);
  }

  /**
   * Where the next read starts: `windowMs` behind the newest delivered stamp,
   * but never before the floor.  Ties on the stamp are left to
   * {@link isDelivered}, so the offset carries only a timestamp.
   */
  readFrom(): Offset {
    const lookback: Offset = {
      timestamp: Math.max(0, this.highWater.timestamp - this.windowMs),
      persistenceId: offsetStart.persistenceId,
      sequenceNr: offsetStart.sequenceNr,
    };
    if (this.floor !== null && offsetCompare(this.floor, lookback) > 0) return this.floor;
    return lookback;
  }

  /** Whether `event` was already delivered — or lies behind where this consumer started. */
  isDelivered<E>(event: PersistentEvent<E>): boolean {
    if (this.floor !== null) {
      const relative = offsetCompare(offsetOfEvent(event), this.floor);
      if (relative < 0 || (relative === 0 && this.floorBound === 'inclusive')) return true;
    }
    const mark = this.marks.get(event.persistenceId);
    return mark !== undefined && event.sequenceNr <= mark.sequenceNr;
  }

  /**
   * The events of one read that are still to be delivered, in delivery order.
   *
   * Order is the query's `Offset` order, except that each persistence id's
   * events keep their sequence order among the slots that id occupies — see
   * the class note on a clock stepping backwards.  An event the same read
   * returns twice is admitted once.
   */
  admit<E>(events: ReadonlyArray<TaggedEvent<E>>): TaggedEvent<E>[] {
    const ordered = inSequenceOrderPerPersistenceId(events);
    const admittedThrough = new Map<string, number>();
    const admitted: TaggedEvent<E>[] = [];
    for (const tagged of ordered) {
      const event = tagged.event;
      if (this.isDelivered(event)) continue;
      const through = admittedThrough.get(event.persistenceId);
      if (through !== undefined && event.sequenceNr <= through) continue;
      admittedThrough.set(event.persistenceId, event.sequenceNr);
      admitted.push(tagged);
    }
    return admitted;
  }

  /** Record `event` as delivered and advance the high-water mark past it. */
  markDelivered<E>(event: PersistentEvent<E>): void {
    const previous = this.marks.get(event.persistenceId);
    if (previous === undefined || event.sequenceNr > previous.sequenceNr) {
      // Delete first so the re-insert moves the id to the back of the order.
      this.marks.delete(event.persistenceId);
      this.marks.set(event.persistenceId, {
        persistenceId: event.persistenceId,
        sequenceNr: event.sequenceNr,
        timestamp: event.timestamp,
      });
    }
    const offset = offsetOfEvent(event);
    if (offsetCompare(offset, this.highWater) > 0) this.highWater = offset;
    this.prune();
  }

  /** The resumable state, for an `OffsetStore` to persist. */
  cursor(): TagCursor {
    const horizon = this.horizon();
    const delivered: DeliveredEventMark[] = [];
    for (const mark of this.marks.values()) {
      if (mark.timestamp >= horizon) delivered.push(mark);
    }
    return this.floor === null
      ? { ...this.highWater, delivered }
      : { ...this.highWater, delivered, floor: this.floor };
  }

  /** Stamps before this are never read again. */
  private horizon(): number {
    return this.highWater.timestamp - this.windowMs;
  }

  /**
   * Drop what no read reaches any more.  Scans from the front and stops at
   * the first mark still inside the window: a mark updated late sits behind
   * newer ones and leaves only once they have, which keeps it a little longer
   * than strictly needed — never shorter, and never past the window plus the
   * lag that made it late.  {@link cursor} filters exactly, so nothing stale
   * is persisted.
   */
  private prune(): void {
    const horizon = this.horizon();
    for (const [persistenceId, mark] of this.marks) {
      if (mark.timestamp >= horizon) break;
      this.marks.delete(persistenceId);
    }
    if (this.floor !== null && this.floor.timestamp < horizon) this.floor = null;
  }
}

/**
 * Restore sequence order within each persistence id, keeping the slots each id
 * occupies in the read.  Returns the input itself when nothing is out of order,
 * which is every read whose writers' clocks did not step backwards.
 */
function inSequenceOrderPerPersistenceId<E>(events: ReadonlyArray<TaggedEvent<E>>): ReadonlyArray<TaggedEvent<E>> {
  const slotsByPersistenceId = new Map<string, number[]>();
  let disordered = false;
  for (let index = 0; index < events.length; index++) {
    const persistenceId = events[index]!.event.persistenceId;
    const slots = slotsByPersistenceId.get(persistenceId);
    if (slots === undefined) {
      slotsByPersistenceId.set(persistenceId, [index]);
      continue;
    }
    if (events[slots[slots.length - 1]!]!.event.sequenceNr > events[index]!.event.sequenceNr) disordered = true;
    slots.push(index);
  }
  if (!disordered) return events;
  const reordered = [...events];
  for (const slots of slotsByPersistenceId.values()) {
    const bySequence = slots
      .map((slot) => events[slot]!)
      .sort((a, b) => a.event.sequenceNr - b.event.sequenceNr);
    slots.forEach((slot, position) => { reordered[slot] = bySequence[position]!; });
  }
  return reordered;
}

/** The three offset fields alone — a cursor's extra fields must not leak into a query offset. */
function plainOffset(offset: Offset): Offset {
  return { timestamp: offset.timestamp, persistenceId: offset.persistenceId, sequenceNr: offset.sequenceNr };
}

/**
 * A loaded cursor is whatever the offset store returned — JSON from a
 * database, for the durable-state store — so its window fields are checked
 * before use.  A malformed entry is dropped: forgetting a mark can only cause
 * a redelivery, which the at-least-once contract already allows, while
 * trusting one could suppress an event.
 */
function isMark(value: unknown): value is DeliveredEventMark {
  if (value === null || typeof value !== 'object') return false;
  const mark = value as Record<string, unknown>;
  return typeof mark.persistenceId === 'string'
    && Number.isFinite(mark.sequenceNr)
    && Number.isFinite(mark.timestamp);
}

function isOffset(value: unknown): value is Offset {
  if (value === null || typeof value !== 'object') return false;
  const offset = value as Record<string, unknown>;
  return typeof offset.persistenceId === 'string'
    && Number.isFinite(offset.sequenceNr)
    && Number.isFinite(offset.timestamp);
}
