/**
 * Tuned values shared across the CRDT subsystem.
 *
 * These are the decode-side bounds that make merging peer-supplied state
 * safe.  They are caps rather than format definitions — the CRDT tag
 * vocabulary stays in the codecs — so they collect here, one directory from
 * the validators that enforce them, with their measurements intact.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * Ceiling on how many entries a decoded collection may carry.
 *
 * It exists because several merges are quadratic in the entry count by
 * nature — `MVRegister.merge` compares every entry against every other to
 * find the causally maximal ones, and no algorithm avoids that for an
 * arbitrary partial order.  Bounded, a quadratic scan is a non-event;
 * unbounded, one sub-500 KiB frame freezes the event loop for tens of
 * seconds and the state is then *kept*, so every later merge is slower than
 * the last (#698).
 *
 * Set far above any legitimate value: concurrent entries in a register are
 * bounded by the number of replicas writing without having seen each other,
 * and a cluster large enough to exceed this has a different problem.
 */
export const MAX_CRDT_ENTRIES = 4_096;

/**
 * Plausibility ceiling on one decoded counter slot.
 *
 * `GCounter.merge` takes a componentwise maximum, so a slot is a *floor* that
 * no honest operation can lower: whatever a peer writes into a replica's slot
 * is that replica's contribution cluster-wide for as long as the key exists,
 * and it is written through to the durable record (#720).  "A non-negative
 * safe integer" was never a bound on that — `Number.MAX_SAFE_INTEGER` is one,
 * and it is precisely the value the attack writes.
 *
 * The number is *derived* rather than picked, because the framework has no
 * unit to reason about: it cannot know whether a counter holds page views or
 * bytes, so "implausibly large for this counter" is not a question it can
 * answer.  What it can answer is where its own arithmetic stops being exact.
 * `GCounter.value()` sums the slots and the decoder admits at most
 * {@link MAX_CRDT_ENTRIES} of them, so this is the largest per-slot ceiling
 * for which a fully saturated decoded counter still sums exactly — 4 096 slots
 * at 2^41 - 1 total 9007199254736896, inside `Number.MAX_SAFE_INTEGER`.  A
 * slot above it claims a contribution the aggregate could not have
 * represented anyway.
 *
 * Deliberately *not* configurable, and that is the substantive decision here
 * rather than an omission.  Raising it is configuring `value()` into silent
 * lossiness, which is the failure this bound exists to prevent; and an
 * application counting past 2.2e12 on a single replica has outgrown a float64
 * sum, not this constant.  The fix on that side is a coarser unit — kibibytes
 * rather than bytes — which shrinks the wire payload too.
 */
export const MAX_COUNTER_SLOT = Math.floor(Number.MAX_SAFE_INTEGER / MAX_CRDT_ENTRIES);

/**
 * Tighter ceiling for a multi-value register's concurrent entries.
 *
 * Separate from {@link MAX_CRDT_ENTRIES} because the two bound different
 * things.  A set or a counter map legitimately holds thousands of entries and
 * merges them linearly.  An `MVRegister` entry is a *concurrent write that
 * has not been superseded*, so the honest bound is the number of replicas
 * writing without having seen each other — a handful, in any cluster this
 * framework targets.
 *
 * The quadratic scan is what makes the difference matter.  Measured on Bun
 * against the shipped code, an all-concurrent merge costs ~161 ms at 800
 * entries, so a 4096 cap would still leave ~4 s of blocked event loop
 * reachable from one frame.  At 256 the worst case — merging two full
 * registers, nothing dominating anything — is ~53 ms.  A cap that merely
 * turns a 33-second freeze into a 4-second one is not a fix.
 */
export const MAX_MV_REGISTER_ENTRIES = 256;

/**
 * How far ahead of local time a peer-supplied timestamp may be.
 *
 * Last-writer-wins is only as sound as the clocks feeding it.  A register
 * carrying a year-3000 stamp wins against every honest write forever, and
 * because the value is also re-gossiped the whole cluster converges on the
 * wedge.  The bound mirrors the cluster's own `maxVersionSkewMs` rule for
 * membership versions — the same five minutes, for the same reason: generous
 * enough for real clock drift, finite enough that "forever" is off the table.
 */
export const MAX_TIMESTAMP_SKEW_MS = 5 * 60_000;

/**
 * Ceiling on nested `ORMap` levels.
 *
 * `decodeCrdt` recurses once per level, so without a bound a few MiB of
 * nested map headers exhausts the JS stack — inside the DistributedData
 * actor, from a single gossip frame (#721).  Real data is shallow; anything
 * approaching this is malformed or hostile.
 */
export const MAX_CRDT_NESTING_DEPTH = 32;

/**
 * Quiet period between two "this key could not be gossiped" warnings.
 *
 * The condition is discovered on the gossip timer, so it recurs at
 * `gossip-interval` — once a second by default — for as long as the key
 * exists, which is indefinitely: an oversized value is not transient the way
 * an undecodable frame is, and nothing prunes it.  Logged per occurrence it
 * would be a line a second per key forever, which reliably ends with the
 * category filtered out and the one condition that needs an operator lost with
 * it.
 *
 * A minute is picked to be legible in the two places this actually gets read:
 * it survives log sampling at any realistic rate, and it is short enough that
 * the line is still in the window an operator opens after noticing a key stuck
 * stale.  The warning carries a running total, so a rate that under-reports
 * episodes cannot under-report their number.
 *
 * Not an option: it tunes a log, and every skip is already counted in
 * `distributed_data_gossip_skipped_keys_total` for anyone who needs the exact
 * series.
 */
export const GOSSIP_SKIP_WARN_INTERVAL_MS = 60_000;

/**
 * Random hex characters in a tag suffix — 96 bits.
 *
 * A tag used to be `${replica}#${seq}` off a monotonic counter, and the
 * counter travelled in the payload.  Tombstones veto by tag on merge and are
 * never pruned, so a peer that could *predict* a tag could tombstone one the
 * victim had not issued yet: the victim's next adds then vanished on the very
 * next merge, silently, with no API to undo a tombstone (#722).  Guessing a
 * tag is the whole attack, which is why this draws from `crypto` — the same
 * conclusion #120 reached for `ClusterClient` ask ids and #896 for quorum
 * correlation ids.
 *
 * Longer than the 12–16 characters those two use, because the uniqueness that
 * has to hold is different: an ask id only has to be distinct among the
 * requests in flight, whereas a tag is compared against every tag its replica
 * has ever minted for the element and against tombstones that outlive them
 * all.  At 96 bits a replica making 10^9 adds has a collision chance around
 * 6e-12 — below the rate at which the hardware underneath miscounts.
 */
export const TAG_ENTROPY_CHARACTERS = 24;
