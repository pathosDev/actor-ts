/**
 * Runtime shape checks for CRDT payloads arriving off the cluster wire.
 *
 * `src/cluster/WireValidation.ts` deliberately forwards frame kinds it does
 * not know, on the stated grounds that "the extension validates its own
 * payload".  DistributedData is named in that list and did not: every
 * `fromJSON` checked `kind` and then trusted the rest, so a gossip frame's
 * contents reached the merge machinery as whatever `JSON.parse` produced.
 *
 * That is a wider hole than the usual `TypeError`-in-a-callback, because a
 * CRDT's whole job is to absorb a peer's state and keep it:
 *
 * - a malformed frame throws inside the DistributedData actor, and twelve of
 *   them exhaust its restart budget and terminate it for good, leaving every
 *   pending promise unsettled (#699);
 * - `GCounter.merge` takes a componentwise maximum, so one bad value pins
 *   another replica's counter at `MAX_SAFE_INTEGER` — or makes `value()`
 *   return a string — with no way back, since max never decreases (#720);
 * - `ORSet` tombstones are honoured on merge, so a peer can pre-tombstone
 *   tags a victim replica has not issued yet and its future adds vanish
 *   silently (#722);
 * - `LWWRegister` resolves by timestamp and, on a tie, by replica id — so a
 *   far-future stamp wedges that register against every honest write,
 *   permanently, and a replica id of the wrong *type* makes the tie-break
 *   answer differently on each side (#724);
 * - a `__proto__` key survives decode but is dropped by every
 *   `Record`-building re-encode, so the entry neither gossips nor persists —
 *   divergence with no error anywhere (#767).
 *
 * The rules are deliberately about *shape and plausibility*, not about
 * whether a peer is allowed to say a thing.  Authority is a separate
 * question, answered by the connection's identity, not by the payload.
 *
 * That split is why the counter rule has two halves.  Shape says a slot is a
 * non-negative integer; plausibility says it is under
 * {@link MAX_COUNTER_SLOT}, which is what stops a peer pinning a slot at a
 * value no honest replica could have counted to.  Neither says the peer had no
 * business writing that slot in the first place — a decoded counter may still
 * advance a slot named after somebody else.  Closing *that* needs a merge that
 * knows which replica it is, and a replica id that survives a restart without
 * being relearned from a peer, which is #955's half of the problem (#720).
 */




import { MAX_COUNTER_SLOT, MAX_CRDT_ENTRIES, MAX_TIMESTAMP_SKEW_MS } from './Constants.js';

/** Thrown when a CRDT payload does not match the shape its `kind` promises. */
export class CrdtDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrdtDecodeError';
  }
}

/** Reject anything that is not a plain, non-null object. */
export function assertPlainObject(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CrdtDecodeError(`${what} must be an object`);
  }
}

/**
 * Own enumerable entries of a decoded map, with `__proto__` rejected.
 *
 * Rejected rather than carried, because carrying it does not work: the entry
 * survives in memory but every `Record`-building re-encode drops it, so the
 * key silently stops gossiping and stops persisting while this replica still
 * believes it holds it (#767).  A loud failure is the only honest option.
 */
export function safeEntries(source: Record<string, unknown>, what: string): [string, unknown][] {
  const entries = Object.entries(source);
  if (entries.length > MAX_CRDT_ENTRIES) {
    throw new CrdtDecodeError(`${what} has ${entries.length} entries, over the ${MAX_CRDT_ENTRIES} limit`);
  }
  for (const [key] of entries) {
    if (key === '__proto__') {
      throw new CrdtDecodeError(`${what} contains a "__proto__" key, which cannot survive re-encoding`);
    }
  }
  return entries;
}

/** A finite number — rejects `NaN`, the infinities, and anything non-numeric. */
export function assertFiniteNumber(value: unknown, what: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CrdtDecodeError(`${what} must be a finite number, got ${describe(value)}`);
  }
}

/**
 * A counter slot: a non-negative integer, at or below {@link MAX_COUNTER_SLOT}.
 *
 * Grow-only counters merge by maximum, so an out-of-range value is not a
 * transient error — it is the new floor for that replica, cluster-wide.
 *
 * The two halves close different things and both are needed.  Safe-integer
 * keeps `value()` returning a number at all, which is what a string slot broke.
 * The ceiling is what keeps a peer from writing a floor no honest replica could
 * have reached: `Number.MAX_SAFE_INTEGER` satisfies every other rule here, so
 * before the ceiling the type check alone left the pinning half of #720 open.
 *
 * Vector-clock entries decode through this too, and want the same bound for
 * the same shape of reason: an entry claiming 2^53 - 1 writes dominates every
 * honest entry in `MVRegister.merge` and is never superseded.
 */
export function assertCounterValue(value: unknown, what: string): asserts value is number {
  assertFiniteNumber(value, what);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CrdtDecodeError(`${what} must be a non-negative safe integer, got ${describe(value)}`);
  }
  if (value > MAX_COUNTER_SLOT) {
    throw new CrdtDecodeError(
      `${what} is ${value}, over the ${MAX_COUNTER_SLOT} plausibility ceiling for a counter slot`,
    );
  }
}

/**
 * A string — a replica id, or anything else the wire declares as one.
 *
 * `ReplicaId` is a bare `type ReplicaId = string`, so nothing at runtime kept
 * a decoder from producing what the local API never can.  It matters wherever
 * the field is *compared* rather than merely carried: `>` between a string and
 * a number is `false` in both directions, which makes a merge that resolves by
 * replica id return each side's own value — the two replicas then never
 * converge (#724).
 */
export function assertString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new CrdtDecodeError(`${what} must be a string, got ${describe(value)}`);
  }
}

/** An array of strings — tags, tombstones, replica ids. */
export function assertStringArray(value: unknown, what: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new CrdtDecodeError(`${what} must be an array, got ${describe(value)}`);
  }
  if (value.length > MAX_CRDT_ENTRIES) {
    throw new CrdtDecodeError(`${what} has ${value.length} entries, over the ${MAX_CRDT_ENTRIES} limit`);
  }
  const bad = value.findIndex((entry) => typeof entry !== 'string');
  if (bad >= 0) {
    throw new CrdtDecodeError(`${what}[${bad}] must be a string, got ${describe(value[bad])}`);
  }
}

/** An array, bounded by {@link MAX_CRDT_ENTRIES} unless a tighter cap is given. */
export function assertBoundedArray(
  value: unknown,
  what: string,
  limit: number = MAX_CRDT_ENTRIES,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new CrdtDecodeError(`${what} must be an array, got ${describe(value)}`);
  }
  if (value.length > limit) {
    throw new CrdtDecodeError(`${what} has ${value.length} entries, over the ${limit} limit`);
  }
}

/**
 * A last-writer-wins timestamp: finite, non-negative, and not implausibly
 * far in the future.  `now` is injectable so the rule can be tested without
 * depending on the wall clock.
 */
export function assertPlausibleTimestamp(
  value: unknown,
  what: string,
  now: number = Date.now(),
): asserts value is number {
  assertFiniteNumber(value, what);
  if (value < 0) {
    throw new CrdtDecodeError(`${what} must not be negative, got ${value}`);
  }
  if (value > now + MAX_TIMESTAMP_SKEW_MS) {
    throw new CrdtDecodeError(
      `${what} is ${value - now}ms in the future, over the ${MAX_TIMESTAMP_SKEW_MS}ms skew allowance`,
    );
  }
}

/** Short, safe rendering of a rejected value for the error message. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  if (typeof value === 'string') return `a string`;
  return String(value);
}
