# Roadmap

This document tracks the planned direction.  Nothing here is committed work — it's a sketch, not a contract.  See `README.md` → "What is this?" for the current scope and `CHANGELOG.md` for what landed in the most recent release.

## Status

- **v0.17.0 is out** — the *dead letters, DevTools and the wire* release, and
  by a wide margin the largest window the project has had: 820 commits
  against v0.16.0's 181, and 290 changelog entries, 53 of them breaking.
  Three things landed together.

  **The cluster wire is a tagged JSON tree (#450).**  Frames were a bare
  `JSON.stringify`, so the framework contradicted itself across its own
  boundaries: a `Map` an actor could persist and recover verbatim arrived at
  a peer as `{}`, a `Date` as a string whose `.getTime()` throws, a
  `Uint8Array` as an index-keyed object, and a `bigint` threw straight out of
  the user's `ref.tell`.  One walker now serves all three boundaries — HTTP
  bodies, journal rows and the wire — so there is no per-transport list of
  what a message may contain to keep in sync.  This is the migration cost of
  the release, and it makes this the **second consecutive release to break
  rolling upgrade**: #112 did it to gossip in v0.16.0, this does it to the
  frame format, and here a legacy body already shaped like a reserved tag
  costs the whole connection rather than the one frame.
  `upgrade-strategies.mdx` now carries a per-release table (#1304).

  **Dead letters got somewhere to go (#1000, #433).**  An undeliverable
  message was published to an event stream that nothing subscribed to by
  default — which is to say it produced no output at all, while two docs
  pages claimed the system logged it.  There is now a bounded, optionally
  durable queue with inspection and replay, including replay to a recipient
  other than the one the message was addressed to, configured through
  `withDeadLetters(…)`.

  **DevTools became a tool rather than a demo (#482).**  The UI moved to
  Angular and gained four panels — dead letters, a live event-stream tail,
  the resolved configuration with every HOCON key and where it came from,
  and a send-message action that is off by default (#553) — plus the ability
  to pause and resume time (#1349).  It also gained roughly 3 000 lines of
  tests, having had none.

  Underneath, the measuring got honest.  `typecheck:dev` went from 320
  errors to zero and became a gated job (#540) — the only gate that sees the
  library from a caller's side, and it immediately turned up five exported
  declarations no caller could use.  The comparison benchmarks are complete
  at nine arms across three runtimes, measured as a hundred interleaved
  rounds on one Linux machine rather than ten on a Windows desktop, which
  moved every absolute number by a factor of two to five (#27, #1327).  The
  toolchain is pinned to Bun 1.4.0 (#1328), and the coverage gate stopped
  being two implementations of one parse: CI and `test:coverage:gate` now
  run the same script, with per-module floors that a rollup of per-file
  percentages could not express (#541, #1016).

- Next window is open (`[Unreleased]`).  The obvious heads from here: the
  `reference.conf` expansion tracked in #887; the residual security items
  the wave narrowed rather than closed (#112 needs a **required** incarnation
  on the wire, which is #823's wire break and not #940's optional field, and
  #823 is now also the change that would make a mixed-version cluster a
  supported state rather than a hazard); #766, whose titled fix turns out to
  be insufficient on its own; and the test-methodology review #1368–#1386
  under meta #1387, which is unstarted and is the first round to ask what the
  suite *cannot* find rather than what it has not covered — mutation testing
  (#1368), generative input for the decoders (#1369), controlled
  promise-resolution order (#1370), a global factor for the testkit's
  millisecond deadlines (#1376), and a message that silently loses its
  prototype on a worker hop (#1386).  Two correctness defects sit outside
  that round and are worth naming on their own: `ShardCoordinator` hands over
  on `LeaderChanged` with no acknowledgment from the incoming coordinator, so
  a leader move reopens the dual-authority window #949 closed for the
  singleton (#1272); and `ReplicatedEventSourcedActor` never consults
  `resolver()`, so every documented `ConflictResolver` override is a silent
  no-op (#1245).
- **Wave 3 (2026-08-18/19) left eighteen tracked residuals, #1211–#1228.**
  Three are worth reading first, because each is a defect the wave measured
  rather than inferred and then deliberately did not fold in: a broker
  connection survives a CoordinatedShutdown `service-stop` and is never
  closed, on the path `runUntilTerminated()` installs (#1223); the
  coordinator's per-shard `GetShardHome` queue is uncapped and any
  authenticated member can grow it (#1219); and a gRPC stream whose peer
  never closes it is never reaped, which is why #577 stayed open until
  #1222 existed.  Four more (#1224–#1226, #1227) are behaviour the wave
  shipped that no test binds — found by reverting one line at a time, not
  by reading — and they are the honest measure of what a green suite did
  not prove.
- ~8 470 tests green (unit + multi-node + in-process integration) + 16 real-network multi-node integration scenarios green; open bugs are tracked as `[Bug]` issues in the tracker.
- A full audit-catalog of follow-up items is tracked in the issue tracker — security findings, framework features, code-quality refactors.  Filter by label `security` + `severity: <tier>` or by title prefix `[Security] ` / `[Feature] `.

## Done since the last roadmap update

- **v0.17.0 — the 50-oldest `production-goal` wave:** the 50 oldest
  open `production-goal` issues — the label that answers "what is still
  between us and running this for real" — worked as one unit, in nine batches
  cut by which files they touch rather than by module label.  **14 closed,
  11 carried forward with the remainder written down, 12 needed a comment
  and no code, 14 deferred to a second wave with the reason recorded.**
  - **Triage before code, and it was the expensive half.** Every issue was
    read against today's tree by an independent pass asking "are the
    acceptance criteria met" rather than "does the defect still exist" —
    **277 claims in the issue bodies did not survive it**, a little over five
    per issue.  Two issues were already fixed and open only because a commit
    said `Refs` where it meant `Closes`; #461 was already specified in #849;
    #121's remaining criteria would have *reverted* the stronger fix that
    closed it in v0.14.0.  Two recorded blockers dissolved on inspection —
    #290's helper was already on disk, and #638's second half **is** #928
  - **`typecheck:dev` is green and gated (#540)**, from 320 errors.  The
    burn-down is not the point: it was hiding five exported declarations that
    no caller could use.  `NoopLogger`, `NoopMetricsRegistry` and
    `HashAllocationStrategy` each declared fewer parameters than the
    interface they implement — `implements` accepts that — so
    `new NoopLogger().info('hello')` did not compile for a user.
    `OtelContextLike` had only optional properties, which trips the weak-type
    check, so *nothing* satisfied it, the real OTel `Context` included.  Each
    compiled for the library and broke only for a caller, which is exactly
    what a configuration that never runs cannot catch
  - **Independent verification found two regressions the wave put into its
    own work**, both repaired with the failing test written first.  #637's
    widened trigger set included `MemberUnreachable`, which makes the peer
    that lost contact promote itself while the incumbent — never told it is
    considered unreachable — keeps its child: a sustained two-host state,
    the exact condition that issue exists to prevent.  It reproduced with the
    implementer's *own* test, which asserted the handover and not the
    invariant its sibling four lines above asserts.  And `bun run smoke` was
    left red on Node by a new case that fails four runs in five — a single
    green run had been taken as evidence
  - **Unreachability is now deliberately *not* reconciled**, and that is the
    fix rather than a gap.  On the no-lease path "hosted somewhere" and "at
    most one" cannot both be had, because reaching the incumbent to ask it to
    stand down is precisely what failed.  A quorum gate was designed and
    rejected: it is a split-brain resolver at a layer with no downing state,
    and the two failure detectors fire independently, so a window remains in
    which both host.  Configure a `lease` where the invariant must survive a
    partition
  - **What the wave narrowed rather than closed**, so it is not re-derived:
    #545's POSIX process-group teardown has never executed (the development
    machine is Windows) and its proof is the first CI run; #539's workflows
    and #538's nightly have both been green since 2026-08-16 — CodeQL 8/8
    on develop with zero open alerts, and the nightly green on 08-17 and
    08-18, 2 of the 14 consecutive nights its exit criterion needs;
    #612's rollback floor is in-process and does not survive a restart;
    #631 fixes the code and
    leaves existing journals holding the collapsed tags
  - **Three counts were wrong in the direction that flatters, and got
    measured.** #663's report claimed four sleeps remained under `examples/`
    and none was a drain sleep; the real figures are 108 delay sites of which
    **7** were drain sleeps — and the boundary a grep cannot see is that
    `terminate()` drains `/user` while eleven framework actors live under
    `/system`, so a sleep crossing that hop is load-bearing.  One candidate
    removal passed on the first run and survived only **2 of 12** repeats,
    which is how it would have reached CI
  which files they touch rather than by module label.  **42 resolved** — 38
  closing on this window's push plus four closed by hand — and 12 left open on
  purpose, each with a comment saying why.  The bulk is the 2026-08-01 audit
  catalogue (#575–#626) plus the four May entries (#112, #118, #121, #132).
  - **Two of the fifty were not defects at all.** #118's titled timer leak
    cannot happen — `settle()` clears and nulls the timer and every later
    `tell()` early-returns — and the issue body already retracted it; it was a
    duplicate of #177, whose two unique clauses were folded across.  #132 asked
    for redaction of a trace id that no framework path ever writes to a log
    record; #995 owns making that bullet true first.  Neither cost a line of
    code, and finding that out was the point of asking "are the acceptance
    criteria met" rather than "does the defect still exist"
  - **Five entries are BREAKING**, each with a migration note in
    `CHANGELOG.md`.  The consequential one is **#112**: `GossipMessage` gains
    a required `sequence`, so a cluster must be upgraded in one step — an
    upgraded peer refuses an old node's frames and an old node ignores the new
    field.  The others are narrower: object-storage bodies must carry their
    integrity tag once integrity is configured (#579), the Express and Hono
    request-body caps drop to match Fastify (#357), a documented-but-inert
    gRPC deadline starts being enforced (#577), and an ungated
    `DevTools.mount()` now throws (#594)
  - **Independent verification found five regressions the wave itself
    introduced**, all repaired before the merge, each with the failing test
    written first.  The worst was #588's own fix: the new inbound-connection
    cap armed no handshake deadline on the accept path, so 1024 sockets that
    send *nothing* saturated it and refused every real peer — a defence that
    became the attack.  Also #597 (one malformed environment variable killed
    the whole discovery ladder, including the explicit seed list that does not
    read it), #600 (`reset()` orphaned an in-flight acquire, so the very end
    state the issue exists to prevent survived), #610 (the scan was fixed but
    not the copy — 95 % of the remaining cost) and #586 (a hard throw on
    `@hono/node-ws` versions `package.json` still declared supported)
  - **What the wave narrowed rather than closed**, stated so it is not
    re-derived later: #112's guard refuses a recording only to a receiver
    that already holds a high-water mark for its sender.  This entry used to
    say the guard holds "while the sender is still a member" — that was
    wrong, and the security page now withdraws it.  The mark has one writer
    and it runs in the gossip path, so it exists for a peer this node has
    accepted a frame *from* and for nobody else, and three kinds of receiver
    hold none: one whose sender was itself evicted (the mark is dropped with
    the member), a fresh or restarted process, and — the ordinary case, not
    an edge — one that learned the subject **third-party**, where the sender
    is a full member throughout and nothing was evicted anywhere.  Each is
    asserted by execution in `GossipReplayGuard.test.ts`, the last two as
    exploits; closing them needs a **required** incarnation on the wire,
    which is #823's wire break rather than the optional field #940 landed.
    #607's key bound was necessary but not sufficient; #1080's guarantee
    split and #607's own `prefixQuotas` are the rest of it, and what
    survives both is a flood inside a single key prefix — an attacker who
    chooses the `Idempotency-Key`s evicts other callers' records out of the
    reservation they share, which no eviction policy fixes and Redis or a
    larger bound does.  #602 deliberately has no HOCON key, because one would
    reach `HttpExtension.client` and silently not the `HttpClient` inside
    `D1Client` — a bound that applies to some clients and not others is
    worse than none
  - **Eleven release notes were corrected** after the fact, most of them
    overclaims by the wave's own hand.  #121's migration note named the wrong
    safe version (v0.13.0 for v0.14.0), which would have had an operator roll
    clients out against nodes that crash on every envelope
- **v0.15.0 — mailboxes and channels:**
  - **The unbounded mailbox is the default again (#1148)** — BREAKING, and
    the reason this window is a minor.  A mailbox cannot tell a stale sample
    from a control message, so `drop-head` on every actor was never confined
    to the telemetry-shaped workloads it suits.  `mailboxOverflow` /
    `withMailboxOverflow` is a real `ActorOptions` field now, setting it
    without a capacity is rejected rather than ignored, and `ActorCell` warns
    at 10 000 queued messages and every doubling after
  - **Drop reporting reaches every mailbox (#1149, #661)** — the cell
    registers its observer after choosing the mailbox, on anything
    implementing the new `DropReportingMailbox` contract, so a mailbox
    supplied through `withMailbox` is no longer invisible to
    `actor_mailbox_dropped_total`.  `Mailbox` and `Envelope` are exported
    from the package root, which is what made the documented escape hatch
    reachable at all
  - **`EventStream` channels can be `kind`-discriminated types (#1143)** —
    a new `EventKey` mirroring `ServiceKey` / `ShardKey`, or the bare kind
    string; class channels are untouched.  Publishing something nobody could
    subscribe to was possible before this
  - **The event stream survives a bad subscription (#1010)** — the channel
    test, the predicate and `subscriber.tell` all run under a guard, so one
    faulty entry no longer silently stops every subscription registered
    after it, on every spawn, stop and dead letter
  - **Constants have a placement rule (#1142)** — four possible homes,
    checked in order, written down in `AGENTS.md`; ~300 constants across 130
    files audited against it.  Every public name is unchanged
  - **A collision predicate on the random-id helpers (#1141, #1146)** — an
    optional `exists` callback that collapses the hand-written `do/while`,
    bounded at 1 000 draws; three of the framework's own twelve draws now
    use it, and the other nine are recorded with the reason

- **v0.14.0 — caps, codecs and lifecycle:**
  - **`allPersistenceIds` + `currentPersistenceIdsPaginated` (#156)** — the
    read side can now enumerate entities as a live fan-out stream and as a
    cursor-paginated walk, instead of only as one materialised array.  Paging
    is pushed into the backend wherever a sorted key over ids exists —
    `ORDER BY … LIMIT` on SQLite and the SQL dialects, an
    `all_persistence_ids` clustering range on Cassandra

- **v0.13.0 — names and lifecycle:**
  - **`Props` removed (#547)** — `spawn(MyActor, name)`; per-actor
    configuration is `ActorOptions`, a regular `XOptions` family.  The one
    place in the framework that did not follow that convention
  - **Sharding lifecycle (#892)** — idle entities passivate after 5 minutes by
    default, empty shards stop with them, `shardPassivationIdleMs`;
    plus `ShardInfo.resident` (#901)
  - **`Actor.displayName()` (#891)** — a readable name in log lines and the
    DevTools tree, settable from the spawn site or at runtime; the path stays
    the identity everywhere it is an address
  - **Generated names hardened** — anonymous actors (#895), reliable-delivery
    controllers (#897), the reserved `$` prefix (#900), DistributedData quorum
    ids (#896), object-storage temp paths (#898), `ClusterClient` identity
    (#910)
  - **Cluster correctness** — a crossing dial no longer partitions two healthy
    nodes forever (#697), `rememberEntities` survives a rebalance handoff
    (#632), handoff buffers are replayed (#893), remembered entities return
    after an unexpected shard death (#894), remote shard refs route through the
    owning region (#901)
  - **The TLS listener actually requests a client certificate (#565)** — the
    documented mTLS recipe had been server-authenticated only, and the `hello`
    handshake carries no credential of its own

- **v0.12.x window:**
  - **DevTools suite (#445)** — embeddable web UI for a running system, seven
    panels on one versioned tap protocol behind a `./devtools` export.  Absorbed
    the separately-listed live cluster visualizer (#204)
  - **Five more persistence backends (#438)** — MongoDB, DynamoDB, MS SQL,
    libSQL/Turso, Cloudflare D1, each with journal + snapshot + durable-state,
    on the new relational base layer (#389); CockroachDB + YugabyteDB certified
    on the Postgres stores (#401)
  - **Documentation site (#26)** — Starlight, with a 1:1 German mirror and a
    generated TypeDoc API reference at `actor-ts.dev/api/`
  - **Cluster addressing** — a shard is a real actor (`Region → Shard →
    Entity`) with `shards()` / `shardRefFor()` / `entityRefFor()` introspection
    (#511, #512, #151); `SingletonKey` / `ShardKey` declare identity on the
    actor class, `cluster.singleton` mirrors `cluster.sharding` and `start()`
    returns a plain `ActorRef` (#523); framework actors moved from `/user` to
    grouped `/system` paths (#509)
  - **Cluster-correctness follow-ups** — cross-node `ask()` gets its reply
    instead of timing out (#517), a role-restricted singleton is hosted by a
    node that carries the role rather than nowhere (#524), the singleton proxy
    buffer is bounded (#526), and `leader()` / `KeepOldest` document the
    address ordering they actually use (#525)
  - **Core correctness pass from the 2026 audit** — the `terminated` signal is
    delivered (#448), routers prune dead routees (#449) and reject an unusable
    pool size (#455), reliable-delivery settles in-flight sends on shutdown
    (#451), a bounded mailbox keeps its bound while suspended (#407),
    `FailureDetector` thresholds are consistent and validated (#452), and HOCON
    parsing cannot reach the object prototype (#406)

- **v0.11.0 window — consistency + validation sweep:**
  - Repo-wide naming conventions, hard cuts: `Websocket` casing (no `Ws`),
    abbreviations spelled out (`*Cmd`/`*Msg`/`*Ack`/`*Impl`/`*Ctor`,
    testkit `expectMessage`/`expectMessageType`), one config vocabulary
    (`Options`, never `Settings`), single-letter locals spelled out
  - `OptionsValidator` + `OptionsError` (#274) — fail-fast domain validation
    on every input path (builder / plain object / HOCON) across brokers,
    cluster, sharding, discovery, leases, caches, persistence, HTTP
    middleware/backends, WebSocket routes + policy, `CircuitBreaker`,
    `BoundedMailbox`, and the testkit
  - Security hardening: WebSocket Origin allowlist (CSWSH defence, WS-2),
    per-route WebSocket connection cap (WS-5, partial), per-caller identity
    scope for idempotency keys (HTTP-4), object-storage decompression cap as
    a store option (#3)
- **v0.10.0 — SQL persistence backends + compression levels:**
  - PostgreSQL backend — journal + snapshot + durable-state (the first SQL-backed durable-state store), `registerPostgresPlugins`, optimistic concurrency, indexed tag queries, live `postgres:latest` CI suite (#323)
  - MariaDB backend — same three components via the `mariadb` connector, MariaDB dialect, live `mariadb:latest` CI suite (#324)
  - Configurable gzip/zstd compression `level` on the object-storage stores (#322)
  - zstd compression fixed on non-native runtimes — compress is native-only (Bun / Node ≥22.15), `fzstd` is the decompress-only fallback (#321)
- **v0.10.0 — production-readiness audit response, 5 technical points:**
  - DurableState revision tampering — opt-in HMAC-SHA256 integrity (#116, CRITICAL)
  - ClusterClient askId predictability — `crypto.randomUUID()` (#120, HIGH)
  - Master-key rotation sweep race — durable resume tokens + keyring-completeness pre-check (#109, HIGH)
  - LeaseMajority split-brain — epoch-gated acquires + release-on-abandon + optional fencing tokens (#142, HIGH)
  - Bounded mailbox is now the default — 10 000 / `drop-head` with `actor_mailbox_dropped_total` metric (#310)
  - `JsonLogger` + `otelLogger` for OTLP-Logs pipelines (#311)
  - HTTP route middleware + `BearerTokenAuth` + `IpAllowlist` + `managementRoutes` auth integration (#312)
  - Real-network multi-node integration tests — docker-compose, tc-netem, 15 scenarios covering cluster primitives end-to-end (#313)
  - MultiNodeSpec `enterBarrier` — Akka-style cross-node test synchronization (#198, was #47)
  - Backend `remoteAddress` wiring for Fastify / Express / Hono (#312 follow-up)
- v0.7.0 — `mget` / `mset` on the `Cache` interface (#14), MQTT 5.0 user properties + reason codes (#13)
- v0.8.0 — Cluster-management extended HTTP endpoints (#56), Re-encryption sweep + journal-to-journal copy + ClusterClient + WriteConsistency/ReadConsistency
- v0.8.0 — 8 security-hardening fixes (wire-frame DoS cap, FS path-traversal guard, Memcached CRLF, gossip version cap, snapshot seq integrity, WebSocket frame cap, hello-handshake hijack defense, idempotency body-fingerprint)

## Feature-parity quick wins

- `Inbox` — synchronous adapter for non-actor callers — #181
- `DeathWatch.watchWith` — custom termination message — #159
- `ShardCommand` types — `StartEntity`, `GetShardStats`, `GetClusterShardingStats` — #151

## Production features (Orleans / Vlingo-inspired)

- Persistent reminders (Orleans-style durable timers) — #168
- Stateless workers — per-node pool of identical activations — #170
- Saga / process-manager with compensations — #179
- Placement strategies (PreferLocal / HashBased / ActivationCountBased) — #169

## Novel differentiators (each own plan-slot)

- Deterministic-simulation-testing (FoundationDB-style seeded virtual-time replay) — #200
- LLM agents as supervised, durable actors — epic #421 (absorbed the earlier
  LLM-tool-call-as-actor sketch; tool dispatch is #423)
- Per-entity chaos injection — #206

## Bigger threads (L / XL — own design phase)

- Streams DSL subset (`SourceQueue`, `MergeHub`, `BroadcastHub`) — #147
- Full `Source` / `Flow` / `Sink` composition DSL — #54 (the long-horizon track;
  #147 is a deliberate ~5 % subset, not a replacement for it)
- WASM / edge-runtime subpackage — #209
- Distributed transactions (Orleans-style ACID 2PC across grains) — #171
- Multi-DC clustering with DC-local failure detection — #149

## Documentation

- ~~Performance benchmarks vs JVM actor frameworks (#27)~~ — done.
  `benchmarks/comparison/` measures actor-ts against eight arms (nact, XState,
  Akka and Pekko each through both their Java and Scala 3 APIs, Akka.NET and
  Orleans) and publishes to the README, `reference/benchmarks` (EN+DE) and a
  generated `RESULTS.md`

## Explicitly out of scope

- "Auto-magic" cache invalidation by tag / pattern — known bug-source; invalidation stays explicit via `cache.delete(...)`.
- Backwards-compatibility guarantees of any kind — pre-1.0.
- Pull requests — not accepted; well-shaped issues are (the issue tracker is the contribution channel, see `README.md` → "Roadmap & status").

→ Full catalog: GitHub issues, filterable by title prefix `[Security]` / `[Feature]` and the `security` / `severity: …` labels.
