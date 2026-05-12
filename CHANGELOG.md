# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a pre-1.0 hobby project — every minor version is potentially
breaking.  See `ROADMAP.md` for what's coming, and `README.md` →
"What's in here / What isn't" for current scope honesty.

## [Unreleased]

### Code-quality hygiene sprint

A focused refactor pass — no behavioural changes, no public-API
breaks, no new features.  Goal: more compile-time safety, fewer
duplicated literals, easier-to-write tests.  17 issues closed
(15 implemented + 2 auto-corrections from the audit catalog).

**Pattern-match exhaustiveness pass** — 9 discriminator-union
dispatch sites converted from if/else-or-switch to
`match(...).exhaustive()` so the TypeScript compiler refuses to
compile when a new variant is added to one of the unions without
a matching arm at the dispatch site.  Touches:
`BrokerActor.enqueueOutbound` state (#230),
`JetStreamActor` / `MqttActor` / `KafkaActor` cmd dispatch (#232,
#233, #234), `BackoffSupervisor` reset-policy + termination-trigger
(#240), `HoconParser` value-shape walk (#241), `Compression` codec
selection (#243), `BodyCodec` encode-compression (#244),
`PersistentActor` (#239 — see below).

**Foundational DRY helpers** (`src/util/`):
- `Constants.ts` — centralised duplicated defaults (gossip
  interval, ask timeout, tombstone TTL, seed-retry, etc.).  6
  named exports replace ~10 inline-literal sites across
  `Cluster`, `Receptionist`, `DistributedPubSubMediator`,
  `ClusterClient`, `ClusterClientReceptionist`, `DistributedData`
  (#257).
- `LazyImport.ts` — uniform peer-dep import + helpful "missing
  package" error.  Replaces ~7 lines × 6 broker actors of
  hand-rolled try/catch + bespoke install messages (#252).
- `WrapError.ts` — typed-error wrap helper with double-wrap
  prevention.  Migrated 8 sites across cache + object-storage
  (#254).

**Foundational typed names**:
- `src/config/ConfigKeys.ts` — typed const-tree for every
  `actor-ts.*` HOCON path.  Migrated 16 call sites across all
  brokers + ActorSystem + CacheExtension (#265).
- `src/persistence/storage/KeyValidator.ts` — declarative
  rule-based factory replacing the hand-rolled `assertSafeKey`
  (filesystem) and `assertSafeMemcachedKey`.  Adding a new
  storage backend with similar key rules becomes a 6-line
  `as const` rule set (#251).

### Added — Persistence

- `eventDispatcher<S, E>()` (#239) — typed builder for
  `PersistentActor.onEvent` that the compiler refuses to finish
  until every variant of the event union has a handler.  Missing
  variants surface as a clear "EventDispatcherIncomplete<missing>"
  type error at the build site.  Documented as the preferred shape
  for new persistent actors; existing handwritten `onEvent`
  impls continue to work unchanged.

### Added — Testing infrastructure

- `tests/util/AsyncAssertions.ts` — `assertCompletesWithin(promise,
  ms, label)` + `assertDoesNotCompleteWithin` for diagnostic-quality
  timeout failures (the label appears in the error message;
  default Bun timeouts give no clue which step was slow) (#288).
- `tests/util/TestActorSystem.ts` — `createTestActorSystem(options?)`
  consolidates the per-file `makeSystem` boilerplate.  Demo
  migration in `BrokerActor.test.ts`; other test files can opt-in
  over time (#283, scope-adjusted).
- `tests/unit/cache/_Contract.ts` — `runCacheContractTests(spec)`,
  a backend-agnostic suite covering set/get/delete/incr/setIfAbsent/
  TTL semantics.  InMemoryCache wired as first consumer; Redis +
  Memcached can opt-in once their mock-client factories are
  available (#287, scope-adjusted).

### Docs

- `decodeCrdt` (`src/crdt/DistributedData.ts`) annotated as the
  codebase's reference shape for discriminator-union dispatch,
  with explicit notes on what makes the existing
  `const _exhaustive: never = json` pattern safe and when to prefer
  it vs `match().exhaustive()` (#231).

### Issue hygiene

- Closed as duplicate: #267 → #253, #266 → #255, #167 → #164.
- Closed as not-applicable: #245 — `BrokerEvents.ts` has no
  in-file dispatch; events flow through `EventStream`'s
  per-subscriber `instanceof` machinery, which by design isn't a
  closed-union dispatch.

## [0.8.0] — 2026-05-11

The "production-vertical big" release — one priority:high cornerstone
plus four mid-sized operator-facing items.  Wire-format additive: new
optional message types and HTTP routes; no existing callers break.

### Added — DistributedData quorum writes / reads (#81)

- `DistributedDataHandle.updateAsync(key, factory, fn, { consistency })`
  and `.getAsync(key, { consistency })` — promise-returning variants
  with a `WriteConsistency` / `ReadConsistency` target.
- Consistency levels: `'local'` (legacy fire-and-forget), `'majority'`
  (⌊N/2⌋+1), `'all'` (every up-member), `{ from: K }` (clamped to
  `[1, N]`).  Self always counts as the first ack; single-node
  clusters resolve instantly.
- Reads merge incoming responses into the local replica before
  resolving, so a `ReadMajority` effectively pulls the freshest
  state without waiting for gossip.
- Timeouts reject writes (the local apply still stands, gossip
  continues) and resolve reads with the best-available merge —
  reads stay best-effort even on partial failure.
- New wire messages `ddata-write-request|ack` /
  `ddata-read-request|response`.  Registered via the extension's
  synchronous `start()` so the inbound side routes before the user
  can issue the first quorum write.

### Added — operations tooling

- `reEncryptObjectStorage(backend, opts)` (#70) — re-encrypt every
  body under a prefix to the active master key from a `MasterKeyRing`.
  Idempotent fast-path on bodies already at the active version;
  `If-Match` CAS internally so a concurrent writer isn't overwritten
  silently.  Closes the missing step in v0.7's
  `docs/operations/rolling-migration.md` Phase-3 — the doc now shows
  the real call instead of a TBD marker.
- `migrateBetweenJournals(source, target, opts?)` /
  `migrateBetweenSnapshotStores(source, target, { pids })` (#87) —
  copy-with-optional-transform helpers for backend swaps and
  schema-piggyback migrations.  Per-pid resume from `target.highest
  Seq + 1`; optional `MigrationProgressStore` for cross-process
  resumability.  `skipExistingPids` for fan-out across worker pools.

### Added — outside-in cluster connectivity (#86)

- `ClusterClient({ contactPoints })` — lightweight handle for
  processes that aren't cluster members (REST frontends, batch jobs,
  operator scripts).  Opens one persistent TCP connection to a
  contact-point, performs the standard hello handshake with a
  synthetic client address, and exchanges `cluster-client-envelope`
  / `cluster-client-reply` frames.
- `send(targetPath, message)` for fire-and-forget,
  `ask(targetPath, message, timeoutMs?)` for request/reply,
  `close()` for teardown.
- Contact-point failover: tries them in round-robin; the first
  successful dial wins.  Ask rejections come back as deterministic
  Error rejections (path-not-found, timeout, cluster-side ask
  failure).
- `ClusterClientReceptionist` extension — cluster-side endpoint.
  Resolves the target path through the local ActorSystem and
  forwards as tell (no askId) or `ask` (with askId) plus a reply
  frame.  Start once per cluster node that should accept client
  traffic.
- Out of scope for v1: ActorRef payloads (no `encodeRefs` round-trip
  on this path), push-style subscriptions, cluster-aware routing on
  the receptionist side.

### Added — extended cluster-management HTTP endpoints (#56)

- `GET /cluster/shards?type=<typeName>` — shard-to-region map for one
  sharded type, read from the coordinator state stored in
  DistributedData.  Returns 404 if DD isn't started or the type
  hasn't recorded state yet.
- `POST /cluster/down` body `{ address }` — operator-initiated
  force-down of a remote peer.  Backed by a new public
  `cluster.down(addr)` method that emits MemberDown + MemberRemoved
  and tombstones the address.  Opt-in via `enableDownEndpoint`;
  production deployments should still gate this behind an auth
  proxy.
- `GET /metrics` — Prometheus text format from the system's
  MetricsRegistry.  Opt-in via `enableMetricsEndpoint` because most
  deployments scrape metrics from a separate port.

### Added — public Cluster API

- `Cluster.down(addr: NodeAddress | string): boolean` — operator
  force-down of a remote peer.  Symmetric to `Cluster.leave()` but
  for someone else's address.  Returns `true` if the member was
  found and downed, `false` if the address was unknown or already
  terminal.  Refuses to down `selfAddress` — that's `leave()`'s job.

## [0.7.0] — 2026-05-11

### Added — operator-facing documentation under `docs/`

- `docs/operations/rolling-migration.md` (#91) — the canonical
  four-phase rolling-deploy walkthrough on top of `writeVersion` +
  `MasterKeyRing` + `wrapLegacy` + `SchemaRegistry`.  Code-first →
  observation → writer flip → optional cleanup, with the parallel
  master-key-rotation story.  ASCII diagram up top for the elevator
  pitch; symbol-reference table at the bottom mapping every
  mentioned API to its export path.
- `docs/persistence/migration-recipes.md` (#93) — decision-tree
  guide for picking among the five overlapping migration tools
  (`defaultsAdapter` / `migratingAdapter` / `SchemaRegistry` /
  `validatedEventAdapter` / `wrapEventAsEnvelope` + bulk
  migrators).  ASCII flowchart routes "what's the change?" to
  exactly one recipe; each recipe has a worked example and a
  "when NOT to use this" note.  Pitfalls section covers the four
  common questions (mixing adapters, downgrades, snapshots,
  manifest renames).
- `ClusterEvents.MemberRemoved` JSDoc + README clarification (#79)
  spelling out the two paths a removal can take — definitive
  (tombstoned with `removedAt`, pruneable after `tombstoneTtlMs`)
  vs FD-driven (deleted outright so a healed partition recovers).
  Public APIs already filter; only direct iteration of the raw
  membership view needs the explicit status check.
  `MemberStatus`'s `'removed'` enum entry gains a paragraph-length
  docstring with cross-refs to #75 and the event JSDoc.

### Added — broker-actor extensions

- MQTT 5.0 user properties + reason codes (#13) — opt in via
  `protocolVersion: 5` on `MqttActorSettings` (default 4 keeps
  every existing config unchanged).  Inbound `MqttMessage`
  carries optional `userProperties: Record<string, string |
  string[]>` (multi-valued per the MQTT 5.0 spec) and
  `reasonCode?: number`; outbound `MqttPublish` accepts a
  `userProperties` map that the actor attaches to the PUBLISH
  packet's v5 properties block.  On v3.1.1 those fields are
  silently dropped — the wire format has no slot for them.  New
  pure helper `buildPublishProperties(p, protocolVersion)` is
  exported for users testing the v5 path without a broker.
- JetStream pull-consumer mode (#62) — opt in via `consumer.mode:
  'pull'`.  Push remains the default.  In pull mode the actor
  doesn't run an auto-iterating subscription; instead the
  application sends `{ kind: 'fetch'; batch; expiresMs? }` cmds
  to drive batch deliveries.  Per-message ack/nak/term handshake
  is unchanged.  Batch semantics fan out all messages to `target`
  up front, then `Promise.all`-await the per-message acks —
  matches the natural pull-consumer pattern (target processes
  the batch as it likes, acks come back independently).
  `JetStreamClientLike` gains `consumers.get(stream, durable):
  Promise<PullConsumerLike>` for the structural-typing contract.

### Added — cache: bulk operations across all three backends

- `Cache.mget<V>(keys: ReadonlyArray<string>): Promise<Map<string,
  V>>` and `Cache.mset<V>(entries: ReadonlyMap<string, V>,
  ttlMs?: number): Promise<void>` (#14).  Hits land in the result
  Map keyed by request keys; misses (no entry / expired /
  malformed payload / transient backend failure) are simply
  absent — `Map.get(k)` returns `V | undefined` with the same
  "missing key" semantics as the single-key `get`.  Backend
  specifics:
    - **InMemoryCache** — iterates the underlying Map; lazy
      expiry applies to `mget` just like `get`.
    - **RedisCache** — `mget` emits a single `MGET`; `mset`
      without TTL emits a single `MSET`, with TTL falls back to
      pipelined `SET ... PX` (Redis MSET has no per-key TTL).
      `RedisClientLike` gains `mget` and `mset` to satisfy the
      structural-typing contract.
    - **MemcachedCache** — no native bulk ops on the wire;
      falls back to `Promise.all` of single-key calls.

### Added — replicated event sourcing: optional Lease

- `ReplicatedEventSourcedActor.lease()` protected hook (#89).
  Default returns `null` (multi-master, unchanged).  When it
  returns a `Lease`, the actor enforces single-writer mode for
  its `persistenceId`: only the lease holder may `persist`,
  non-holders are observers that throw on `persist` (use the
  `isLeaseHolder` getter to gate side-effect logic before
  calling).  Companion `onLeaseLost(reason)` hook fires when a
  TTL expiry / fence / backend failure flips the actor to
  observer mode.  Same Lease-based pattern v0.6.0's
  ClusterSingleton (#38) and ShardCoordinator (#60) ship —
  different scope (per-pid among replicas instead of
  cluster-wide), same machinery.  Use cases: non-replayable
  side effects (card charges, webhooks) and heartbeat actors
  where N replicas would multiply the rate.

### Changed — `Cache` interface (additive)

- The `Cache` interface gains two REQUIRED methods (`mget` and
  `mset`).  Existing user-side implementations of `Cache` must
  add them — the three shipped backends (`InMemoryCache`,
  `RedisCache`, `MemcachedCache`) are updated.  Pre-1.0
  framework, so this counts as additive evolution rather than
  a tracked breaking change — but worth flagging.

### Removed — `CONTRIBUTING.md`

- `CONTRIBUTING.md` (v0.6.0's #92) is removed.  The doc was
  written under the assumption external contributors would land
  PRs; the actual project posture is single-maintainer and PRs
  aren't accepted.  Internal conventions stay in `CLAUDE.md` /
  the plan-doc / commit-message style.
- Replaced with four issue templates under `.github/ISSUE_TEMPLATE/`:
  `bug_report.yml` (pre-labelled `bug` + `priority: medium`,
  prompts for repro / version / runtime / peer-deps / logs),
  `feature_request.yml` (pre-labelled `enhancement` +
  `priority: low`, use-case + API sketch + acceptance criteria),
  `documentation.yml` (pre-labelled `documentation` +
  `priority: low`, location + kind), and `config.yml`
  (disables blank issues, links to README / ROADMAP / CHANGELOG).
  Closes the original #77 (multi-issue close-syntax — the
  convention itself stays in commit-message style, not docs).

## [0.6.0] — 2026-05-08

### Added — sample apps (chat, voice, six frontends each)

- `examples/chat/` — clustered chat app on a 3-node TCP cluster:
  sharded persistent rooms (`ChatRoomActor` + SQLite journal),
  `OnlineUsersActor` via DistributedData + DistributedPubSub,
  cluster-singleton HTTP front door (auto-failover ~5–10 s), six
  frontends (Plain, Lit, Svelte, React, Next.js, Angular) sharing
  one `protocol.ts` over the wire.
- `examples/voice/` — distributed voice server: 1:1 PTT, group, and
  Teams-style rooms; `MediaRecorder` + `MediaSource` per-sender
  audio relay over WebSocket binary frames; same six-frontend
  matrix.  Plain HTML frontend gates `getUserMedia` on
  `isSecureContext` so Safari quirks surface upfront.
- Chat sample now uses snapshots — `ChatRoomActor.snapshotPolicy`
  via `everyNEvents(100)` + `SqliteSnapshotStore` (#102), and
  optional TLS / WSS via `--tls-cert` / `--tls-key`
  (Fastify `https` option threaded through `FastifyBackend`),
  with frontends auto-switching to `wss:` based on
  `location.protocol` (#101).

### Added — observability bridges to industry-standard SDKs

- `promClientRegistry({ client, registry, namePrefix? })` in
  `src/metrics/PromClientAdapter.ts` — bridges the framework's
  `MetricsRegistry` to a user-owned `prom-client` registry so app
  + framework metrics share one `/metrics` endpoint.  Structural
  typing on `PromClientLike` keeps `prom-client` an optional peer
  dep with no hard `import` (#64).
- `otelTracer({ api, tracer?, tracerName?, tracerVersion? })` in
  `src/tracing/OtelAdapter.ts` — bridges the framework's `Tracer`
  to `@opentelemetry/api`.  W3C `traceparent` cross-actor /
  cross-cluster propagation; `SpanKind` / `SpanStatusCode` mapping
  via lookup tables; same structural-typing approach so the OTel
  SDK stays optional (#63).
- README documents both adapters with end-to-end snippets in a new
  "Observability — Prometheus + OpenTelemetry" section.  See also
  `examples/management/prom-client-shared.ts` and
  `otel-jaeger.ts`.

### Added — persistence query: multi-tag filter

- `eventsByTag` accepts a `TagFilter` object combining three
  operators (#90):
    - `all: [...]` — intersect (every listed tag must appear).
    - `any: [...]` — union (at least one listed tag must appear).
    - `not: [...]` — exclusion (no listed tag may appear).
  A bare string stays a back-compat shorthand for `{ all: [tag] }`.
- `InMemoryQuery` does the whole match in JS.  `SqliteQuery` pushes
  the filter into SQL — `JOIN events_tags` for `all`, `IN (?,?,…)`
  with `DISTINCT` for `any`, JS-refines `not`.  Prepared statements
  cached per arity.
- `CassandraQuery` follows the same three strategies once the new
  optional `events_by_tag` side table is populated (`useTagIndex:
  true` on `CassandraJournal`).  DDL + dual-write per `(event, tag)`
  pair, exposed via `tagIndexDdl` (#44).

### Added — cluster lifecycle: TTL tombstones + LRU sharding

- Cluster-member tombstone pruning (#75) — `Member.removedAt`
  travels in gossip; new `tombstoneTtlMs` (24 h),
  `tombstonePruneIntervalMs` (5 min), `tombstoneMinRetentionMs`
  (`6 × downAfterMs`) settings; `mergeMember` rejects expired
  tombstones from gossip so a slow peer can't resurrect addresses
  already pruned cluster-wide.
- ClusterSharding `maxEntities` cap with LRU passivation (#82) —
  when the local region is at capacity, the entity with the oldest
  `lastActivity` is passivated to make room.  Default `0` (no
  cap, current behaviour); already-passivating entities don't
  count toward the cap.
- Cassandra-backed `RememberEntitiesStore` (#84) — state-based
  schema (`(type_name, shard_id, entity_id) → started_at`),
  partition-by-type for atomic whole-partition `clear`.  Both
  `JournalRememberEntitiesStore` and `CassandraRememberEntitiesStore`
  now exported from `cluster/index.ts`.

### Added — framework primitives: FSM, supervision, throttle

- `PersistentFSM.stateTimeout` (#65) — declare a per-state
  `_timeout: { afterMs, event, next, guard? }` to auto-fire a
  transition when no command moves the FSM out within the window.
  Routes the timeout fire through the actor mailbox via a magic
  self-tell so it serialises cleanly with concurrent commands;
  recovery re-arms the timer relative to wall-clock at recovery
  completion.
- `PersistentFSM` multi-event transitions (#66) — `event` in the
  transitions table accepts `Event[]` (or a function returning one)
  alongside the single-Event form.  Multiple events persist
  atomically via `persistAll`; final-state vs `next` check fires
  against the post-replay state.
- `BackoffSupervisor.triggerOn: 'failure' | 'stop' | 'any'` (#68)
  — split crash-only vs clean-stop respawn (mirrors Akka's
  `Backoff.onFailure` / `Backoff.onStop`).  Default `'any'` keeps
  the v1 behaviour.
- `BackoffSupervisor.forwardDuringGrace: false` (#67) — opt-in
  strict gate: messages arriving in the post-respawn grace window
  stash until the child confirms it survived `drainGraceMs`.  Fixes
  the dead-letter cascade described in the issue at the cost of
  `drainGraceMs` of latency on the first message after each
  respawn.
- `context.throttle({ qps, burst, onExcess: 'pause' | 'drop' })`
  per-actor token-bucket rate limiter (#83).  New `TokenBucket`
  utility class (`src/util/TokenBucket.ts`) — pure, clock-injected,
  refill-on-read.  System messages bypass the gate so lifecycle
  stays responsive under tight throttles.
- `EventStream.subscribe(actor, channel, predicate)` overload
  (#85) — predicate-filtered subscriptions, evaluated before
  delivery; throwing predicates are treated as no-match and the
  bus stays alive for other subscribers.

### Added — broker actors: long-running handler heartbeat

- `KafkaActor` `heartbeat` command + `withAutoHeartbeat` helper
  (#78) — long manual-commit handlers can periodically tell
  `{ kind: 'heartbeat', topic, partition, offset }` to bump
  kafkajs's session-deadline mid-processing.  The convenience
  helper wraps a body in a `setInterval` that fires the cmd at
  ~1/3 of session-timeout.

### Added — DX: CONTRIBUTING.md

- New `CONTRIBUTING.md` covers the workflow this project actually
  uses: setup, test layout (unit / multi-node / smoke /
  cross-runtime), commit conventions, the multi-issue close-syntax
  gotcha (`Closes #N. Closes #M.` — separate keywords required),
  Co-Authored-By trailer convention, pre-1.0 release stance, code
  style (#92, #77).

### Added — multi-node test harness + cluster sharding hardening

- `MultiNodeSpec` test harness — in-process N-role cluster with
  failure-detector tightening, partition / heal helpers,
  `awaitMembers` / `awaitMemberStatus` / `awaitLeader` synchronisation,
  per-role downing-provider injection (#34).
- `ParallelMultiNodeSpec` — worker-thread variant for tests that need
  true parallelism across OS threads (#46).
- Sharding rebalance hardening + sharded-daemon failover; `Passivate`
  semantics across shard hand-off; coordinator state machine
  reviewed against partition / leader-change scenarios (#35).
- Persistent `ShardCoordinator` allocation state via `DistributedData`
  — survives leader hand-off without re-emitting allocations (#39).
- Persistent Remember-Entities — entity list rides through cluster
  restart instead of being re-discovered lazily (#49).
- `KubernetesLease` real implementation against the K8s coordination
  API (replaces the stub from 0.2) (#33).
- `ClusterSingleton` accepts an optional Lease for split-brain-safe
  handover (#38, #61).
- `ShardCoordinator` accepts an optional Lease for split-brain-safe
  coordinator handover (#60).
- `LeaseMajority` split-brain resolver — external Lease as tiebreaker
  in the partition-resolution race (#51).

### Added — persistence performance + projections + replicated ES

- Persistence Query / projections read-side query layer:
  `PersistenceQuery` with `eventsByPersistenceId` / `eventsByTag`, plus
  `ProjectionActor` with at-least-once delivery + offset persistence
  (`InMemoryOffsetStore`, `DurableStateOffsetStore`) (#36).
- Push-based `PersistenceQuery` — events delivered on append via
  `JournalEventBus` instead of polling (#42).
- SQLite tags join table — indexed `events_by_tag` query path (#43).
- Snapshotting for `ReplicatedEventSourcedActor` — vector-clock-aware
  snapshots survive multi-master replay (#41).
- Durable `DistributedData` — CRDT state survives full cluster
  restart via per-replica `DurableStateStore` records (#40).
- CRDTs + Replicated Event Sourcing core: `GCounter`, `PNCounter`,
  `GSet`, `ORSet`, `LWWRegister`, `DistributedData` extension with
  gossip replication; `ReplicatedEventSourcedActor` for multi-master
  event sourcing with conflict-resolver pluggability (#37).

### Added — additional CRDTs + persistent FSM + DX patterns

- `LWWMap`, `ORMap`, `MVRegister`, `GCounterMap` — round out the CRDT
  family.  All four implement the same `Crdt<Self>` interface,
  expose `equals` / `toJSON` / `fromJSON`, and are wired into
  `DistributedData`'s discriminator (#45).
- `PersistentFSM` — finite-state machine combined with event sourcing.
  Declare a transitions table, an `applyEvent` function, and the
  base class handles invalid-transition rejection, guard checks,
  and replay-driven state rebuild (#52).
- `BackoffSupervisor` — restart-with-exponential-backoff supervisor
  for transient failures, with optional message stash during the
  backoff window and a configurable counter-reset rule (#48).
- `ClusterRouter` — cluster-aware router with role filter + four
  routing strategies (round-robin, random, consistent-hashing,
  broadcast).  Routees auto-rebuild on `MemberUp` / `MemberRemoved`
  (#50).

### Added — observability stack

- `LogContext` — Mapped Diagnostic Context (MDC) backed by
  `AsyncLocalStorage`.  Propagates through `tell` / `ask` calls and
  across cluster nodes; `Logger.withFields` for static fields,
  `LogContext.run` / `with` for dynamic scoping (#53).
- Prometheus / OpenMetrics export — `MetricsRegistry` with
  Counter / Gauge / Histogram primitives, label support,
  `exportPrometheus` text-format renderer, `prometheusHandler`
  for `Bun.serve`.  Stock instrumentation: actor lifecycle counters,
  message-handler-duration histogram, cluster gossip + member-up
  metrics.  Opt-in via `MetricsExtensionId.enable()` so the no-
  metrics path is zero-cost (#11).
- OpenTelemetry-style distributed tracing — `Tracer` interface +
  `RecordingTracer` reference impl + W3C `traceparent` codec.
  `actor.receive` and `cluster.envelope.received` spans wired
  automatically; trace context rides cross-wire envelopes
  alongside MDC.  `@opentelemetry/api` is NOT a dependency — users
  bring their own SDK and wrap it in the framework's `Tracer` (#10).

### Added — schema migration & encryption polish

- Master-key rotation for client-side AES-256-GCM snapshots — new
  `MasterKeyRing` shape (`active` + `retired`), key-version byte
  in the body manifest (`FLAG_KEY_VERSIONED`), legacy single-key
  bodies remain readable (#8).
- Rolling-deployment-friendly schema migration — `MigrationChain`
  gains downcasters; `migratingAdapter` / `defaultsAdapter` accept
  a `writeVersion` so v2 nodes can keep emitting v1 events while
  v1 readers still exist (#7).
- One-shot migration helpers — `wrapEventAsEnvelope` /
  `wrapStateAsEnvelope` primitives plus `migrateInMemoryJournal` /
  `migrateSnapshotStore` bulk-rewriters for repos adopting
  schema-evolution after-the-fact (#9).
- Pluggable codec + in-process schema registry — `Codec<T>`
  interface with `jsonCodec` / `zodCodec` / `composeCodecs`,
  `validatedEventAdapter` / `validatedSnapshotAdapter` wrappers,
  `InMemorySchemaRegistry` with on-register compatibility checks
  (`'none'` / `'backward'` / `'sample'`) (#6).

### Added — production-grade brokers & WebSocket server-side

- Kafka exactly-once via manual offset-commit mode — opt-in
  `commitMode: 'manual'` pumps each message into a pending-promise
  map until the handler sends `commit` / `nack` / timeout fires;
  `commitOffsets` uses BigInt arithmetic so 2^53+ offsets stay
  exact (#2).
- NATS JetStream actor — durable streams + push consumer with
  `ack` / `nak` / `term` / `inProgress` handshake; auto-create-or-
  update streams + consumers; idempotent publish via `messageId`
  (`Nats-Msg-Id`) (#3).
- Server-side WebSocket — `ServerWebSocketActor` wraps a pre-
  upgraded socket; `serverWebSocketActorOf` for the `ws`-package
  family (Fastify, Hono); `bunWebSocketHandlers` for `Bun.serve`'s
  callback-style API (#1).

### Fixed

- `DistributedPubSubMediator` — gossip frame trimmed to topic
  names only (#80).  The `entries` field used to be `Record<string,
  string[]>` carrying every local subscriber's actor path per
  topic, but `handleGossip` discarded the path lists; bytes are
  now proportional to topic count, not subscriber count.  Audit
  tests pin the boundedness contract: 100 sub/unsub cycles on
  the same topic leave both `topics` and the gossip frame at
  zero entries.
- `FilesystemObjectStorageBackend` is multi-process safe (#19) —
  drops the in-memory etag map (disk is canonical via
  deterministic FNV-1a content hash) and serialises CAS via
  per-key `<key>.lock` files created with `fs.writeFile(...,
  { flag: 'wx' })`.  Body writes are atomic via temp + rename;
  Windows quirks (`EPERM` / `EBUSY` during NTFS deletion-pending
  states) recognised as benign retry signals; stale locks
  (>30 s default) reclaimed automatically.  Includes a Bun-spawn-
  based multi-process test as the integration check.
- `DistributedPubSubMediator` — eager broadcast on subscribe /
  unsubscribe.  The previous "one random peer per gossip tick"
  scheme had a probabilistic gap (~3 % per 5-tick window) where
  a publish-immediately-after-subscribe could miss the new
  subscriber.  Eager-broadcast on state mutation closes the gap
  deterministically; periodic gossip stays as steady-state
  anti-entropy.  Eliminated CI flake on
  `tests/multi-node/pubsub-cross-node.test.ts` and
  `tests/multi-node/parallel-pubsub.test.ts`.
- `tests/multi-node/cluster-router.test.ts` — replaced the tight
  5 s `waitFor(() => total === 21)` predicate with a "3 readings
  stable" stability check + 15 s timeout, covering CI variance
  when other multi-node test files run in parallel (#76).
- Five small correctness items batched together: `tests/unit/util/
  Option.test.ts` typecheck:dev failure (#17), eager peer-dep
  validation at object-storage plugin-init for every codec
  (#18, #59), `ORSet` / `GSet` element-identity callbacks for
  non-JSON-serialisable values (#57), single-actor-per-pid
  enforcement for `ReplicatedEventSourcedActor` (#58).

## [0.5.0] — 2026-04-27

### Added — I/O & message-broker actors

- `BrokerActor` base with reconnect (exponential backoff + optional
  CircuitBreaker), outbound buffer, subscriber fan-out, lifecycle
  events on the EventStream, and a 3-layer settings resolver
  (constructor → HOCON → defaults).
- Phase 1 actors: `TcpSocketActor`, `UdpSocketActor`, `MqttActor`,
  `WebSocketActor`.
- Phase 2 actors: `KafkaActor`, `AmqpActor`, `GrpcClientActor`,
  `GrpcServerActor`.
- Phase 3 actors: `NatsActor`, `RedisStreamsActor`, `SseActor`.
- Examples: `examples/io/{mqtt-temperature,websocket-feed,grpc-sensor}.ts`.

## [0.4.0] — 2026-04-27

### Added — object-storage + schema migration + caching

- Object-storage persistence: `ObjectStorageBackend` interface,
  `FilesystemObjectStorageBackend` (built-in), `S3ObjectStorageBackend`
  (lazy AWS SDK; works against AWS / MinIO / R2 / Backblaze B2 /
  Wasabi).  `BodyCodec` with manifest header — gzip / zstd
  compression and AES-256-GCM client-side encryption (HKDF-SHA256
  per-pid subkey derivation, compress-then-encrypt).
- `ObjectStorageSnapshotStore` + `ObjectStorageDurableStateStore` with
  per-prefix compression / encryption resolvers and per-actor
  overrides via `PersistenceOptions`.
- Schema migration: `EventAdapter` / `SnapshotAdapter` / `StateAdapter`
  interfaces with a versioned `_v / _t / _e` envelope wire format,
  plus `MigrationChain` for hand-written upcasters and
  `defaultsAdapter` for additive evolution without code.  Hooks
  on `PersistentActor` + `DurableStateActor`.
- Cache abstraction: `Cache` interface (get / set / incr /
  setIfAbsent / delete) + 3 backends (`InMemoryCache`, `RedisCache`
  via lazy ioredis, `MemcachedCache` via lazy memjs).
  `CacheExtension` for named-cache registration.
- HTTP middleware: `rateLimit`, `idempotent` (Stripe-style), `cached`
  (response-cache with stampede protection).
- `CachedSnapshotStore` decorator wrapping any `SnapshotStore` for
  cold-start storms after sharding rebalance.
- Examples: `examples/cache/redis-rest-service.ts`,
  `examples/persistence/{event-migration,event-migration-chain,
  s3-snapshot-bank-account}.ts`.

## [0.3.0] — 2026-04-27

### Added — persistence + HTTP

- Persistence: `Journal`, `SnapshotStore`, `DurableStateStore`
  interfaces.  `PersistentActor` (event sourcing with
  snapshotPolicy + persist callback) and `DurableStateActor`
  (snapshot-only with strict CAS via expectedRevision).
- Three persistence backends ship: `InMemoryJournal` /
  `InMemorySnapshotStore` (default), `SqliteJournal` /
  `SqliteSnapshotStore` (Bun via bun:sqlite, Node via
  better-sqlite3 — abstracted by a `SqliteDriver`), `CassandraJournal`
  / `CassandraSnapshotStore` (lazy cassandra-driver).
- HTTP service stack: directives DSL (get / post / put / del / patch /
  path / pathPrefix / concat) compiling to backend-agnostic
  `CompiledRoute`; three backends — `FastifyBackend` (default),
  `ExpressBackend`, `HonoBackend` (with auto-detection of the right
  serve primitive per runtime).  `HttpClient` for outbound calls.

## [0.2.0] — 2026-04-27

### Added — distributed primitives

- HOCON config (parser + ENV interpolation + Duration / Size types).
- JSON + CBOR serialization (`Serializer<T>` interface with manifest
  tagging; SerializationExtension for plugin registration).
- `CoordinatedShutdown` (12-phase, dependency-ordered task runner) and
  `Lease` abstraction (with InMemoryLease + KubernetesLease impls).
- Cluster fabric: TCP / in-memory / worker-thread transports;
  membership state machine + gossip; failure detection (Phi-Accrual
  default + simple time-threshold variant); `ClusterEvents` on
  EventStream.
- Cluster sharding: `ShardCoordinator`, `ShardRegion`,
  `ClusterSharding` extension; `HashAllocationStrategy` /
  `LeastShardAllocationStrategy`; `Passivate` for entity lifecycle;
  `ShardedDaemonProcess` for fixed N workers across the cluster.
- Distributed pub/sub (`DistributedPubSubMediator`); `Receptionist`
  service-key registry; `ClusterSingleton` (manager + proxy + lease-
  based variant); `ReliableDelivery` (at-least-once point-to-point
  with explicit acks).
- Four split-brain resolvers (KeepMajority / KeepOldest /
  StaticQuorum / KeepReferee).
- Four seed providers (Config / DNS / Kubernetes API / Aggregate),
  with an in-process TTL cache on the DNS provider.
- Management endpoints: `/health`, `/ready`, `/cluster/state`, etc.

## [0.1.0] — 2026-04-27

### Added — minimum viable actor system

- `Actor` base class + lifecycle hooks (preStart / postStop /
  preRestart / postRestart) + `ActorRef` / `ActorContext` /
  `ActorPath` / `ActorSelection`.
- `ActorSystem`, `Props`, `Extension` registry, `SystemMessages` (the
  internal control protocol — Watch / Unwatch / Terminated / Suspend
  / Resume / Stop / …).
- Supervision: `OneForOneStrategy` / `AllForOneStrategy` with Resume
  / Restart / Stop / Escalate directives.
- Mailbox variants: unbounded (default), bounded with three overflow
  policies, priority (with caller-supplied comparator), per-actor
  stash.
- `ActorCell` + `Guardian` + `DeadLetterRef` + `LocalActorRef` +
  `PromiseActorRef`; deathwatch, `ReceiveTimeout`, become / unbecome,
  per-actor `TimerScheduler`.
- `Scheduler` (real timers + `ManualScheduler` for tests),
  `Dispatcher` variants, `Logger` (leveled + Noop), `EventStream`
  (system-wide pub/sub on classes).
- `typed` Behaviors DSL — functional facade over the OO API
  (`Behaviors.receive`, `Behaviors.same`, `Behaviors.stopped`,
  `Behaviors.setup`, supervise + withSupervision).
- TestKit: `TestProbe` (synchronous mailbox with expect-* timeouts),
  `ManualScheduler` (virtual clock).
- Patterns: `ask` (Promise-returning send) + `retry` (exponential
  backoff) + `CircuitBreaker` + `Router` (round-robin / random /
  broadcast) + `after` + `pipeTo`.
- `FSM` DSL — named-state finite-state-machine actor base.
- Utility primitives: `Option<T>`, `Lazy<T>`, `Try<T>`, `Either<L,R>` —
  Scala-style ergonomics, used throughout.
