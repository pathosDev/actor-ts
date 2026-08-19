/**
 * Tuned values shared across the cluster subsystem.
 *
 * A constant lives here when it is a cap, bound, timeout or cadence that
 * more than one cluster file reads — not when it is the built-in default of
 * a single options type (that belongs in the matching `XOptions.ts`), and
 * not when it is part of the wire format defined beside it (`Protocol.ts`'s
 * `HEADER_SIZE`, `WireValidation.ts`'s codepoints).
 *
 * The case this module exists for is the one `XOptions.ts` cannot express:
 * a default shared by *two* options types.  Co-location would put it in
 * both, which is the duplication it is supposed to prevent.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * How often the cluster sends heartbeats, in milliseconds.
 *
 * The cadence belongs to the cluster's heartbeat loop, not to the detection
 * algorithm: `Cluster` schedules both its heartbeat tick and its detection
 * tick from whichever detector is installed (`failureDetector.interval`).
 * So swapping `FailureDetector` for `PhiAccrualFailureDetector` without
 * naming options must not silently change how often the node talks to its
 * peers — which is exactly what two independent copies of this number
 * allowed.
 *
 * Mirrored by `actor-ts.cluster.failure-detector.heartbeat-interval` in
 * `reference.conf`, which is pinned to the simple detector's defaults by
 * `ClusterConfigDefaults.test.ts`.  The φ-accrual detector has no config
 * block at all, so its copy was pinned to nothing.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 500;

/**
 * Maximum allowed deviation between a peer-supplied **wall-clock stamp** and
 * the local clock — 1 day.  Anything above is rejected as a corrupted or
 * forged frame.
 *
 * It guards the two fields that are timestamps rather than versions: a
 * tombstone's `removedAt`, which decides when the entry ages out, and a
 * heartbeat's `ts`.  Both are read for housekeeping, not for conflict
 * resolution, so the bound is tuned generous-but-finite — a node with a
 * 23-hour clock skew still prunes in step with its peers, while a frame
 * claiming `Number.MAX_SAFE_INTEGER` (≈ 285 000 years above now) is rejected
 * on the spot.
 *
 * Member **versions** are a different quantity and are held to the much
 * tighter, per-node configurable {@link ClusterOptionsType.maxVersionSkewMs}
 * — see {@link Cluster.admitsVersion} for why the two numbers are not one.
 */
export const MAX_WALL_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a `ClusterClient` waits for the receptionist's `hello-ack` before
 * giving up on a contact point and trying the next one.  Matches
 * {@link HANDSHAKE_TIMEOUT_MS}: both bound the same thing from opposite ends
 * of the same handshake.
 */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * How long a connection may sit without its half of the handshake before it is
 * torn down and whatever it holds released.  A peer that accepts TCP but never
 * speaks the protocol would otherwise hold that resource — for the process's
 * lifetime.
 *
 * It bounds **both directions**, from the moment each connection exists: a dial
 * waiting on a `hello-ack` holds a `byPeer` slot and every frame aimed at that
 * address (#697), and an accepted socket waiting on a `hello` holds one of the
 * {@link MAX_INBOUND_CONNECTIONS} (#588).  Only the dial was ever bounded, and
 * the accepted socket was the cheaper of the two to abuse — no dial, no
 * membership, and on Bun not even a TLS handshake, since `open` fires before
 * the certificate exists to check.
 *
 * The same 5 s the dialling side gives itself, deliberately: that clock starts
 * before the TCP connect and the TLS handshake while this one starts after the
 * accept, so a peer that is still trying has always given up first, and the
 * accepting side can never be the deadline that punishes a slow-but-legitimate
 * one.
 */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Cap on frames buffered while a handshake is outstanding.  The buffer exists
 * so a `send` racing the handshake is not lost; it is not a durable queue, and
 * an unbounded one turns a silently-stuck peer into a memory leak.  Oldest
 * frames are dropped first — the newest membership/heartbeat state is the
 * state worth keeping.
 */
export const MAX_PENDING_FRAMES = 1_000;

/**
 * Where a connection's frame-decode buffer starts, and the largest one it
 * keeps once it has nothing left to decode (#588).
 *
 * The decoder accumulates into a slab it grows by doubling, so the initial
 * size only decides how many growths an ordinary connection performs before
 * it settles — a few kilobytes covers every gossip, heartbeat and shard-map
 * frame this framework emits, so in practice that is one allocation for the
 * life of the connection.
 *
 * The retention bound is the other half: a slab is sized by the largest frame
 * it has ever had to hold, so one 16 MiB envelope would otherwise pin 16 MiB
 * per connection for the process's lifetime.  Above this size the slab is
 * released the moment the buffer drains, which costs one allocation on the
 * next chunk — worth paying for a frame size that, by definition, is rare.
 */
export const INITIAL_FRAME_BUFFER_BYTES = 8 * 1_024;
export const RETAINED_FRAME_BUFFER_BYTES = 64 * 1_024;

/**
 * How long a connection may hold a half-received frame without another byte
 * arriving before it is torn down (#588).
 *
 * This is a **stall** bound, not a budget for the frame: it is re-armed on
 * every chunk, so a peer shipping a large frame over a slow link is never
 * punished for being slow — only for going silent.  What it reclaims is the
 * socket that sends three bytes of a length prefix and then nothing.
 *
 * It is the *decode buffer* this gives back, and only for a socket that has
 * sent something.  A socket that sends nothing is not stalled mid-frame and
 * never reaches this deadline at all — {@link HANDSHAKE_TIMEOUT_MS} is what
 * covers that one, and the two are not interchangeable.
 *
 * Generous on purpose.  Together with {@link MAX_INBOUND_CONNECTIONS} it is
 * what bounds inbound decode memory at all, and the bound is the product of
 * the two — so the useful tightening is the connection count, not this.
 */
export const INCOMPLETE_FRAME_IDLE_MS = 30_000;

/**
 * How many inbound connections one transport accepts before it starts
 * refusing sockets outright (#588).
 *
 * A fully-meshed cluster needs one inbound connection per peer, so this is
 * also a ceiling on how many peers may dial *this* node — set far above any
 * topology this framework is built for, because refusing a legitimate peer is
 * a partition and holding an idle socket is not.  What it stops is the
 * unauthenticated caller opening sockets in a loop: each one carries a frame
 * decoder, so without a cap the resident cost of "connected but silent" was
 * unbounded.
 *
 * A cap is only worth what its slots' turnover is worth, which is why every
 * accepted socket is handed its slot against {@link HANDSHAKE_TIMEOUT_MS}: a
 * slot that no deadline reclaims turns the cap itself into the exploit — this
 * many silent sockets and every subsequent peer is refused, permanently.
 *
 * Refusing the newest rather than evicting the oldest is the same choice the
 * member-map caps make: eviction would let an attacker push established peers
 * off the node, which is a better exploit than the one being closed.
 */
export const MAX_INBOUND_CONNECTIONS = 1_024;

/**
 * How many keys a remote peer may contribute, and how long each value may be.
 * A context rides on *every* envelope and is stamped onto *every* log line the
 * receiving actor emits, so an oversized one is not a single large record —
 * it is a permanent tax on the node's log volume.
 */
export const MAX_CONTEXT_KEYS = 32;
export const MAX_CONTEXT_VALUE_LENGTH = 1_024;

/**
 * How long an incarnation identifier arriving off the wire may be (#940).
 *
 * Same reasoning as the context cap above, one field to the left: an
 * incarnation rides on *every* address, and an address rides on every member
 * record of every gossip frame — so an oversized one is retained per member,
 * for as long as that member is on file, and re-gossiped to every peer.  The
 * frame cap bounds one delivery; this bounds what a delivery may leave behind.
 *
 * Deliberately a length rather than a format: what this node mints is a UUID
 * (`NodeAddress.mintIncarnation`), but the *rule* has to admit whatever a peer
 * of another version mints, or the identifier becomes a second thing to
 * negotiate on a wire that has no version handshake yet (#823).  128 characters
 * is four UUIDs' worth of room and still a bound.
 */
export const MAX_NODE_INCARNATION_LENGTH = 128;

/**
 * How long allocation changes are gathered before one `ShardMapUpdate` goes
 * out.  Long enough to fold a whole-cluster placement into a single
 * broadcast, short enough that a panel still feels live.
 */
export const SHARD_MAP_PUBLISH_DELAY_MS = 50;

/**
 * How long the singleton manager waits before re-spawning a child that died
 * unexpectedly (#1175).
 *
 * A pause rather than an immediate respawn, because the death that reaches
 * this path is often a supervision budget already exhausted — re-spawning
 * restarts that budget too, so coming straight back would turn a
 * crash-looping singleton into a hot loop.  One second is long enough to stay
 * out of that loop and short enough that a component whose job is
 * availability is not meaningfully absent.
 *
 * Not an option: the manager exposes no other timing knob, and the value only
 * matters in the failure case it damps.
 */
export const SINGLETON_RESTART_BACKOFF_MS = 1_000;

/**
 * How long an incoming singleton host waits for every eligible peer to confirm
 * it is not running an instance, before hosting anyway (#949).
 *
 * Here rather than in an `XOptions.ts` because the field it defaults is on
 * **two** options types — `StartSingletonOptionsType` (what
 * `cluster.singleton.start` accepts) and `ClusterSingletonManagerOptionsType`
 * (what the extension builds from it).  Co-location would put the number in
 * both, which is the duplication this module exists to prevent.
 *
 * Ten seconds, matching `DEFAULT_HAND_OFF_TIMEOUT_MS` in
 * `sharding/ShardCoordinatorOptions.ts`, and generous on purpose in the
 * direction that costs less.  The wait ends the moment the last peer answers,
 * so in a healthy cluster it is one network round trip and this number is
 * never reached.  What it has to survive is a *legitimately* slow stand-down:
 * the outgoing instance answers only after its `PoisonPill` has worked through
 * the whole mailbox and its `postStop` has run, and cutting that short is
 * precisely the second live singleton being avoided.  Reaching the timeout
 * means the invariant could not be proven — availability is chosen over it,
 * and the manager says so at `warn`.
 */
export const DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS = 10_000;

/**
 * How many messages a singleton manager holds while a hand-over it started is
 * still outstanding, before it starts dead-lettering them (#949).
 *
 * The hand-over introduces a window that did not exist before: this node is
 * the elected host, every proxy already routes here, and the child is not
 * spawned yet because a peer has not finished standing down.  Without a buffer
 * the protocol would trade a second live singleton for message loss on every
 * host move, which is not the trade being made.
 *
 * Not an option, unlike the proxy's `bufferSize`: this window is bounded by
 * {@link DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS} rather than by an outage of
 * unknown length, so there is no deployment in which the useful value differs.
 * A cap all the same — a sender in a hot loop must not be able to turn a
 * ten-second wait into an out-of-memory.
 */
export const SINGLETON_HAND_OVER_BUFFER_SIZE = 1_000;

/**
 * How often an outstanding {@link SingletonHandOverRequest} is re-sent while
 * the hand-over is still waiting (#949).
 *
 * A cadence rather than a count, and **not optional**, because it is not a
 * tuning knob — it is what makes the exchange correct at all. `Cluster._sendEnvelope`
 * is fire-and-forget: a frame sent while a handshake is still open competes for
 * {@link MAX_PENDING_FRAMES} and the oldest are dropped, so a single request can
 * simply never arrive.  Without a re-send that is indistinguishable from a peer
 * refusing to stand down, and the incoming host pays the whole
 * {@link DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS} before hosting anyway.
 *
 * It also covers a peer whose manager appears *after* the request was sent —
 * a node calling `start()` or `ref()` a moment later than the incoming host.
 *
 * Half a second gives twenty attempts inside the default timeout, which is the
 * same order as the fifteen retries the singleton config block proposes (#855),
 * and re-sending is free of side effects: a peer with no instance acknowledges
 * again, and a peer already standing down is already on the requester's list.
 */
export const SINGLETON_HAND_OVER_RETRY_INTERVAL_MS = 500;
