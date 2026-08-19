import type { NodeAddress } from '../NodeAddress.js';

/**
 * The cross-node exchange that makes "at most one live singleton" a *cluster*
 * property instead of a per-node one (#949).
 *
 * Every node computes the host from its own gossip view, so a routine
 * scale-up has the incoming host promoting itself — off its own `SelfUp`,
 * before any peer has been told anything — while the incumbent is still
 * draining the instance it was asked to stop.  Nothing on that path consulted
 * another node, so the overlap was bounded by nothing but luck.
 *
 * Two messages, modelled on the working precedent one directory over
 * (`sharding.BeginHandOff` / `BeginHandOffAcknowledgment`, see
 * {@link ../sharding/ShardingProtocol.ts}), including the namespaced
 * discriminant: the singleton manager's path also carries user payloads, so a
 * bare `kind: 'HandOverRequest'` would be indistinguishable from an
 * application message that happened to use the same word.
 *
 * They ride inside `EnvelopeMessage.body` at the manager's well-known path —
 * no wire-schema change, because the envelope's body is already free-form.
 */

/**
 * *"I am taking over hosting; stop yours and tell me when it is gone."*
 *
 * Sent by the incoming host to **every** peer that its own view says is
 * eligible to host — not to a single remembered predecessor.  A remembered
 * one has no addressee at all on a node that has just joined, and a stale one
 * is exactly the case this protocol exists for.  The eligible set is the set
 * of nodes running a manager (the docs require `start()` on every node that
 * may become the host), and the previous host is by definition its first
 * member, so asking all of them cannot miss it.
 */
export type SingletonHandOverRequest = {
  readonly kind: 'singleton.HandOverRequest';
  /**
   * Which singleton, even though the manager path already says so.  A
   * mismatch means the per-path handler and the manager have drifted, which
   * is worth a warning rather than a silently mis-applied stop.
   */
  readonly typeName: string;
};

/**
 * *"I am not running an instance of that singleton."*
 *
 * Sent once the answering node holds no child **and** no child of its own is
 * mid-stop — so it is a statement about a completed `postStop`, not about a
 * `PoisonPill` having been enqueued.  There is no negative counterpart on
 * purpose: see {@link SingletonMessage}.
 */
export type SingletonHandOverAcknowledgment = {
  readonly kind: 'singleton.HandOverAcknowledgment';
  readonly typeName: string;
  /**
   * The stopped instance's state, when it offered one — see
   * {@link ../WarmHandOver.ts} (#194).
   *
   * It rides *here* rather than on a message of its own because this frame is
   * already sent at the only instant the state is final: the answering node
   * emits it once its instance's `postStop` has completed, so there is no
   * further message to fold in and no second round trip to sequence against.
   * A separate `HandOverState` frame would have to be ordered against this one
   * anyway, and `_sendEnvelope` is fire-and-forget — two frames is two chances
   * to arrive in the wrong order or not at all.
   *
   * Optional in the strong sense: absent whenever the actor does not implement
   * the hooks, declined the snapshot, died unexpectedly, or produced one too
   * large for the frame.  Every one of those falls back to a cold start, so a
   * receiver treats "no state" as the ordinary case and never as an error.
   */
  readonly state?: Uint8Array;
};

/**
 * Everything the singleton managers say to each other.
 *
 * **There is deliberately no refusal message.** A node that declines a
 * hand-over — because it believes it is the host and the requester does not
 * out-rank it — stays silent, and the requester falls through to its
 * `handOverTimeoutMs` and hosts anyway with a warning.  An explicit refusal
 * would let the requester back off instead, which is the better answer when
 * the refusal is honest; but the cluster wire carries no credential (#964), so
 * it would also let one hostile member keep the singleton hosted *nowhere*
 * indefinitely by refusing every request.  A forced spawn after a bounded wait
 * is recoverable and loud; permanent unavailability from one frame is neither.
 */
export type SingletonMessage = SingletonHandOverRequest | SingletonHandOverAcknowledgment;

/** Every `kind` in {@link SingletonMessage}, for the inbound-body guard. */
const SINGLETON_MESSAGE_KINDS: ReadonlySet<string> = new Set<SingletonMessage['kind']>([
  'singleton.HandOverRequest',
  'singleton.HandOverAcknowledgment',
]);

/**
 * Whether an inbound envelope body is one of ours rather than a user payload.
 *
 * Exact kinds rather than a `singleton.` prefix test: the prefix would hand a
 * version-skewed peer's unknown kind to the manager's matcher, and the whole
 * point of the namespace is that an application message cannot land in it by
 * accident.  A future kind is better refused here than dispatched as one of
 * the two that exist.
 */
export function isSingletonMessage(body: unknown): body is SingletonMessage {
  if (typeof body !== 'object' || body === null) return false;
  const { kind, typeName, state } = body as {
    kind?: unknown;
    typeName?: unknown;
    state?: unknown;
  };
  if (typeof kind !== 'string' || !SINGLETON_MESSAGE_KINDS.has(kind)) return false;
  if (typeof typeName !== 'string') return false;
  // The warm-hand-over payload, checked here rather than trusted downstream: it
  // is the one field of this protocol that reaches *user* code, so the shape
  // guard in front of it is the difference between "bytes from a peer" and
  // "whatever a peer put in a JSON object" (#194).  Absent is the ordinary
  // case; present-but-not-bytes is a peer to disbelieve entirely, not a frame
  // to strip a field off — a body this wrong is not one to act on.
  if (state !== undefined && !(state instanceof Uint8Array)) return false;
  return true;
}

/**
 * A hand-over frame together with the peer whose connection it arrived on.
 *
 * **Deliberately a class, not a `{ kind }` tag** — the same reasoning as
 * `AuthenticatedShardingMessage` (#584, #712).  A wire body is always plain
 * JSON, so a class instance is a shape the wire cannot mint: `instanceof` is
 * therefore proof the frame came through `Cluster._registerEnvelopeHandler`,
 * which is the only place the socket-authenticated `NodeAddress` exists.  A
 * tagged object would not be — `singleton-deliver` is exactly that shape, and
 * any peer can reproduce it verbatim inside a user payload.
 *
 * It also survives the generic-path-resolution route through
 * `Cluster.dispatchEnvelope`: a frame whose `to` misses the per-path handler
 * still reaches the manager's mailbox, unwrapped — and therefore unauthorised,
 * which is the correct outcome for a directive about who hosts.
 */
export class AuthenticatedSingletonMessage {
  constructor(
    /** Connection-authenticated sender.  Never a value out of the payload. */
    readonly peer: NodeAddress,
    readonly message: SingletonMessage,
  ) {}
}
