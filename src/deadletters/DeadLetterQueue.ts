import { match } from 'ts-pattern';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { parseSelectionPath } from '../ActorSelection.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import type { Journal } from '../persistence/Journal.js';
import type { DeadLetter } from '../SystemMessages.js';
import { randomUuid } from '../util/RandomString.js';
import type {
  DeadLetterEntry,
  DeadLetterFilter,
  DeadLetterPayload,
  DeadLetterReplayResult,
} from './DeadLetterEntry.js';
import {
  DEFAULT_DEAD_LETTER_MAX_ENTRIES,
  DEFAULT_DEAD_LETTER_MAX_REPLAYS,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_DEAD_LETTER_STORE,
  DeadLetterQueueOptionsValidator,
  defaultDeadLetterPersistenceId,
  type DeadLetterQueueOptions,
  type DeadLetterQueueOptionsType,
  type DeadLetterStore,
} from './DeadLetterQueueOptions.js';

/**
 * A letter arriving in the durable log.  `entry` is stored whole rather than
 * spread across columns because the queue is the only reader — nothing
 * queries it by field, and a single object keeps the record forward
 * compatible with fields added later.
 */
type CapturedRecord = {
  readonly kind: 'captured';
  readonly entry: DeadLetterEntry;
};

/**
 * A letter leaving the queue other than by ageing out — today only a
 * successful `replay`.
 *
 * Eviction needs no tombstone: the ring evicts oldest-first, so everything
 * it drops sits below the oldest surviving entry and is removed by the
 * prefix trim.  A replay punches a hole *above* that line, which a trim
 * cannot express, so it is recorded instead.
 */
type RemovedRecord = {
  readonly kind: 'removed';
  readonly id: string;
};

type DeadLetterRecord = CapturedRecord | RemovedRecord;

/** A live entry plus the journal sequence it was written at, if it was. */
type StoredEntry = {
  entry: DeadLetterEntry;
  /** Journal sequence number, or `null` while the append is in flight. */
  sequenceNr: number | null;
};

/**
 * Bounded, optionally durable record of the messages this system could not
 * deliver (#433).
 *
 * Before this existed, `DeadLetterRef` published each letter on the event
 * stream and returned.  With no subscriber — the default — the letter was
 * simply gone, which made "what did we drop during that incident?" a
 * question the framework could not answer after the fact.  The queue is the
 * subscriber that is always there: it captures at the single choke point
 * every dead letter already passes through, so nothing has to be routed to
 * it and no emitter has to know it exists.
 *
 * **Capture sits upstream of publication and of any future suppression.**
 * A rate limiter or sampler over the dead-letter stream is a reasonable
 * thing to want (#1179), but one that dropped letters before this sink
 * would quietly turn a durable record into a lossy sample while every
 * document still called it complete.  `DeadLetterRef` therefore calls the
 * sink first and publishes second.
 *
 * **What it cannot see.**  A message discarded by a bounded or priority
 * mailbox never becomes a dead letter at all: the drop-reporting seam
 * carries a reason and not the envelope, so `DroppingMailbox` has nothing
 * to hand over.  That is the largest class of undeliverable message the
 * queue does *not* hold, and closing it needs a public widening of
 * `DropReportingMailbox.observeDrops` — deliberately out of scope here
 * rather than papered over.
 *
 * **Persistence is resolved lazily**, through a dynamic import, so that a
 * consumer importing `Actor` does not pull a journal — and its codec, and
 * its plugin registry — into their bundle for a feature they left `off`.
 */
export class DeadLetterQueue {
  private readonly settings: Required<Omit<DeadLetterQueueOptionsType, 'persistenceId'>>
    & { readonly persistenceId: string };

  /** Live entries, oldest first — the ring's insertion order. */
  private readonly entries: StoredEntry[] = [];

  /**
   * Letters currently out on a replay, keyed by the message itself.
   *
   * Keyed on the value rather than on an id the recipient would have to
   * carry, because the payload is redelivered untouched — wrapping it to
   * smuggle a correlation id through would change what the actor receives,
   * which is the one thing replay must not do.  Bounded by `maxEntries`:
   * a replay that never comes back leaves an entry here, so the oldest are
   * dropped rather than accumulated.
   */
  private readonly replayed = new Map<unknown, { id: string; replayCount: number }>();

  /**
   * Serialises the durable writes.  Every append chains onto this, so the
   * journal sees the letters in capture order and `flush` has a single
   * thing to await.  `catch` rather than `then`, because a failed write
   * must not poison the chain for the letters behind it.
   */
  private writeTail: Promise<void> = Promise.resolve();

  /** Highest journal sequence written so far — `append`'s `expectedSeq`. */
  private highestSequenceNr = 0;
  /** Highest sequence already compacted away, so the trim is monotonic. */
  private compactedThroughSequenceNr = 0;
  private restored: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly system: ActorSystem,
    options: DeadLetterQueueOptions = {},
  ) {
    const merged = { ...(options as Partial<DeadLetterQueueOptionsType>) };
    new DeadLetterQueueOptionsValidator().validate(merged);
    this.settings = {
      store: merged.store ?? DEFAULT_DEAD_LETTER_STORE,
      maxEntries: merged.maxEntries ?? DEFAULT_DEAD_LETTER_MAX_ENTRIES,
      retentionMs: merged.retentionMs ?? DEFAULT_DEAD_LETTER_RETENTION_MS,
      maxReplays: merged.maxReplays ?? DEFAULT_DEAD_LETTER_MAX_REPLAYS,
      persistenceId: merged.persistenceId ?? defaultDeadLetterPersistenceId(system.name),
    };
  }

  /** Where this queue keeps what it captures. */
  get store(): DeadLetterStore { return this.settings.store; }

  /**
   * Captured letters, **newest first**, narrowed by `filter`.
   *
   * Newest first because the question that brings someone here is almost
   * always "what just broke", and a queue at its cap would otherwise open
   * on the oldest thing it still happens to hold.
   *
   * Asynchronous even though the letters are held in memory: a `persistent`
   * queue has a previous run's log to read back first, and a synchronous
   * reader would have answered "nothing" for however long that took —
   * exactly at the moment after a restart when the answer matters most.
   */
  async list(filter: DeadLetterFilter = {}): Promise<ReadonlyArray<DeadLetterEntry>> {
    await this._restore();
    this.expire();
    const out: DeadLetterEntry[] = [];
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!.entry;
      if (!this.matches(entry, filter)) continue;
      out.push(entry);
      if (filter.limit !== undefined && out.length >= filter.limit) break;
    }
    return out;
  }

  /** One entry by id, or `undefined` if it has been replayed or aged out. */
  async get(id: string): Promise<DeadLetterEntry | undefined> {
    await this._restore();
    this.expire();
    return this.entries.find((stored) => stored.entry.id === id)?.entry;
  }

  /**
   * Hand a captured letter back to the actor it was addressed to.
   *
   * Removes the entry *before* redelivering, and remembers the message so
   * that a second failure comes back as the **same** entry with a higher
   * `replayCount` rather than as a fresh one.  Without that bookkeeping an
   * operator retrying a poison message would add an entry per attempt while
   * each attempt still looked like a first — the queue growing on exactly
   * the letters it should be refusing.  Past `maxReplays` the letter is
   * quarantined and this refuses to send it.
   */
  async replay(id: string): Promise<DeadLetterReplayResult> {
    await this._restore();
    this.expire();
    const index = this.entries.findIndex((stored) => stored.entry.id === id);
    if (index < 0) return { kind: 'unknown-entry' };
    const stored = this.entries[index]!;
    const entry = stored.entry;

    if (entry.payload.kind === 'degraded') return { kind: 'degraded-payload' };
    if (entry.replayCount >= this.settings.maxReplays) {
      return { kind: 'quarantined', replayCount: entry.replayCount };
    }

    const recipient = this.resolve(entry.recipientPath);
    if (recipient === null) {
      return { kind: 'unresolved-recipient', recipientPath: entry.recipientPath };
    }

    this.entries.splice(index, 1);
    this.recordRemoval(entry.id);
    // Registered before the send, because a synchronous mailbox rejection
    // can dead-letter the message before `tell` returns.
    this.replayed.set(entry.payload.message, {
      id: entry.id,
      replayCount: entry.replayCount + 1,
    });
    recipient.tell(entry.payload.message as never, this.resolve(entry.senderPath));
    this.count('replayed', entry.recipientPath);
    return { kind: 'replayed', recipientPath: entry.recipientPath };
  }

  /** Forget everything held.  The durable log is compacted to match. */
  async clear(): Promise<void> {
    await this._restore();
    for (const stored of this.entries) this.recordRemoval(stored.entry.id);
    this.entries.length = 0;
    this.replayed.clear();
  }

  /**
   * Settle the durable writes issued so far.
   *
   * Registered as a `CoordinatedShutdown` task in
   * `before-actor-system-terminate` and awaited again once the actor tree is
   * down.  Both are needed and neither is redundant: the phase catches the
   * letters a running system produced, and the second catches the ones the
   * teardown itself produces — a stashed message, a mailbox drained past its
   * cell — which are emitted *after* every phase has run and are, for a
   * shutting-down system, most of them.
   */
  async flush(): Promise<void> {
    if (this.settings.store !== 'persistent') return;
    // Twice: awaiting the tail lets whatever was queued behind it run, and
    // that run may have appended more.  Two rounds settle a chain that is
    // no longer being fed, which is the state a shutdown flush is in.
    await this.writeTail.catch(() => {});
    await this.writeTail.catch(() => {});
  }

  /**
   * @internal Stop accepting letters.  Called once the system is down, so a
   * late emitter cannot start a write into a journal nobody will await.
   */
  _close(): void { this.closed = true; }

  /**
   * @internal The sink `DeadLetterRef` calls, ahead of publishing.
   *
   * Must not throw: it runs inside `tell`, on whatever path produced the
   * undeliverable message, and a queue that failed loudly there would turn
   * a lost message into a broken caller.
   */
  _capture(deadLetter: DeadLetter): void {
    if (this.settings.store === 'off' || this.closed) return;
    try {
      this.captureUnguarded(deadLetter);
    } catch (error) {
      this.system.log.warn(
        `[dead-letters] capturing a letter for ${deadLetter.recipient.path} failed: `
        + `${(error as Error).message}`,
      );
    }
  }

  /**
   * @internal Load whatever a previous run left behind.  Idempotent, and a
   * no-op unless the store is `persistent`.
   *
   * Not awaited by the constructor: an `ActorSystem` is created
   * synchronously, and a queue that had to be started before it could
   * capture would drop every letter produced while it was starting.  Live
   * captures append at sequences above whatever is restored, and the fold
   * runs before them, so the two orders cannot cross.
   */
  async _restore(): Promise<void> {
    if (this.settings.store !== 'persistent') return;
    this.restored ??= this.restoreOnce();
    await this.restored;
  }

  /* ------------------------------ capture ------------------------------ */

  private captureUnguarded(deadLetter: DeadLetter): void {
    const message = deadLetter.message;
    const previous = this.replayed.get(message);
    if (previous !== undefined) this.replayed.delete(message);

    const entry: DeadLetterEntry = {
      id: previous?.id ?? randomUuid(),
      timestampMs: Date.now(),
      recipientPath: deadLetter.recipient.path.toString(),
      senderPath: deadLetter.sender === null ? null : deadLetter.sender.path.toString(),
      payload: { kind: 'captured', message },
      replayCount: previous?.replayCount ?? 0,
    };

    this.expire();
    const stored: StoredEntry = { entry, sequenceNr: null };
    this.entries.push(stored);
    while (this.entries.length > this.settings.maxEntries) this.entries.shift();
    while (this.replayed.size > this.settings.maxEntries) {
      const oldest = this.replayed.keys().next();
      if (oldest.done === true) break;
      this.replayed.delete(oldest.value);
    }

    this.count(previous === undefined ? 'captured' : 'replay-failed', entry.recipientPath);
    if (this.settings.store === 'persistent') {
      this.enqueueWrite({ kind: 'captured', entry }, stored);
    }
  }

  /** Drop everything older than `retentionMs`.  `0` disables ageing. */
  private expire(): void {
    if (this.settings.retentionMs <= 0) return;
    const cutoff = Date.now() - this.settings.retentionMs;
    // Oldest first, so the first survivor ends it — timestamps are assigned
    // in push order and therefore non-decreasing along the array.
    let dropped = 0;
    while (dropped < this.entries.length && this.entries[dropped]!.entry.timestampMs < cutoff) {
      dropped++;
    }
    if (dropped > 0) this.entries.splice(0, dropped);
  }

  private matches(entry: DeadLetterEntry, filter: DeadLetterFilter): boolean {
    if (filter.sinceMs !== undefined && entry.timestampMs < filter.sinceMs) return false;
    if (filter.untilMs !== undefined && entry.timestampMs > filter.untilMs) return false;
    if (filter.recipient === undefined) return true;
    const wanted = filter.recipient;
    return entry.recipientPath === wanted || entry.recipientPath.startsWith(`${wanted}/`);
  }

  /**
   * Resolve a recorded path back to a live ref.
   *
   * Deliberately a fresh lookup rather than a ref held on the entry: the
   * point of replay is that the recipient has since been restarted or
   * respawned, and a captured ref would address the instance that was
   * already gone when the letter was written.
   */
  private resolve(path: string | null): ActorRef | null {
    if (path === null) return null;
    const segments = parseSelectionPath(this.system, path);
    if (segments === null) return null;
    const refOption = this.system._resolvePath(segments);
    return refOption.isSome() ? refOption.value : null;
  }

  /**
   * `actor_dead_letters_total`, labelled by outcome and recipient path.
   *
   * The path label is precedented by `actor_mailbox_dropped_total` and safe
   * for the same reason: the registry caps series per family and folds the
   * overflow into one, so an unbounded set of recipients costs a bounded
   * number of series (#131, closed).
   */
  private count(outcome: 'captured' | 'replayed' | 'replay-failed', recipientPath: string): void {
    metricsOf(this.system).counter(
      'actor_dead_letters_total',
      { outcome, recipient: recipientPath },
      { help: 'Undeliverable messages captured by the dead-letter queue, by outcome.' },
    ).inc();
  }

  /* ----------------------------- durability ---------------------------- */

  /**
   * Chain one durable write. Fire-and-forget by design: `tell` is
   * synchronous and cannot wait for a journal, so the write is issued and
   * `flush` is what makes it observable.
   */
  private enqueueWrite(record: DeadLetterRecord, stored: StoredEntry | null): void {
    this.writeTail = this.writeTail
      .catch(() => {})
      .then(() => this.write(record, stored));
  }

  private recordRemoval(id: string): void {
    if (this.settings.store !== 'persistent') return;
    this.enqueueWrite({ kind: 'removed', id }, null);
  }

  private async write(record: DeadLetterRecord, stored: StoredEntry | null): Promise<void> {
    if (this.closed) return;
    try {
      const journal = await this.journal();
      const encodable = await this.encodable(record);
      const [written] = await journal.append(
        this.settings.persistenceId,
        [{ event: encodable }],
        this.highestSequenceNr,
      );
      this.highestSequenceNr = written?.sequenceNr ?? this.highestSequenceNr + 1;
      if (stored !== null) stored.sequenceNr = this.highestSequenceNr;
      await this.trim(journal);
    } catch (error) {
      this.system.log.warn(
        `[dead-letters] persisting to '${this.settings.persistenceId}' failed: `
        + `${(error as Error).message}`,
      );
    }
  }

  /**
   * Replace a payload the journal's codec would refuse with its provenance.
   *
   * Probed here rather than at capture time so the in-memory entry keeps the
   * live object — a `memory` queue can hand back a function-carrying message
   * perfectly well, and only the durable copy has to give it up.
   */
  private async encodable(record: DeadLetterRecord): Promise<DeadLetterRecord> {
    if (record.kind !== 'captured') return record;
    const payload = record.entry.payload;
    if (payload.kind !== 'captured') return record;
    const { encodeJsonTree } = await import('../serialization/JsonTree.js');
    try {
      encodeJsonTree(payload.message);
      return record;
    } catch (error) {
      const degraded: DeadLetterPayload = {
        kind: 'degraded',
        className: classNameOf(payload.message),
        reason: (error as Error).message,
      };
      return { kind: 'captured', entry: { ...record.entry, payload: degraded } };
    }
  }

  /**
   * Compact the durable log up to the oldest entry still held.
   *
   * `delete` is prefix-only by contract, which is exactly a ring's
   * eviction — and `highestSeq` keeps reporting the high-water mark
   * afterwards, so the numbering the next `append` expects is unaffected.
   * The bound is the oldest *live* sequence rather than a count, because a
   * `removed` tombstone may sit above entries that are still held and a
   * count-based trim would take them with it.
   */
  private async trim(journal: Journal): Promise<void> {
    const oldestLive = this.entries.find((stored) => stored.sequenceNr !== null)?.sequenceNr
      ?? this.highestSequenceNr + 1;
    const through = oldestLive - 1;
    if (through <= this.compactedThroughSequenceNr) return;
    await journal.delete(this.settings.persistenceId, through);
    this.compactedThroughSequenceNr = through;
  }

  private async restoreOnce(): Promise<void> {
    try {
      const journal = await this.journal();
      this.highestSequenceNr = await journal.highestSeq(this.settings.persistenceId);
      const events = await journal.read<DeadLetterRecord>(this.settings.persistenceId, 1);
      const byId = new Map<string, DeadLetterEntry>();
      for (const event of events) {
        match(event.event)
          .with({ kind: 'captured' }, (record) => this.onCapturedRecord(record, byId))
          .with({ kind: 'removed' }, (record) => this.onRemovedRecord(record, byId))
          .otherwise(() => this.onUnknownRecord());
      }
      // In front of whatever this run already captured: those letters are
      // newer, and the array is ordered oldest-first.
      const restored = [...byId.values()].map((entry): StoredEntry => ({ entry, sequenceNr: null }));
      this.entries.unshift(...restored);
      this.expire();
      while (this.entries.length > this.settings.maxEntries) this.entries.shift();
    } catch (error) {
      this.system.log.warn(
        `[dead-letters] restoring '${this.settings.persistenceId}' failed, starting empty: `
        + `${(error as Error).message}`,
      );
    }
  }

  private onCapturedRecord(record: CapturedRecord, byId: Map<string, DeadLetterEntry>): void {
    byId.set(record.entry.id, record.entry);
  }

  private onRemovedRecord(record: RemovedRecord, byId: Map<string, DeadLetterEntry>): void {
    // A tombstone whose `captured` was already trimmed away names nothing —
    // deleting a missing key is the right no-op, not an inconsistency.
    byId.delete(record.id);
  }

  private onUnknownRecord(): void {
    // A record kind a newer version wrote.  Skipped rather than rejected:
    // losing one dead letter is not worth failing a restore over.
  }

  /**
   * Resolve the journal, lazily.
   *
   * The dynamic import is load-bearing, not stylistic: `ActorSystem`
   * constructs this queue, so a static edge here would put the persistence
   * extension, its plugin registry and the tagged-JSON codec into the static
   * import closure of every program that uses an actor.
   */
  private async journal(): Promise<Journal> {
    const { PersistenceExtensionId } = await import('../persistence/PersistenceExtension.js');
    return this.system.extension(PersistenceExtensionId).journal;
  }
}

/** Best available name for a payload the codec refused. */
function classNameOf(message: unknown): string {
  if (message === null) return 'null';
  if (typeof message !== 'object') return typeof message;
  return (message as object).constructor?.name ?? 'Object';
}
