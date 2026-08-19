/**
 * Carrying a singleton's in-memory state across a change of host, so the
 * incoming instance starts warm instead of recovering from scratch (#194).
 *
 * A singleton with expensive recovery — thousands of events to replay, a large
 * read-through cache — is unavailable for as long as that recovery takes every
 * time it moves, and it moves on any routine scale-up.  The outgoing instance
 * already holds the answer; the hand-over #949 introduced already has a moment
 * at which that answer is final and a frame going the right way.  This is the
 * state riding along on it.
 *
 * **Opt-in on the actor, not on the options.**  The two hooks are the whole
 * API: an actor that implements them gets warm hand-over, an actor that does
 * not is untouched, and no type parameter has to be threaded through
 * `SingletonKey`, four `start` overloads, both options types and two barrels to
 * name a state shape the framework never inspects.  The singleton API is
 * generic in its *command* type because callers send commands; nobody sends a
 * state, so making it generic in one buys type safety at the call site for a
 * value that only ever travels between two implementations of the same class.
 *
 * **Best-effort by construction.**  Every failure — no hooks on the actor, an
 * oversized snapshot, a serializer that throws, a peer that never answered, a
 * forced downing — falls back to exactly today's cold start.  Warm hand-over is
 * an optimisation, and one that is allowed to not happen; a singleton whose
 * correctness depended on the state arriving would be a singleton that cannot
 * survive the loss of its host, which is the situation it exists to survive.
 */

/**
 * Implemented by a singleton actor that can hand its state to its successor.
 *
 * ```ts
 * class PriceCacheActor extends Actor<PriceCommand> implements WarmHandOverActor {
 *   static readonly singleton = SingletonKey.of<PriceCommand>('price-cache');
 *   private prices = new Map<string, number>();
 *
 *   override async preStart(): Promise<void> {
 *     // Skipped entirely when a predecessor handed its cache over.
 *     if (this.prices.size === 0) await this.loadEveryPrice();
 *   }
 *
 *   serializeForHandOver(): Uint8Array {
 *     return new TextEncoder().encode(JSON.stringify([...this.prices]));
 *   }
 *
 *   restoreFromHandOver(state: Uint8Array): void {
 *     this.prices = new Map(JSON.parse(new TextDecoder().decode(state)));
 *   }
 * }
 * ```
 *
 * The example shows the one thing an implementation has to get right, and it is
 * not the codec: `preStart` must ask whether it already has state.  The restore
 * runs **before** `preStart`, so a `preStart` that recovers unconditionally
 * pays the cost the feature exists to avoid and then overwrites what arrived.
 */
export interface WarmHandOverActor {
  /**
   * A snapshot of everything the successor should start with, or `null` to
   * decline this hand-over and let the successor start cold.
   *
   * Called **once, after `postStop` has completed** on the outgoing instance —
   * so the state is final: no further message will be processed, and anything
   * still in the mailbox has already gone to dead letters rather than into this
   * snapshot.  Called only for a *planned* stand-down.  An instance that died
   * to a crash or an exhausted supervision budget is never asked, because the
   * state that survives such a death is the state that caused it.
   *
   * A throw is caught and treated as `null`.
   */
  serializeForHandOver(): Uint8Array | null;

  /**
   * Adopt a predecessor's snapshot.
   *
   * Called **after the constructor and before `preStart`**, on the incoming
   * host, and only when a snapshot actually arrived.  That position is the
   * point of the feature: it is the only moment at which `preStart` can still
   * decide to skip its recovery.
   *
   * Bytes from another node.  Validate them — a hand-over frame reaches this
   * method only from a socket-authenticated peer that this node itself asked to
   * stand down, but the cluster wire carries no credential (#964), so the
   * authenticated peer is the *transport's* identity and not a claim about the
   * payload's shape.  Treat a version skew between the two nodes' code as the
   * ordinary case: two releases of the same actor is exactly what a rolling
   * upgrade is, and it is also exactly when a singleton moves.
   *
   * A throw is caught and logged, and the instance continues as if it had
   * started cold.  It is **not** re-constructed, so an implementation that
   * mutates as it parses can leave itself half-populated: validate first, then
   * assign, or make the assignment the last statement.
   */
  restoreFromHandOver(state: Uint8Array): void;
}

/**
 * `actor` as a {@link WarmHandOverActor}, or `null` when it does not implement
 * the hooks.
 *
 * Both methods are required together.  Half an implementation is a mistake
 * rather than a partial feature — serializing without restoring ships bytes
 * nothing reads, and restoring without serializing waits for bytes that never
 * come — and answering `null` for it means the caller logs one clear line
 * instead of failing on a missing method at the worst moment.
 *
 * `unknown` rather than `Actor<…>`, because that is what a feature test takes:
 * an `Actor<T>` is not assignable to an `Actor<never>` (its `onReceive` is
 * contravariant in `T`), so a parameter naming the base class would force every
 * caller to cast past the very variance the cast would be hiding.  Nothing here
 * reads the actor *as* an actor.
 */
export function asWarmHandOverActor(actor: unknown): WarmHandOverActor | null {
  if (actor === null || typeof actor !== 'object') return null;
  const candidate = actor as Partial<WarmHandOverActor>;
  if (typeof candidate.serializeForHandOver !== 'function') return null;
  if (typeof candidate.restoreFromHandOver !== 'function') return null;
  return candidate as WarmHandOverActor;
}

/**
 * What one base64 character costs per source byte, and the reason the wire
 * budget is not the frame cap.
 *
 * A cluster frame is `JSON.stringify(encodeJsonTree(message))` (`Protocol.ts`),
 * and `JsonTree` encodes a `Uint8Array` as **base64** under its `__bytes__`
 * tag — four characters per three bytes, rounded up to the next quantum.  So a
 * snapshot occupies about a third more on the wire than in memory, and a
 * `maxStateBytes` set to the frame cap produces a frame a third over it.
 *
 * That is not a rejected message.  The cap is enforced by the *receiver's*
 * `FrameDecoder`, which throws, and `Transport` answers a throw by dropping the
 * connection — taking heartbeats, gossip and every other cross-node `tell` with
 * it.  Nothing on the send side checks, so the sender would kill the link once
 * per attempt and never learn that it had.  Hence the budget below, checked
 * before the frame is built.
 *
 * Here rather than in `cluster/Constants.ts`, deliberately: this is not a tuned
 * value that a second file reads, it is the arithmetic of
 * {@link handOverStateFitsFrame} written down — the ratio of a codec chosen
 * elsewhere, and an allowance that means nothing away from the function that
 * spends it.  Neither is exported, and moving them would separate a formula
 * from its own two terms.
 */
const BASE64_CHARACTERS_PER_BYTE = 4 / 3;

/**
 * Bytes reserved for everything in the frame that is not the snapshot: the
 * 4-byte length header, the JSON scaffolding of the envelope and the
 * `__bytes__` wrapper, the manager path, the type name.  A kilobyte is orders
 * of magnitude more than those need, and the point is to be safely wrong rather
 * than exactly right — the failure mode on the other side of this number is a
 * dropped inter-node connection.
 */
const HAND_OVER_FRAME_RESERVE_BYTES = 1_024;

/**
 * Whether a snapshot of `byteLength` bytes fits a frame cap of
 * `maxFrameBytes`, once base64 inflation and envelope overhead are paid.
 *
 * `undefined` means the transport does not frame at all — `InMemoryTransport`,
 * `MessageChannelTransport` and `MultiNodeTransport` hand the message object
 * to the peer, so there is no length prefix to overflow and no honest number to
 * check against.  Those answer `true`: the configured
 * `maxHandOverStateBytes` is then the only bound, which is the truth rather
 * than a guess dressed up as a limit.
 */
export function handOverStateFitsFrame(
  byteLength: number,
  maxFrameBytes: number | undefined,
): boolean {
  if (maxFrameBytes === undefined) return true;
  const onTheWire = Math.ceil(byteLength * BASE64_CHARACTERS_PER_BYTE);
  return onTheWire + HAND_OVER_FRAME_RESERVE_BYTES <= maxFrameBytes;
}
