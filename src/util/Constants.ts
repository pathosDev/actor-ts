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
 * Since #863 it is the *built-in* answer for `ActorRef.ask` rather than the
 * only one: `actor-ts.actor.ask-timeout` overrides it for every ref that can
 * reach an `ActorSystem`, and this value is what the refs that cannot — and
 * the three sites above, which have no config seam of their own yet (#856,
 * #858) — still resolve to.
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
 * The words a config key uses to say that its value is a credential — the
 * test behind every value withheld *by name* from a rendered merged tree,
 * DevTools' `config.resolved` pull (#553) and the boot dump
 * `actor-ts.diagnostics.log-config-on-start` turns on (#867).
 *
 * It lives here rather than in `devtools/protocol/ConfigFrames.ts` because a
 * second renderer appeared: `src/` outside `src/devtools/` imports nothing
 * from that tree, deliberately — the DevTools protocol is an attached
 * debugger's vocabulary and the core does not carry it — so the choice was
 * this file or a second copy of the pattern, and two redaction lists is how
 * one of them stops being extended.
 *
 * **Anchored, and matched against one word of a key — never the whole
 * dotted path.**  That anchoring is the whole point of the pattern and it
 * was learned the expensive way: as a bare alternation over the path it
 * withheld thirty-one keys of a stock configuration, twenty of them
 * ordinary tuning values, because `passivation` contains `pass` and
 * `keyspace` contains `key` (#867).  A dump that hides `passivation-idle`
 * hides exactly what the operator turned it on to read.
 * `namesSecretConfigValue` in `diagnostics/ConfigDump.ts` is what cuts a
 * path into the words this is applied to, and `withCredentialFieldsWithheld`
 * reads the field names of an object inside a list the same way — a list is
 * one leaf, so its fields have no path of their own to be read by (#1458).
 * The rule both implement is that an English compound is head-final, so the
 * *last* word says what the value **is** and the ones in front of it say
 * what it is *about* — `api-key` is a key, `key-prefix` is a prefix.
 *
 * **Matched against the key, not the value.**  A password that happens to
 * look ordinary is still a password, and the key is what names it.  The one
 * thing the value can do here is veto: a value drawn from HOCON's boolean
 * vocabulary carries no secret whatever its key is called, because all six
 * spellings of it are public.
 *
 * **It is a heuristic, and it is the weakest part of the guarantee.**  It
 * catches `password`, `api-key`, `secret`, `auth-token`, `credentials`, and
 * every key beneath a branch one of those names.  It cannot catch a secret
 * whose key does not say so — a `dsn`, a `connection-string`, a `uri`: the
 * merged tree is a tree of strings, and by the time it exists a
 * `${?DATABASE_PASSWORD}` has resolved into a value with nothing left in it
 * to say what it is.  Where the value came from can say so, though: both
 * renderers withhold every value the secrets file sets, whatever its key is
 * called — decided by the layer the loader kept, not by this pattern
 * (#1546).  Nor does the pattern read a name whose head is an identifier or
 * a location as the thing itself: `kms-key-id` is an id and `token-path` is
 * a filesystem path.
 *
 * **What a value marks by its own syntax needs no guess.**  The userinfo of
 * a URL — `scheme://user:password@host` — says it is a credential whatever
 * the key is called, so `withUrlCredentialsMasked` in
 * `diagnostics/ConfigDump.ts` masks it by value in both renderers (#1458),
 * and this pattern is not widened to `url` or `dsn` to reach it.  Outside
 * the secrets file — in `application.conf`, say, or the code's overrides —
 * what none of these rules sees still prints: a bare password under a key
 * that does not name one, a credential in a query string, SQL Server's
 * `Server=…;Password=…` form and memjs's scheme-less `user:pass@host` list.
 * The defences that do not depend on a guess are keeping credentials in the
 * secrets file and not printing the tree, which is why both renderers are
 * opt-in and the boot dump ships `off`.
 *
 * Deliberately not widened past these words.  `seed` would redact
 * `cluster.seed-nodes`, `id` would redact half the file, and a dump whose
 * ordinary keys read `<redacted>` teaches an operator to stop reading it —
 * which costs more than the word would have bought.
 */
export const CONFIG_SECRET_PATTERN =
  /^(?:pass(?:word|phrase|wd)|secret|token|key|credential|auth)s?$/i;

/**
 * Keys this project ships that {@link CONFIG_SECRET_PATTERN} reads wrong,
 * with the reason each one is safe.
 *
 * A supplement to the pattern and never the mechanism: entries are full
 * dotted paths of keys **`reference.conf` declares**, so their meaning is
 * known here and a wildcard is never needed.  An application's own key is
 * not eligible — this file cannot know what one holds — and the pattern is
 * what has to be right for those.
 *
 * `ConfigDump.test.ts` asserts the entire withheld set of a stock tree, so
 * an addition is a visible line in a diff rather than a quiet loosening.
 */
export const CONFIG_NEVER_REDACTED_PATHS: ReadonlySet<string> = new Set([
  // The *names* of the DistributedData keys a durable store persists
  // (`session-*` and friends), never key material — a list of them says
  // which replicas survive a restart, which is the one thing an operator
  // reading this key came to check.
  'actor-ts.distributed-data.durable-keys',
]);

/**
 * What a withheld value is replaced with — one whose key
 * {@link CONFIG_SECRET_PATTERN} reads as a credential, one the secrets file
 * set, and a credential field of an object inside a list alike.
 */
export const CONFIG_REDACTED = '<redacted>';

/**
 * How often one *reason* for dropping a frame on a `MessagePort` may reach the
 * log, whatever the drop rate (#1515).
 *
 * The rate limit is the whole point, and it is a security bound rather than a
 * tidiness one: a line per dropped frame lets whoever is on the other end of
 * the port write this process's log at `postMessage` rate — the amplification
 * `ENVELOPE_REFUSAL_REPORT_INTERVAL_MS` refuses to hand out on the wire, and a
 * thread is a cheaper place to post from than a socket.  The first drop of
 * each reason is reported at once, so a wiring mistake or a version skew is
 * visible immediately; what this spaces out is the second thousand, folded
 * into one line carrying the count.  A counter carries the signal
 * (`MessageChannelTransport.dropped`, `WorkerBroker.dropped`); the log carries
 * a sample of it.
 *
 * A constant and not an option, for the reason its two consumers already give:
 * there is no deployment in which the useful value differs, and a knob for it
 * would be a knob for how loud a peer may make this process's log.
 *
 * **Here rather than in either subsystem's `Constants.ts`, because it is one
 * decision with a consumer on each side of the channel.**
 * `MessageChannelTransport` lives in `src/cluster/` and `WorkerBroker` in
 * `src/worker/`; `src/worker/` already imports `src/cluster/`, so the reverse
 * edge is not available, and this file's no-outward-import property is exactly
 * what makes it the home rule 4 of AGENTS.md describes.  The broker reached
 * the same number first and still holds its own copy as
 * `WORKER_BROKER_DROP_REPORT_INTERVAL_MS` — re-pointing it here is a two-line
 * follow-up that was outside the lane that added this.  Until it lands, the
 * value is written twice on purpose and not by accident.
 */
export const DEFAULT_DROP_REPORT_INTERVAL_MS = 30_000;

/**
 * The largest delay `setTimeout` — the primitive `setTimeoutSleep` in
 * `pattern/Retry.ts` picks — can actually represent.  Its argument is coerced
 * to a 32-bit signed integer, and anything larger silently becomes `1`, so an
 * exponential backoff that overflows does not wait longer: it stops waiting
 * altogether and turns into a hot loop against the dependency that is
 * already failing (#771).
 *
 * Clamping is therefore not a cap on what the caller may ask for, it is the
 * direction the failure has to fall in: "waits ~24.9 days" is a
 * misconfiguration an operator can see and fix, "waits 1 ms" looks like the
 * retry working.  It applies to an injected `sleep` too — a delay this large
 * is a bug wherever it is awaited, and making the clamp conditional would
 * make the one path that matters the one no test can observe.
 *
 * Here rather than in `pattern/Constants.ts`, where it lived first, because
 * `src/http/` holds its deadlines to the same ceiling: `HttpServerOptions`
 * refuses a `headerTimeoutMs` above it and an `idleTimeoutMs` above it less
 * one second (#870), and the `requestTimeout()` middleware refuses a
 * `deadlineMs` above it (#1463).  `retry` clamps where http refuses, but both
 * answer the same fact about the timer, and a second copy of the number is a
 * coupling nothing checks.  A third answer lives in `Scheduler.ts`:
 * `armChainedTimeout` chains host timers of at most this length, so a delay
 * past it is waited out in full rather than clamped or refused — for the
 * scheduler, the `ask` deadline, `after()`, `gracefulStop`, the `InMemoryCache`
 * sweep, a persistent actor's recovery deadline and an `HttpClient` deadline.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
