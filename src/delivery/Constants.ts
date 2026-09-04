/**
 * Tuned values for the reliable-delivery subsystem.
 *
 * None of these is an options default, which is why they are not in an
 * `XOptions.ts`: the two token lengths are security parameters of the
 * protocol, the identifier bound is a wire-input admission limit that is
 * deliberately not configurable — a peer-supplied cap is not a cap — and the
 * dedup-report interval only paces a log line.  The *default* `producerId`
 * is a value `ProducerControllerOptions` documents and a caller can override;
 * how many random characters the framework draws when it has to mint one is
 * not, which is why the size lives here and the drawing lives beside the
 * field that consumes it.
 *
 * The dedup-map bounds a consumer applies to its own heap are the opposite
 * case and live in `ConsumerControllerOptions.ts`: that reasoning is about
 * *wire input*, and a resource budget is the operator's to set.
 */

/**
 * Hex characters in a {@link ProducerController}'s per-incarnation token —
 * 16 characters, so 64 bits of crypto-grade randomness.
 *
 * The token does two jobs and the size is set by the harder one.  For the
 * consumer it only has to distinguish one incarnation of a `producerId` from
 * the next, which a handful of bits would do.  For the producer it has to be
 * *unguessable*, because it is the one field an `Acknowledgment` carries that
 * an arbitrary sender can never derive (#730): `seq` counts up from 1, and
 * `producerId` is unguessable only while the framework is the one minting it
 * — see {@link GENERATED_PRODUCER_ID_LENGTH} — whereas a caller who configures
 * one picks a name.  64 bits is the same order as the ~48 the generated
 * controller names draw (#897) and costs 16 bytes per delivery on the wire.
 */
export const PRODUCER_INCARNATION_LENGTH = 16;

/**
 * Hex characters in the random half of a `producerId` the framework has to
 * mint itself, because the caller left {@link ProducerControllerOptionsType}'s
 * `producerId` unset.
 *
 * This used to be a module counter — `producer-1`, `producer-2`, … — which is
 * wrong twice over.  It is enumerable, and `producerId` is one of the fields
 * an `Acknowledgment` carries, so a counter left a forger with only the
 * incarnation to guess (#730).  That token is still the thing which actually
 * authenticates an ack, and nothing here changes that; drawing the id at
 * random just means a forgery now has to produce two unguessable fields
 * instead of one.  Defence in depth behind the incarnation, not a substitute
 * for it — a `producerId` a caller *configures* stays as guessable as the
 * name they picked.
 *
 * The counter also could not be unique across the boundary that matters.
 * Being module-global it was not even per-`ActorSystem`, and — far worse —
 * two *processes* running the same service each minted `producer-1`.  Two
 * producers under one id reaching one consumer is a correctness bug, not an
 * aesthetic one: the consumer keys dedup on `producerId` and swaps the entry
 * whenever the incarnation changes, so each producer's first delivery resets
 * the other's window and both sides re-handle messages they had already
 * absorbed.  64 bits make that collision negligible with no coordination at
 * all, which is exactly what two independently started processes have.
 */
export const GENERATED_PRODUCER_ID_LENGTH = 16;

/**
 * Longest `producerId` or incarnation token a {@link ConsumerController} will
 * admit, in characters.
 *
 * Both strings arrive from the wire, both are retained per producer, and
 * `producerId` additionally becomes a `Map` key — so an unbounded one is a
 * memory amplifier on a path that has no other bound (#728).  256 is far
 * above anything an identifier needs and far below anything that matters as
 * a per-producer overhead; the framework's own default is
 * {@link PRODUCER_INCARNATION_LENGTH} characters and a hand-picked
 * `producerId` is typically a name like `'orders'`.
 *
 * The same bound is enforced on the *producing* side, by
 * `ProducerControllerOptionsValidator` — a `producerId` the consumer would
 * refuse must fail at construction, not silently dead-letter every delivery.
 */
export const MAX_DELIVERY_IDENTIFIER_LENGTH = 256;

/**
 * Shortest gap, in milliseconds, between two warnings about a
 * {@link ConsumerController} dedup bound being reached — a least-recently-used
 * eviction from the producer map, or a delivery refused because that
 * producer's out-of-order window is full.  Occurrences in between are counted
 * and named by the next line.
 *
 * A warning per occurrence would be the wrong trade in exactly the case the
 * warning exists for.  Neither event happens at all until a bound has been
 * reached, and the way each is reached fastest is a flood — sender-chosen
 * `producerId`s for the eviction, a sequence gap the sender never closes for
 * the refusal — so an unpaced line would turn a bounded heap back into an
 * unbounded log, which is the same exhaustion one layer down (#728).  A
 * minute is short enough that an operator watching a healthy service still
 * sees the first sign of churn promptly, and long enough that a flood costs a
 * handful of lines an hour instead of one per message.
 *
 * One interval, two independent pacers: the controller keeps a timestamp and
 * a pending count per kind, so a flood of one never suppresses the first
 * sighting of the other.
 */
export const DEDUPLICATION_REPORT_INTERVAL_MS = 60_000;
