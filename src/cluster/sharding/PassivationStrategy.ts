import { match } from 'ts-pattern';
import type { EntityAdmissionFilter, EntityReplacementPolicy } from './ShardingOptions.js';

/**
 * Resolved inputs for {@link createPassivationStrategy} — the region's
 * `maxEntities` plus the four `actor-ts.sharding.passivation.*` knobs, already
 * defaulted (#848).
 *
 * A plain config shape rather than an `XOptions.ts` triad on purpose: the
 * public, buildable surface is `ShardingOptions`, and this is the internal
 * argument `ShardRegion.settingsToConfig` derives from it — the same
 * relationship `ShardConfig` has to `ShardingOptionsType`.
 */
export type PassivationStrategyConfig = {
  /** Resident entities the region may hold.  `<= 0` means "no cap". */
  readonly capacity: number;
  readonly replacement: EntityReplacementPolicy;
  readonly segmentedProtectedProportion: number;
  readonly admissionWindowProportion: number;
  readonly admissionFilter: EntityAdmissionFilter;
};

/**
 * Which resident entity a region at capacity gives up, and which newcomers are
 * allowed to displace one (#848).
 *
 * Deliberately knows nothing about actors, shards or the `ActorSystem`: it sees
 * entity ids and nothing else, so it is unit-testable without a cluster and the
 * region keeps every decision that needs an `ActorRef`.  The region also keeps
 * the *idle* policy — `passivation-idle` sweeps on `lastActivity`, which is
 * wall-clock and orthogonal to replacement order.
 *
 * Every method is O(1) amortised.  That is the point of the seam as much as the
 * policies are: the linear scan it replaces walked every resident entity on the
 * first message for each *new* one, which is quadratic exactly at the entity
 * counts a cap exists for.
 */
export interface PassivationStrategy {
  /** Record a hit on an entity that is already resident.  Unknown ids are ignored. */
  touch(entityId: string): void;
  /**
   * Make room for a newly-resident entity and record it.
   *
   * Returns the entity that has to go to keep the count at `capacity`, or
   * `null` when nothing does.  The returned victim is **already removed** from
   * the strategy, so the caller owes it a passivation and nothing else.
   *
   * Never returns `entityId` itself.  The region calls this while creating that
   * entity to deliver a message to it, so refusing it outright is not an option
   * the caller has — see {@link CompositePassivationStrategy} for how the
   * admission filter refuses a candidate without ever refusing the newcomer.
   */
  admit(entityId: string): string | null;
  /** Drop an entity — passivated, stopped, or gone with its shard.  Idempotent. */
  remove(entityId: string): boolean;
  /** Whether the strategy is currently holding `entityId`. */
  has(entityId: string): boolean;
  /** Resident entities the strategy is tracking. */
  readonly size: number;
}

/**
 * Build the strategy for a region, or `null` when `capacity <= 0`.
 *
 * `null` rather than a no-op implementation, and that is a deliberate cost
 * decision rather than a style one: `maxEntities = 0` is the shipped default,
 * so the overwhelmingly common region has no cap at all, and everything here
 * would then be a second index of every resident entity — kept up to date on
 * the routing hot path — bounding nothing.  A `null` check on that path is one
 * branch; a null-object's `touch` is a megamorphic call plus a `Map` rewrite.
 */
export function createPassivationStrategy(
  config: PassivationStrategyConfig,
): PassivationStrategy | null {
  if (config.capacity <= 0) return null;
  return new CompositePassivationStrategy(config);
}

/* -------------------------------------------------------------------------- */
/*                              Frequency sketch                              */
/* -------------------------------------------------------------------------- */

/** Rows of the count-min sketch — four independent estimates, minimum wins. */
const SKETCH_ROWS = 4;

/**
 * Counter ceiling.  Four bits' worth, held in a byte: the sketch answers "is
 * this one hotter than that one", and beyond a couple of dozen accesses the
 * comparison is already decided.  A low ceiling is also what makes the halving
 * reset below cheap and what keeps a burst from pinning an entity forever.
 */
const SKETCH_MAX_COUNT = 15;

/**
 * Accesses per capacity before every counter is halved — the sketch's "aging"
 * period.  Ten is the figure the TinyLFU paper settles on, and the reason there
 * is a period at all: without it a key that was hot an hour ago outranks one
 * that is hot now, which is the exact failure a frequency policy is otherwise
 * prone to.
 */
const SKETCH_SAMPLE_FACTOR = 10;

/** Smallest table width, so a tiny cap still spreads over more than a few cells. */
const SKETCH_MINIMUM_WIDTH = 64;

/**
 * Accesses per capacity before {@link FrequencyRegion} halves every count.  The
 * same period as the sketch's and for the same reason, but a distinct constant:
 * the two age different structures, and binding them would make tuning one
 * silently retune the other.
 */
const FREQUENCY_AGING_FACTOR = 10;

/** One odd mixing constant per row — the "independent hash functions" of a count-min sketch. */
const SKETCH_SEEDS: readonly number[] = [0x7f4a_7c15, 0x9e37_79b9, 0xc2b2_ae35, 0x27d4_eb2f];

/** FNV-1a over the id's UTF-16 code units — total, allocation-free, and stable. */
function baseHash(entityId: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < entityId.length; index++) {
    hash ^= entityId.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

function nextPowerOfTwo(value: number): number {
  let width = SKETCH_MINIMUM_WIDTH;
  while (width < value) width *= 2;
  return width;
}

/**
 * A count-min sketch of how often each entity id has been touched — the
 * *history* an admission filter needs and a cache cannot keep, because the
 * entities it would keep it for are precisely the ones it evicted.
 *
 * Approximate on purpose, and the direction of the error matters: collisions
 * can only make an id look hotter than it is, never colder.  A false positive
 * admits a cold entity that will be evicted again on its own merits; a false
 * negative would evict a genuinely hot one, and there is none by construction.
 *
 * Sized from the entity cap rather than configured. A key an operator cannot
 * reason about is worse than a derived value: the table is
 * `SKETCH_ROWS × nextPowerOfTwo(capacity)` bytes — 512 KB at a cap of 100 000,
 * 4 KB at 1 000 — which is a rounding error beside the entities themselves.
 */
class FrequencySketch {
  private readonly table: Uint8Array;
  private readonly mask: number;
  /** Accesses after which every counter is halved. */
  private readonly sampleSize: number;
  private accesses = 0;

  constructor(capacity: number) {
    const width = nextPowerOfTwo(capacity);
    this.mask = width - 1;
    this.table = new Uint8Array(width * SKETCH_ROWS);
    this.sampleSize = Math.max(1, capacity * SKETCH_SAMPLE_FACTOR);
  }

  /** Count one access to `entityId`. */
  record(entityId: string): void {
    const hash = baseHash(entityId);
    for (let row = 0; row < SKETCH_ROWS; row++) {
      const index = this.cellFor(hash, row);
      if (this.table[index]! < SKETCH_MAX_COUNT) this.table[index]!++;
    }
    if (++this.accesses >= this.sampleSize) this.age();
  }

  /** Estimated access count for `entityId` — never an underestimate. */
  estimate(entityId: string): number {
    const hash = baseHash(entityId);
    let smallest = SKETCH_MAX_COUNT;
    for (let row = 0; row < SKETCH_ROWS; row++) {
      const seen = this.table[this.cellFor(hash, row)]!;
      if (seen < smallest) smallest = seen;
    }
    return smallest;
  }

  private cellFor(hash: number, row: number): number {
    const mixed = Math.imul(hash ^ SKETCH_SEEDS[row]!, 0x2545_f491) >>> 0;
    return row * (this.mask + 1) + ((mixed ^ (mixed >>> 15)) & this.mask);
  }

  /**
   * Halve every counter.  This is what makes the estimate a *recent* frequency
   * rather than a lifetime one, and halving rather than clearing is what keeps
   * a long-standing hot key ahead of a newcomer across the reset.
   */
  private age(): void {
    for (let index = 0; index < this.table.length; index++) this.table[index]! >>= 1;
    this.accesses = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Replacement regions                             */
/* -------------------------------------------------------------------------- */

/**
 * A bounded set of resident entities that can name the one it would give up
 * next.  Internal to this module: the cap arithmetic, the admission window and
 * the filter all live in {@link CompositePassivationStrategy}, so a region only
 * has to answer "who is next" for its own ordering.
 *
 * `add` never evicts.  Keeping the two apart is what lets the composite hold
 * one entity in flight between the window and the main region without either
 * of them briefly believing it is over capacity.
 */
interface ReplacementRegion {
  /** Record a hit on a resident entity.  Unknown ids are ignored. */
  touch(entityId: string): void;
  /** Take `entityId` in.  The caller has already made room. */
  add(entityId: string): void;
  /** Drop `entityId`; `false` when it was not held here. */
  remove(entityId: string): boolean;
  has(entityId: string): boolean;
  /** The entity this region would give up next, or `null` when it holds none. */
  victim(): string | null;
  readonly size: number;
}

/**
 * Plain LRU, and the shipped default — the ordering every release before #848
 * had, with the region's linear scan replaced by an O(1) one.
 *
 * A `Set` is the whole implementation: JavaScript iterates one in insertion
 * order, `delete` + `add` moves an entry to the back, and the first entry the
 * iterator yields is therefore the least recently used.
 */
class RecencyRegion implements ReplacementRegion {
  private readonly order = new Set<string>();

  touch(entityId: string): void {
    if (this.order.delete(entityId)) this.order.add(entityId);
  }

  add(entityId: string): void {
    this.order.delete(entityId);
    this.order.add(entityId);
  }

  remove(entityId: string): boolean { return this.order.delete(entityId); }

  has(entityId: string): boolean { return this.order.has(entityId); }

  victim(): string | null { return this.order.values().next().value ?? null; }

  get size(): number { return this.order.size; }
}

/**
 * Segmented LRU — a *probationary* segment for entities seen once and a
 * *protected* one for entities seen again, with eviction taken from probation
 * first.
 *
 * This is the policy the issue exists for.  Under plain LRU a scan over cold
 * ids evicts the hot set one entity at a time, because "least recently used"
 * cannot tell "touched once, ever" from "touched constantly until a moment
 * ago".  Segmenting can: a cold id that is never touched twice never leaves
 * probation, so it can only ever displace another cold id.
 *
 * The protected segment is bounded, and demotion rather than eviction is what
 * bounds it: an entry pushed out of protected returns to probation as its most
 * recently used entry, so it survives one more pass of the scan and is then
 * judged like anything else.  Evicting on the same event would make a busy
 * period in one part of the key space discard the rest of it outright.
 */
class SegmentedRecencyRegion implements ReplacementRegion {
  private readonly probation = new RecencyRegion();
  private readonly protectedEntities = new RecencyRegion();

  constructor(private readonly protectedCapacity: number) {}

  touch(entityId: string): void {
    if (this.protectedEntities.has(entityId)) {
      this.protectedEntities.touch(entityId);
      return;
    }
    // A second access is what earns promotion; the first one only got the
    // entity into probation.
    if (!this.probation.remove(entityId)) return;
    this.protectedEntities.add(entityId);
    this.demoteOverflow();
  }

  add(entityId: string): void { this.probation.add(entityId); }

  remove(entityId: string): boolean {
    return this.probation.remove(entityId) || this.protectedEntities.remove(entityId);
  }

  has(entityId: string): boolean {
    return this.probation.has(entityId) || this.protectedEntities.has(entityId);
  }

  /**
   * Probation first, and only then protected.  Falling through matters at the
   * edges: a protected segment configured as the whole region leaves probation
   * permanently empty, and a `victim()` that stopped at `null` there would
   * report a full region as having nobody to give up.
   */
  victim(): string | null {
    return this.probation.victim() ?? this.protectedEntities.victim();
  }

  get size(): number { return this.probation.size + this.protectedEntities.size; }

  private demoteOverflow(): void {
    while (this.protectedEntities.size > this.protectedCapacity) {
      const demoted = this.protectedEntities.victim();
      if (demoted === null) return;
      this.protectedEntities.remove(demoted);
      this.probation.add(demoted);
    }
  }
}

/**
 * Least-frequently-used with aging — evicts the entity accessed fewest times,
 * with every counter halved periodically so the ranking reflects recent
 * traffic rather than a lifetime total.
 *
 * The aging is not optional and it is why this is not plain LFU.  Without it
 * an entity that was hammered during a start-up burst outranks one that is
 * being used right now, forever, and the cache converges on whatever the
 * workload looked like when it was cold.
 *
 * Counts live in frequency buckets rather than being sorted, so `touch` and
 * `add` are O(1); `victim()` walks up from the lowest known count, which is
 * amortised O(1) because every step it takes raises the floor for the next
 * call.  The halving pass is O(n) once every `capacity × SKETCH_SAMPLE_FACTOR`
 * accesses, i.e. O(1) amortised per access.
 */
class FrequencyRegion implements ReplacementRegion {
  private readonly counts = new Map<string, number>();
  private readonly buckets = new Map<number, Set<string>>();
  private lowestCount = 0;
  private highestCount = 0;
  private accesses = 0;

  constructor(private readonly agingPeriod: number) {}

  touch(entityId: string): void {
    const count = this.counts.get(entityId);
    if (count === undefined) return;
    this.moveBucket(entityId, count, count + 1);
    this.afterAccess();
  }

  add(entityId: string): void {
    if (this.counts.has(entityId)) { this.touch(entityId); return; }
    this.counts.set(entityId, 1);
    this.bucketFor(1).add(entityId);
    this.lowestCount = 1;
    if (this.highestCount < 1) this.highestCount = 1;
    this.afterAccess();
  }

  remove(entityId: string): boolean {
    const count = this.counts.get(entityId);
    if (count === undefined) return false;
    this.counts.delete(entityId);
    this.buckets.get(count)?.delete(entityId);
    return true;
  }

  has(entityId: string): boolean { return this.counts.has(entityId); }

  victim(): string | null {
    if (this.counts.size === 0) return null;
    for (let count = this.lowestCount; count <= this.highestCount; count++) {
      const bucket = this.buckets.get(count);
      const candidate = bucket?.values().next().value;
      if (candidate !== undefined) {
        this.lowestCount = count;
        return candidate;
      }
    }
    // Unreachable while the bookkeeping holds, and cheap insurance if it ever
    // does not: a strategy that answered `null` for a full region would stop
    // enforcing the cap silently, which is the one failure worth a linear scan.
    const repaired = this.counts.keys().next().value ?? null;
    if (repaired !== null) this.lowestCount = this.counts.get(repaired)!;
    return repaired;
  }

  get size(): number { return this.counts.size; }

  private bucketFor(count: number): Set<string> {
    let bucket = this.buckets.get(count);
    if (!bucket) { bucket = new Set(); this.buckets.set(count, bucket); }
    return bucket;
  }

  private moveBucket(entityId: string, from: number, to: number): void {
    const source = this.buckets.get(from);
    source?.delete(entityId);
    this.counts.set(entityId, to);
    this.bucketFor(to).add(entityId);
    if (this.highestCount < to) this.highestCount = to;
    // `to` is always `from + 1`, so emptying the lowest bucket raises the floor
    // by exactly one — the standard O(1) LFU invariant.
    if (from === this.lowestCount && (source?.size ?? 0) === 0) this.lowestCount = to;
  }

  private afterAccess(): void {
    if (++this.accesses < this.agingPeriod) return;
    this.age();
  }

  private age(): void {
    this.buckets.clear();
    this.lowestCount = Number.POSITIVE_INFINITY;
    this.highestCount = 0;
    for (const [entityId, count] of this.counts) {
      // Floored at one: a count of zero would make an entity indistinguishable
      // from one that has never been seen, and every entry here has been.
      const halved = Math.max(1, count >> 1);
      this.counts.set(entityId, halved);
      this.bucketFor(halved).add(entityId);
      if (halved < this.lowestCount) this.lowestCount = halved;
      if (halved > this.highestCount) this.highestCount = halved;
    }
    if (this.counts.size === 0) { this.lowestCount = 0; this.highestCount = 0; }
    this.accesses = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Composite                                  */
/* -------------------------------------------------------------------------- */

/**
 * The strategy the region actually holds: an optional admission *window* in
 * front of a main replacement region, with an optional frequency filter
 * deciding which of the two candidates at that seam survives.
 *
 * The window is the part that makes an admission filter expressible at all.  A
 * region cannot refuse the entity a message has just arrived for — it is being
 * created to receive that message — so the filter cannot sit on the newcomer.
 * With a window it does not have to: the newcomer enters the window, and the
 * *candidate* judged against the main region's victim is whatever fell out of
 * the window's far end, which is an entity that arrived some time ago and can
 * be passivated like any other.
 *
 * Hence the constructor's guard and `ShardingOptionsValidator`'s matching
 * cross-field rule: `frequency-sketch` without a window has nothing to filter,
 * and silently degrading to no filter at all would be a config that reads as
 * armed and is not.
 */
class CompositePassivationStrategy implements PassivationStrategy {
  private readonly window: RecencyRegion | null;
  private readonly windowCapacity: number;
  private readonly main: ReplacementRegion;
  private readonly mainCapacity: number;
  private readonly sketch: FrequencySketch | null;

  constructor(config: PassivationStrategyConfig) {
    // At least one slot each, whatever the proportion rounds to: a window of
    // zero is "no window", which is a different configuration and is spelled
    // `admission-window-proportion = 0`.
    this.windowCapacity = config.admissionWindowProportion > 0
      ? Math.min(config.capacity - 1, Math.max(1, Math.floor(config.capacity * config.admissionWindowProportion)))
      : 0;
    this.window = this.windowCapacity > 0 ? new RecencyRegion() : null;
    this.mainCapacity = Math.max(1, config.capacity - this.windowCapacity);
    this.main = buildMainRegion(config, this.mainCapacity);
    this.sketch = config.admissionFilter === 'frequency-sketch' && this.window !== null
      ? new FrequencySketch(config.capacity)
      : null;
  }

  touch(entityId: string): void {
    this.sketch?.record(entityId);
    if ((this.window?.has(entityId) ?? false)) { this.window!.touch(entityId); return; }
    this.main.touch(entityId);
  }

  admit(entityId: string): string | null {
    // Defensive rather than expected: the region only admits an entity it has
    // no bookkeeping for.  Treating a re-admission as a hit keeps the strategy
    // from holding two orderings for one entity if that ever stops being true —
    // and delegating rather than recording first is what keeps the access from
    // being counted twice in the sketch.
    if (this.has(entityId)) { this.touch(entityId); return null; }
    this.sketch?.record(entityId);

    if (this.window === null) return this.promote(entityId, false);

    this.window.add(entityId);
    if (this.window.size <= this.windowCapacity) return null;
    // The window is over its bound, so its least recently used entry leaves it
    // — never `entityId`, which was just added as the most recent.
    const candidate = this.window.victim()!;
    this.window.remove(candidate);
    return this.promote(candidate, true);
  }

  remove(entityId: string): boolean {
    return (this.window?.remove(entityId) ?? false) || this.main.remove(entityId);
  }

  has(entityId: string): boolean {
    return (this.window?.has(entityId) ?? false) || this.main.has(entityId);
  }

  get size(): number { return (this.window?.size ?? 0) + this.main.size; }

  /**
   * Move `candidate` into the main region, evicting whichever of it and the
   * incumbent victim the filter rules against.
   *
   * `fromWindow` is what makes refusing the candidate legal: only an entity
   * that has already spent time in the window may be turned away here, because
   * only that one is not the entity a message is waiting on.
   */
  private promote(candidate: string, fromWindow: boolean): string | null {
    if (this.main.size < this.mainCapacity) { this.main.add(candidate); return null; }
    const victim = this.main.victim();
    if (victim === null) { this.main.add(candidate); return null; }
    if (this.sketch !== null && fromWindow
      && this.sketch.estimate(candidate) <= this.sketch.estimate(victim)) {
      // The incumbent has been used at least as often, so the candidate is the
      // one that goes.  Ties go to the incumbent deliberately: a scan produces
      // an unbounded supply of ids tied at one access, and letting each of them
      // displace a resident entity is exactly the thrash the filter exists to
      // stop.
      return candidate;
    }
    this.main.remove(victim);
    this.main.add(candidate);
    return victim;
  }
}

/**
 * The main region for a configured policy.  Inline arms rather than `onXxx`
 * delegations: this is a match that *computes a value* from configuration in a
 * helper, which is the case AGENTS.md exempts — nothing is being dispatched.
 *
 * The protected segment is floored at one and capped one below the main region
 * so that both segments always exist.  An empty probation makes every newcomer
 * evict a protected entry on arrival, and an empty protected segment makes the
 * policy plain LRU wearing a longer name — either way the configuration would
 * read as segmented and behave as something else.
 */
function buildMainRegion(
  config: PassivationStrategyConfig,
  mainCapacity: number,
): ReplacementRegion {
  return match(config.replacement)
    .with('segmented-least-recently-used', () => new SegmentedRecencyRegion(Math.min(
      mainCapacity - 1,
      Math.max(1, Math.round(mainCapacity * config.segmentedProtectedProportion)),
    )) as ReplacementRegion)
    .with('least-frequently-used', () => new FrequencyRegion(
      Math.max(1, config.capacity * FREQUENCY_AGING_FACTOR),
    ) as ReplacementRegion)
    .with('least-recently-used', () => new RecencyRegion() as ReplacementRegion)
    .exhaustive();
}
