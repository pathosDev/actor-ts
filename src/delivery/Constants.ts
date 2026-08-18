/**
 * Tuned values for the reliable-delivery subsystem.
 *
 * Neither of these is an options default, which is why they are not in an
 * `XOptions.ts`: the incarnation length is a security parameter of the
 * protocol, and the identifier bound is a wire-input admission limit that is
 * deliberately not configurable — a peer-supplied cap is not a cap.
 */

/**
 * Hex characters in a {@link ProducerController}'s per-incarnation token —
 * 16 characters, so 64 bits of crypto-grade randomness.
 *
 * The token does two jobs and the size is set by the harder one.  For the
 * consumer it only has to distinguish one incarnation of a `producerId` from
 * the next, which a handful of bits would do.  For the producer it has to be
 * *unguessable*, because it is the only thing an `Acknowledgment` carries that
 * an arbitrary sender cannot derive from an enumerable `(producerId, seq)`
 * pair (#730).  64 bits is the same order as the ~48 the generated controller
 * names draw (#897) and costs 16 bytes per delivery on the wire.
 */
export const PRODUCER_INCARNATION_LENGTH = 16;

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
