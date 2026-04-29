import type { ReplicaId } from '../../crdt/Crdt.js';
import type { ReplicatedEventEnvelope } from '../ReplicatedEventSourcedActor.js';
import type { VectorClockData } from './VectorClock.js';

/**
 * Wire shape for a `ReplicatedEventSourcedActor` snapshot.  Persisted
 * to the standard `SnapshotStore` and reloaded on `preStart` so a
 * months-old replica doesn't have to re-fold its entire local journal
 * to rebuild state.
 *
 * Why every field is needed:
 *
 *   - `state` — what `onEvent` has produced; the user-visible result.
 *   - `vc` — the actor's current vector-clock view; required so future
 *     ticks merge correctly with peer envelopes.
 *   - `seenIds` — dedupe set keyed by `(replica, seqAtReplica)`.  After
 *     loading a snapshot we still process the journal's delta, plus
 *     in-flight pubsub deliveries; without seenIds we could double-
 *     apply an event that was on disk AND in flight.
 *   - `events` — canonical sorted history.  Out-of-order remote arrivals
 *     trigger a refold; the refold reads `events`, so we must persist
 *     it.  This is the heaviest field — for a 100k-event actor a
 *     snapshot is 100k envelopes on disk.  Worth it because it
 *     eliminates the recovery-time cost of re-sorting the whole journal.
 *   - `localSeq` — `_localSeq` at snapshot time, so a fresh restart
 *     doesn't issue a `seqAtReplica` that conflicts with previously-
 *     written events.
 *   - `journalSeqAtSnapshot` — the journal's sequence number of the
 *     last event accounted for by `events`.  Recovery reads from
 *     `journalSeqAtSnapshot + 1` — that's where the I/O win comes from.
 */
export interface ReplicatedSnapshot<E, S> {
  readonly state: S;
  readonly vc: VectorClockData;
  readonly seenIds: ReadonlyArray<string>;
  readonly events: ReadonlyArray<ReplicatedEventEnvelope<E>>;
  readonly localSeq: number;
  readonly journalSeqAtSnapshot: number;
  /** Replica that took the snapshot — informational. */
  readonly takenBy: ReplicaId;
  /** Wall-clock time the snapshot was written — informational. */
  readonly takenAt: number;
}
