/**
 * The **cross-subsystem** tier of the constants layout: values consumed by
 * two or more top-level directories under `src/`.
 *
 * This is the last of four homes a constant can have, and the rule that
 * picks between them is in AGENTS.md under *Constants*.  In short: a
 * built-in default goes beside its options type in `XOptions.ts`; a value
 * that *is* its file's implementation (a codec's tags, a parser's regex, a
 * singleton, a derived value) stays put; every other tuned cap, bound,
 * timeout or size goes in its subsystem's `src/<subsystem>/Constants.ts`;
 * and only what crosses subsystems reaches here.
 *
 * Why this file rather than a subsystem one: `src/util/` has **no outward
 * import at all** — verified, not aspirational — so it is the one module
 * every subsystem may depend on without any of them depending on each
 * other.  That property is what makes it the shared tier, and it is why a
 * constant that grows a second consumer in another subsystem moves here
 * rather than being imported across a subsystem boundary.
 *
 * Centralising buys two things.  **One source of truth** — change the
 * gossip interval and every consumer follows, with per-call options still
 * overriding at the site.  And **self-documenting magic numbers** — a
 * named `DEFAULT_GOSSIP_INTERVAL_MS` at a call site says what a bare
 * `1_000` cannot.
 *
 * Naming: `DEFAULT_<DOMAIN>_<UNIT>`, always with the unit suffix, since
 * milliseconds dominate and confusing `5` (seconds) for `5_000`
 * (milliseconds) is exactly the bug centralising is meant to head off.
 *
 * Note what is *not* here.  Values with a single consumer belong to that
 * consumer's subsystem even when they look general — this file held the
 * tombstone TTL, the shutdown phase timeout and the mailbox defaults for a
 * while on that mistake, and it held a snapshot-cache TTL that nothing
 * imported at all while its intended consumer kept a second copy.  Two
 * constants may also share a value and still stay apart:
 * `MAX_WALL_CLOCK_SKEW_MS` in `cluster/Constants.ts` and
 * `DEFAULT_TOMBSTONE_TTL_MS` in `ClusterOptions.ts` are both 24 h for
 * unrelated reasons — a security cap on peer-supplied timestamps versus a
 * retention window — and merging them would couple two decisions that
 * should be free to move independently.
 */

/**
 * Default cluster gossip-tick interval.  Used by `Cluster`,
 * `DistributedPubSubMediator`, and `Receptionist`.
 */
export const DEFAULT_GOSSIP_INTERVAL_MS = 1_000;

/**
 * Default ask-reply timeout.  Used by `ActorRef.ask` itself, and by
 * `ClusterClient`, `ClusterClientReceptionist` and `DistributedData`
 * quorum read/write.  Per-call `timeoutMs` overrides at every site.
 *
 * `ActorRef.ask` carried its own `5_000` literal until #1088, where the
 * cost of that showed up: `ScatterGatherRouter` has to stay *below* this
 * value to report before the caller gives up, and a duplicated literal is
 * a coupling nothing can check.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 5_000;

/**
 * Messages an explain plan keeps when the caller names no capacity.
 *
 * There are two doors onto the same ring and they have to resolve
 * "unspecified" identically: `ActorContext.enableExplainPlan()` for code
 * that switches it on directly, and the DevTools `explain.enable` RPC for
 * a client that switches it on from outside.  Both land in
 * `ActorCell._enableExplain`.  Two copies of the number meant the same
 * feature could answer "how big is the default ring?" two ways depending
 * on which door you came through.
 *
 * The DevTools path additionally *clamps* a caller-supplied capacity; that
 * ceiling is a guard on untrusted RPC input rather than a property of the
 * ring, so it stays in `ExplainTap` where the input arrives.
 */
export const DEFAULT_EXPLAIN_CAPACITY = 100;

/**
 * Whole-token values that would carry traversal meaning in a name.
 *
 * Rejected as an actor-path segment (`ActorPath`) and as a persistence id
 * (`PersistenceIdValidator`).  The two validators guard different things
 * but against the same attack: a persistence id reaches a filesystem or
 * object-storage key, where `..` climbs out of the configured prefix, and
 * a path segment reaches actor-selection resolution.
 *
 * Shared rather than duplicated because a denylist that exists twice is a
 * denylist that can be extended once.  Adding a third traversal token to
 * one copy and not the other leaves a hole in whichever validator was
 * forgotten, and nothing about the two files makes that omission visible.
 *
 * Typed `ReadonlySet` on purpose: `new Set([…])` alone infers a mutable
 * `Set<string>`, and a shared denylist any caller can `.delete()` from is
 * worse than two private ones.
 */
export const PATH_TRAVERSAL_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/**
 * How many times a uniqueness draw may be repeated before it gives up.
 *
 * Both sites that redraw against a collision predicate use it: `randomId`
 * and friends when handed an `exists` callback, and `freeActorName` when a
 * DevTools actor name is already taken.  Exhausting a thousand draws does
 * not mean this call was unlucky — it means the space is too small or the
 * predicate is inverted, and the caller wants an error rather than a
 * loop.
 *
 * Shared because both bounds answer the same question for the same reason.
 * They were introduced independently and the second one said so in prose
 * ("the same bound, and the same reasoning, as `freeActorName`"), which is
 * a coupling a comment cannot keep.
 */
export const MAXIMUM_DRAW_ATTEMPTS = 1_000;

/**
 * Config **paths** whose value is withheld wherever the merged tree is
 * rendered — DevTools' `config.resolved` pull (#553) and the boot dump
 * `actor-ts.diagnostics.log-config-on-start` turns on (#867).
 *
 * It moved here from `devtools/protocol/ConfigFrames.ts` the moment the
 * second renderer appeared: `src/` outside `src/devtools/` imports nothing
 * from it, deliberately — the DevTools protocol is an attached debugger's
 * vocabulary and the core does not carry it — so the choice was this file
 * or a second copy of the pattern, and two redaction lists is how one of
 * them stops being extended.
 *
 * **Matched against the path, never the value.**  A password that happens
 * to look ordinary is still a password, and the key is what names it.
 *
 * **It is a heuristic, and it is the weaker half of the guarantee.**  It
 * catches `password`, `api-key`, `secret`, `auth-token`, `credentials` and
 * anything else spelling one of the six fragments.  It does not catch a
 * secret whose key does not say so — `dsn`, `connection-string`, a `uri`
 * with userinfo in it — and it cannot: the merged tree is a tree of
 * strings, and by the time it exists a `${?DATABASE_PASSWORD}` has
 * resolved into a value with nothing left to say where it came from.  The
 * defence that does not depend on a guess is not printing the tree, which
 * is why both renderers are opt-in and the boot dump ships `off`.
 *
 * Deliberately not widened past these six.  `seed` would redact
 * `cluster.seed-nodes`, `id` would redact half the file, and a dump whose
 * ordinary keys read `<redacted>` teaches an operator to stop reading it —
 * which costs more than the fragment would have bought.
 */
export const CONFIG_SECRET_PATTERN = /pass|secret|token|key|credential|auth/i;

/** What a value redacted by {@link CONFIG_SECRET_PATTERN} is replaced with. */
export const CONFIG_REDACTED = '<redacted>';
