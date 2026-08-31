# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a pre-1.0 hobby project — every minor version is potentially
breaking.  See `ROADMAP.md` for what's coming, and `README.md` →
"What is this?" for current scope honesty.

## [Unreleased]

### Added

- **The flake catalog names the third shape of the fixed-cap failure — real
  work in a *test body*** (#1393).  `docs/…/testing/diagnosing-flakes.mdx`
  covered bun's 5 000 ms cap twice, one level apart: a budget that cannot reach
  it (remedy, a third argument) and real work in a hook (remedy, layered
  budgets).  #1392 was neither, and a reader who pattern-matches to the nearest
  entry picks a remedy that does not fit — a third argument sizes a *failure
  budget*, a wait meant to expire and print a label, and bounded work has none;
  layered budgets need a spawn boundary the inner operation can carry a timeout
  across, and there is none.  The remedy that is right — module scope carries no
  per-test timeout at all — was written nowhere, although three guards already
  depend on it.  Both mirrors gain a catalog row and a section, with the
  measured figures and the module-scope fixture that settles the mechanism in
  one run.  It also records a negative result: the hook section's sizing advice
  (run several copies of the file at once) does **not** transfer, because the
  pre-fix file under 12 concurrent CPU hogs still completed in 31.45 ms and
  passed — external load competes with *spawned* work, while in-process work is
  slowed by the host process's own heap, garbage collection and coverage
  counters.

### Fixed

- **The supply-chain page said the SBOM starts "from the next release
  onward", and then v0.17.0 shipped it — so the sentence began pointing past
  the release the reader had just downloaded** (#1391).  The claim was
  correct when written and became wrong on publication, because it was
  relative to a moving point: read from a repository whose latest release is
  v0.17.0, "the next release" is v0.18.0.  Both language mirrors now name
  v0.17.0 as the first release carrying `actor-ts-sbom.cyclonedx.json` — in
  the frontmatter, the artifact table and the aside — and still say plainly
  that v0.16.0 and everything before it carry none, so the qualification
  moves to a fixed point rather than being dropped.  `CHANGELOG.md` gets the
  same fixed wording, and `tests/unit/ci/SupplyChainDocs.test.ts`, which pins
  these sentences by literal text so the prose half of #539 cannot rot again,
  moves in the same commit.  Its no-concrete-tag rule for `gh release
  download` is untouched: a tag pinned in prose would now rot at v0.18.0
  exactly as v0.16.0 did.
- **`CoreStaticImports` walked a 148-file import closure inside the test body,
  so bun's 5 000 ms per-test default killed the #1005 gate under a loaded
  coverage run** (#1392).  Neither test declared a third argument and
  `bunfig.toml` raises nothing, so the cap was bun's default; what ran against
  it was `staticClosure('src/ActorSystem.ts')` — 148 files, 1.28 MiB of source,
  29 ms of real work on an idle machine.  Observed at 6 723.89 ms in a full
  `ACTOR_TS_SKIP_FLAKY_MNS=1 bun run test:coverage:gate` run on Windows /
  bun 1.4.0 — roughly 230x — having passed a gated run earlier the same day and
  passing standalone in 276 ms: the failure reported the machine, not the
  invariant.  Both closures are now walked at module scope, which carries no
  per-test timeout at all (measured), and which is the shape the sibling
  repo-file guards `AwaitConditionBudgets`, `WorkflowHygiene` and
  `NoDeadConfigKeys` already use.  The two assertions are untouched — `ActorSystem`
  is still proven never to statically reach `FastifyBackend.ts` or a bare
  `fastify`, and the canary still proves the walker is not blind — while the
  test bodies drop from 29.15 ms and 1.24 ms to 0.41 ms and 0.04 ms, which puts
  the same contention at ~95 ms against the 5 000 ms cap.  A larger third
  argument was the other option and is the wrong one here: that remedy is for a
  *failure budget*, one meant to expire and print a label, and a literal cap
  would be one more encoded assumption about machine speed — the shared defect
  #1376 is open to remove.
- **`TreeShaking` built four bundles inside three test bodies, against the same
  unset cap — 3.7x the exposure of the test that had already timed out**
  (#1394).  Caught before it was ever observed failing, rather than after.  None
  of the three tests declared a third argument, so four `Bun.build` calls raced
  bun's 5 000 ms default; measured idle with the junit reporter the bodies were
  0.6 ms, 66.5 ms, 30.1 ms and 109.7 ms, and that heaviest one is 3.7x the
  29.1 ms `CoreStaticImports` was doing when a full coverage run stretched it
  ~230x and bun killed it.  The bundles are now built at module scope — top-level
  await, already used at
  `tests/integration/in-process/persistence/journals/NodeSqliteDriver.test.ts:22`
  — which also removed a duplicate: the narrow bundle was built twice from
  byte-identical source, so three builds now do what four did.  The five
  assertions are unchanged, and the bodies drop to 0.58 / 0.05 / 0.05 / 0.04 ms.
- **`throttle({ qps: Infinity })` threw `TokenBucket: qps must be > 0, got
  Infinity` instead of clearing the limiter — flatly contradicting its own
  JSDoc, which documents `{ qps: Infinity }` as a way to remove a throttle**
  (#636).  `ActorContext.throttle` promised the sentinel but `ActorCell`
  passed it straight into a `TokenBucket`, whose constructor rejects any
  non-finite `qps`, so the throw escaped into user code rather than flowing
  through supervision.  `qps: Infinity` now removes the throttle (exactly
  like `cancelThrottle()` — an unlimited rate installs no bucket), and a new
  `ThrottleOptionsValidator` rejects an invalid `qps` / `burst` / `onExcess`
  up front with an `OptionsError` naming the field, rather than a bare
  `Error` from deep in the runtime.  Throttle options gain the standard
  `XOptions` family (a fluent `ThrottleOptions` builder alongside the plain
  object), and the per-actor throttle now has a dedicated docs page
  (`fundamentals/throttling`, EN + DE).

## [0.17.0] — 2026-08-29

### Added

- **Cluster readiness — wait until the cluster is actually formed**
  (#1355).  `cluster.awaitReady({ minimumMembers, timeoutMs })` resolves
  once this node is a full member (`up` — `weakly-up` deliberately does not
  count, matching the `/ready` endpoint's `cluster-membership` check) and
  the cluster has at least `minimumMembers` up members; without `timeoutMs`
  it waits indefinitely, `whenTerminated()`-style, and `cluster.isReady()`
  is the synchronous probe.  On a named deadline it rejects with
  `ClusterReadyTimeoutError`, whose fields carry self's status, the up
  count, the bar and the budget.  Deliberately membership-only — never the
  `HealthCheckRegistry` aggregate, whose app-registered checks may depend
  on initialisation that runs *after* bootstrap; `/ready` stays the load
  balancer's view.

  New observables: `cluster.selfMember()` (own record, tombstone included),
  `cluster.selfElected` and `BootstrappedCluster.formedNewCluster` — a node
  that founded its cluster is now distinguishable from one that joined an
  existing one (#943), and `JoinTargets` carries `selfElectionGraceMs` for
  every node.  HOCON: `actor-ts.cluster.bootstrap.minimum-members` ships as
  a leaf (default 1 — single-node development stays zero-config);
  `await-ready` ships comment-only, because a leaf that is always present
  could not express "unset", and unset is what selects the grace-aware
  computed default.

- **Storage locality + identity: a cluster now says when two nodes are
  not reading the same database** (#1356, #1358). Two nodes over
  per-node storage — a SQLite file each, the in-memory defaults, or two
  separate instances of a shared-capable backend — fork every entity's
  history silently: each node's optimistic head check runs against its
  own database, so `JournalConcurrencyError` structurally cannot fire
  across nodes, and a rebalanced entity recovers whatever its
  destination holds. Nothing in the framework could even see the
  combination. Now two independent guards can:

  - Every in-repo store declares
    `storageLocality: 'node-local' | 'shared'` (an optional contract
    member on `Journal`, `SnapshotStore`, `DurableStateStore` and
    `ObjectStorageBackend` — absence means unknown and stays silent, so
    third-party stores are never misjudged; instance-level, so a
    genuinely shared in-memory fixture declares itself `'shared'`). A
    `'node-local'` store backing a `PersistentActor` or
    `DurableStateActor` while the cluster has — or later gains — remote
    peers logs one warning per store kind (needle: `node-local
    storage`). Single-node systems, clusters without persistent actors,
    and replicated event sourcing (whose per-node journals are the
    design) stay silent structurally.
  - Every in-repo store also mints a random **storage identity** on
    first contact and persists it in the database itself
    (`storageIdentity()` — a one-row `storage_identity` table on the
    SQL family, an LWT row on Cassandra, a `$setOnInsert` document on
    MongoDB, a sentinel item per table on DynamoDB, an object under
    `storage-identity` on object storage, a per-instance value
    in-memory). Nodes gossip the identities of the stores they actually
    use as an optional member-record field — mixed-version safe, capped
    and type-checked off the wire — and any node that sees a peer claim
    a different identity for the same store kind warns once per kind
    (needle: `storage identity differs`). That is the check the
    locality declaration cannot make: two nodes each on their *own*
    Postgres, a stale connection string, a restored backup. Resolution
    is cluster-gated — a system that never clusters never mints — and
    the claims ride an overlay lane outside the member version clock,
    because a version bump raced the leader's `joining → up` promotion
    to the same value and wedged cluster formation.

  Docs: a new "Storage locality & identity" section anchors the
  persistence overview (EN+DE), with a "shared across nodes" column in
  the backend matrix and corrections to the pages that presented
  per-node SQLite in a cluster as workable.

- **`ClusterOptions.advertisedHost`** (#944), with
  `withAdvertisedHost(...)` on both the cluster and the bootstrap
  builders and `actor-ts.remote.tcp.advertised-host` in HOCON. A node's
  bind address and the address it tells peers to dial are two different
  things, and only one of them may be a wildcard: `host` is the
  interface to bind and keeps `0.0.0.0` as its default, `advertisedHost`
  is the identity that travels in every gossip frame, heartbeat and
  member record.

  The Kubernetes shape is what the split is for — bind `0.0.0.0` because
  the pod does not know its address at start-up, advertise `POD_IP`
  because that is the one the platform assigned. Left unset,
  `advertisedHost` is derived: from `host` when that is routable, else
  from `CLUSTER_HOST` / `POD_IP` / `HOSTNAME`, else loopback. So naming
  one routable host still does both jobs, exactly as before.

  The HOCON key ships **no leaf** in `reference.conf`, only a comment. A
  key that is always present could not express "unset", and unset is
  what makes that fallback chain reachable — the same shape
  `sharding.shard-passivation-idle` already uses.

- **Pause and resume time in DevTools** (#1349). One control in the header,
  or the <kbd>P</kbd> key outside a text field, stops every panel at once
  so there is time to read what is on screen.

  Two things stop, and the second is the point. The data stops, obviously.
  But the *clock the panels are read against* stops with it — uptime, a
  departed node's "last seen", and the "stopped 12s ago" badge on a
  terminated actor. A pause that froze only delivery would still let the
  actors panel sweep a tombstone away 30 seconds later, which is the exact
  row somebody paused to study, and it would do it quietly. Three tests
  fail if the clock is left running and none of the other eighty-eight
  notice, which is why they exist.

  Nothing that happens during the pause is lost, but the two kinds of
  stream get there differently. The event tail, tracing spans and profiler
  frames are *held* and delivered in order on resume: a tail is its frames
  and the server keeps no past to recover them from, so dropping them
  would lose them outright. The overview figures, actor tree, cluster view
  and mailbox depths are discarded and re-fetched as a fresh snapshot,
  which is exact and cheaper than replaying deltas — reusing the path the
  client already takes on a sequence gap rather than inventing a second
  one. Held frames are capped per stream, and the header names anything
  the cap threw away rather than shortening a tail in silence.

  The charts get no hole: the server records continuously, so resuming
  re-reads the window and the paused stretch fills in.

  Two things deliberately do not stop. A connection that dies while paused
  still raises the offline dialog — a paused screen and a dead one look
  identical, so the one you did not ask for has to say so. And the taps
  keep running, so pausing is a property of your view rather than of the
  system being watched, and costs the actor system nothing.

- **A send-message action in DevTools** (#553), **off by default**. Every
  other panel reads; this one writes a JSON message into a running system,
  so it is disabled until acknowledged in code with
  `DevToolsOptions.withAllowMessageSending()`.

  Two switches, and only one is a security decision: `panels: { send:
  false }` hides the view, `allowMessageSending` grants the capability.
  While the acknowledgement is unset the `actors.send` method is never
  registered, so a client that knows the name is told there is no such
  method rather than being refused by a guard it might argue with.

  Bounds when it is on: JSON object or array only, at most 64 KiB, and
  the recipient must be under `/user`. The message is sent with no sender,
  so a reply goes to dead letters rather than to an actor that never sent
  anything. One bound is structural rather than checked, which is why it
  holds: the body is JSON, so it cannot be a `PoisonPill` or any other
  class the system treats specially.

- **A resolved-configuration panel in DevTools** (#553). Every HOCON key,
  its effective value, and which of the three layers put it there —
  `reference.conf`, `application.conf`, or a code override — plus whether
  it displaced a lower one and where `application.conf` was read from.

  A merged tree answers "what is this setting now"; the question that
  brings someone here is "why is it not what I wrote", which needs the
  layer as well as the value. `Config.load` now keeps the layers it merged
  so the answer is looked up rather than inferred — a config built any
  other way reports that it cannot attribute, instead of guessing.

  Values whose key names a secret (`pass`, `secret`, `token`, `key`,
  `credential`, `auth`) are redacted before they leave the process. By key
  rather than by value: a password that happens to look ordinary is still
  a password. Switch the panel off with `panels: { config: false }` where
  even a redacted tree says too much.

- **An event-stream panel in DevTools** (#553). A live tail of the system
  bus — actor lifecycle events, dead letters, and whatever your actors
  publish — with a filter over type and payload and the cluster PubSub
  topics beside it. Pausing the tail is the header's job (#1349).

  It needs a seam the bus did not have: `EventStream._observe`, one
  internal slot checked on every publish. It is checked BEFORE the
  empty-stream early return, deliberately — an observer placed after it
  sees nothing on a system nobody else subscribes to, which is exactly the
  system a developer opens this panel on. Six tests fail if it moves.

  **The observer is installed only while a panel is subscribed**, unlike
  the span tap, which records from attach. Tracing is opt-in already; the
  event bus is always live, so an always-on observer would run on every
  actor start and stop for a panel nobody opened. The trade is that the
  panel opens empty and fills, which is what a tail is.

  Events are batched on a tick and capped by `eventBufferCapacity`
  (default 500). Past it the oldest are dropped and the panel says how
  many: a tail that silently skips is worse than one that admits it,
  because the reader draws conclusions from what is not there.

- **A dead-letter panel in DevTools** (#553). A message that cannot be
  delivered throws nothing and logs nothing by default — `tell` returns, the
  sender carries on, and the work never happens. That silence is what makes
  the failure easy to miss, and the panel is where it becomes visible:
  recipient, sender, message type, replay count, and the payload on click.

  It reads the queue from #433 through a new `deadletters.list` request
  method, polling once a second rather than streaming — the queue is a
  bounded ring the server already keeps, and pushing every capture would put
  DevTools on the delivery path of the very failures it is watching.

  The queue is off by default, and the panel says so rather than showing an
  empty table: "nothing is broken" and "nothing is being recorded" are
  opposite answers that an empty table gives identically. Payloads are
  sanitised through the wire serialiser, and one the queue could not keep
  names the reason instead of rendering a `null` that reads like an empty
  message. Switch it off with `panels: { deadLetters: false }` wherever the
  payloads are not the operator's to read.

- **The DevTools UI has tests** (#487, part of #482). Roughly 3,000 lines of it
  had none, which was the migration's whole point. Fifty tests across two
  runners: the framework-free half stays on `bun test`, and the Angular half
  runs under Vitest in jsdom as `bun run test:ui`, wired into CI and
  `prepublishOnly`.

  The most valuable of them cover `TapClientService` against a socket the test
  drives — reconnect backoff, `incompatible` never retrying, a sequence gap
  re-subscribing instead of rendering a diverged tree, refcounted
  subscribe/unsubscribe, and request/response resolution. Every one of those
  failure modes is silent in production: a broken refcount leaves the actor
  system producing frames for a panel nobody is looking at, and a missed gap
  renders a tree that quietly disagrees with the real one. None of it was
  reachable from a test until #485 added a seam for the socket constructor.

  The chart-option builders are asserted as plain objects, which is what keeps
  charts testable without a browser — and where `yAxis.min: 0` and
  `xAxis.type: 'time'` are pinned. Both invariants were enforced by
  `projectPoints` until #486 deleted it with its renderer, and ECharts has
  neither by default.

  Two runners sharing one tree needed one accommodation: the Angular specs are
  `.ng-spec.ts`, because `bun test` collects `*.spec.ts` anywhere in the
  repository and tried to run eighteen of them without Vitest or a DOM. The
  coverage gate was measured before and after, as the issue asked rather than
  assumed: 93.68 % to 93.54 %, both far above the 80 % floor.

- **Dead letters can now be replayed to a recipient other than the one they
  were addressed to — `deadLetterQueue.replay(id, alternateRecipientPath)`
  (#433).**

  The recorded path is not resolved at all when an alternate is given,
  because redirecting is most useful exactly when the original address is
  gone for good (a renamed actor, a shard that moved, a typo in a spawn).
  Only the destination changes: the sender stays the recorded one, so the
  recipient's `sender` still answers the actor that sent the message.
  `max-replays` still applies, so a quarantined letter stays refused
  however it is addressed — otherwise alternating between two paths would
  hand back the unbounded retry loop the cap exists to close. If the
  letter dead-letters again at the alternate it returns as the same entry,
  now recording the alternate as its `recipientPath`.

- **`ActorSystemOptions.withDeadLetters(...)` configures the dead-letter
  queue the system actually uses (#433).**

  The `DeadLetterQueueOptions` family shipped complete and publicly
  exported with no reachable consumer: `system.deadLetterQueue` is
  readonly, its only construction site read HOCON and nothing else, and
  nothing installed a hand-built queue as the capture sink — so `new
  DeadLetterQueue(system, options)` produced a correctly-configured object
  that never received a letter, which the docs nevertheless advertised.
  Explicit options now beat HOCON field by field, so naming one knob in
  code leaves the rest of the `actor-ts.dead-letters` block in effect.

- **A `metrics` dead-letter store: `actor-ts.dead-letters.store = "metrics"`
  counts every undeliverable message and retains no payload (#433).**

  `store` is now one axis with four rungs ordered by how much is kept —
  `off`, `metrics`, `memory`, `persistent`. The arm exists because
  retaining a payload is a different decision from observing a rate: a
  ring holds a strong reference to every undeliverable message, which is a
  data-protection question the moment a payload says anything about a
  person, and a counter is not. It cannot be approximated with a small
  ring, since `max-entries` must be positive and even the tightest one
  keeps a live payload for a whole retention window.

- **A named cache can now be sized for its own key space (#607).**

  `CacheExtension`'s in-memory factory reads
  `actor-ts.cache.<name>.in-memory` layered over the global
  `actor-ts.cache.in-memory`, leaf by leaf, so `cache('idempotency')` and
  `cache('rate-limit')` no longer share one `maxEntries`. That is what
  makes the one-cache-per-consumer advice in three JSDoc headers and six
  doc pages actionable: sizing one named instance previously required
  hand-constructing an `InMemoryCache` and injecting it with `setCache`,
  which nothing recommended for that purpose. The cache factory type
  `CacheFactory` gains a second `name` parameter so a third-party plugin
  can read its own per-name block the same way; a one-parameter factory
  still satisfies it, so existing `registerCache` callers are unaffected.
  The path carries no `reference.conf` leaf because the name belongs to
  the application, exactly as `actor-ts.cache.<name>.plugin` does not.

- **Warm hand-over for cluster singletons: a singleton actor that implements
  `serializeForHandOver()` and `restoreFromHandOver(bytes)` hands its
  in-memory state to its successor, so a singleton with expensive recovery —
  thousands of events to replay, a large cache — no longer starts cold every
  time the host moves. The state rides on the hand-over acknowledgment
  introduced in #949, which is emitted at the only instant it is final: once
  the outgoing instance's postStop has completed. The restore runs after the
  constructor and before preStart, which is the only position from which
  recovery can still be skipped. It is opted into on the actor rather than
  through an option, so an actor written before this release is untouched,
  and it is best-effort throughout: no hooks, an oversized snapshot, a
  serializer or restore that throws, an instance that died unexpectedly, or
  a predecessor that was downed rather than asked all fall back to today's
  cold start with a warning. The snapshot is capped by a new
  `maxHandOverStateBytes` (1 MiB default) and, independently, by whether it
  fits the transport's live frame cap once base64-encoded. (#194).**

- **`bun run test:coverage:gate` now enforces per-module line-coverage
  floors on top of the aggregate one (#541).**

  `src/cluster/` at 90 % and `src/persistence/` at 90 %, computed as the
  weighted sum of lcov's LH over LF for every record under the path prefix
  rather than as an average of bun's per-file percentages, which would
  cancel a ten-line barrel against a thousand-line coordinator. Measured
  on 2026-08-19 with the CI population (ACTOR_TS_SKIP_FLAKY_MNS=1, 7695
  tests, bun 1.3.1) the two modules sit at 97.39 % and 95.35 %. The gate
  also accepts `--log=<bun-test.log> --lcov=<lcov.info>` to gate the
  artifacts of a run that already happened instead of running the suite
  itself — both flags or neither, so half the gate can never report as all
  of it.

- **actor-ts.distributed-data.max-gossip-bytes (default 1M) and the matching
  DistributedDataOptions.withMaxGossipBytes, bounding one gossip frame's
  payload (#691).**

  The effective budget is always the smaller of this and the transport's
  own maxFrameBytes, so lowering the wire cap for a semi-trusted network
  lowers the gossip budget with it and no setting can put gossip back over
  the edge. 0 removes the DistributedData-side budget; the clamp still
  applies.

- **A new counter, distributed_data_gossip_skipped_keys_total, labelled by
  reason (oversize or unserialisable), plus a rate-limited warning naming
  the key, its measured size, the budget and the store size (#691).**

  A single key whose own encoding exceeds the budget cannot be sliced —
  one key's full state is the smallest unit gossip sends, and
  MAX_CRDT_ENTRIES bounds an entry count rather than a byte size — so it
  is skipped and does not converge. Making that observable was chosen over
  a silent skip; it is documented on the replication and stock-metrics
  pages in both languages.

- **Transport now publishes an optional readonly maxFrameBytes, and
  TcpTransport's field is public (#691).**

  A sender needs the number before it builds a frame, because nothing on
  the interface reports failure: send is fire-and-forget and the cap is
  enforced on the far side. Optional rather than mandatory, since the
  in-memory, MessageChannel and multi-node transports hand the message
  object to the peer and enforce no frame cap at all.

- **`handOverTimeoutMs` on `StartSingletonOptions` and
  `ClusterSingletonManagerOptions` (default 10 s, builder
  `withHandOverTimeoutMs`): how long an incoming singleton host waits for
  every eligible peer to confirm it is not hosting before hosting anyway.
  Reaching it means the uniqueness invariant could not be proven —
  availability is chosen over it and the manager says so at `warn`. No HOCON
  leaf yet; that belongs to #855, whose proposed retry-count keys are
  superseded by this single timeout. (#949).**

- **A scheduled task that throws is now reported instead of vanishing onto
  the console (#678).**

  `Scheduler` gained an optional `onError` sink and `ActorSystem` fills it
  in, so a throw out of `scheduleOnceFunction` or
  `scheduleAtFixedRateFunction` reaches the system logger — and therefore
  every configured log sink, MDC included — and is published on the event
  stream as a new `SchedulerError` carrying the `cause`. Both the sink
  type `SchedulerErrorSink` and the event class are exported.
  `console.error` survives only as the documented last resort, for a
  scheduler used outside an actor system; a sink you set yourself is never
  taken over, and it is handed back when the system terminates.

- **`NodeAddress` carries an optional `incarnation` — which process is
  answering at a `system@host:port` — minted once per `Cluster.join` from
  `NodeAddress.mintIncarnation()` (#940).**

  It rides every address-bearing wire field, is bounded on arrival by
  `MAX_NODE_INCARNATION_LENGTH`, and stays deliberately out of `toString`,
  `equals` and `compareTo`, so every map keyed on the string form, the
  leader's lexicographic order and `RefCodec`'s local-vs-remote test are
  unchanged. Optional in both directions: a peer that predates the field
  sends none and is understood, and a peer that does not know the field
  ignores the extra JSON key — so this is not a wire break. No merge rule
  is keyed on it yet, and that is a decision rather than an omission: an
  optional field is bypassed by stripping it, so a refusal on a mismatch
  would be one an attacker opts out of while a legitimate peer of the
  previous version walks into it. Requiring the field breaks all eight
  address-bearing frame fields at once and waits on #823. The one
  comparison that needs no distributed agreement is made: a record a peer
  sends about the local node keeps the local node's own incarnation, so
  the leader's promotion — the single claim about itself a node accepts,
  merged wholesale including the address — can no longer restate it.

- **`actor_mailbox_depth` — a label-free histogram of queue depth, observed
  once per delivery, with buckets from 1 to 10 000 messages (#196).**

  It is the distribution `actor_mailbox_size` cannot be: that gauge
  samples an instant every 2 s and mints no series below 10 000 queued
  messages, because the `path` label it needs to say which actor is behind
  is only affordable that far up. The range it is blind on is 1-9 999,
  which is where a burst actually lives, and a spike between two of its
  ticks was recorded nowhere. The histogram's top bucket boundary is the
  gauge's floor, so the two now cover everything between them with no gap:
  read the histogram to learn that a backlog exists and how deep its tail
  goes, read the gauge to learn whose. Because it carries no labels it
  costs one series per bucket however many actors or sharded entities
  exist. Its count matches `actor_messages_delivered_total` exactly, and
  its floor is 1 rather than 0 because the observation counts the message
  being delivered — so sizing a bounded mailbox from its p99 is now a
  measurement rather than a guess.

- **`actor_dispatcher_queue_delay_seconds` — a histogram labelled by
  `Dispatcher.id`, measuring how long an actor turn waited between being
  handed to a dispatcher and starting (#196).**

  This is the saturation signal, and it is deliberately not the
  `dispatcher_saturation_ratio` the issue asked for. A 0-1 busy fraction
  has no primitive this project can use on all three supported runtimes:
  `performance.eventLoopUtilization` is absent on Bun 1.3, real on Node
  26, and a permanent hard-zero stub on Deno 2.6 — measured on each, and
  now re-checked per runtime by a new cross-runtime smoke case. A ratio
  built on it would read a flat 0 % on Deno for ever, which is worse than
  publishing nothing, because an alert on a metric that never fires looks
  exactly like a system that is never saturated; and even where the
  reading is real it covers the whole event loop, so it could never have
  been attributed to one of several dispatchers. Scheduling delay needs
  nothing but a clock, so it is the same measurement everywhere: at rest
  it is one hand-off (microseconds), under saturation it grows without
  bound, and "utilization is at 100 %" becomes "turns are waiting longer
  than my latency budget", which an alert rule can actually state. Buckets
  run 10 µs to 10 s. One caveat is documented rather than glossed: on
  `MicrotaskDispatcher` the delay stays low even while actors starve the
  event loop, because the queue it measures is the microtask queue the
  runtime drains first — a low reading there means microtask scheduling is
  not the bottleneck, not that there is headroom.

- **`PriorityMailboxOptions` gains `onPriorityError` and
  `withOnPriorityError(cause, message)`, fired whenever `priorityFor` throws
  or returns something unrankable (#733).**

  Worth wiring, because containment is otherwise invisible: the message
  still arrives, just last, so nothing else in the system reports that a
  priority callback is broken. `cause` is what the callback threw, or a
  `TypeError` describing the value it returned. Record and return from the
  hook — it runs on the sender's stack too.

- **`ClusterSharding.shardMap(typeName)` returns the last shard map this
  node was told about as plain JSON (`ShardMapView`), synchronously and with
  no round trip, no DistributedData extension and no coordinator-state store
  (#682).**

  It is the serialisable counterpart to `shards()`, which carries a live
  `ActorRef` and therefore cannot cross a wire. `shardMapViewOf` projects
  a `ShardMapChanged` event into the same shape for callers that would
  rather subscribe than poll.

- **`DistributedDataCoordinatorStateStore` and the `CoordinatorStateStore`,
  `CoordinatorStateData` and `RegionInfoData` types are exported from
  `actor-ts/cluster` (#682).**

  The sharding options JSDoc instructs callers to pass `new
  DistributedDataCoordinatorStateStore(...)`, and no public entry point
  exposed the class, so the opt-in it documents was impossible to perform
  from outside the repository.

- **Static file serving can now stream instead of buffering (#465).**

  Set `streamThreshold` (builder: `withStreamThreshold(bytes)`) and a body
  at or above that size is sent as a chunked-read `ReadableStream`, so
  serving a file larger than the process's memory costs the same as
  serving a small one. Setting it also retires the `maxFileSize` 413 —
  safely, not as a waiver: the validator rejects a threshold above
  `maxFileSize`, which means nothing can buffer past the threshold and the
  cap becomes unreachable. `Content-Length` is stated on the streamed
  response, because a backend has nothing to measure on a stream and would
  otherwise turn every large download chunked. Unset by default, so
  nothing changes for an existing mount; streaming is opt-in until #674
  and #979 land, because a one-shot body is still mishandled by the
  caching and idempotency middleware and by the Express backend's pipe.

- **Three gates for the repeat-run flake harness (scripts/stress-test.mjs),
  which decided flaky-versus-broken with nothing checking it.
  tests/unit/ci/StressHarnessAggregation.test.ts drives the JUnit parser and
  the aggregation over fixtures, including bun's real output with its
  host-separator file attributes;
  tests/unit/ci/StressHarnessClassification.test.ts drives the whole script
  against a synthetic suite that fails in run 3 of 5, one that fails in
  every run, and one that hangs in the middle of otherwise green runs;
  tests/unit/ci/StressHarnessQuarantine.test.ts proves
  ACTOR_TS_SKIP_FLAKY_MNS really is dropped from the child environment and
  really is set by --skip-quarantined. The script gained exports and an
  import.meta.main guard so a test can import it without starting a stress
  run; invoking it as an entry point behaves exactly as before. (#290).**

- **IpAllowlist gained `trustedProxies`, the CIDRs of the reverse proxies in
  front of the app (#715).**

  Set it and the middleware reads the chain in wire order — forwarded
  entries first, socket peer last — and walks it from the right, taking
  the first address that is not one of those proxies. A client that
  reaches the app directly is the untrusted peer, so its header is never
  read at all; junk it prepends sits left of its real address and is never
  reached; an unparseable entry counts as untrusted, ends the walk and
  then fails the allowlist too. When every entry is trusted the fallback
  is the socket peer, not the leftmost entry, which is a deliberate
  divergence from proxy-addr because that value is reachable by a caller
  behind the proxy. `forwardedHeader` (default x-forwarded-for) points the
  same walk at a header a vendor sets rather than appends —
  cf-connecting-ip, true-client-ip, x-real-ip. Trust is expressed as
  addresses and not as a hop count on purpose: a numeric trust-proxy
  setting compares indexes and never addresses, so it believes the header
  on a request that passed no proxy at all. It also means the option needs
  nothing from the backend and therefore works identically on Fastify,
  Express and Hono — where trustProxy is respectively reachable, reachable
  only via a bring-your-own app, and absent. IpAllowlist now also has the
  standard XOptions family: IpAllowlistOptionsType,
  IpAllowlistOptionsBuilder, IpAllowlistOptions and
  IpAllowlistOptionsValidator.

- **`Mailbox.enqueueSignal(envelope)` and `Envelope.undroppable`, the seam
  that keeps a framework lifecycle notification out of reach of a
  load-shedding policy (#729).**

  A `Mailbox` subclass of your own that overrides `enqueue` to shed should
  override `enqueueSignal` too and queue the envelope past its bound; the
  base implementation delegates to `enqueue`, which is correct for a queue
  that discards nothing. `BoundedMailbox` and `PriorityMailbox` already
  override it. Delegating rather than writing straight to the base user
  queue is deliberate — a subclass may keep its messages elsewhere, and an
  envelope hidden in a store its own `dequeueUser` never reads is worse
  than one it dropped.

- **Worker respawns are now delayed and budgeted instead of firing straight
  from the close listener without limit (#734).**

  Five new options and their builder methods: `restartMinBackoffMs`
  (default 200), `restartMaxBackoffMs` (default 10000),
  `restartRandomFactor` (default 0.2), `maxRestarts` (default 10, `-1` for
  the previous unbounded behaviour) and `restartWindowMs` (default 60000),
  matching the framework's own ten-restarts-per-minute supervision
  allowance. A slot whose budget is spent is retired for good and reported
  once through the new `onWorkerPermanentlyDown` callback, which is the
  only diagnostic the worker subsystem can offer — it has no logger. A
  replacement that never becomes ready counts against the same budget as a
  worker that died. The pending respawn timer is unreferenced so it cannot
  hold the process open, cancelled by `terminate()`, and re-checks the
  shutdown flag when it fires; without all three, introducing a delay
  would have made a previously unreachable broker hole reachable. The
  knobs are code-only for now and have no config-file equivalent.

- **`MAX_DELIVERY_IDENTIFIER_LENGTH` is exported from the `./delivery` entry
  point, so an application picking its own `producerId` can read the bound
  the consumer admits rather than discovering it by having deliveries
  refused (#727).**

  This mirrors `MAX_PERSISTENCE_ID_LENGTH` on the persistence side.

- **A ratchet over the test tree's fixed-delay waits,
  `tests/unit/ci/SleepRatchet.test.ts`, following the shape
  `AwaitConditionBudgets.test.ts` established: a repo-wide invariant
  expressed as a test, so it needs no new tooling and no workflow change and
  does not wait on the Biome adoption in #417. Three ledgers, each a ceiling
  that only ever moves down and each with a zero-cost remedy the failure
  message names: 93 modules that declare their own `sleep` instead of
  importing the shared one, 35 hand-rolled polling helpers (`waitFor` /
  `waitUntil` / `awaitConvergence`), and 486 waits that state no reason,
  counted per module so a failure names the file. It counts more than the
  greps this migration has been measured with: beside the 479 `await sleep(`
  sites the tree holds 60 inline `Bun.sleep(20)` and 72 inline `new
  Promise((r) => setTimeout(r, 20))`, 611 waits in all, so a fifth of the
  debt was previously invisible. It is deliberately not a ban on waiting,
  because 57 of those waits are followed by an assertion that something did
  not happen and an absence cannot be polled for; what it forbids is an
  unexplained wait, a re-declared `sleep` and a re-invented poll loop. Also
  removes the one dead `Bun.sleep` shim, in
  `tests/unit/ActorSelection.test.ts`, which had zero call sites and
  survived because no tsconfig sets `noUnusedLocals`. (#418).**

- **Email bridge actor** (#1133).  `EmailBridgeActor` turns a mailbox into a
  message source and SMTP into a sink — the ops/alerting bridge that otherwise
  gets hand-rolled per project.  Inbound uses IMAP IDLE via `imapflow` (with a
  polling fallback for servers that do not offer it, or do not honour it) and is
  **at-least-once, settled by IMAP flags**: a message is marked `\Seen` — or
  moved to another mailbox — only once the target actor tells back
  `{ kind: 'acknowledgment', ackToken }`.  A refusal, a missed deadline, a lost
  connection and a dead process all end the same way, with the message still
  unflagged and therefore delivered again; "processed" is a fact on the server,
  not bookkeeping in memory.  Outbound goes through a pooled `nodemailer`
  transport, and an SMTP failure is classified before it is escalated — a
  message the server rejected is dropped rather than re-queued at the head of
  the buffer behind a torn-down pool.  Reconnection is the `BrokerActor`
  lifecycle's, since `imapflow` does none of its own.  Both drivers are optional
  peer dependencies loaded on first connect, so a send-only bridge never imports
  `imapflow`.  One actor watches one mailbox (an IMAP connection can IDLE only
  on the mailbox it selected).  Config under
  `actor-ts.io.broker.email-bridge`; verified against GreenMail in the broker
  integration suite.
- **HTML email templates** (#1133).  `EmailTemplate` fills a stored HTML snippet
  — one from HOCON, a database row, or a file an operator edits — which the
  `html` tagged template cannot cover, since it needs its markup as a JavaScript
  literal.  Values are HTML-escaped by default and the one opt-out is the same
  `SafeHtml` brand the HTTP side uses, so `rawHtml(...)` states the intent at the
  call site.  Setting a placeholder the template does not declare throws, and
  rendering with any placeholder still unset throws naming all of them — both
  are failures that would otherwise only surface in a mail already sent.
  Deliberately logic-less: it substitutes placeholders, it is not a template
  engine.
- **The comparison is complete: eight arms across three runtimes** (#27).  Two
  .NET arms close the set the issue asked for — the classic actor API on the
  CLR, and the virtual-actor runtime.  Full table in the README and in
  `reference/benchmarks`; the short version is that actor-ts sustains **897k
  messages/second** at a batch of 10 000, against 2.9-3.0M on the JVM, 1.33M on
  .NET and 600k for virtual actors, while leading every JavaScript arm.

  Having the *same* actor model on three runtimes is what makes the runtime's
  own contribution visible rather than inferred — and it settled a question the
  earlier phases could only flag. The ask row splits by **runtime, not
  framework**: both JVM arms sit near 40-47 µs while both .NET and both
  JavaScript arms sit under 11 µs. That is the external caller — a microtask on
  an event loop, an `await` in .NET, a thread parking on a future on the JVM —
  and the JVM arms lead the tell rows precisely because that cost is not in
  their path there.

  The virtual-actor arm is the one whose semantics genuinely differ: grains
  activate on first call and there is no caller-visible create or stop, so
  three of its four rows measure a named near-equivalent and say so on the row.
  Its strong ask and weak tell are the same fact twice — request/response is
  what a grain call is.

- **Both sides of the JVM licence split are measured, and they are the same
  speed** (#27).  A second JVM arm (`benchmarks/comparison/pekko/`) measures
  the Apache-licensed fork against the BUSL-1.1 original from Java sources that
  are identical apart from the package prefix.  They agree to within the noise
  on every scenario — 2.74M/s against 2.73M/s on tell throughput — so **staying
  on an OSI-approved licence costs nothing in throughput**, and each arm is a
  control on the other since they differ only in which dependency they pull.
  Pinned to the newest *stable* release rather than the available 2.0
  milestone.

- **The comparison now reaches across the language boundary** (#27).  A JVM arm
  (`benchmarks/comparison/akka/`, Maven + the Akka Typed Java API) answers the
  question the issue was opened for: **actor-ts sustains about a third of a
  mature JVM actor system's message throughput** — 925k/s against 2.85M/s at a
  batch of 10 000, and 115k/s against 351k/s on a two-actor volley.  It wins
  the spawn row (48k/s against 25k/s) and the ask row, the latter because every
  arm drives the system from an external caller, which on an event loop is a
  microtask and on the JVM is a thread parking on a future.

  Pinned to 2.8.8: releases from 2.9 onwards are published only to a repository
  that answers 403 to anonymous requests, and a row nobody can reproduce is not
  evidence.  Its BUSL-1.1 licence is carried into every published table next to
  the throughput figure.  The harness is mirrored by hand rather than using
  JMH, so both sides of the table measure the same way — which is also why
  cross-language rows never share a table with same-runtime ones.

- **Warmup is part of the workload definition, and it had been wrong** (#27).
  The harness default worked out at three unmeasured iterations for the largest
  batch — harmless for a JavaScript arm, and measuring a JIT-compiled runtime
  mid-compilation.  Fixing it moved the JVM arm's tell rate by 130 % and its
  ask rate by 33 %.  Warmup is now explicit per case, identical across arms, and
  cross-checked by the report generator like every other workload constant.

- **Framework-comparison benchmarks, and the first numbers this project has
  ever published** (#27).  `benchmarks/comparison/` measures actor-ts against
  nact, XState v5 and a no-framework floor across four scenarios — spawn, tell
  throughput, ask round-trip and ping-pong — and publishes the result in the
  README, in a bilingual `reference/benchmarks` docs page, and in a generated
  `RESULTS.md` carrying the hardware, versions, licences and date behind every
  row.

  The headline: actor-ts sustains ~900k messages/second at a batch of 10 000,
  2.2× nact and 4.3× XState, and is level with nact on ask latency (7.8 µs vs
  6.9 µs at p50).  It is behind on spawning (42k/s vs 157k/s) and on two-actor
  ping-pong (138k/s vs 197k/s), both for the same reason: actor creation goes
  through a `create` system message and every message through a dispatcher
  turn, so per-message batching pays when a mailbox has depth and does nothing
  when a volley alternates.  A mixed result, published as one.

  The methodology is enforced rather than described.  Every arm runs through
  the *same* harness — same warmup, same clock, same percentile maths — so
  only the four operation bodies differ.  Every arm reports work the system
  was **observed** to complete, and the report generator refuses to render a
  row whose completed count disagrees with what was requested; that guard is
  the mechanised form of the defect that once had this project publishing a
  figure roughly 10× too high (#1027).  Arms are interleaved round by round
  and each published row is the median of nine, because a single round varied
  by up to 34 % on an ordinary desktop while the ordering of the frameworks
  never changed.

  The comparison tree carries its own manifest and lockfile, so the measured
  frameworks never enter the shipped dependency closure, `bun audit`'s surface
  or `bun run bench`.  `bun run typecheck:compare` is the check that owns it.

- **`bun run bench:compare`, `bench:compare:report` and `typecheck:compare`**
  (#27) — measure, validate-and-publish, and type-check the comparison tree.
  `bench:compare -- --rounds=N` runs the arms interleaved and publishes the
  per-scenario median; `bench:compare:report` refuses to write `RESULTS.md`
  when any row's completed work disagrees with the workload definition.

- **The bidirectional collections count participants, not only pairs**
  (#1199).  `BidirectionalMultiMap` gained `leftSize` and `rightSize` — the
  number of distinct participants on each side, both O(1), reading the two
  backing maps directly.  `size` still counts pairs, which is what a cap is
  usually written against; the two questions are now both askable without
  spreading an iterator to measure the answer (`[...map.lefts()].length` was an
  O(n) allocation to read a number the object already held).  They are correct
  on an `inverse()` view for free, because the view's forward map *is* the
  original's reverse one — unlike the pair counter, which needs a shared box
  for exactly that reason.

  `BidirectionalMap` gained `keySize` and `valueSize` for symmetry.  The
  relation there is 1:1, so both always equal `size`; they exist so that moving
  between the two types needs no memory of which one has the accessor.
  `valueSize` reads the reverse map rather than aliasing the forward one, so it
  still tells the truth if the invariant it corroborates ever breaks.

- **`PersistentActor` can be fenced with a lease** (#1166).  Nothing stopped
  two live instances of one persistence-id.  After a partition plus a
  rebalance — or any orchestration mistake that spawns an entity twice — both
  recovered, both accepted commands, and both ran `onCommand` side effects.
  The journal stayed sound, because the conditional append makes one of them
  lose with `JournalConcurrencyError`; the damage was outside the journal.  By
  the time the loser found out it had already charged the card or sent the
  mail, and until its next `persist` it went on answering reads from state the
  other writer had moved past.

  Two layers now close that, and the first needs no configuration:

  - **A lost race stops the actor.**  `JournalConcurrencyError` is treated as
    evidence of a second writer rather than a transient fault, so the instance
    stops instead of propagating an ordinary failure — whose default
    supervision answer is a *restart*, after which the loser recovers the
    now-foreign head and carries on as though it owned the entity.
  - **An optional `lease()` hook**, mirroring the one
    `ReplicatedEventSourcedActor` has had since #89.  Return a `Lease` and the
    entity becomes single-writer: the lease is acquired in `preStart`
    **before recovery**, so a non-owner never even reads the history, and its
    `persist` is refused up front rather than at the journal.  That is the
    difference that keeps a duplicated side effect from firing at all — the
    backstop above can only act after `onCommand` has already run.

  `isLeaseHolder` gates side-effecting work without a try/catch, and
  `onLeaseLost(reason)` runs when a held lease goes away — defaulting to a
  stop, since an actor that may not write is rarely usefully alive.  Actors
  that do not override `lease()` behave exactly as before.

- **`restartOnTermination` on a cluster singleton** (#1175).  Default `true`,
  and the switch for the fix below: set it to `false` for an actor that uses
  `stopSelf()` as a terminal state, and the manager releases its lease instead
  of re-spawning — so another node could host later, rather than the manager
  holding a lease over a child that is gone.

- **`PriorityMailbox` accepts a capacity and an overflow policy, so
  priority ordering and a bound are no longer an either/or (#647).**

  Choosing priority meant choosing an unbounded queue, and there was no
  way around it: `ActorOptions` rejects `withMailbox` combined with
  `withMailboxCapacity`, because a supplied mailbox brings its own bound,
  and `PriorityMailboxOptions` had exactly one field. The options type now
  carries `capacity`, `overflow` and `onDrop`, with matching builder
  methods and a `PriorityMailboxOptionsValidator` at parity with the
  bounded one — which also means a missing or non-callable `priorityFor`
  now throws `OptionsError` at construction rather than surfacing as "is
  not a function" inside the first sender's `tell`.

  The policies are `drop-lowest-priority`, `drop-new` and `reject`,
  defaulting to `reject`. `drop-head` is deliberately not among them. On a
  FIFO queue it means "discard the stalest", which holds because arrival
  order is the only order there is; on a priority queue the head is the
  message the priority function called most important, so dropping it
  defeats the reason for choosing the mailbox. `drop-lowest-priority`
  sheds from the other end instead, which is O(1) and is the version of
  shedding load that a priority mailbox exists to express. The arriving
  message competes on the same terms as the backlog, so one ranked below
  everything queued is itself the one shed — and is reported as
  `drop-new`, keeping the metric's closed two-value reason vocabulary
  honest without widening it.

  Drops flow through the same `onDrop` hook and
  `actor_mailbox_dropped_total` counter as `BoundedMailbox`, because that
  bookkeeping moved into a shared `DroppingMailbox` base rather than being
  copied; the base is exported so a mailbox of your own can inherit it
  too. Two behaviours are worth knowing: the bound holds while the actor
  is suspended, which is when it matters most, and `unstashAll()` on a
  full priority mailbox can now drop, because `prependUser` re-runs the
  priority function through `enqueue`.

- **`gracefulStop(ref, timeoutMs)` stops one actor after its mailbox
  drains, and lets you await it (#663).** `ActorRef.stop()` has always
  meant stop-after-drain — it sends a `PoisonPill`, an ordinary user
  message ordered behind everything already queued — but it is
  fire-and-forget, and outside an actor there is no `context.watch` to
  learn when the stop actually happened.

  The new helper sends the same pill and resolves `true` once the actor is
  confirmed terminated, or `false` if the budget runs out — and in that
  case it escalates, enqueueing the system command that jumps the user
  queue, so a caller who has run out of patience is not also left with a
  live actor. A timeout resolves rather than rejects because it is an
  outcome, not an error: the caller asked for a bounded stop and got one,
  and the two answers differ only in whether the mailbox finished. The
  budget is a required argument, since a default one would be the number
  that silently truncates somebody's shutdown.

  The confirmation comes from the target cell's own watcher set, which is
  why only a locally-hosted actor can be observed this way; a cluster ref
  still receives the stop but has nothing local to confirm it with, so
  watch it from inside an actor with `context.watch(ref)` instead.
  `ActorSystem.stop()`'s JSDoc, which had promised "a promise that
  resolves once it is fully terminated" above a `void` signature, now says
  what it actually does and points here.

- **The bundled examples now run in CI, so a framework change that breaks
  one is a red check (#545).**

  Nothing in CI had ever executed an example.
  `.github/workflows/examples.yml` installed and built the frontends and
  ran nothing else, and its path filter carried only `examples/**` - so
  the failure this most needed to catch, a `src/` change that breaks a
  snippet, produced zero checks. The only signal was a user running the
  example.

  `bun run test:examples` spawns each standalone example as its own
  process, waits, asserts on its output and stops it (~90 s for the whole
  set). This is a new harness rather than a widening of
  `tests/smoke/run-cases.mjs`: that runner is in-process, importing the
  framework once and then `import()`ing each case, which works because a
  smoke case is a runtime-neutral module exporting `run(context)`. An
  example is the opposite by design - a standalone script with a top-level
  `void main()`, its own argv parsing and often a bound port - so
  importing one would run it in the harness's own process, with the
  harness's argv, and leave no way to time it out or reclaim the port.

  The output assertion is what makes it a gate rather than the appearance
  of one. `examples/io/grpc-sensor.ts` exits 0 after ten failed actor
  starts and a restart-threshold warning, so a case checked on its exit
  code alone would be checked on nothing; the runner refuses a runnable
  entry that declares no expected output.

  What gets stopped is the process tree, not the child. While classifying,
  two of `examples/chat/failover-test.ts`'s three cluster nodes outlived a
  clean exit and went on holding ports 2552 and 2553, which made every
  later port-binding example fail with EADDRINUSE and made the chat smoke
  test pass against a backend that was supposed to be gone. A gate whose
  cases can poison each other that way reports the run order rather than
  the code, so teardown signals a process group on POSIX and walks the
  tree with `taskkill /T` on Windows.

  `tests/examples/examples.manifest.json` classifies all 78 standalone
  scripts - 68 runnable with an assertion, 10 skipped with the reason,
  which is a Docker broker, Kubernetes credentials, an optional peer
  nothing declares, or a file that is not an entry point. The runner fails
  when the manifest and the tree disagree in either direction, so a new
  example cannot silently opt out. `examples/chat/smoke-test.ts` gained a
  `--spawn-backend` flag that brings up its own node on isolated ports
  against a scratch journal, which is how it and the voice smoke test both
  run unattended; the default two-terminal invocation is unchanged.

- **BREAKING — Projections gained a handler-failure recovery strategy, and
  no longer retry a poison event forever (#650).**

  A projection's cursor only advances after a successful `handle`, and
  `ProjectionActor.onReceive` was a single try/catch that logged the error
  and re-armed the poll unconditionally. A handler that kept throwing
  therefore retried the same event once per poll interval for the life of
  the process, every event behind it waited forever, and the only trace
  was one error line per second naming the projection.

  `ProjectionOptions` now carries `recoveryStrategy` with four values —
  the cross product of the only two decisions available, whether to try
  again and what to do once trying is over: `retry-and-fail` (the
  default), `retry-and-skip`, `fail`, `skip`. `maxRetries`,
  `retryBackoffMs` and `maxRetryBackoffMs` tune the exponential backoff,
  and a `ProjectionOptionsValidator` checks them at spawn time. The
  default is deliberately not `fail`: a projection is a background pull
  loop feeding a read model, and the common failure is transient, so
  stopping on the first blip would turn every read-model deploy into a
  dead projection nobody notices until the view is visibly stale.

  The `fail` arm stops the actor explicitly instead of letting the error
  escape the tick. `persistence/projection` has no entry in the system
  group policies, so it inherits the restarting default — an escaped error
  would re-run `preStart`, reload the same cursor and fail on the same
  event, a restart loop that is louder than the spin it replaced and no
  more useful.

  Deduplicating the log could not land on its own, because that error line
  was the only existing signal that a projection was wedged, so the
  structured signals land with it. `onFailure` is called on every attempt
  with the offending `PersistentEvent`, the error, the attempt number and
  the action taken; a skipped event is published on the system dead-letter
  stream so nothing disappears silently; and three stock metrics appear —
  `persistence_projection_stalled`,
  `persistence_projection_failures_total{projection,reason}` and
  `persistence_projection_events_skipped_total`. The log itself now emits
  one error when a failure streak opens and one when it ends, with the
  retries in between at `debug`.

  Query and offset-store failures are counted and backed off on the same
  curve but kept on a separate counter, so a flaky journal cannot spend
  the retry budget of an event whose handler was never reached.

  *Migration:* A projection whose handler throws permanently used to retry
  forever; it now retries three times and stops. If you were relying on a
  projection eventually recovering from a very long outage on its own, set
  `recoveryStrategy` explicitly — `retry-and-skip` keeps it live at the
  cost of a hole in the read model, and a large `maxRetries` with
  `maxRetryBackoffMs` at your outage budget keeps the old shape while
  still bounding it. Existing code needs no change to keep compiling:
  every new field is optional.

- **A nightly workflow that runs the three quarantined multi-node suites
  with `ACTOR_TS_SKIP_FLAKY_MNS` switched off, and a written criterion for
  lifting the quarantine (#538).**

  `ACTOR_TS_SKIP_FLAKY_MNS=1` removes `LeaseMajority`, `ParallelPubSub`
  and the `ParallelMultiNodeSpec` self-tests from every CI run, because
  Bun on GitHub's hosted runners cannot respawn functional worker threads
  after the first worker test — the same resource starvation delays
  LeaseMajority's renewal timer past its lease TTL, so both sides of a
  partition acquire and the test sees a false split-brain. Nothing
  re-checked that afterwards, which made the quarantine permanent by
  default rather than by decision, and every in-repo pointer to the
  reasoning read "See the [CI] tracking issue" with no number behind it.

  `.github/workflows/nightly-flakes.yml` runs those three suites at 04:00
  UTC with the flag deliberately absent, three repeats a night, and
  uploads the per-run JUnit reports and logs — the repository's first
  artifact upload; the two existing nightlies only echo container logs
  into the job log, which is unreadable once the log ages out. Both of its
  jobs are `continue-on-error`: the suites are expected to be red, and a
  red required check for a known-red measurement is one people learn to
  ignore, so the result arrives as a run annotation and a step-summary
  table instead.

  The exit criterion is 14 consecutive green nights — 42 consecutive green
  executions — stated in the workflow header and in the new `Diagnosing
  test flakes` documentation page. Two calendar weeks rather than a
  smaller number because the failure is a property of the runner pool and
  not of the code: a fortnight spans weekday and weekend pools and several
  `bun-version: latest` rolls, which is what has to be shown to have
  stopped happening. A single red night resets the count, and each night's
  uploaded `summary.json` is the evidence. All eight places that implement
  or document the quarantine now name #538, including `benchmarks.yml`'s
  `--exclude=worker`, which shares the cause and would otherwise have been
  left excluded forever with the reason gone.

- **A repeat-run flake harness (`bun run test:stress`) and a `Diagnosing
  test flakes` documentation page carrying the catalog of causes this
  suite has actually had (#290).**

  A single `bun test` answers whether the suite is green right now; it
  cannot answer which tests are green *most* of the time, which is the
  only question a flake catalog can be built from.
  `scripts/stress-test.mjs` runs the suite N times, keeps every run's
  JUnit report and log, and aggregates failures by test identity —
  splitting *flaky* (failed in some runs) from *consistently failing*,
  which is a broken test that repetition tells you nothing new about. It
  also names two outcomes a naive loop reads as green: a run that produced
  no JUnit report at all, and a run that exited non-zero with no failing
  test.

  The harness deletes `ACTOR_TS_SKIP_FLAKY_MNS` from the environment it
  hands to `bun test`. Inheriting it would measure a strictly smaller
  suite than a local run and then report a reliable pass rate over exactly
  the three suites known not to be reliable. `--skip-quarantined` opts
  back in.

  The new documentation page states what repetition can and cannot find,
  because that is where an afternoon goes: a loop drives up the
  probability of a load-sensitive flake and says nothing about a
  deterministic ordering bug, and the worked example is the case that was
  0 failures in 200 runs at a 1 ms poll interval because the dispatcher
  schedules via `setImmediate`. Six cause families are catalogued with
  their status, and five tests observed failing intermittently are listed
  as open entries without a verdict — ruling causes out is not the same as
  establishing one.

  Those five have had their fixed sleep, or in one case a hand-rolled
  deadline loop that fell through silently, replaced by a wait on the
  state the assertion reads. Every assertion survives verbatim; the
  timeouts are larger than the sleeps they replace while the tests get
  faster, because a failure budget is only paid when something is broken.

- **`PersistentActor` and `DurableStateActor` gained an `integrity()`
  hook, so an actor can declare its own body integrity (#493).**

  `PersistenceOptions.integrity` has existed since #116, and the
  object-storage stores have honoured it on both the write and the read
  path since #612, but neither actor base class could reach it —
  `persistenceOptions()` built `{ compression, encryption }` and dropped
  integrity on the floor. Override `integrity()` to return `{ mode:
  'hmac-sha256', integrityKey }` and the stored body is signed;
  configuring it also makes the tag mandatory on read, with the
  store-level `allowUntaggedBodies` as the migration window for a
  pre-integrity corpus.

  Only the object-storage snapshot and durable-state stores read this
  hook. Ten of the eleven snapshot stores and nine of the ten
  durable-state stores accept `PersistenceOptions` and never look at it
  (#960), so on SQLite, Postgres, Cassandra, Mongo, DynamoDB and the
  in-memory reference store an override buys no tamper detection and
  raises no error. The persistence docs now state that count in both
  languages, replacing a sentence that described the same gap as "ignored
  by stores that don't (in-memory, SQLite)" — the phrasing #960 was filed
  about, because it reads as a benign footnote rather than a missing
  control.

- **`InMemorySnapshotStore` now accepts a `keepN` retention bound through
  the new `InMemorySnapshotStoreOptions` (#493).**

  It was the only snapshot store with no retention at all: nothing but an
  explicit `delete()` ever shrank the per-`persistenceId` list, so a
  long-running actor that snapshots on a policy grew the map for the
  lifetime of the process. Every other store in the family has taken a
  `keepN` since it was written.

  The default stays keep-everything rather than the family's `3`. This is
  the store `PersistenceExtension` installs when nothing is configured, so
  a default bound would silently change what every unconfigured
  application retains, and retention that only surfaces later as a missing
  snapshot is a poor thing to opt users into. Set `keepN` explicitly to
  bound it; `<= 0` keeps everything, matching the rest of the family.

  Re-saving at a sequence number that already exists now replaces that
  entry instead of appending a second one, matching the relational stores'
  `(persistence_id, sequence_nr)` primary key. `loadLatest` already
  returned the newer value, so the duplicate was invisible while retention
  was unbounded — with a bound it is not, because duplicates counted
  against it and evicted genuinely older sequences.

- **Postgres and MariaDB projections read the tags index instead of the
  whole journal (#391).**

  `RelationalJournal` has written an `events_tags` join table on every
  append since it existed, and nothing in `src/` ever selected from it. A
  by-tag projection over either backend therefore fell through to
  `InMemoryQuery`, which lists every persistence id and replays each one
  from sequence 1 — the whole journal, with no row cap — once per poll
  interval.

  `RelationalQuery` is the missing reader. It ports the three strategies
  `SqliteQuery` uses (range-walk the first `all` tag; `t.tag IN (…)` with
  `DISTINCT` for `any`; the journal scan when only `not` is given) onto
  canonical `?` SQL expanded through the dialect, so one class serves
  every `SqlDialect` instead of becoming a copy per backend.
  `PostgresQuery` and `MariaDbQuery` are named subclasses adding only the
  name an error reports — the same reasoning behind `LazyStore.storeName`.
  All three are exported from `actor-ts/persistence`.

  The seam is a new `RelationalJournal.openForQuery()`, modelled on
  `MongoJournal.openForQuery()`. It hands back four things because that is
  how many access barriers sit between a query and the index: the pool is
  behind the protected `LazyStore.ensureOpen`, the table names are
  private, and the dialect and serializer are protected on
  `RelationalStore`.

  Nothing changes for a caller who keeps using `InMemoryQuery` — the
  results were correct before and are correct now, only slower. Pairing
  the journal with its own query is what buys the index.

- **A per-actor message batch budget: `ActorOptions.withThroughput()` and
  `actor-ts.actor.throughput` (#409).**

  How many user messages one actor handles per dispatcher turn before it
  yields. Unset falls through to the HOCON key and then to the built-in
  default of 16, so the usual precedence applies. Raise it for a
  short-handler actor that is a throughput bottleneck; lower it toward `1`
  for an actor whose handler is slow enough that a full batch would keep
  timers and I/O waiting.

  This is deliberately a separate knob from
  `actor-ts.dispatcher.throughput`, which counts queued *turns* across
  actors rather than messages within one. A batch always ends early on an
  empty mailbox, a stop or suspend, and a throttle bucket that runs out,
  so the budget is a ceiling rather than a commitment.

- **`actor_mailbox_wait_seconds` — how long a user message waited in the
  mailbox before it was delivered (#196).**

  The half `actor_message_handler_seconds` could not give you: that
  histogram starts measuring once a message is already being handled, so
  an actor that is slow and an actor that is merely behind look identical
  in it. Read together, the pair separates the two — and mailbox wait is
  the earlier backlog signal, since `actor_mailbox_size` only mints a
  series once a queue passes 10 000 messages.

  The family carries no labels, so it adds no cardinality and stays clear
  of the stock-label policy set in #658. Its buckets are explicit rather
  than the client-library defaults, running 1 ms to 10 s: the defaults
  start at 5 ms, where a mailbox that is keeping up drains in well under a
  millisecond, so reusing them would have reproduced #998 verbatim in a
  new family. 1 ms is also the finest the metric could be, since the stamp
  is wall-clock.

  Two populations are deliberately excluded, so the count does not match
  `actor_messages_delivered_total`. A message replayed out of the stash
  kept the stamp of its original arrival, and counting it would report
  however long the actor chose to hold it as queueing delay — enough for
  one stashing actor to drown every other actor's signal in a metric with
  no labels to separate them. The explain plan makes the opposite choice
  on the same field, because there the `stashed` entry that accounts for
  the span is visible beside it. Messages queued before metrics were
  switched on carry no stamp and are omitted rather than invented, which
  corrects itself within one drain. Throttled messages are counted: a
  parked message really is waiting for an actor that cannot keep up.

  The arrival stamp is gated on a reader existing — an explain plan, or
  metrics enabled — rather than being taken unconditionally, preserving
  the property #411 established that a system instrumenting nothing pays
  no clock read on the receive path. An interleaved A/B on Bun 1.3.1 /
  Windows 11 finds no cost these benchmarks can resolve: five rounds per
  arm on `ask` give 100.8k/s before against 99.7k/s after, and three
  rounds per arm on `tell` land within 3.3% at every batch size. Both
  differences sit well inside the per-arm run-to-run spread, which is
  10-14% on `ask` and up to 9% on `tell` — so "no measurable difference"
  is the whole of what was measured, and a narrower claim than that would
  be reporting noise.

  New public surface, both additive: `Envelope` gains an optional
  `replayed` field, and `MAILBOX_WAIT_BUCKETS_SECONDS` is exported from
  `actor-ts/metrics`, so a dashboard or a recording rule can be built on
  the same bucket edges the histogram uses.

- **Documented default values are now pinned to the constants they are
  published from (#470).**

  Every default is written down twice — as a `DEFAULT_*` constant in
  `src/`, and as a HOCON literal in `REFERENCE_CONF` — and nothing
  compared the two. The existing guards stop at the same ceiling: they
  prove a reference, not a correct value, so a wrong number typed into the
  hand-maintained `REFERENCE_CONF` was copied faithfully onto both
  language pages with every check still green.

  What the new assertion adds is the half the byte-pin could never reach.
  `Config.load()` layers reference over application over overrides, so for
  any key present in `REFERENCE_CONF` the HOCON literal already *is* what
  ships, and pinning the published page to those bytes was enough to make
  docs and runtime agree. The `DEFAULT_*` constant is the other value: it
  is what a consumer that never loads config gets, and nothing compared it
  to the literal. 93 keys are covered, each linked by importing the
  constant, so a rename is a compile error rather than a silently dropped
  assertion. Values are read through `Config`, the loader the runtime
  uses, rather than a regex — a test that re-implements duration and byte
  parsing ends up asserting its own arithmetic. Keys where
  `reference.conf` deliberately overrides a shared constant are recorded
  as such rather than omitted, because it is a layer above the constants
  and not a copy of them.

- **A compile harness for the fenced TypeScript samples, run with `bun run
  check:doc-samples` (#470).**

  Doc fences are the one body of code here that nothing type-checks, and
  the existing api-drift guard is a literal-substring blocklist that
  cannot see a name imported from the wrong subpath. This resolves
  `actor-ts…` through `package.json#exports` — the map is derived from
  that block rather than hand-written — and reports each failure at its
  real page and line.

  It is deliberately not wired into CI yet, and the sweep it is waiting on
  is larger than it first looked. Of the 834 fences that survive the two
  fragment classifiers, four fail to parse, 254 are already clean, 367
  fail *only* with "cannot find name" — an identifier a previous fence on
  the same page introduced — and **209 have a real error**: a wrong
  argument type, a property that does not exist, an unresolvable module.
  Those 209 need completing or an explicit exemption before this can be a
  gate; turning it on first would only add a permanently-red job. The
  counts are a reading of the tree as it stands and move as pages are
  edited — `--measure` re-derives the fence classification, and the error
  split is the `tsc` output grouped per fence. The script's header records
  the rest of what the sweep decision needs, including the finding that
  carrying an import does not imply a sample is self-contained.

- **`/health` and `/ready` now aggregate framework-owned health checks
  instead of an always-empty list (#655).**

  The `HealthCheckRegistry` became an `ActorSystem` extension, reached
  with `healthChecksOf(system)`. That is what the feature needed: a
  `Cluster`, a `ShardRegion` or a transport starts long before anyone
  builds a management route tree, so a registry created inside
  `managementRoutes` had no component able to register with it. Nothing in
  `src/` ever called `addLiveness`/`addReadiness` — every caller was an
  example, a test or a docs snippet — so `/health` returned `{status:'UP',
  checks:[]}` unconditionally and `/ready` added only self-is-up. A pod
  whose cluster transport was dead still reported ready and kept taking
  traffic.

  Three checks ship with it. Liveness gets exactly one, `actor-system`
  ("has this system shut down?"), and deliberately nothing else: a failing
  liveness check gets the pod killed, so it may depend on nothing a
  restart can fix — a check that goes red when a shared database blinks
  turns one outage into a fleet-wide restart storm. Readiness gets two,
  registered by `Cluster._start`. They are **not** removed by `leave()`: a
  left node keeps them, reporting DOWN, because an empty aggregate reads
  as healthy and un-registering would make a drained node report itself
  ready. A later `join` on the same system retires the previous pair at
  registration time.

  `cluster-membership` is the self-is-`up` test the endpoint used to
  compute inline. `cluster-transport` is new: it fails when the node can
  reach none of the peers it still expects, where reachable means an open
  connection to a member the failure detector has not written off. Both
  halves are needed — an open socket alone proves nothing, because a
  `DROP` partition produces no FIN and no RST and leaves the sockets
  established while nothing is exchanged, so the failure detector is the
  only thing that notices. That is a *total isolation* test, not full
  reachability: a partial partition leaves the node able to gossip,
  converge and route, and dropping it from the load balancer would take
  capacity from a cluster that is coping. Members marked `unreachable`
  still count as expected, so a partition cannot make the check green by
  shrinking the set it asks about; a peer that was actually downed stops
  counting, so a legitimate lone survivor stays ready. A single-node
  cluster expects nobody and always passes. What it does not catch: the
  failure detector's own latency, and a one-way partition in which this
  node still receives.

  The gRPC `grpc.health.v1.Health` service can be made to answer from the
  very same aggregate, and that is the point of the `health` field on
  `GrpcServerOptionsType` taking a registry rather than a boolean — pass
  `healthChecksOf(system)` and the management endpoint and the gRPC
  service read one instance and apply the same exported `isHealthy` rule.
  Nothing enforces it, though: the field is whatever the caller supplies,
  so a bare `new HealthCheckRegistry()` there forks them and only one of
  the two is the answer a load balancer acts on. `/ready`'s `clusterReady`
  field is read back out of the aggregate by name rather than recomputed
  in the handler, for the same reason.

- **`ActorSystem.runUntilTerminated()` — the whole of a service's shutdown
  in one call (#549).** It installs SIGTERM/SIGINT handlers, resolves once
  the system is down *and* the CoordinatedShutdown pipeline has finished,
  and detaches the handlers on the way out.

  The detach is why it is a method rather than a documented three-liner: a
  `Deno.addSignalListener` listener holds the event loop open and has no
  `unref`, so a program that shuts down for any other reason — a
  `terminate()` from inside, an admin endpoint — would never exit. It
  resolves on the pipeline rather than on `whenTerminated()` alone because
  a task registered alongside the built-in terminator in the final phase
  runs in parallel with it.

  Signal delivery now goes through a new `src/runtime/signals/` backend,
  beside the existing `tcp/`, `http/`, `sqlite/` and `worker/` ones. Bun
  and Node share Node's `process` events; Deno needs
  `Deno.addSignalListener`, because its `process` shim carries no signal
  events at all — so the old `process.on(signal, …)` inside
  `installProcessHooks` registered nothing there and reported success. A
  signal the platform cannot deliver is skipped rather than registered, so
  Windows degrades to SIGINT/SIGBREAK instead of throwing.

- **The framework now registers its own teardown in the shutdown phases
  (#549).** `Cluster.join()` registers `cluster.leave()` in
  `cluster-leave`, and every `BrokerActor` closes its connection in
  `service-stop` — joining the HTTP unbind and the DevTools detach, which
  were already there.

  Ten of the twelve phases were empty in every deployment before this, and
  `src/cluster/` contained no reference to CoordinatedShutdown at all. The
  broker half is an ordering fix rather than a missing teardown:
  `postStop` always closed the connection and the `/user` stop cascade
  always reached it, but *last* — so a broker kept publishing while the
  HTTP server was unbinding and while the node was leaving the cluster.

  Those registrations get an opt-out with a home:
  `actor-ts.coordinated-shutdown.auto-register-tasks`, default `true`.
  Setting it `false` keeps the phases and the built-in terminator and
  hands every resource back to the caller. It is one switch rather than
  one per subsystem, because the reason to reach for it is "I own the
  lifecycle", never "unbind the HTTP server but leave the brokers to me".

- **A bounded, optionally durable dead-letter queue with inspection and
  replay (#433).**

  Until now `DeadLetterRef` published each undeliverable message on the
  event stream and returned. With no subscriber — the default, and the
  only in-framework one is the DevTools sampler — the letter was simply
  gone, so "what did we drop during that incident?" was a question the
  framework could not answer after the fact.

  `system.deadLetterQueue` is the subscriber that is always there. It
  hangs on a single sink slot inside `DeadLetterRef.tell`, the one choke
  point every dead letter already passes through, so nothing has to be
  routed to it and no emitter has to know it exists.
  `actor-ts.dead-letters.store` picks between `off` (the default),
  `memory` (a bounded ring, `max-entries` and `retention`) and
  `persistent` (additionally an append-only log in the configured journal,
  read back on the next start). Left `off`, the dead-letter path itself is
  byte-for-byte what it was — no sink is installed, so `DeadLetterRef.tell`
  does what it always did — and no shutdown task is registered. Start-up
  is not literally free, though: every `ActorSystem` reads the five
  `actor-ts.dead-letters.*` keys, constructs the queue and runs its
  options validator once, which is a handful of `hasPath` lookups and two
  small objects.

  Capture runs before publication, deliberately: the sink is the durable
  record and publishing is an observation with no guaranteed audience, so
  any future rate limiter or sampler over the dead-letter stream belongs
  on the publish side of that line rather than in front of it.

  `list({ recipient, sinceMs, untilMs, limit })` returns entries newest
  first, `recipient` matching a path or its subtree. `replay(id)` resolves
  the recipient path afresh — the point is that the actor has come back at
  the same address as a new instance — and every refusal is a named result
  (`unknown-entry`, `unresolved-recipient`, `degraded-payload`,
  `quarantined`) rather than a silent no-op. A replayed message that
  dead-letters again returns as the *same* entry with a higher
  `replayCount`, so an operator retrying a poison message cannot grow the
  queue one entry per attempt; past `max-replays` the letter is
  quarantined.

  Entry identity is a new `DeadLetterEntry` record rather than a fourth
  field on `DeadLetter`: the event answers what was undeliverable and from
  and to whom, while the id, the timestamp and the paths belong to the
  queue. Nothing about `SystemMessages.DeadLetter` changed. A payload the
  tagged-JSON encoder refuses — a function, a symbol, a `Promise`, a weak
  collection, a cycle — is kept as `{ kind: 'degraded', className, reason
  }` in the durable copy rather than lost, and `replay` refuses it because
  there is nothing left to send; the in-memory entry still holds the live
  object.

  Durable writes are settled twice, and neither is redundant: a framework
  task in `before-actor-system-terminate` settles what a running system
  produced, and a drain once the actor tree is down settles what stopping
  it produced — stashes discarded, mailboxes emptied past their cell —
  which is emitted after the last shutdown phase has run and, for a
  shutting-down system, is most of them. The second also covers a direct
  `terminate()` with no pipeline at all. A hard kill can still lose
  in-flight writes; the queue is a diagnostic record, not a transactional
  outbox.

  The new counter is `actor_dead_letters_total{outcome, recipient}`, with
  `outcome` one of `captured`, `replayed`, `replay-failed`. Persistence
  and the codec are reached through dynamic imports, so a queue left `off`
  costs a consumer's bundle nothing.

  One class of loss is explicitly out of scope: a message discarded by a
  bounded or priority mailbox never becomes a dead letter at all, because
  the drop-reporting seam carries a `MailboxDropReason` and never the
  envelope. That overflow shows up in `actor_mailbox_dropped_total` and
  nowhere else.

### Changed

- **The upgrade documentation now names the releases that break the cluster
  wire** (#1304).  `operations/upgrades/upgrade-strategies.mdx` described a
  code-only upgrade as a rolling deployment where old and new versions
  coexist briefly.  That is false for the two most recent releases, and the
  qualification lived only in two CHANGELOG entries and one JSDoc on
  `encodeFrame` — a changelog is read forward by release, not sideways
  across two of them, so nothing joined them up for the operator planning
  the move.  Both language mirrors gain a per-release table, and the two
  legs are stated separately because they do not fail alike: v0.15.x →
  v0.16.0 breaks gossip (#112) and membership silently never converges,
  nothing erroring at all, while v0.16.0 → v0.17.0 breaks the frame format
  (#450), where a legacy body already shaped like a reserved tag throws at
  decode and costs the whole connection along with every frame batched into
  the same chunk.  The "coexist briefly" row is qualified rather than
  deleted, since it still describes a release that leaves the wire alone;
  #823 is named as the change that ends the caveat; and
  `reference/version-policy.mdx` points at the table from the sentence that
  already sends a reader to the changelog before a minor bump.

- **BREAKING — `Cluster.bootstrap` rejects when readiness is missed**
  (#943, #1086).  A resolved `bootstrap()` now means a formed cluster.
  `awaitReady` widens to `boolean | number | ClusterReadinessOptions`, its
  default budget covers the self-election grace on **every**
  stable-observation node — the old default under-covered N−1 of N nodes on
  a genuine cold start (#1086) — and on timeout the bootstrap runs the
  coordinated-shutdown pipeline and rejects with `ClusterReadyTimeoutError`
  instead of resolving for a node still `joining` and letting it serve
  traffic.  Migration: `awaitReady: false` plus
  `cluster.awaitReady().catch(…)` restores the old fire-and-forget shape.
  (`JoinTargets` literals built outside this repository need the new
  required `selfElectionGraceMs` field.)

- **BREAKING — discovery failure is no longer an empty seed list** (#943).
  A seed-provider rejection propagates out of `Cluster.bootstrap` (the
  just-created system is terminated first), and `AggregateSeedProvider`
  rejects with `SeedDiscoveryError` when its chain is non-empty and every
  provider **threw**.  A provider that *returns* an empty list is still an
  authoritative "no peers", so `discovery: 'auto'` with an empty
  environment keeps producing the single-node development cluster — what
  stops existing is the DNS blip that silently became N self-elected
  one-node clusters, each reporting a healthy bootstrap.

- **BREAKING (pre-1.0): `rememberEntities: true` on the auto-wired path
  refuses a node-local journal in a multi-peer cluster (#1356).**
  `sharding.start` now throws `StorageLocalityError` where it
  previously started and silently forked the registry per node — the
  registry is read by the leader-hosted coordinator, so on failover the
  next leader loaded *its own* journal and forgot every remembered
  entity (the multi-node suite hand-injects one shared journal
  precisely because of this). Migration: wire a shared journal, pass an
  explicit `rememberEntitiesStore` (e.g.
  `CassandraRememberEntitiesStore`), or pass
  `rememberEntitiesStore: null` for the in-memory registry.
  `ShardedDaemonProcess` is unaffected: it wires its registry
  explicitly and only warns, because its liveness tick respawns daemons
  whether or not the registry survives failover.

- **BREAKING (pre-1.0): `BrokerActor.onReceive` is sealed (#709).** A
  subclass now implements the new abstract `onCommand(command)` instead of
  overriding `onReceive`, so the base class can intercept `Terminated` before
  the subclass's dispatch table sees it. A stopped subscriber registered
  through `subscribeRef` is now removed from every topic it held with no
  cooperation from the subclass.

  What went wrong before: `subscribeRef` death-watches its subscribers, and
  `ActorCell` delivered the resulting `Terminated` into the subclass's
  `onReceive`, where it hit a matcher written for commands. `.exhaustive()`
  threw `NonExhaustiveError`, the default supervisor restarted the actor,
  `preRestart` → `postStop` tore the broker connection down, and ordinary
  subscriber churn drove the bridge past `maxRetries: 10 / 60_000` into a
  permanent stop. A subclass that used `.otherwise()` instead survived and
  leaked: the dead ref stayed registered and was told on each fan-out, one
  dead letter per inbound message. The previous round's compile-time doc
  recipe only bound a subclass that copied it verbatim; the guard is
  unconditional now.

  *Migration:* a mechanical rename. The method body is unchanged and the
  `match(...).exhaustive()` table gets narrower, because `Terminated` is no
  longer something a command union has to admit. A subclass that
  death-watches refs of its own overrides the new optional
  `onTerminated(signal)` hook, which runs after the base has pruned the
  registry — for `MqttActor` and `WebsocketClientActor` a `Terminated` from
  your own `context.watch` now arrives there rather than falling through
  `.otherwise()` into `onSelfMessage`. The extension docs (EN + DE) drop the
  widened `match<MyCommand | Terminated>` recipe and its mandatory
  `P.instanceOf(Terminated)` arm.

  Two related defects remain open and are unaffected: a remote subscriber
  never produces a `Terminated` at all, so no interception can reach it
  (#918), and the subscriber registry keys on the actor path while
  death-watch keys on `path#uid`, so a re-spawned subscriber can still be
  unsubscribed by its predecessor's signal (#1238).

- **CI now gates the coverage run it already made, and
  `scripts/coverage-gate.mjs` is the only coverage parser in the repository
  (#541, #1016).** `test.yml` used to re-derive the aggregate figure in bash
  and gate on that, while the script held a second implementation of the same
  parse that nothing in CI called — so the per-module floors for
  `src/cluster/` and `src/persistence/` ran only on developer machines. The
  workflow now runs the suite once with both coverage reporters and hands the
  captured log and the lcov report to the script, which refuses one artifact
  without the other, so a step can never report a pass having evaluated half
  the gate. `COVERAGE_LINE_FLOOR` no longer appears in any workflow: all
  three floors are configured in the script and nowhere else, and
  `CoverageGate.test.ts` fails if `test.yml` starts carrying a copy of the
  number, if a bash parse of the `All files` row reappears, or if no CI step
  calls the script with both artifacts. Note the reach precisely: that test
  reads `test.yml` and nothing else, so a `COVERAGE_LINE_FLOOR` set in
  `publish.yml` or `multi-runtime.yml` would not turn it red. Neither
  workflow runs the gate today, which is why this is a bound on the guard
  rather than a hole in it.

  The aggregate line-coverage floor is raised to **90 %**, from 80 %.
  Measured on the CI population (`ACTOR_TS_SKIP_FLAKY_MNS=1`, bun 1.4.0,
  8186 pass / 35 skip across 522 files): 93.63 % from bun's `All files` row,
  92.85 % as `Σ LH / Σ LF` over the same 679 lcov records, 93.81 % over the
  636 records under `src/`, against 93 % from the badge bot's hosted run. The
  unguarded band narrows from 13 points to about 3, and 90 clears every
  candidate statistic, so a future change to *which* statistic the aggregate
  is cannot turn CI red on its own fix. The per-module floors stay at 90,
  re-measured at 97.29 % and 95.22 %. The README badge's integer now comes
  out of the gate script through `GITHUB_OUTPUT`, written before any floor
  verdict — the run whose coverage dropped is exactly the run whose real
  number the badge should carry.

- **The WebSocket transport frame cap is stated as what it is — per server,
  not per route (#373)** — as a decision rather than an unfinished half of
  the issue's title. No behaviour changed. The per-route half is declined,
  not deferred: `@fastify/websocket` registers once per instance and Bun's
  `maxPayloadLength` belongs to the whole `Bun.serve`, so neither can hold
  more than one limit. Express structurally could, but taking it up there
  would satisfy the title on one backend of three and make the same
  configuration mean different things on the other two. For a limit whose job
  is bounding what a hostile peer can allocate, one shape everywhere beats a
  narrower window on one backend. The cost is unchanged and still named: a
  64 KiB route sharing a server with an 8 MiB one gets an 8 MiB buffering
  window, though what that route *accepts* is unaffected — the connection
  actor still refuses its oversize frames with a clean 1009, per route.

  A canary branch that no gate ever ran is removed.
  `BackendTransportFrameCap.test.ts` chose its expectation with
  `detectRuntime() !== 'bun' ? 'client' : 'server'`, but the file only runs
  under `bun test`, so the Node arm asserted nothing while reading as
  evidence for a claim nothing in the repository checks. The runtime is now
  an asserted premise followed by the one outcome it implies, which leaves
  the canary sharper: the day Bun's built-in `ws` shim honours `maxPayload`,
  the test goes red and the caveat in the WebSocket docs can be lifted.

- **DevTools charts are Apache ECharts** (#486, part of #482). The overview's
  sparklines and line charts, the cluster ring, the tracing flame graph and
  waterfall, and the profiler icicle. What that buys is tooltips, crosshairs and
  resize handling that the hand-drawn canvases never had, and three
  near-identical device-pixel-ratio helpers collapsing into one wrapper.

  The actor tree stays DOM and the percentage bars stay CSS, deliberately: a
  tree needs search, selection and copyable paths, and a chart engine behind
  three lines of CSS is pure overhead.

  Where ECharts has no answer, the geometry stayed ours. There is no flame-graph
  series, so `layoutTrace`, `layoutRectangles`, `buildProfileTree` and
  `layoutProfile` are unchanged and feed a `custom` series that only paints
  them. What did go is `render/timeseries.ts` and the two hand-rolled hit tests,
  since ECharts reports which bar the pointer is over. `projectPoints` went with
  the renderer it projected for, and its two invariants are now spelled out as
  `yAxis.min: 0` and `xAxis.type: 'time'` in the option builders — a rate chart
  auto-scaled to its own minimum turns jitter into mountains, and an
  index-spaced axis quietly compresses away a gap in the samples.

  **The size budget for charts moved from 150 to 200 KiB, on a measurement
  rather than a preference.** ECharts costs 165.9 KB gzip with a *single* chart
  type registered; the two further types this UI needs are cheap on top of that
  floor — 8.3 KB for `custom`, 14.7 KB for `graph` — for 188.9 KB in total. So
  the 150 KiB estimate could not have been met by any import set, and the number
  is the library rather than the drawings. It stays a bucket of its own because
  it is lazy: the chunk loads when a charting panel opens, so opening the actor
  tree costs none of it. The whole bundle is 311 KB gzip against the unchanged
  400 KiB ceiling — more than the epic's 200–230 KB estimate, and still inside
  the limit that protects the reader.

  Colour keeps coming from the `--dt-*` custom properties. Everything in the DOM
  now references them directly and re-themes itself through CSS; only the
  canvases need resolved values, which is what `ChartThemeService` reads on a
  theme flip. Verified in both directions: flipping the theme repaints the
  cluster ring, and flipping back restores it pixel for pixel.

- **The DevTools UI is Angular throughout** (#485, part of #482). The shell and
  all seven panels are components reading Angular signals, routed by Angular's
  router. The hand-rolled framework is gone: `core/signal.ts`, `core/dom.ts`,
  `core/router.ts`, `shell/PanelRegistry.ts`, `shell/AppShell.ts` and the two
  adapters the migration itself needed. What the user sees is unchanged — the
  same 2 s grace period before the offline dialog, the same nav built from the
  `welcome` panel roster with disabled entries carrying both the panel name and
  the reason, the same 30 s tombstones, 200-row trace cap, 1 s explain poll,
  persisted chart timespan and speedscope download.

  `withHashLocation()` is mandatory rather than stylistic: `UiAssetRoutes.ts`
  deliberately serves no SPA fallback, so a request for a PATH that is not an
  asset has to 404 rather than return the shell — which is what lets the same
  bundle be served at the server root and under `DevTools.mount('/devtools')`.
  Every navigation target therefore lives in the hash.

  Each panel is a lazy `loadComponent`, so the per-panel chunk split and its
  size budget survive the change. The roster now lives in the routes' `data`
  rather than in a second registry, which is one list instead of two.

  `core/tapClient.ts` gains an injectable `TapClientService` around it, and a
  seam for the socket constructor. The connection logic itself is deliberately
  not rewritten: backoff from 500 ms to 10 s, `incompatible` never retrying,
  re-subscribing every open stream on `welcome`, treating a sequence gap as
  "re-subscribe for a fresh snapshot" rather than rendering a diverged tree, and
  refcounting listeners so an idle panel costs the actor system nothing — none
  of that is covered by a test yet, and porting it by hand in the same change
  would have made a regression indistinguishable from a wiring mistake. The seam
  is what lets #487 finally reach it with a fake socket.

  `core/theme.ts` became an Angular signal too, which is what lets a theme flip
  recolour the canvases and the cluster SVG: they read the `--dt-*` custom
  properties on every paint rather than caching what `getComputedStyle` returned
  once.

  One defect this found is worth recording, because every gate was green while
  it was there: a `computed` that mutates during evaluation leaves the view
  rendering one update behind for ever. The actor tree swept its tombstones
  inside the computed that built its rows — the natural place, and where the
  imperative version had it — and collapsing a branch then updated the model and
  the computed while the DOM did not move. Sweeping now happens on the way in.
  Nothing in this repository can see a stale view; that is what #487 is for.

- **The DevTools UI is built by Angular 22 instead of `Bun.build`** (#483, part
  of #482). A build-time change only: no panel is ported, the served UI behaves
  exactly as before, and the public API is untouched.

  Angular and ECharts are devDependencies of a nested `devtools-ui/` package,
  which is deliberately **not** a bun workspace — hoisting would put
  `@angular/core` in the root `node_modules` and in Dependabot's view of a
  manifest that ships two runtime dependencies, and Angular pins
  `typescript >=6.0 <6.1` while the library is on `^7.0.2`. The two example
  Angular frontends already live with that same split. Nothing here reaches a
  consumer: the UI is bundled at build time into
  `src/devtools/generated/UiAssets.ts`, no framework appears in `dependencies`
  or `peerDependencies`, and the served page loads nothing over the network.

  The toolchain is a separate install, `bun run ui:install`. `bun run build:ui`
  fails hard without it and prints that command; `bun run typecheck` skips the
  UI half with a warning locally and fails hard under CI. That split is what
  keeps `typecheck`, `bun test` and `bun run smoke` working from a fresh clone,
  which is only possible because the bundle is committed. A new `bun run
  build:lib` (`tsc` alone) serves the jobs that want `dist/` and have no opinion
  about the UI — the two cross-runtime smoke scripts among them, which would
  otherwise have made the Angular install a prerequisite for `bun run smoke`.

  All seven panels keep running through a temporary adapter that mounts the
  existing shell inside one Angular component. The adapter wraps the shell
  rather than each panel on purpose: wrapping panels would have meant Angular
  owning navigation, and with it the nav rail, the `welcome` panel roster, the
  route guards and the offline dialog — a shell port, which is #485's scope,
  smuggled into the issue that was only supposed to change how the bundle is
  produced.

  Two build details worth recording. Chunks are attributed to size budgets from
  the builder's own metafile rather than from file names: Angular emits
  `chunk-<hash>.js`, so the panel identity survives only in `stats.json`'s
  `entryPoint`, and reading that is strictly better than the naming convention
  it replaces. And `angular.json` sets `"baseHref": "./"`, without which every
  asset would be pinned to the server root and `DevTools.mount('/devtools')`
  would break; the build now asserts that, plus that no asset reference is
  root-relative and that no embedded text asset carries a CRLF.

  Budgets: the shell ceiling moves from 60 to 100 KiB to cover Angular's core
  and bootstrap, a `charts` bucket of 150 KiB is declared ahead of #486, and the
  400 KiB total is unchanged. The bundle currently measures about 67 KB gzip
  against that total.

- **Example frontend bundles are no longer committed, and the 34 per-broker
  integration scripts are one driver** (#559). Two kinds of build weight,
  addressed together because underneath they are the same mistake: a list kept
  by hand in more places than anyone checks.

  `examples/{chat,voice}/static/{angular,next,react,svelte}/` held 86 tracked
  files — hashed chunks, RSC payloads, a Next build-id directory — that
  `.github/workflows/examples.yml` already rebuilds from source on every
  change. They are gitignored now, and each sample's README says to run
  `npm ci && npm run build` in a frontend's own directory before opening its
  route. `static/plain/` and `static/lit/` stay committed, because they have no
  build step: those files are the source, and the matching `frontend-plain/` /
  `frontend-lit/` directories hold nothing but a README. This also retires a
  question `examples.yml` documented at length — four of the six builds are not
  reproducible (Next mints a fresh build id, Svelte stamps a timestamp), so a
  rebuild-and-diff staleness gate could never have worked, and not committing
  the output dissolves the problem rather than answering it.

  Separately, 34 `test:integration:<broker>` / `:teardown` scripts were the
  same two `docker compose` lines with a different path spliced in, and the
  list of backends lived in four places at once — both scripts, both aggregate
  chains, and the CI matrix. Miss one and the suite simply never ran, silently.
  `scripts/integration-compose.mjs` discovers the suites from the tree instead:
  `bun run test:integration:broker <name>`, `…:broker:teardown <name>`, plus
  the unchanged `test:integration:brokers` aggregate. The CI matrix now carries
  only the display label nothing can derive, and lost the second column that
  existed solely to map `redis-streams` to a short `redis` script.
  `tests/unit/ci/IntegrationBrokerSuites.test.ts` fails when the matrix and the
  tree disagree in either direction, and pins the compose argument vectors
  against the commands the removed scripts ran — `--exit-code-from runner`
  included, since without it a failing scenario inside the container would
  leave every broker suite green forever. `test:integration` still means the
  multi-node cluster suite and is deliberately untouched.

- **The Bun toolchain is pinned to 1.4.0** (#1328). CI read
  `bun-version: latest` at 13 of 14 setup-bun sites, so Bun 1.4.0 — the
  first release of Bun's Rust rewrite — would have switched every
  workflow silently, the way 1.3.14 once broke the badge scrape (#1194).
  The version now lives in `.bun-version`; every workflow reads it via
  `bun-version-file`, the 18 integration images moved to
  `oven/bun:1.4-debian`, and a future bump is a one-line reviewed change
  that triggers the gates it affects. The supported floor is unchanged —
  `engines` still declares Bun >= 1.3.0 and the multi-runtime floor leg
  still tests it — and the nightly quarantine criterion now counts
  nights only while the pin is unchanged (#1330). Validated under 1.4.0
  before pinning: full suite, coverage gate, stress ×5, three-runtime
  smoke, examples, bench:smoke, check:ui, lint:package, lint:audit.

- **The published comparison figures come from a hundred-round run on Linux**
  (#1327). All nine arms, one run, one machine, one commit — replacing a
  ten-round run on a Windows desktop. Every absolute number moved by a factor
  of two to five, so the columns are comparable with each other and with
  nothing quoted before.

  Three published claims did not survive the move, and the pages carry them as
  corrections rather than restating them quietly:

  - **The alternating volley is no longer a tie.** At ten rounds those columns
    carried spreads from ±27 % to ±82 % and the honest reading was that nobody
    was clearly ahead. At a hundred rounds they carry ±2–3 %, and actor-ts
    leads the best JVM arm by 1.4×.
  - **The round-trip row no longer splits by runtime.** The JVM arms were
    reported at 32–38 µs against under 8 µs elsewhere, explained as a non-actor
    thread parking on a future. On Linux the same arms at the same versions sit
    at 3.5–3.7 µs, beside 3.2 µs for the CLR arm. The mechanism is real and
    worth a fraction of a microsecond; the rest belonged to the previous host.
  - **"The two lineages agree to within the noise on every row"** was a claim
    about the noise, and a hundred rounds leave much less of it. The conclusion
    holds — neither lineage has a systematic advantage, and the largest gap at
    the Java binding is 6 % — but it is now stated as sizes rather than as
    agreement.

  The language-binding finding gets stronger and simpler: 26 % and 36 % behind
  the Java siblings at a batch of 1 000 (t = 11 and 16), and at a batch of
  10 000 the effect is gone rather than merely narrowed (−1.5 % and +0.1 %).
  That is much better evidence for the reading the pages already offered.

- **The comparison gains two Scala 3 arms, and all four JVM arms move to one
  build tool** (#1229).

  Akka and Pekko are now each measured twice — through their Java API and
  through their Scala 3 API, at the identical pinned version, built by the same
  committed launcher on the same pinned JDK. Reading down a pair gives the
  licence question the suite already answered; reading across one gives the
  language binding. The Scala arms are written in the idiomatic functional
  style (state advanced by returning a new behavior) in brace-less indentation
  syntax, because transliterating the Java shape would have measured Java
  idioms with a Scala accent.

  **The binding costs on exactly one row.** At a batch of 1 000 the Scala arms
  run 36–38 % behind their Java siblings — in both pairs independently, and far
  enough outside their spreads to stand (t = 3.4 and 2.8). That is the
  per-message behavior allocation the functional style implies, and the rows
  where it can appear carry a note saying so. It narrows to 7–11 % at a batch
  of 10 000; the plausible reading is that the JIT eliminates the allocation
  once it has enough profile, which this benchmark suggests rather than
  measures. Spawn, ask and the volley show no binding effect at all.

  **A measurement artefact was removed along the way, and it moves published
  numbers.** The JVM arms used to run inside their build tool's own JVM —
  warm, its JIT exercised — while every other arm in the suite starts a fresh
  process. Isolating it by running the same compiled classes three ways showed
  the cause is the fork rather than the tool or the JDK, and it was worth up to
  half of the alternating-volley figure. The JVM volley numbers published
  before this change were flattered by the harness; these are lower and
  noisier, because a cold JVM is a more variable one. Those columns now carry
  spreads from ±27 % to ±82 % and should be read as an order of magnitude
  rather than a ranking.

  All nine arms were re-measured in one ten-round run; README, the benchmarks
  reference in both languages, both FAQ sections and the generated `RESULTS.md`
  carry it. The two JVM arms' result files are renamed to name their binding
  (`akka-java-jvm.json`, `pekko-java-jvm.json`), and the `--framework` keys and
  directories move with them.

- **Every published benchmark figure is re-measured** (#1210). Ten interleaved
  rounds, all seven arms, one machine, every row verified against work the
  system completed. README, the benchmarks reference (EN + DE), both FAQ
  performance sections and the generated `RESULTS.md` now carry the same run.

  Across the programme, on the comparison arm:

  | scenario | before | after | |
  |---|---|---|---|
  | tell, batch 10k | 890k/s | **4.50M/s** | 5.1x |
  | tell, batch 1k | 780k/s | **2.96M/s** | 3.8x |
  | ping-pong, 10k | 123k/s | **521k/s** | 4.2x |
  | ask | 92.5k/s | **223k/s** | 2.4x |
  | ask p50 | 8.5 µs | **3.6 µs** | 2.4x faster |
  | spawn | 41k/s | **79k/s** | 1.9x |

  The published run is the second of two full ten-round measurements taken a
  few hours apart. They agree to within 4 % on every actor-ts row — inside the
  spread each figure already carries — which is the reproducibility claim the
  spread column implies and had not until now been checked.

  Two published claims were wrong afterwards and are corrected rather than
  quietly dropped. The README and both benchmark pages said to expect roughly a
  third of a JVM actor system's throughput; bulk messaging is now ahead of both
  JVM arms, and the alternating volley sits inside Pekko's spread, which is a
  tie. And the FAQ's per-message figure of about 1 µs is now about 210 ns, with
  the caveat that matters attached: a deep mailbox amortises the wakeup across
  a batch and a request/response actor cannot, which is why the same system
  reports hundreds of nanoseconds for a flooded `tell` and microseconds for an
  ask.

  Spawning remains behind the minimal JavaScript library, by about two and a
  half times, and the pages now say why in terms of what the row measures: a
  confirmed `preStart`, a `stop()`, a confirmed `postStop`, and a teardown that
  notifies the parent so supervision stays correct.
- **The nine test modules under tests/unit/cluster, tests/unit/crdt,
  tests/unit/coordination and tests/unit/discovery that declared their own
  `const sleep = (ms) => Bun.sleep(ms)` now import the shared portable
  `sleep` from tests/util/AwaitCondition.ts, and the four that hand-rolled a
  `waitFor` deadline loop delegate to `awaitCondition` instead. A wait that
  expires now names the condition that never became true and how long it
  really waited; the old loops fell through their `while` silently and
  reported only the budget. (#418).**

- **Five fixed-delay waits in those trees became state polls, each on the
  same object the following assertion reads rather than one mailbox hop
  upstream of it: the KubernetesLease renewal-loop case now polls the record
  stored in the fake API server, its two onLost cases poll the reason the
  assertion reads, and the two DistributedData decode-isolation merges poll
  for the merged key's presence rather than its value, so the exact-count
  assertions still do the checking. The remaining 27 keep their fixed delay
  and state the reason in a comment at the call site — eleven are absence
  assertions that cannot be polled at all, two are cases where the elapsed
  time is itself the thing under test, seven are startup settles with no
  readiness flag to wait on, and two position a write inside a window on
  purpose. (#418).**

- **The in-process persistence suites and the four remaining root-level test
  files (Actor, Cluster, ClusterBootstrap, ShardingAdvanced) now wait on
  observable state instead of a fixed delay (#418).**

  In those 23 files, 88 unexplained fixed-delay waits go to 0, 18 per-file
  `Bun.sleep` shims are replaced by the shared `sleep` from
  `tests/util/AwaitCondition.ts`, and 3 hand-rolled `waitFor` deadline
  loops — each of which fell through silently on expiry, so a convergence
  that never happened surfaced as a bare `2 !== 3` — are gone. Repo-wide
  that is `await sleep(` 555 to 480, shim modules 94 to 76,
  `awaitCondition(` 912 to 975. Six stop-then-respawn sites now use
  `gracefulStop(ref, timeoutMs)` and carry no delay at all. Waits that
  legitimately stay — an absence assertion, a TTL window, a wall-clock gap
  that gives two journal appends distinct offset timestamps, a settle that
  lets a shard region see the last MemberUp — state their reason at the
  call site. No library behaviour changes; test coverage is unchanged or
  stronger.

- **The broker and WebSocket integration suites under
  tests/integration/in-process/io/ and .../http/ now wait on observable
  state instead of on elapsed time (#418).**

  Across twelve files the fixed-delay waits drop from 181 to 87,
  awaitCondition call sites rise from 28 to 123, all twelve local
  Bun.sleep/setTimeout shims are replaced by the shared
  tests/util/AwaitCondition.ts export, and one hand-rolled waitUntil
  deadline loop that fell through silently is gone. Every wait that
  remains states at the call site why it has to: it guards an absence that
  cannot be polled for, the elapsed time is itself the assertion, it is a
  settle window restoring the upper half of an exact-count claim a poll
  can only ever half-check, or it is a drain before teardown whose subject
  is not observable. Three of the conversions needed a new observable
  rather than a substitution, because the obvious predicate was already
  true at t=0 — most sharply the reconnect: false case, where polling
  connectAttempts === 1 returns on the first attempt and can never see the
  second attempt the test exists to rule out. No assertion was added,
  removed or altered: the in-scope expect() count is unchanged at 529.

- **The unit test suite outside the cluster, CRDT, coordination and
  discovery trees now takes its waits from the one shared helper. 31 modules
  that each re-declared a private one-line `sleep` import `sleep` from
  `tests/util/AwaitCondition.js` instead, and two hand-rolled polling
  helpers are gone: a `waitUntil` whose only diagnostic was the string
  "waitUntil timed out" became four labelled `awaitCondition` calls, and a
  26-call-site `waitFor` keeps its name and signature while forwarding to
  `awaitCondition`, so a timeout there now reports the elapsed time and the
  poll count instead of only the budget it was given. Six further fixed
  delays became polls on the state the following assertion reads, including
  one in the WebSocket server suite where the hub's own connect callback was
  already observable and one in the devtools explain-plan suite that had no
  deadline at all and would have hung until the runner killed it. (#418).**

- **Every fixed-delay wait remaining in those suites states why it is a wait
  and not a poll, which is what makes the sweep auditable rather than a
  snapshot: 131 unexplained waits across 54 files are now zero (#418).**

  The reasons fall into four kinds and the distinction is load-bearing,
  because roughly nine in ten of these waits cannot become polls at all.
  Where the assertion is an absence the predicate is already true when the
  wait starts, so a poll returns immediately and the test stops checking
  anything. Where it is an exact count or array, a poll returns on the
  delivery that reaches the count and can never see the surplus the
  assertion exists to catch. Where the elapsed time is itself the claim,
  as with a circuit breaker that compares clocks inside `call()` or a
  cache TTL that expires lazily, there is no event to wait on even in
  principle. And a slow handler that exists to overrun a mailbox, keep a
  transaction open, or hold two async contexts suspended at once is a
  fixture rather than a wait.

- **The cluster integration and multi-node test suites now share one wait
  helper (#418).**

  Twenty-three hand-rolled waitFor / awaitConvergence deadline loops —
  each with its own timeout, its own poll step and a message naming the
  elapsed budget but not the awaited state — forward their bodies to
  awaitCondition, keeping every call site unchanged; twenty-three per-file
  Bun.sleep shims are gone in favour of the portable sleep; and every
  fixed-delay wait that legitimately stays now states why on the line
  above it. No assertion was weakened and no budget changed in either
  direction. This takes all three SleepRatchet ledgers to zero for
  tests/integration/in-process/cluster/ and tests/multi-node/: 89
  unexplained waits, 23 shim declarations, 23 rival polling helpers.

- **AGENTS.md gains a measured-hot-path exemption to the pattern-matching rule,
  and one site uses it** (#1209). Where a benchmark in this repository has
  measured a path as hot, a `match(…)` may be a `switch` on `kind` — arms still
  one-line `onXxx` delegations, exhaustiveness restored by a `never` assignment
  in the `default`, and a mandatory comment naming the benchmark and the delta.
  The comment is what makes the exemption per-site and evidence-carrying, and
  what the conformance sweep (#494) recognises so it does not convert these
  back.

  `ActorCell.handleSystemCommand` is the converted site: two of its arms run per
  actor lifecycle, so a nine-arm matcher and its closures were built twice per
  spawn. Measured over six interleaved rounds: **spawn +16.9 % (t = 2.7)**, with
  every other scenario inside the noise — the shape to expect, since nothing
  else issues system commands at that rate.

  Exhaustiveness moves from run time to compile time and was verified rather
  than assumed: adding a tenth `SystemCommand` variant fails the build at the
  `never` assignment.

- **An ask stops rebuilding its own address** (#1208). `AskResponseRef` built
  three `ActorPath` objects per call, two of which were the same constant
  `actor-ts://<system>/temp` prefix — rebuilt and re-validated character by
  character every time. It is now cached per system name. The settle-callback
  array, which only the cluster ever fills, is `null` until something registers
  instead of being allocated on every local ask.

  Measured over six interleaved rounds: **ask 189.5k → 217.5k/second (+15 %,
  t = 5.8), p50 4.12 µs → 3.67 µs**. Nothing else moves, which is the expected
  shape — no other path builds a reply ref.

  The per-ask `setTimeout` and the `replyTo` spread were both considered and
  kept, and the reasons now sit in the code rather than only in a tracker
  comment: a shared deadline wheel would change what a timeout means, since a
  bucketed wheel fires up to a bucket late; and writing `replyTo` onto the
  caller's object is observable, while a prototype-based stand-in breaks a
  remote ask, whose serialisation walks own properties.

- **A spawn stops building things it does not need** (#1207).

  A full lifecycle — spawn, confirmed `preStart`, `stop`, confirmed `postStop` —
  is CPU-bound rather than scheduling-bound, so it needed a diet rather than a
  faster dispatcher. Six items: the options blueprint is built once and
  validated in place instead of copied twice, with a shared validator; anonymous
  names and ask reply-refs draw from a pooled entropy buffer (599 ns → 216 ns per
  identifier, same generator and same rejection sampling — only the call is
  amortised, because both name families are addressable on the cluster wire and
  a guessable one is a security defect); the per-cell logger and timer scheduler
  are built on first use rather than at spawn; restart-window timestamps start
  as `null`; and lifecycle events and death notifications are constructed only
  when something is listening, for which `EventStream` gains `hasSubscribers`.

  Measured on the comparison arm, six rounds interleaved: **spawn 48.6k → 65.4k
  actors/second (+34 %, t = 12.5)**, ask +16 % with p50 4.63 µs → 4.12 µs, tell
  +6 % at a batch of 10 000. The alternating volley is unchanged, as expected —
  it spawns nothing.

  Two candidates were measured and declined rather than skipped silently:
  skipping name *validation* for framework-generated names is worth about 1 % of
  a spawn and needs provenance threaded through the cell constructor, and the
  watch maps and stash buffer would trade eight to twelve null-checked access
  sites for one allocation each.

- **`ReplayedResult.recipientPath` now reports where a replayed letter was
  actually sent rather than echoing the entry's recorded recipient, and the
  `recipient` label on `actor_dead_letters_total{outcome="replayed"}`
  follows it (#433).**

  Without that, a caller logging the result after a redirect would name
  the actor that received nothing. Anything that read the field before a
  redirect was possible sees an unchanged value.

- **Documented which durability the persistent dead-letter store provides
  (#433).**

  It is graceful-shutdown durability, not crash durability, and the
  previous wording understated the boundary: because appends are issued
  fire-and-forget onto a serialized chain, a burst arriving faster than
  the journal accepts it leaves many un-settled appends outstanding, so a
  hard kill loses all of them and not just the one in flight. Anything
  captured before a `terminate()` is in the journal after it, however
  large the burst.

- **Settled the `actor-ts.dead-letters.*` namespace, with the reasoning
  recorded at the key definition instead of only in a commit body (#433).**

  It shipped while #1179 and #867 were open, which made it look like a
  decision taken rather than made. Neither issue asks for the retention
  keys to move and the two do not agree with each other: #1179 sketches a
  publish-path token bucket under `actor-ts.diagnostics.*`, #867 sketches
  dead-letter logging toggles at the root. The dividing line is the reader
  — these keys are read by the queue and decide what is retained, those
  are read on the publish side and decide how loudly a letter is announced
  — so merging them would give one block two readers in two subsystems and
  make a suppression knob look like it gates capture, which the code
  prevents by capturing before publishing.

- **A synchronous receive handler no longer pays for the async machinery**
  (#1206).

  Delivering one message ran through three nested `async` functions and three
  `await`s regardless of what the handler did. An `async` function allocates a
  promise and a heap frame and costs a microtask hop whether or not anything in
  it suspends — and the ordinary handler does not suspend: it counts something,
  updates a field, forwards a message and returns nothing.

  `handleUserMessage` and `_dispatchToBehavior` now return `void | Promise<void>`
  and each caller awaits only what is thenable. `handleSystemCommand` does the
  same; four of its nine arms are synchronous and were each paying a hop to hand
  back `undefined`, two of them per actor lifecycle.

  Measured on the comparison arm, six rounds interleaved against the previous
  build: **tell throughput 1.06M → 4.42M messages/second at a batch of 10 000**,
  and 993k → 3.53M at a batch of 1 000. The repo's own tell benchmark agrees
  independently (4.23M at 10k, 4.78M at 100k), and every row is
  completion-verified — 300 000 of 300 000 messages accounted for.

  The gain is larger than the removed allocations alone explain, and the reason
  is worth recording: `run()` handles up to 16 messages per dispatcher turn, and
  it was suspending and resuming its own state machine at every one of them. The
  batch now runs as a single synchronous loop, so what disappeared is 16 round
  trips through the microtask queue per turn rather than two promises per
  message.

  The one figure that moved the other way is the alternating volley, at −4.3 %
  (t = −1.9, at the edge of what six rounds resolve). That path is depth-1 by
  construction: there is no batch to amortise anything across, so it sees only
  the fork's own cost and none of its benefit.

  The fork duplicates nothing — the success tail, the failure tail and the
  epilogue are one method each, called from both sides. The epilogue had to stop
  being a `finally` for that, since a synchronous path and a promise path cannot
  share one. A new equivalence suite runs six scenarios twice, once with a
  synchronous handler and once with an `async` handler whose body is identical,
  and asserts the two produce the same observable sequence.

- **The coverage floors are now a ratchet with the policy written down in
  AGENTS.md: raise freely, never lower silently, and record the measurement
  that forces a lowering beside the number (#541).**

  `tests/unit/ci/CoverageGate.test.ts` makes that enforceable — it pins
  the aggregate floor across all three places that quote it (the gate
  script, `test.yml` and AGENTS.md) and puts a lower bound under every
  floor. Nothing under `tests/` previously even named COVERAGE_LINE_FLOOR,
  so lowering the floor was one token in one file. The gate's own
  docstring also stopped claiming that CI uses it and that it shares a
  single source of truth with `test.yml`; neither was true.

- **The default dispatcher wakes actors on the microtask queue, with a
  macrotask fairness budget** (#1205).

  `HybridDispatcher` is new and is now the default; `actor-ts.dispatcher.default`
  gains the value `"hybrid"`, and `"immediate"` still selects the previous
  behaviour.

  The scheduling hop was the larger half of a request/response round trip. A
  `setImmediate` costs roughly 2.4 µs, which a flooded actor amortises across
  the batch it handles per turn and a request/response actor cannot amortise at
  all — its mailbox is empty between messages, so it pays the hop per message.
  Measured on a 10 000-exchange volley: 8.1 µs per round trip, of which about
  4.8 µs was the two hops. Switching to `queueMicrotask` alone measured almost
  four times faster and is unusable, because a microtask queue that refills
  itself never lets the event loop reach timers or I/O.

  The hybrid counts consecutive microtask-scheduled units and sends every 64th
  through `setImmediate`, so the loop advances at least every ~1 024 messages
  and the worst case degrades to exactly what `ImmediateDispatcher` always did.
  The count is per dispatcher rather than per actor, because the microtask chain
  is the union across every actor scheduled on it. Ordering is preserved across
  a yield: units handed over while one is in flight queue behind it instead of
  overtaking it.

  A fairness smoke case runs on all three runtimes, which is where the relative
  ordering of microtasks, immediates and timers is actually decided, and the
  unit test proving the budget works is paired with one proving the same probe
  starves an unbounded microtask dispatcher.

  **Two timing consequences are worth knowing**, both of which follow from actor
  turns becoming cheaper rather than from any semantic change:

  - A supervision decision can now come back *inside* a batch. A handler that
    throws suspends the cell, and the supervisor's `Resume` may land before the
    batch loop re-checks the cell state — so the batch continues rather than
    ending at the failure. The re-check still happens and still refuses to
    deliver to a suspended actor; it simply finds the actor running again.
  - A hub-style actor can observe `context.children` still containing a child
    that is finishing stopping. A connection actor reports its disconnect from
    `postStop`, while the message that unregisters it from its parent is sent
    afterwards, so a fast enough parent turn sees the hook first. Framework-level
    bookkeeping — a WebSocket server's `clients`, for instance — is unaffected;
    only the raw child list shows the transient.

- **A router no longer hands work to a routee that is stopping** (#154 follow-up).
  `smallestMailbox` skipped terminated routees but not terminating ones, which
  read a mailbox depth of 0 and so looked like the most attractive member of the
  pool. A message routed there is accepted and then dead-lettered from the
  termination drain. Rare enough to be invisible while every actor turn cost a
  macrotask; reachable once they got cheaper.

- **The receive and lifecycle paths stop paying for instrumentation nobody
  switched on** (#411, #974).

  Five costs that ran regardless of whether anything was collecting. The
  end-of-dispatch `performance.now()` fed three consumers — the handler
  histogram, the explain recorder and the dispatch observer — each already
  behind a null check, so with all three off it computed a number nobody read.
  The tracer probe called `activeSpan()` on the noop tracer once per message to
  be told `null`. The `actor_created_total` and `actor_terminated_total`
  counters walked the extension chain and built two argument objects for a
  registry that discards them, twice per actor lifetime; `actor_mailbox_dropped_total`
  did the same per shed message, which is hottest exactly when a mailbox is
  already over capacity. `EventStream.publish` copied its subscriber array
  before iterating — on every start, stop, restart and dead letter, including
  when that array was empty — and `unsubscribe` allocated a second empty array
  to report that an empty stream removed nothing. `BoundedMailbox.enqueue`
  built a pattern matcher and one closure per arm for every message arriving at
  a full mailbox.

  The *start* clock read stays unconditional, and the code now says why: a
  recorder switched on from inside a handler was off when the message began, so
  gating that read would leave it with no knowable start and its handling time
  would have to be invented.

  Measured on the comparison arm, five rounds interleaved against the previous
  build: **+6.2 % on the 10 000-message flood**, the case where per-message cost
  dominates an iteration. Every other scenario moved less than the round-to-round
  spread — spawn and the alternating volley are bound by scheduling rather than
  by this work, and say so.

  Behaviour with instrumentation *enabled* is unchanged, which is the half worth
  proving: inverting each new guard turns tests red rather than leaving them
  green — three for the duration gate, 34 for the publish guard, two for the
  receive-timeout check, one for the creation counter.
- **The optional-peer rule in AGENTS.md now matches the two-manifest design
  the tree has implemented since #540 (#676).**

  It had said to add a matching devDependency "so the test suite can
  exercise them", which contradicted `tsconfig.dev.json` (which states the
  broker drivers are absent from the root install by design) and did not
  hold on its own terms: nothing in tests/ is conditioned on module
  availability and every adapter runs against a fake, so installing a
  package flips no suite from skipped to running. The rule now names both
  dependency contexts, makes the choice follow from how the adapter is
  exercised (in-process under `bun test` versus against a live broker in
  Docker), and states what a root devDependency actually buys — a test
  importing the real module to check the structural stub against upstream.
  Two new guards under tests/unit/ci enforce the split, so an optional
  peer declared in neither manifest is a failing test rather than a
  discovery years later.

- **scripts/check-doc-samples.mjs now reports what it was hiding (#470).**

  A parse error suppresses TypeScript's semantic pass for the whole
  program, and four unmarked fences were enough to reduce the script to a
  four-line syntax report that read as a pass; it now compiles twice,
  dropping the syntactically broken fences and re-checking the rest. Each
  emitted fence also carries a one-line page-continuity prologue, so a
  fence that continues an earlier one on its page is no longer counted as
  broken, and a carried name that was imported from actor-ts or node: is
  re-imported rather than stubbed, which keeps the continuation genuinely
  type-checked. The leftover cannot-find-name bucket is split by whether
  the corpus imports the name anywhere: a name nothing imports is a prose
  placeholder and reported as a fragment, a name other pages do import is
  a missing import and stays an error. The script exposes its pure half
  for testing, adds --report for the per-code and per-page tallies, prints
  the reason on each no-compile exemption, and accepts --docs and --out so
  it can be driven over a fixture tree. It is still deliberately not a CI
  gate.

- **Cluster singleton: the envelope-router claim on a singleton's manager
  path belongs to the `ClusterSingleton` extension rather than to the
  manager actor, and is taken by `start()` or by `ref()`, whichever comes
  first (#949).**

  A proxy-only node is still asked to hand the singleton over when the
  host moves, and with nothing registered it was indistinguishable from an
  unreachable one. One visible consequence: a user message routed to a
  node that never called `start()` now reaches `deadLetters` instead of
  only a Cluster-level log line.

- **The comparison drops its no-framework arm and averages its rounds** (#27).
  Two changes to how the benchmark is measured and read.

  The floor arm — plain objects and direct method calls — is gone. A column two
  to three orders of magnitude above everything else is read as "these
  frameworks are wasteful" rather than as "a direct call does none of this
  work", and no caveat printed beside it changed which of those a reader took
  away. It was also the least trustworthy figure in the suite: a loop a JIT can
  flatten moved 16 % between consecutive runs, more than any real arm. The FAQ's
  "several hundred times a direct call" ratio came from that arm and is removed
  with it.

  `--rounds=N` now publishes the **mean** of every metric rather than the median
  row: with ten rounds, reporting one discards 90 % of the evidence. Because a
  mean carries a disturbed round where a median drops it, every throughput
  figure now publishes the spread of the rounds behind it, rendered `± x %`.
  That turned out to matter — several published figures move by more than 15 %
  between rounds, which the previous three-significant-digit presentation hid.

  All published tables are re-measured from a ten-round run: actor-ts sustains
  **890k messages/second ±8 %** at a batch of 10 000, against 2.97M on the JVM,
  1.13M on .NET and 603k for virtual actors, and 2.3x the nearest JavaScript
  neighbour.

- **An uninstrumented system is unaffected: `ActorCell.schedule` branches on
  whether a metrics registry is installed before arming a turn, so the path
  with metrics off keeps exactly the closure it had, captures no clock read,
  and allocates nothing extra. The measurement is taken cell-side rather
  than inside `Dispatcher`, which is what keeps the public `Dispatcher`
  contract a two-member interface a third party can implement — and it means
  the three built-ins, a per-actor `ActorOptions.withDispatcher(...)`, and a
  third-party dispatcher the framework has never seen are all covered
  without an API change. The gate is evaluated when a turn is armed, so a
  turn armed just before metrics were enabled is left out rather than
  measured against a clock read that never happened, matching the rule the
  mailbox arrival stamp already follows. (#196).**

- **`examples/mailbox/priority-dispatch.ts` ranks unknown messages with
  `.otherwise(() => 5)` instead of `match(...).exhaustive()` (#733).**

  The exhaustive form is the shape people copy and it throws on
  `PoisonPill`, so every `ref.stop()` went through the new containment
  path. The example's output is unchanged.

- **BREAKING — The `/cluster/shards` response gains a `version` field — the
  coordinator's broadcast counter, one bump per publish, not a count of
  shard moves — and `takenAt` now means when the answering node recorded the
  map rather than when the coordinator wrote its snapshot. Every field the
  previous response carried survives under the same name. The 404 condition
  moved with the data source: the endpoint answers only on a node that
  started a region or a proxy for the sharded type, because the coordinator
  broadcasts only to regions that registered. A 200 with an empty
  `shardHome` is the normal answer for a type no entity has been addressed
  in yet, since `regions` fills on registration while a shard gets a home
  only once something asks for it. (#682).**

  *Migration:* If you queried /cluster/shards from a node that had neither
  started nor proxied the sharded type, it now returns 404 — query a
  participating node instead.

- **A `Range` request against a static file now reads only the bytes it
  asked for (#465).**

  It used to read the whole file and answer with a `subarray` of it, and a
  subarray is a view — so answering `bytes=0-0` on a 50 MiB file kept 50
  MiB resident for the life of the response, once per in-flight request.
  No API or observable behaviour change; the memory is the whole point.
  Refs #969.

- **BREAKING — InMemoryCache eviction picks its victim by what an entry
  carries first and by recency second (#1080).**

  A setIfAbsent claim and an incr counter with a finite TTL carry a
  guarantee, and so does a set that replaces such an entry while it is
  still live (the idempotency marker becoming the finished response);
  every other set and mset write is opportunistic and is drained first.
  maxEntries is unchanged and still a hard cap: once every entry carries a
  guarantee the least-recently-used of those goes, so a key flood still
  cannot grow the map. No API, option or HOCON key was added.

  *Migration:* Nothing to change in code; an instance shared between a
  response cache and a guarantee-carrying consumer evicts the cached
  responses sooner than before, so size maxEntries for both, and a test
  that pins exact LRU order across mixed write kinds needs updating.

- **LogContext.runFresh now returns the callback's value directly when no
  store is ambient, instead of always opening one (#718).**

  Observably identical - with nothing ambient, get() already returns the
  frozen empty context - and it keeps the runtime's no-store fast path,
  which is what makes the framework's own three clearing seams free in a
  process that never opens an MDC scope. Measured on
  benchmarks/single-node/tell-throughput.ts with the arms run alternately:
  an unconditional wrapper cost 3 to 8 per cent of tell throughput and
  lost all twelve pairs across three rounds, because an active store
  propagates to every async resource created under it and a turn awaits up
  to `throughput` handlers inside the wrapper; with the guard the two arms
  are indistinguishable, within one per cent on the three larger batches
  and split six-six.

- **BREAKING — Strong DynamoDB reads consume twice the read capacity of
  eventually-consistent ones, and the cost is not confined to recovery
  (#736).**

  Journal.read and Journal.highestSeq are also what the query layer's
  catch-up path, currentEventsByTag, remember-entities, dead-letter
  replay, journal migration and DevTools time travel call, so those pay it
  too. There is no per-store opt-out; Cassandra's withConsistency has no
  DynamoDB equivalent yet.

  *Migration:* On PROVISIONED billing, re-check the read capacity on the
  events and snapshots tables before upgrading -- a table sized for
  eventually-consistent reads can now throttle. On PAY_PER_REQUEST nothing
  to do beyond the cost increase.

- **Documented in both languages that a `supervise` scope outlives the
  subtree it wraps while a signal handler does not, across four pages that
  previously stated the first only by implication and left the second
  unstated: the typed `behaviors` page gains scope and nesting subsections
  plus the signal-handler migration cases, the typed `typed-actor` page says
  that "the framework remembers the strategy" is a stack and how a failure
  travels it, the supervision page's typed aside says a wrapper chain is a
  supervision hierarchy inside one actor, and the death-watch page corrects
  "even when a signal handler is registered" from a property of the actor to
  a property of the behavior. #928's second acceptance criterion asks for
  the opposite scope rule ("supervise applies to its subtree and stops
  applying when the actor transitions out of it"); it is answered by
  documenting and testing the nesting instead, because four shipped
  paragraphs promise the actor-lifetime scope the code has and the sibling
  decorator `Behaviors.intercept` documents the same survive-the-transition
  rule. (#928).**

- **BREAKING — ReplicatedEventSourcedActor validates its own `replicaId` at
  preStart against the same 255-character bound peers apply to an arriving
  envelope, and throws naming the bound (#706).**

  Without it an over-long id chosen locally showed up only as every peer
  silently dropping this replica's events — a one-way divergence with
  nothing in the offending node's log. `MAX_REPLICA_ID_LENGTH` and
  `DEFAULT_MAX_REPLICATED_OBSERVED_EVENTS` are exported from the
  persistence barrel, since both are reachable from a subclass.

  *Migration:* An actor whose `replicaId` override returns an empty or
  longer-than-255-character string now fails at startup instead of
  running; shorten the id.

- **The flake diagnosis page, both languages, now gives per-row grounds for
  ruling a fixed sleep out of each open entry instead of one blanket claim
  that held for three of five, names the InMemoryTransport test that was
  actually observed failing rather than a different one, catalogues a fifth
  cause family (an assertion whose denominator is process-global state) with
  its remedy, and carries a measurement of the three quarantined multi-node
  suites: 15 local repeats, two tests flaky at 1 in 15, nothing consistently
  failing, no hangs. The claim that neither quarantined failure reproduces
  locally is corrected, since it holds for the hang and not for
  LeaseMajority's false split-brain, whose local failure follows a
  hand-rolled 25 s deadline loop falling through silently. (#290).**

- **BREAKING — The exported type IpAllowlistOptions is now the
  accepted-input union IpAllowlistOptionsBuilder | IpAllowlistOptionsType,
  and also a value alias for the builder, matching every other options
  family in the project (#715).**

  Passing an object literal to IpAllowlist is unaffected.

  *Migration:* Annotate with IpAllowlistOptionsType instead of
  IpAllowlistOptions wherever you read fields off a value of that type —
  the union has no `allow` on its builder branch.

- **BREAKING — A bounded mailbox's `capacity` now bounds the messages it is
  allowed to discard rather than the messages it holds (#729).**

  A queue made entirely of undelivered death notifications sits above the
  number instead of losing one, and the overshoot is bounded by how many
  actors that watcher watches. Nothing changes for a queue holding
  ordinary traffic, and no drop is reported for an eviction that did not
  happen.

  *Migration:* If you sized a capacity as a hard memory ceiling, add
  headroom for the watcher's watch set, or assert on `size` only for
  mailboxes that hold no death notifications.

- **The documented recipe for routing Terminated into
  pruneTerminatedSubscriber now widens the match input instead of guarding
  ahead of the matcher, which makes the arm mandatory at compile time:
  exhaustive() refuses to compile without it, so omitting it is a build
  failure rather than a NonExhaustiveError thrown at the first subscriber
  death, answered by a supervisor restart and a full broker reconnect per
  death. The arm delegates to a private onTerminated handler, matching the
  house rule for match arms. Both language pages also gain the caveat that
  context.watch installs a watcher only for a local ref, so a remote
  subscriber never produces a Terminated at all, and the wrong subclass
  count in the rationale is corrected from thirteen to fourteen. (#709).**
- **The FAQ's per-message overhead figures are measured now, and two of them
  were wrong** (#27).  `reference/faq` had asserted "~50 ns per `tell`" and
  "actor messaging costs 50-200× a direct call" with nothing behind either.
  The measured end-to-end cost of a `tell` is about **1.1 µs** — the ~50 ns
  figure described the enqueue alone, not delivery and handling, so the page
  answered "how long does `tell` take" with a number and "how many messages
  per second" with the same one, two orders of magnitude apart.  Against a
  no-framework floor of ~1.7 ns per call the real ratio is about **650×** on
  the throughput path and about **8×** on an ask round trip, not 50-200×.

  Both language versions now cite the benchmark run behind the numbers and
  link the new `reference/benchmarks` page.  The cross-cluster line is marked
  as still unmeasured rather than left to read as measured, since the cluster
  benchmarks do not leave the process (#1177).

- **BREAKING — the receptionist's total cap is now called
  `maxSubscriptionsTotal`** (#1200).  It was enforced as a count of
  key/subscriber *pairs* while being documented as a count of *subscribers* —
  "Most subscribers this receptionist may hold across all keys together" — so
  one subscriber watching five keys quietly consumed five units of it, and a
  deployment that sized the cap against its expected subscriber population got
  refusals at a fraction of it.

  The name moved rather than the implementation, because the pair count is the
  correct bound.  Re-pointing the check at the distinct-subscriber count would
  have made the name true and removed a memory bound: nothing caps keys per
  subscriber, so a single already-counted subscriber could then take
  unboundedly many fresh service keys and grow both the relation and the key
  map without limit.  That was confirmed by trying it — the naive swap makes a
  fourth subscribe from a capped-out subscriber succeed, while all three
  pre-existing total-cap tests stay green, because each of them gives every
  subscriber exactly one key.  A new case now pins the distinction.

  `maxSubscribersPerKey` is unchanged: it counts the subscribers on one key, so
  its name was already accurate.  Behaviour is identical end to end, and the
  default is still `10000`.

  *Migration:* `withMaxSubscribersTotal(n)` → `withMaxSubscriptionsTotal(n)`;
  the plain-object field `maxSubscribersTotal` → `maxSubscriptionsTotal`; the
  HOCON leaf `actor-ts.cluster.receptionist.max-subscribers-total` →
  `…max-subscriptions-total`.  Code matching on
  `SubscribeRejected.reason === 'maxSubscribersTotal'` now matches
  `'maxSubscriptionsTotal'`, and `DEFAULT_MAX_SUBSCRIBERS_TOTAL` is exported as
  `DEFAULT_MAX_SUBSCRIPTIONS_TOTAL`.

- **BREAKING — `KeepMajority` downs both sides of an exact 50/50 split**
  (#1170).  `decide` returned the empty set on a tie — "remain pending" — so
  neither half downed anything and both kept running: the split-brain
  outcome the strategy exists to prevent.  It was not a transient state
  either, since each side's view is stable once the partition settles, so
  pending was the permanent answer for as long as the partition lasted.
  The tie branch now returns the reachable set, and because each half runs
  the same computation over its own view, both halves down themselves and
  the cluster stops whole instead of forking.  The documentation described
  this behaviour all along, in three places and in both languages; the code
  was the side that disagreed.

  *Migration:* an even-sized cluster that suffers an exact 50/50 partition
  now stops entirely rather than continuing as two live halves.  Size the
  cluster odd — the tie path is the fail-safe, not the plan — or pick
  `KeepOldest` / `KeepReferee`, which break ties by design.

- **`restartOnTermination: false` now takes the node out of rotation for
  good, instead of only until the next reconcile (#637).**

  Widening the singleton manager's reconcile trigger set put this opt-out
  in the blast radius. Both reconcile paths decide whether to spawn from
  "I am the host and have no child", which cannot tell a terminal stop
  apart from never having started — so any later reconcile resurrected an
  actor that had explicitly opted out of restarting. That was survivable
  while `LeaderChanged` was the only membership trigger, since a stable
  cluster may never fire it again; it is not survivable now that every
  up/down transition of any member reconciles.

  The opt-out is therefore state on the manager rather than an absence of
  events, and it is checked ahead of the membership question so it also
  gates the lease — a re-acquire would rebuild precisely the "holding a
  lease over a dead child" state that releasing the lease exists to avoid,
  and would block every other node from hosting too. Other nodes are
  unaffected. The latch lives on the manager instance, so restarting the
  manager (`cluster.singleton.stop(...)` then `start(...)`, or a
  supervisor restart, which builds a fresh instance) clears it.

- **BREAKING — Two nodes that disagree about `numShards` are no longer
  allowed to double-home entities silently (#633).**

  A shard id is `hash(entityId) % numShards`, computed independently on
  every node, and nothing in the sharding handshake ever carried the
  count. Two nodes configured differently therefore put the same entity id
  in different shards, each owned the shard its own arithmetic produced,
  and both instantiated the entity — at `shard-6/entity-x` and
  `shard-50/entity-x`, paths that never collide, which is exactly why
  nothing warned. For a persistent entity that is two writers on one
  `persistenceId`. The existing shard-id range check covers only one
  direction of this, a region asking for an id above the coordinator's
  range, and turns it into a silent hang that names the id and never the
  cause; the opposite direction passes the bound cleanly.

  `RegisterRegion` now carries `numShards` and the coordinator compares it
  against its own before accepting. A mismatch is refused: the region is
  not recorded, gets a new `sharding.RegisterRefused` back, logs it at
  error naming both counts, and stops re-registering until the coordinator
  moves to another node. The comparison is against the coordinator's own
  configured count rather than the first registrant's, which is not a
  durable authority — a leader change clears the region registry and the
  persisted coordinator state carries no shard count, so "first
  registrant" would be re-decided at every election and could flip
  mid-rolling-deploy.

  Refusing the registration is not sufficient on its own, and this is the
  part that is easy to miss: answering `GetShardHome` never required one.
  A refused region's first buffered message would still have had a shard
  allocated for it, under its own modulus, which is precisely the split
  the refusal exists to prevent. Refused region keys are therefore
  remembered and their `GetShardHome` dropped, until they either
  re-register with a matching count or the leader term ends. A
  misconfigured node stalls with a diagnosis next to it instead of quietly
  running a second copy of your entities.

  The rejection arrives as a log line rather than an exception because
  registration is asynchronous, retried, and re-run on every membership
  event — `start()` has long returned, and the coordinator may not exist
  yet when it does.

  *Migration:* Set the same `numShards` on every node that starts **or
  proxies** a sharded type — sharing one
  `actor-ts.sharding.number-of-shards` across the deployment is the least
  error-prone way. Two cases that previously appeared to work now fail
  loudly. A proxy started from a bare `ShardKey` (`startProxy(MyEntity)`)
  never received a `numShards` and fell through to HOCON and then 64, so
  in a cluster running any non-default count it was already mis-routing;
  it is now refused instead, and the error names the fix — pass the
  cluster's count through the options form of `startProxy`, or set it in
  HOCON. And calling `start()` for a type this node already started with
  `startProxy()` (or the reverse) now throws instead of returning the
  region the first call made; start each type once per node, as either a
  hosting region or a proxy.

- **`actor-ts.remote.tls.enabled` is now type-checked, and the startup
  warning it produces no longer quotes back a spelling you may not have
  written (#591).**

  The warning that told you the flag buys no encryption left three edges
  behind. Reading the key at all means going through `Config.getBoolean`,
  so a malformed value — `enabled = maybe`, or a numeric `1` — throws a
  `ConfigError` out of `Cluster.join` and the node does not start, where a
  typo used to be inert and the node came up plaintext. That is kept
  deliberately rather than softened: guessing what a mistyped *security*
  toggle meant has two defensible answers, and the forgiving one ("not the
  literal `true`, so: off") hands you a plaintext wire while your config
  says TLS — the exact state the warning exists to rule out. It is also
  what every other typed key in the framework already does. The throw
  names the key and what it expected. Both `reference/configuration.mdx`
  caution blocks now spell out which spellings enable, which decline, and
  that anything else stops the node.

  The warning text said "is true", but HOCON also spells a boolean `on`
  and `yes`; an operator who wrote `on` was sent hunting their config for
  a line that was not in it. It now says "asks for TLS", which holds for
  every spelling. And the guard was gated on `transport === undefined`
  while the line it guards selects the transport with `??`, which falls
  through on `null` too — so a `transport: null` built the plaintext
  transport and then said nothing about it. Unreachable from typed code,
  but it is the one case the warning exists for, so the `== null` is
  pinned by a test.

  Encrypting the cluster wire is still #941; none of this changes what
  goes over the socket.

- **Both mailbox queues are backed by a ring buffer, so a deep backlog no
  longer costs more per message than a shallow one (#408).**

  Every removal from a mailbox used to be an `Array.prototype.shift()` —
  `dequeueUser`, the `drop-head` eviction, and `dequeueSystem` alike — and
  `shift()` reindexes everything still queued. That was a bounded
  annoyance while the default mailbox was bounded. It stopped being one
  when the unbounded mailbox became the default again: a production
  backlog is now capped by the heap and nothing else, and 10 000 survives
  only as the depth at which a cell starts warning. The queue paying the
  tax was the one every actor gets by default.

  The replacement is a circular buffer with a moving head, power-of-two
  capacity and doubling growth, so pushes are amortized O(1) and taking
  the front is O(1). Measured on Bun 1.3.1 with the new
  `benchmarks/single-node/deep-mailbox.ts`, a full enqueue-then-drain
  cycle went from 6.6M to 9.3M msg/s at depth 1 000, from 9.8M to 14.2M at
  depth 10 000, and from 12.9M to 28.9M at depth 50 000; the gap widening
  with depth is the reindex being removed. End-to-end through an actor the
  difference is small and flat, because a `setImmediate` round trip per
  message dwarfs the queue operation.

  `prependUser` now moves a stash replay in one bulk insert instead of
  `unshift(...envs)`, which spread up to a thousand envelopes onto the
  call stack and reindexed the backlog once per envelope.
  `ThroughputDispatcher`'s work queue gets the same treatment, since it is
  drained from the front once per scheduled tick and holds every actor's
  pending unit. None of this is visible to a `Mailbox` subclass — both
  queues are private and the only seam, `protected removeOldest()`, is
  unchanged — and the queue type itself is exported as `RingBuffer` for
  anyone who wants it.

- **The examples that finish on their own no longer carry the DevTools
  harness (#552).**

  Forty-three short-lived examples each carried the same three lines of
  wiring — the `attachDevTools` import, the attach, and a `holdOpen()`
  parked before shutdown — or five, where the example builds two systems.
  Those are the files people copy to start from, and the first of those
  lines does not resolve at all once the file leaves this repository, so
  the scaffolding had to be understood and deleted before the example was
  the thing it claimed to be. `examples/hello-world.ts` is now twenty-six
  lines of actor code and nothing else.

  The harness stays where it earns its place. The dividing line is whether
  the example ends by itself: the twenty-five that run until you stop them
  — the HTTP and cache services, the cluster demos, the chat and voice
  backends — keep their wiring, and `--devtools` behaves there exactly as
  before. That is also the only place it was ever useful, since a script
  that is over in a few hundred milliseconds cannot be opened in a
  browser. Parking one just before shutdown was the workaround for
  precisely that, and with the short examples unwired it has no callers
  left, so `holdOpen` and `waitForInterrupt` are gone from
  `examples/devtools.ts`. The opt-in gate itself is unchanged and was
  never the cost: it has lived inside the harness since 3cf46220, so a
  disabled example already paid nothing at runtime.

  The DevTools documentation walked through `examples/hello-world.ts`,
  which would now demonstrate nothing; both languages run
  `examples/http/rest-service.ts` instead — a service that stays up, with
  a sharded actor tree that moves while the panels watch it. The
  `singleton-hello` fences are unchanged, that example being in the keep
  set. Both overview pages also claimed every example was wired for
  DevTools, and advertised the harness as "about thirty lines" when it was
  286; both claims are corrected.

- **The last seven examples that finish on their own lose the DevTools
  harness too, so the documented dividing line is the applied one
  (#552).**

  The sweep above keyed on `holdOpen()` — the examples that had parked
  themselves before shutdown — which is not the same set as "finishes on
  its own". Seven had only ever attached, so the sweep passed them by:
  `cluster/singleton-hello.ts`, `cluster/singleton-cron.ts`,
  `cluster/sharded-daemon-hello.ts`,
  `cluster/sharded-daemon-fixed-workers.ts`,
  `discovery/service-locator-cluster.ts`,
  `pubsub/event-bus-across-nodes.ts` and
  `management/opentelemetry-tracing.ts`. Each bound a DevTools port,
  logged a URL and exited between 0.7 and 2.9 seconds later —
  `singleton-hello` printed three URLs and was gone after about 1.3 s.
  The previous entry documented that wiring as inert rather than wrong
  and deliberately left it in place; it is removed now, which is what the
  documentation had claimed all along.

  The alternative was to give them a way to stay up under `--devtools`,
  resurrecting something like the `holdOpen()` the sweep deleted. Each of
  the seven ends by leaving the cluster and terminating its systems, so
  parking after that would tap a system that no longer exists — and
  parking *instead* of it would delete the demonstration, which in three
  of them is exactly the teardown: `singleton-cron` kills the leader to
  show failover, `service-locator-cluster` and `event-bus-across-nodes`
  drop a node to show a listing and a subscription set shrink. The
  scripted scenario is over within three seconds either way, so a browser
  would arrive at a finished system rather than a working one.
  `examples/cluster/counter-node.ts` is the cluster demo that runs until
  stopped, and both pages already send readers there.

  `tests/unit/devtools/ExampleWiringClaims.test.ts` guarded the old state
  by requiring the overview to *name* the seven. With the gap closed there
  is nothing to name, so it asserts the gap itself is empty instead: no
  example the example gate has watched run to completion may import the
  harness. Both overview pages, both actor-visualizer pages and the
  harness's own header record the closed gap rather than the open one.

- **BREAKING — `system.terminate()` now drains the actors under `/user`
  before it stops them (#663).** `ref.tell('x'); await system.terminate()`
  used to lose `x`, and every example, the README quickstart and both
  quickstart pages taught the workaround: sleep twenty milliseconds and
  hope.

  The mechanism was subtler than "system commands come first".
  `ActorCell.run()` re-evaluates its `while (mailbox.hasSystemMessages())`
  condition after every `await`, so a `terminate` arriving during an open
  await window is picked up in that same turn — before the user message
  already queued behind it — and a cell that has flipped to `terminating`
  stops dequeuing user messages entirely. The loss was therefore
  race-dependent rather than deterministic: measured against the old code,
  spawn+tell+terminate delivered 0 of 1, while a started idle actor
  delivered exactly 2 of 5, 2 of 10 and 2 of 50, one per hop of the root →
  /user-guardian → child cascade.

  The wait sits in front of the cascade rather than inside it, because the
  cascade is precisely what cannot be made to wait; the teardown itself is
  unchanged. Quiescence is per cell — no turn in flight, nothing
  dispatchable queued — and it is transitive for free, because a cell is
  marked busy synchronously at `tell` time. A reply that has been sent but
  not yet run already counts, so a ping-pong, a router fan-out and a
  supervision restart all keep the drain going instead of flushing each
  mailbox once. `system.awaitQuiescence(timeoutMs)` exposes the same wait
  and reports whether the tree settled or the budget expired.

  Three things are deliberately not waited for. A throttle-paused mailbox
  and a supervisor-suspended one count as quiet, because neither drains at
  a rate a shutdown can wait for — a `qps: 10` bucket would run shutdown
  at ten messages a second. Nothing under `/system` is inspected:
  heartbeats, failure detectors and broker reconnect loops are never quiet
  by design. And work that is not in a mailbox yet — a `context.timers`
  tick, a `tell` from an un-awaited promise — arrives after the tree looks
  quiet.

  The new `actor-ts.system.shutdown-drain-timeout` bounds the whole thing,
  defaulting to 2 s. That is deliberately under
  `coordinated-shutdown.default-phase-timeout`: the pipeline's last phase
  is a task that awaits `terminate()`, and a drain as long as the phase
  could burn the entire budget before a single actor had been told to
  stop, leaving the phase abandoned with the system still up. An idle
  system pays nothing — the first quiescence probe is synchronous, so
  `terminate()` on a quiet tree is as fast as it ever was.

  *Migration:* Set `actor-ts.system.shutdown-drain-timeout = 0` to restore
  the previous behaviour exactly — the drain is skipped and a queued
  backlog is dead-lettered by the teardown as before. This only matters
  for code that relied on shutdown discarding pending user messages, or on
  `terminate()` resolving without letting them run; anything that already
  awaited its work is unaffected. Note that a value above
  `actor-ts.coordinated-shutdown.default-phase-timeout` will get the
  `actor-system-terminate` phase abandoned mid-drain, so raise both
  together if you raise either.

- **A message routed to a singleton manager that is not hosting now goes
  to `system.deadLetters` instead of being dropped (#637).**

  `ClusterSingletonManager.onSingletonDeliver` logged a warning per
  message and discarded it. Nothing reached the dead-letter stream, so the
  loss was invisible to metrics, to DevTools, and to any assertion — while
  the proxy already dead-lettered on both of its own undeliverable paths
  (`bufferUntilHosted` past `bufferSize`, and `onMissingHost`), which is
  the same event seen from the near end of the wire.

  It is not a rare path. The proxy and the manager compute the host from
  the same rule but from different nodes' views, and a one-sided
  unreachability makes those views disagree by construction: peers of an
  unreachable role host route to the next role member, which deliberately
  does not promote itself, so every message from that side lands there.
  The warning is latched — and unlatched when the manager does spawn —
  because the condition lasts as long as the outage does while the sender
  keeps sending, so one line per message would be a flood rather than a
  diagnostic.

- **BREAKING — `actor_mailbox_dropped_total` is now labelled `{class,
  reason}` — the per-actor `path` label is gone (#658).**

  `path` was the one stock label whose values the framework derived per
  instance rather than the deployment declaring them:
  `$anonymous-<n>-<random>` for every `spawnAnonymous`, and
  `entity-<entityId>` under sharding, where the id comes from whoever
  addressed the shard region. Because the registry mints one child per
  distinct label tuple and has no per-child eviction, every dropping actor
  took a permanent time series — and shedding is a bounded mailbox's
  designed steady state rather than an anomaly, so a system behaving
  exactly as configured paid the cost. The counter was O(n) in actor count
  up to the 10 000-series family cap.

  The surviving labels are bounded by the program: `class` is a
  source-code constant and `reason` a closed two-value set. Per-instance
  drop counts have not gone away, they moved to where the cardinality
  budget belongs — `observeDrops` appends rather than assigns, so a
  `BoundedMailboxOptions.onDrop` of your own still fires alongside the
  stock counter and can label a series you have sized your own monitoring
  for.

  The sibling `actor_mailbox_size{class, path}` gauge and the
  `persistence_projection_*{projection}` families deliberately keep their
  per-instance labels, for reasons now written down as a rule under "What
  may become a stock label" in the stock-metrics docs.
  `maxSeriesPerFamily`'s 10 000 default is unchanged — its recorded
  rationale was built on the deleted label and has been rewritten onto the
  two families that can still legitimately reach thousands.

  *Migration:* Dashboards, alert rules and recording rules that group,
  filter or join `actor_mailbox_dropped_total` on `path` stop resolving —
  drop the `path` selector and aggregate by `class` instead (`sum by
  (class, reason) (rate(actor_mailbox_dropped_total[5m]))`). If you
  genuinely need per-actor drop counts, pass an `onDrop` to your mailbox
  options and record your own series; it runs alongside the stock counter
  rather than replacing it, so nothing else changes.

- **BREAKING — `ActorCell` now handles a batch of user messages per
  dispatcher turn, worth 2.1x-3.6x on `tell` throughput (#409).**

  The run loop dequeued exactly one user message and then re-scheduled
  from its `finally`, so every message cost a full `setImmediate` round
  trip no matter what any dispatcher's `throughput` was set to. The cap
  was structural: a cell may have at most one unit queued on a dispatcher,
  and it re-queues itself a microtask after the dispatcher's synchronous
  drain loop has already found its queue empty. A *per-actor*
  `ThroughputDispatcher` — the shape the tuning docs recommended — was the
  worst case, since its queue can never hold a second unit for its only
  actor.

  Measured on Bun 1.3.1 / Windows 11, running the two builds alternately
  four times each rather than once apiece: 143k to 297k msg/s at
  batch=100, 250k to 656k at 1k, 255k to 723k at 10k, 202k to 717k at
  100k. The run-to-run spread within an arm is under 9%, which is what the
  ends of the 2.1x-3.6x band are worth — the ratio rises with the batch
  size, and only the largest batch separates cleanly from the smallest.
  The `ask` round-trip benchmark gains less, 68.9k to 98.5k or 1.4x,
  because it awaits each reply, so its mailbox never holds more than one
  message and there is nothing to batch.

  `ThroughputDispatcher` is unchanged but re-documented: it batches
  *across* actors, which is not what the dispatcher-tuning and dispatchers
  pages claimed in either language.

  *Migration:* Scheduling interleaving changes: an actor now drains up to
  16 messages before yielding, so code that relied on other work running
  between two of one actor's messages can observe a different order. Three
  in-repo tests depended on it — a router reading routee mailbox depths,
  and two shard-allocation cases. Set `actor-ts.actor.throughput = 1`
  system-wide, or `ActorOptions.withThroughput(1)` on the specific actor,
  to restore the pre-#409 message-at-a-time loop exactly.

- **The receive path no longer allocates per message when metrics and
  tracing are off, worth a further 12-27% on `tell` throughput (#411).**

  Every user message used to pay four extension-registry lookups, four
  metric label and help objects built for a registry that discards them,
  one closure, one throwaway keys array and two clock reads before any
  user code ran. `ActorSystem` now mirrors the live registry and tracer
  onto plain fields written only by the owning extension; the dispatch
  closure became a private method taking the values it used to capture;
  `Date.now()` is read only when the explain recorder that consumes it
  already exists, rather than for every message; and `LogContext.isEmpty`
  replaces `Object.keys(context).length > 0` at the three envelope sites,
  with `RemoteActorRef` also dropping the conditional spreads that
  allocated an empty object on their false branch.

  Measured the same way as #409, three alternating rounds per arm: 12-14%
  at batch=100 and at 1k, 26-27% at 10k and 100k, and 12% on the `ask`
  round-trip (98.6k to 110.1k). Unlike #409's batching, these cuts apply
  at mailbox depth 1 as well — every delivery paid them — which is why the
  `ask` arm moves for this change at all. What no A/B over the pair can do
  is attribute the total between the two commits, so the per-message work
  this one removed is bound by counting the calls that would have done it
  instead: four extension-chain walks and one `Object.keys` per message
  with the caching taken out, flat zero with it in place.

  Behaviour with metrics or tracing enabled is unchanged, including when
  either is switched on or off while cells are already draining — which
  nothing covered before, and which four new cases now pin. A message is
  wholly instrumented or wholly not, since the handles are resolved once
  per message rather than at each instrumentation point.

  Two JSDoc comments that asserted the opposite of what the code did are
  corrected in place: `ActorCell` claimed a boolean was read first to
  avoid the extension chain (`||` short-circuits on a truthy operand, so
  the lookup always ran), and `metricsOf` claimed it avoids the extension
  chain while its body is that chain.

- **BREAKING — The cluster wire frames the tagged JSON tree instead of a
  bare `JSON.stringify` (#450).**

  `encodeFrame` was plain `JSON.stringify`, so the framework contradicted
  itself across its own boundaries. A `Map` a `PersistentActor` could
  persist and recover verbatim arrived at a peer as `{}`; a `Date` arrived
  as a string whose `.getTime()` throws; a `Uint8Array` arrived as an
  index-keyed object; `NaN` / `Infinity` / `-0` arrived as `null` / `null`
  / `0`; and a `bigint` threw a bare `TypeError` out of
  `TcpTransport.send`, which is to say out of `RemoteActorRef.tell` and
  into the sending actor's `onReceive`. Persistence settled this in #888
  and HTTP marshalling in `JsonSerializer`; the wire kept its own answer.

  The frame is now the same tree those two write, applied to the whole
  frame rather than to an envelope's `body` alone: the frame kinds
  carrying user data are not all declared in `Protocol.ts` —
  `ClusterClient`, pub-sub, sharding and DistributedData register their
  own through `Cluster._onWire` — and every one of them was lossy in the
  same way. `undefinedValues: 'omit'` keeps a payload made of plain data
  byte-identical to what `JSON.stringify` produced, and a test asserts
  that byte identity; `undefined` in a value position (array slot, `Set`
  member, `Map` key or value) is now preserved rather than becoming
  `null`.

  Verification had to be built from nothing, because nothing in `bun test`
  exercised an outbound `TcpTransport` encode: `MultiNodeSpec` delivers by
  reference, `ParallelMultiNodeSpec` structured-clones, all five cluster
  benchmarks and smoke case 02 use `InMemoryTransport`, and the two suites
  that do construct a `TcpTransport` only drive inbound mock sockets.
  `tests/unit/cluster/WireTypeFidelity.test.ts` drives two real transports
  through their public `send` / `setHandler` with real frames between
  them, and `tests/smoke/cases/27-cluster-wire-rich-types.mjs` runs the
  same thing over an actual socket on Bun, Node and Deno.

  *Migration:* This is a wire-format change and there is no protocol
  negotiation for it yet (#823). Neither direction of a mixed-version
  cluster is safe, and the newer-reads-older direction is the one worth
  spelling out, because it is easy to assume it is. An older node's frame
  is untagged JSON, and `decodeJsonTree` interprets a tag only when it is
  an object's sole own key — so *almost* everything an old node sends is
  carried through unchanged. The exception is a legacy value that already
  had that shape: `{__bytes__: 'not base64!!!'}` decodes to a 6-byte
  `Uint8Array` and `{__date__: 'whenever'}` to an Invalid Date, silently;
  `{__map__: …}`, `{__set__: …}`, `{__regexp__: …}`, `{__bigint__: …}`,
  `{__url__: …}`, `{__number__: …}` and `{__error__: …}` throw `Invalid
  wire frame payload` at any depth, and a decoder throw costs the whole
  TCP connection plus every frame batched into the same chunk. The
  `__literal__` escape only protects data the *new* encoder produced, so
  it does nothing for this. The other direction is plainly lossy: an older
  node reading a newer node's frame sees the tag wrapper as plain data.

  So: a cluster whose message bodies are plain data and contain no
  object-with-a-single-`__tag__`-key can roll node by node; anything else
  — a `Map`, `Set`, `Date`, `bigint` or typed array in any message body,
  or a plain object that happens to look like a tag — must be upgraded in
  a single window. Separately, a body the codec refuses (a function, a
  symbol) now costs the frame instead of being silently stripped — grep
  your logs for `dropping a '<kind>' frame` after the upgrade.

- **BREAKING — `managementRoutes(...)` returns the `Route` tree directly
  instead of `{ routes, health }` (#655).**

  The function no longer owns a `HealthCheckRegistry` — it reads the
  system's. Keeping the field would have preserved the misleading signal
  that the registry is born at route-building time, which is the shape
  that made the framework unable to register anything into it. Every
  registration that matters now happens before the call.

  *Migration:* Replace `const { routes, health } =
  managementRoutes(system, cluster)` with `const routes =
  managementRoutes(system, cluster)`, and obtain the registry with
  `healthChecksOf(system)` from `actor-ts/management`. Note that the
  `cluster` argument now selects which endpoints exist, not what readiness
  means: passing `null` on a system that did join a cluster still leaves
  `/ready` gated on that cluster's checks.

- **BREAKING — `Cluster.bootstrap`'s `shutdown()` now runs the
  CoordinatedShutdown pipeline instead of leaving and terminating directly
  (#549).** It is `coordinatedShutdown.run(ClusterLeavingReason)`, and it
  remains idempotent — `run()` hands back the same in-flight promise.

  For the default configuration this is a strict superset: everything that
  used to happen still happens, in the same relative order, and everything
  else that had registered a task now happens too. Two cases differ. An
  embedder that set `actor-ts.coordinated-shutdown.terminate-actor-system
  = false` will find that `shutdown()` no longer terminates the system —
  the old code bypassed that flag, which is the flag's entire purpose. And
  a caller that relied on `shutdown()` touching *only* the cluster and the
  system will now also see its HTTP servers unbound, its brokers closed
  and its DevTools detached.

  The signal handlers the bootstrap installs are `process.on` rather than
  `process.once` now, and can be removed — `removeProcessHooks()` detaches
  exactly what it installed, which the old raw handler could not do at
  all.

  *Migration:* If you set `terminate-actor-system = false` and still want
  `shutdown()` to terminate the system, call `system.terminate()` yourself
  after awaiting it. If you want the old narrow behaviour for the other
  resources, set `actor-ts.coordinated-shutdown.auto-register-tasks =
  false` and register what you want by hand.

- **Every example uses `runUntilTerminated()`, and the docs stopped
  describing wiring that did not exist (#549).** Seventeen examples each
  spelled out their own teardown and no two agreed; fourteen of them ended
  in `process.exit(0)`, which is what turns "graceful shutdown" into
  "whatever finished first". The other three — `io/jetstream-orders.ts`,
  `io/kafka-exactly-once.ts`, `io/websocket-server.ts` — awaited
  `system.terminate()` and stopped there, which leaves the phases a
  service actually needs unrun rather than cut short.

  Resources the framework does not own are registered as phase tasks
  instead, which is the part worth copying: `counter-node.ts` stops its
  traffic generator in `before-service-unbind`, `prometheus-endpoint.ts`
  stops its own `Bun.serve` in `service-unbind`, `redis-rest-service.ts`
  closes its caches in `service-stop`, `k8s-lease-singleton.ts` releases
  its lease in `before-cluster-shutdown`.

  On the docs side, `coordinated-shutdown.mdx` claimed the cluster phases
  "wire themselves up automatically when the cluster extension is active"
  and that the "cluster downing path is auto-wired". The first is now true
  for `cluster-leave` and stated that narrowly; the second is still not
  true and is documented as what it is, with the `cluster.subscribe(...)`
  you write if you want it. The phase table gains a **Wired** column,
  `cluster-exiting` gets an aside saying it has no acknowledgment to wait
  for (#1189), the Kubernetes rollout sequence loses its "wait for cluster
  to acknowledge leave" step, and `actor-system.mdx` stops teaching the
  hand-rolled `process.on('SIGTERM', …)` this issue exists to delete. Both
  language mirrors.

### Fixed

- **The comparison tables named seven columns and printed eight, so every
  column from `per op` onward carried its neighbour's label** (#1390).
  `report.ts` builds each row as framework / runtime / throughput / spread /
  per-op / p50 / p99 / ΔRSS and wrote a header that omitted `spread`;
  Markdown drops cells past the header width, so what the table called `p50`
  was the per-operation mean, what it called `p99` was p50, and ΔRSS never
  rendered at all.  In the published `ask-round-trip` table that read as a
  p50 of 1.23 µs where the measured p50 was 786 ns — 1.23 µs being exactly
  `1 / 817,189 s`, the throughput on the same row.  The file's own Arms
  section pointed a reader at "the spread column in the tables below", and
  there was no such column to find.  `RESULTS.md` is what `README.md` links
  as "Full tables and methodology", so this sat on the page whose whole job
  is being precise about the numbers.  The header gains the missing column;
  every figure is unchanged, because the report only re-renders the result
  files.

- **`incr` now adopts a counter another call seeded, so a rate-limit
  window is protected whichever call opened it (#1295).** `InMemoryCache`
  keeps two halves and takes its eviction victim from the opportunistic one
  first, but the half was picked at write time and never revisited: `incr`
  conferred the guarantee only on the branch that *created* an entry, and on
  an existing one it merely bumped, which re-inserts into whichever half the
  key already sits in. A window opened with `set(key, 0, windowMs)` therefore
  stayed opportunistic for its whole life however many finite-TTL `incr` calls
  followed — evicted first under exactly the key flood the split exists to
  survive, which is #607's shape at a configuration the operator has been told
  is hardened.

  The condition is the *entry's* expiry, not `incr`'s `ttlMs` argument: Redis
  semantics set a TTL only on creation, so the call that drives an existing
  window normally passes none, and reading the argument would have adopted
  only the counters that least needed it. Adoption is also separate from the
  bump rather than folded into the write, because re-inserting a key a `Map`
  already holds does not reorder it — `incr` owes an entry both the half and
  the recency, and a test pins each.

  Unchanged in both directions, which is what keeps the policy coherent:
  `set` still never *manufactures* a guarantee, so a seeded counter nobody has
  incremented is as evictable as any cached body; and a counter with no TTL is
  still not adopted, for the same reason an unbounded `setIfAbsent` claim is
  not — nothing would ever expire it, so protecting it would pin a slot for
  the life of the process.

  The shipped `rateLimit` always creates its counter through `incr`, so this
  was a user-code and shared-cache exposure rather than a live bypass of the
  middleware.

- **BREAKING (pre-1.0): `migrateBetweenJournals` no longer stops halfway
  through a copy (#740).** Every refusal it can raise — a tag list the
  target's `append` rejects, a compacted prefix the target cannot represent,
  a hole in the source's sequence numbers — is now decided in a read-only
  preflight over the whole run, so a copy either refuses with the target and
  the progress store untouched, or it runs to completion. It could previously
  leave behind a partly populated target, one truncated stream, and progress
  entries claiming the persistence ids before it were done — a shape a re-run
  with `skipExistingPersistenceIds` walked straight past, because the target
  held some data for the truncated stream.

  This was found by the wave's own verification pass, as a regression the
  wave itself introduced: #740's tag rules made `append` reject an empty or
  repeated tag, and a migration is a read and a write at once. A journal
  written before those rules could still be replayed but no longer copied,
  because the copy hands the source's `tags` straight to `target.append`
  behind a pass-through default `eventTransform`. It now fails with a
  `MigrationTagError` naming the persistence id and the sequence number.
  Reading such a stream is still never refused; copying it is a write, and
  that distinction is now stated on the persistent-actor and
  migration-recipes pages in both languages.

  `invalidTags: 'sanitize'` is the opt-in repair, and it covers exactly the
  two shapes a repair can be honest about: an empty member is dropped, a
  repeat is collapsed, and `MigrateJournalsResult.eventsWithSanitizedTags`
  counts every list it changed — so rewriting historical data is a number in
  the result rather than a silent edit. A comma, a control character, an
  over-long tag or too many tags on one event still refuse under it, because
  repairing those means inventing a tag or discarding one the caller meant.
  `eventTransform` is where that decision belongs.

- **The DevTools overview's Throughput chart no longer draws a line from
  metrics the node could not read (#744).** The tiles fed by an unreadable
  `MetricsRegistry` were dashed, but the chart below them kept plotting
  `messages / s` from the same counter — so one panel reported "no reading"
  and "zero traffic" at once. A blind node reports that counter as 0 on every
  sample, so the result was not a gap but a flat line along the axis: a
  positive claim that the system handled nothing, made in the shape readers
  trust most, at the moment they are scanning a busy system for a slow
  consumer.

  The chart now leaves the line out, keeps its axis, and names the omission
  in the legend, in the same warn colour as the dashed tiles. The block is
  not blanked: `dead letters / s` beside it is counted off the event stream,
  stays true, and is the series an operator reaches for during exactly the
  incident this flag appears in. The legend's peak reading is computed over
  the lines that survive, so it describes what is drawn.

- **`DocSampleHarnessEndToEnd` no longer fails most whole-suite runs on
  a timeout nobody set (#1282).** Its `beforeAll` runs the doc-sample
  harness twice, and each of those runs spawns `bunx tsc` twice — the
  fixture carries an unparseable fence on purpose, so the script's
  second pass always fires — which puts four compilers in series against
  bun's undeclared 5 000 ms hook cap. Idle the hook takes 3.1 s and the
  file passed; inside a full `bun test` it takes 4.3 s and under
  contention 9.0 s, so it failed roughly three whole-suite runs in four,
  on clean `develop` as much as on a branch. The compiles are unchanged
  and still real — reducing them would delete the two properties the file
  exists to prove. What changed is that the budgets are stated and
  layered: each spawn carries a 30 s budget and throws an error naming the
  script, its flags and the elapsed time, and the hook's 90 s cap is a
  backstop behind it. Measured before and after under identical load
  (16 repeats, 8 in flight): **0/16 runs green with 17 test executions,
  against 16/16 green with 208**.

  The failure was also unreadable, which is why it stood for a week: bun
  reports a hook timeout as `(unnamed)` and calls a `beforeAll` a
  `beforeEach/afterEach` hook, and the whole 13-test block collapses to
  one recorded failure. Hence the named error: reaching the hook cap now
  means the stall was somewhere other than a spawn.
  `docs/…/testing/diagnosing-flakes.mdx` (EN + DE) carries it as a new
  catalog family, with the caveat that `bun run test:stress` cannot
  currently name this shape (#1359).

- **A shard region refused for a `numShards` mismatch now releases the
  shards it was already hosting (#633).** Refusing a registration only
  stopped *new* placements, so a region accepted by one leader and refused by
  its successor — what a rolling deploy that changes the count produces the
  moment leadership reaches an already-updated node — kept the
  `shardHomes`/`localShards` the first coordinator gave it, kept delivering
  out of that cache, and could never be handed off, because the coordinator
  only sends `HandOff` to a region it has registered. The split routing the
  refusal exists to prevent therefore survived it. The refusal now stops each
  hosted shard through the shard actor's own stop, so the entities beneath it
  run `postStop` and a persistent one flushes rather than being dropped
  mid-write, and drops the ownership in the same synchronous step.

  A region's `Register` is also re-sent every 500 ms until the coordinator
  acknowledges or refuses it. `Register` is fire-and-forget at a path that
  need not exist yet — a node that joins and immediately takes leadership has
  no coordinator behind that path until its own `sharding.start(...)` runs,
  and the frame is dropped as an envelope with no handler. Nothing re-sent
  it, because `ensureRegistered` runs off cluster events and the events for
  that leadership move have already fired. The region then stayed silently
  *unregistered*, which is worse than refused: no acknowledgment, no
  refusal, and a new coordinator that never got the chance to say no to a
  region still hosting shards.

- **The testkit's multi-node broker validates a brokered frame before
  dereferencing it (#701)**, the way the production worker broker has since
  its own fix. `MultiNodeBroker.onMessage` took its argument as a
  `BrokeredMessage` and read `env.to` straight into `NodeAddress.fromJSON`,
  so one malformed frame from a worker threw inside `ParallelMultiNodeSpec`'s
  own `message` listener — where nothing catches it — and failed the whole
  test process rather than the scenario that sent it. `./testkit` is a
  published entry point, so this was shipped code.

  The frame guard now lives beside `BrokeredMessage` in
  `MessageChannelTransport.ts` and is shared by both brokers instead of being
  private to `WorkerBroker`: a security check copied into two files is how
  the testkit fork kept the defect through the first fix. As a side effect of
  the try/catch, a frame the harness forwards to a worker `crash()` has
  already terminated is dropped instead of throwing `InvalidStateError` out
  of `postMessage` — that failure used to be attributed to whichever test
  happened to be running. `tests/unit/testkit/MultiNodeBroker.test.ts` is new
  and gives that file its first coverage; it drives the broker through an
  in-memory port shim, so unlike `ParallelMultiNodeSpec.test.ts` it runs in
  CI rather than behind `ACTOR_TS_SKIP_FLAKY_MNS`.

- **`reEncryptObjectStorage` no longer crashes when `sampleSize` exceeds
  the object count** (#1353). The pre-sweep keyring-completeness check
  clamped its sample to the corpus when it picked the default, and not
  when the caller passed one. A `sampleSize` past the end of the listing
  walked `items` off its tail and died on `undefined.key` — a bare
  `TypeError`, thrown before the sweep rewrote a single object.

  The reason this was reachable rather than theoretical is that the
  master-key rotation runbook suggests it: `operations/upgrades/
  rolling-migration` shows `sampleSize: 200` as the optional override.
  Uncomment it on a bucket holding fewer than 200 objects — a staging
  bucket, a small tenant, a first rehearsal of the rotation — and the
  operator tool whose whole job is to fail *safely* before touching the
  corpus instead failed uninformatively.

  The sample is now clamped at the point the default is resolved, so an
  oversized `sampleSize` samples every object. The documented
  `min(100, total)` default is unchanged, and the check still refuses a
  ring that is missing a version the corpus references.

- **A cluster that can never converge now says so** (#1351). Give every
  node a non-empty seed list and the default `selfElection: 'immediate'`
  — which self-elects only on an *empty* one — and no node ever reaches
  `up`: `leader()` is the first of `upMembers()`, and only a leader moves
  a node from `joining` to `up`. The configuration is documented as one
  that does not cold-start, but nothing said so at runtime.

  What an operator saw instead was `AskTimeoutError` from a singleton
  proxy, several subsystems from the cause, because
  `ClusterSingletonManager` picks its host from `upMembers()` and there
  was never one to pick.

  The seed retry loop now carries the verdict: it runs exactly while the
  node is stuck and cancels itself the moment it is not. After
  `COLD_START_STALL_AFTER_SEED_ROUNDS` fruitless rounds, with no `up`
  member known and no self-election pending, it logs one WARN — naming
  the unanswered seed addresses when nothing has replied, and the
  `seeds` / `selfElection` pairing when every peer is present and every
  one of them is waiting. Once, not per round.

  The check is exact rather than heuristic, so it does not fire for a
  node joining a healthy cluster, nor while a deferred self-election is
  still due. The round threshold exists only because the same condition
  is briefly true, and harmless, during an ordinary simultaneous start.

- **A healthy cluster no longer logs a WARN on every gossip frame**
  (#1352). A frame carries the sender's whole member map, so a node's
  own record comes back to it once per round. `maySpeakFor` refuses a
  claim about the receiving node — rule 1 of #562, unchanged — but it
  logged every one of them, including the peer simply echoing the status
  the node already held. At the default one-second gossip interval that
  is a WARN per second per peer describing normal operation, and during a
  two-node bring-up it was the loudest line present and read as the cause
  of a failure that lay elsewhere.

  An echo is now refused in silence: it would have changed nothing the
  version comparison in `mergeMember` did not already drop. A peer that
  *contradicts* us still surfaces, but through the same per-frame
  machinery as every other guard on that path — one line and one
  `cluster_gossip_records_refused_total{reason="self-claim"}` increment
  per frame rather than per record, the property #131 established. The
  counter still reads zero on a healthy cluster, and what a peer is
  allowed to say about this node is untouched.

- **A bounded mailbox now applies its capacity, its overflow policy and its
  drop accounting to the `unstashAll()` replay path (#772).**
  `BoundedMailbox` overrode `enqueue` and nothing else, so every envelope
  re-entering through `prependUser` went straight onto the queue, past the
  capacity check, past the overflow dispatch and past the drop accounting. A
  `reject` mailbox never threw, a `drop-head` / `drop-new` mailbox never
  dropped, and `droppedCount` / `actor_mailbox_dropped_total` under-reported
  by exactly the batch. With the stash capped at 1024 envelopes a
  `capacity: 10` mailbox could hold 1034 — the advertised memory ceiling was
  not one.

  The geometry mirrors rather than copies: an arrival lands at the tail and
  `drop-head` makes room at the head, so a replay lands at the head and makes
  room at the **tail**. A full mailbox sheds its newest queued messages instead
  of the ones the actor deliberately parked; evicting the head under a prepend
  would discard the messages the replay just put back, which is not a bound but
  a way of making `unstashAll()` a no-op. Once the queue holds nothing
  droppable the arrival is what goes, reported as `drop-new`. `reject` throws
  `MailboxFullError` *before admitting anything*, and `ActorCell.unstashAll`
  restores the stash buffer before the error travels on, so the batch stays
  parked and `deadLetterStash` still sees it.

  That last sentence holds for the untyped `context.stash()` /
  `unstashAll()` path only. The typed `Behaviors.withStash` path
  dead-letters the batch instead, because `StashBuffer` has already emptied
  itself by the time it calls the cell and there is nothing left to put back.
  The same split applies to `Envelope.undroppable`: a `Terminated` that
  round-tripped through the untyped stash is admitted whatever the policy says
  and is never counted (#729), and the typed buffer has no such path to
  preserve it.

  New seams, because `Mailbox.userQueue` is private: `RingBuffer.pop()` and a
  protected `Mailbox.removeNewest()` beside `removeOldest`, both stepping over
  undroppable envelopes. `PriorityMailbox` overrides `removeNewest` as well —
  it does not use the base user queue, so an inherited version would return
  `undefined` forever and any bound built on it would quietly stop enforcing,
  which is the shape of #407.

  Worth knowing for anyone who opted into a bound: `unstashAll()` on a full
  bounded mailbox can now drop messages, or throw under `reject`, where it
  previously always succeeded. Mailboxes are unbounded by default since #1148,
  so nothing changes for an actor that never called `withMailboxCapacity`.

- **`FilesystemObjectStorageBackend.list` now reads only the directory its
  prefix names (#746)** — everything up to the prefix's last `/` —
  instead of walking the whole storage root and filtering afterwards. A snapshot
  `loadLatest` previously read every *other* entity's directory, turning an
  O(1) lookup into O(N) in the entity count on the actor's mailbox, and
  `keepN` pruning re-ran the same LIST after every save. Which keys come back
  is unchanged; the `startsWith` filter stays as the correctness backstop, so
  a partial-segment prefix like `mine/e` still matches `mine/e0/…` and
  `mine/e10/…` alike. The S3 backend was never affected — it passes `Prefix`
  and `MaxKeys` to `ListObjectsV2Command` — so the defect was invisible to
  anyone measuring against S3.

  A positive `limit` now stops the walk rather than trimming a finished array,
  which is the parity with S3's `MaxKeys` the issue asked for; `limit: 0` and
  negative limits keep their historical `slice` semantics, and under a limit
  each directory's entries are ordered before descending so the depth-first
  order agrees with the ascending key order the contract promises — with one
  bound the code's own JSDoc states and this entry should too: that agreement
  rests on `localeCompare` being prefix-monotone, which it is not for every
  character. A key containing U+FF0F FULLWIDTH SOLIDUS, legal on NTFS and
  POSIX alike, collates so that the early exit can stop one entry too soon.
  No caller in `src/` passes a limit today. A prefix
  naming a directory nothing ever wrote to, or one whose directory portion is
  an ordinary file, now returns an empty listing instead of surfacing
  ENOENT/ENOTDIR — both became reachable only once the walk started at the
  prefix. `list` also now runs the same post-resolve root containment check
  `put` / `get` / `delete` already do, since it joins caller-supplied text
  into a path for the first time.

  Corrected the `ObjectStorageSnapshotStore` class doc, which described
  `loadLatest` as "a single LIST with `limit:1` and reverse iteration over the
  sorted result". It never did that and could not: the contract sorts
  ascending, so `limit: 1` returns the *oldest* snapshot.

- **A cluster whose nodes all advertised `0.0.0.0` never formed** (#944).
  The host a node resolved became both its bind address and its identity,
  and the last resort of that resolution was the wildcard. Every node
  that reached it advertised the byte-identical
  `<system>@0.0.0.0:2552`, so each read the others' self-announcements as
  claims about *itself*, `maySpeakFor` refused them as claims a node may
  not make about another's status, and every member map held exactly one
  entry — with nothing in the log to separate that from a cluster that
  had merely not converged yet.

  The fallback was reachable more often than its position suggested.
  `POD_IP` exists only where the pod spec exports it; `HOSTNAME` is a
  shell variable, so a service started by systemd or a process manager
  sees `process.env.HOSTNAME === undefined`, and where it *is* set it is
  a pod name that resolves under a StatefulSet with a headless service
  and nowhere else.

  `resolveAdvertisedHost` now fills the identity from one chain that both
  `Cluster.join` and `bootstrapCluster` share, and no stage of that chain
  except an explicitly named value can produce a wildcard — which is what
  lets `ClusterOptionsValidator` refuse one outright, at construction,
  instead of leaving a cluster to not converge. `TcpTransport` gained a bind host used for the `listen` call
  alone, so `self` stays the identity in the handshake and in the peer
  keys.

  **BREAKING** in behaviour, not in signature: a node that named no host
  at all used to advertise `0.0.0.0` and now advertises `127.0.0.1`.
  Nothing configured correctly moves — a routable `host` still wins over
  the environment — but a multi-node deployment that relied on the old
  fallback was already broken and is now reachable only on loopback,
  which the node says out loud at startup. Set `withAdvertisedHost(...)`,
  `actor-ts.remote.tcp.advertised-host`, or `CLUSTER_HOST` / `POD_IP`.

- **The DevTools tracing panel no longer draws every retained span twice
  after a re-subscribe (#1350).** `SpanTap.snapshot()` hands a fresh
  subscriber the server's whole ring, and two paths re-subscribe a stream
  that is already open: the sequence-gap recovery in `tapClient`, and the
  re-subscribe of every live stream after a reconnect. The panel appended
  that snapshot to what it already held, so the flame graph and the
  waterfall showed each span twice, a trace grew duplicated children, and
  the span count was simply wrong.

  The other stream consumers survive the same frame because their handlers
  **replace** — `ActorTreeModel.reset` drops its map, `onClusterSnapshot`
  calls `members.set(...)`. Tracing is the one that accumulates, so the
  snapshot meant "here is everything" to them and "here is more" to it. It
  now keys its ring by `spanId` (16 hex characters of crypto-grade
  randomness, from W3C trace-context), so a span that arrives twice is
  recognised rather than recorded again. Insertion order is unchanged: a
  resent span keeps its own place instead of jumping to the newest end and
  pushing a genuinely newer one out of the ring.

  Rare enough to have gone unnoticed — a reconnect after a laptop wakes
  from sleep is the likely first sighting. Not reached by the pause added
  in #1349, which classifies `spans` as a buffered stream and replays held
  batches rather than re-subscribing.

- **`RedisStreamsActor` now routes connection loss into the shared
  `BrokerActor` reconnect machinery (#742).** It was the one subclass that
  never called `handleConnectionLost`: it registered no listener on either
  ioredis client, and its consumer loop answered every `XREADGROUP` rejection
  the same way — warn, sleep 500 ms, retry the same dead client. `_state`
  stayed `'connected'` for the whole of an outage, so the configured
  `reconnect` backoff, the circuit breaker and the `BrokerDisconnected` health
  signal were all inert on the consume path, and the
  `XGROUP CREATE … MKSTREAM` bootstrap never re-ran — leaving the loop to
  spin on `NOGROUP` after a Redis restart that lost the group. Only a
  publishing application recovered, via the outbound path; a pure consumer
  had no route in at all.

  The driver's `error` / `close` / `end` signals are now wired to
  `handleConnectionLost`, which also removes ioredis's unhandled-`error`
  fallback; signals escalate only from clients that finished connecting, so a
  refused connection is reported once rather than scheduling two competing
  reconnect loops. The consumer loop classifies its rejections —
  connection-level ones (socket gone, `ECONNREFUSED`, ioredis exhausting its
  per-request retries, `NOGROUP`) hand the outage to the configured backoff
  and leave the loop, command-level ones keep a short local retry. `NOGROUP`
  counts as connection-level deliberately: re-running the group bootstrap is
  the only thing that clears it, and that happens on connect. Repeated
  identical failures collapse into one WARN per 30 s carrying the count it
  stood in for.

  `connectImplementation` can now fail — the clients are built with
  `lazyConnect` and their `connect()` awaited, so an unreachable Redis
  produces a failed attempt and a backoff instead of a `BrokerConnected` for
  a broker nothing has reached. The consumer loop is bound to the client
  generation that started it, closing a window in which a loop suspended in
  `xreadgroup` across a reconnect would resume beside the new one, two
  readers sharing one consumer name (#982). A `protected createClient(url)`
  seam mirrors `NatsActor.createNatsConnection`, so all of this is testable
  without the `ioredis` optional peer.

  The Redis Streams page documents the reconnect behaviour for the first time
  (EN + DE), and the `BrokerDisconnected` row of the BrokerActor events table
  is corrected in both languages: it claimed the event fires when "a
  `disconnectImplementation` ran or a connection failed", but the only
  publish site sits inside `handleConnectionLost`, so a graceful `postStop`
  teardown publishes nothing.

- **DevTools grouped large numbers differently depending on the host**
  (#553). `formatCount` grouped thousands by rewriting the comma out of
  `toLocaleString('en-US')`, but that separator comes from the runtime's
  ICU data — it is a comma under Bun and a thin space (U+2009) under the
  Node that runs the UI test suite, where the rewrite therefore hit
  nothing. Grouped by hand now, and pinned by a test that asserts the
  codepoint rather than the shape.

- **The voice sample promised a `Uint8Array` and returned `unknown`, and the
  one config that could have said so was told not to look** (#1015).
  `Array.prototype.find` over a union hands back the whole union, so reading
  `.data` off the result is `unknown`. Both helpers in
  `examples/voice/smoke-test.ts` reached for it through `(e as any).data` and
  `?.['data']`, which is precisely what stopped the mismatch from being
  visible where it was written. They now narrow with a type guard over named
  `TextEvent` / `BinaryEvent` variants, and the casts are gone. The change is
  type-level only — the sample still round-trips all three modes.

  Why it survived is the more useful half. `tsconfig.dev.json` excluded the
  file, excused as a black-box script that "imports nothing from `src/` and
  this config would catch no API drift in it either way". That does not match
  the exclude rule stated at the top of that same file — a file is excluded
  when a manifest *other than the root* resolves its imports, and this one's
  (`node:*`, `ws`) all come from the root — and drift is not the only thing a
  typecheck catches. The entry is gone, so the file is gated from now on. The
  gate was checked in both directions: with the exclusion lifted but the
  source left unfixed, `typecheck:dev` fails with exactly the reported error,
  and green only once the narrowing lands. This was the last of the eight
  errors #1015 inventoried; the other seven had already been fixed in passing
  by #540's sweep and by #1014.

- **A one-way tell batch could be read before it landed, and one failed arm
  discarded every arm's rounds** (#1326). Both surfaced on the same run: a
  hundred-round measurement stopped at round 44 with `completed 993 of 1000
  operations`.

  The virtual-actor arm sends its batch as one-way RPCs — that runtime's
  nearest analogue to fire-and-forget — and then read the counter back with a
  single call. A one-way call completes when the message is *dispatched*, not
  when the grain has processed it, and the runtime orders it against nothing,
  so the read could overtake the tail of the batch. No other arm needs care
  here: their frameworks order messages per sender-recipient pair, so a read
  issued after N sends observes all N. The read is now a bounded drain that
  accumulates across reads — delayed messages are counted, and messages that
  were *dropped* rather than delayed still time out and still fail the row, so
  it remains a completion check rather than a way of passing one. Both
  directions are covered by a probe: the same delayed batch fails with the old
  single read and passes with the drain, and a permanently lost batch fails
  either way.

  Separately, the driver called `process.exit(1)` before it merged, so one arm
  failing once at round 44 threw away the other eight arms' hundred rounds as
  well — hours of measurement, already written per round, discarded over one
  bad row. It now merges first and reports the failure afterwards. Merging
  costs no honesty: each merged file records that arm's own round count and
  `RESULTS.md` prints it per arm, and the driver names any arm that fell short
  of the requested count.

- **The comparison benchmarks now run on Linux** (#1325). Six of the nine arms
  failed there. Two separate causes, and they deserved separate treatment.

  The committed POSIX build-tool launchers were recorded at mode `100644`, so
  `/bin/sh` refused to exec them and every JVM arm died with exit 126 before
  its build tool was reached. Windows never saw it — there the `.bat` sibling
  is the entry point and `core.fileMode` is false regardless — and neither did
  any gate, because nothing in the repository looked at a file mode. The four
  scripts are now `100755`, asserted against the **git index** by
  `tests/unit/ci/ComparisonLauncherModes.test.ts`; the working tree cannot
  answer that question on Windows, so a filesystem check would have passed on
  the one platform where the bug does not bite.

  Separately, an arm whose toolchain is simply not installed was reported as a
  failed arm, so a machine without the .NET SDK exited non-zero and buried the
  arms that did measure under an error summary. The driver now checks each
  external arm before running it and reports a missing toolchain as **skipped**,
  naming what to install and keeping the exit code at 0 — `RESULTS.md` dates
  every arm separately, so a partial run stays legible. Skips are listed in the
  summary on the success path too, since a partial run reported as a plain
  green tick is how a release publishes figures for arms that never ran. A
  launcher that exists but is not executable stays a hard failure: that is a
  broken checkout, not an environment choice, and the message carries the
  `chmod` that fixes it.

  The Windows `.bat` is also no longer the reason POSIX goes through a shell.
  A shell is now used only where one is required, which removes the last place
  a path containing a space could break the invocation.

- **The parallel pubsub end-to-end test waited for its two subscribers by
  polling drain, which empties the probe it reads, so the round in which one
  subscriber had the message and the other did not discarded the first one's
  copy and the loop could only succeed when both deliveries landed inside
  one 80 ms window; when they did not, it fell through silently and failed
  on an empty array. It now polls a non-destructive count and drains once.
  (#418).**

- **The dead-letter queue's shutdown flush was covered by nothing (#433).**

  The whole restart suite stayed green with `flush()` stubbed out to do
  nothing, because the in-memory journal's appends resolve promptly enough
  that the serialized write chain drained by itself before termination
  started — so the four cases the "letters survive a restart" criterion
  rests on were passing for an unrelated reason. A journal with a delayed
  append plus a burst of captures makes the backlog real at shutdown time,
  and that case now fails when the flush is removed while the other eight
  stay green.

- **The stock-metrics pages claimed that "a system that keeps nothing counts
  nothing", which the new `metrics` store falsifies, and still described the
  replayed counter as naming the original recipient, which stopped being
  true when replay grew an alternate destination. Both languages corrected.
  (#433).**

- **A rate-limit regression test asserted the right conclusion for the wrong
  reason (#607).**

  With `max` set below the flood size, the limiter short-circuited from
  the third request on, so the flood minted two response-cache entries
  instead of twenty, the map never reached its cap, and no eviction ran at
  all in the test that claimed to prove a counter survives eviction. It
  now floods with `max` at the flood size and asserts the map is full
  before drawing any conclusion.

- **BREAKING — A cluster singleton no longer dead-letters messages routed to
  it while it is the elected host but has no instance yet (#637).**

  Three ways into that state were uncovered: a hand-over is outstanding
  and a peer has not finished standing down, `lease.acquire()` has not
  resolved (a round trip to Kubernetes, etcd or Redis), or the node is
  already the host in a peer's view and not yet in its own — a joining
  member is `up` to its peers a gossip round before it is `up` to itself.
  Measured on the three-node role-restricted fixture the issue names,
  seven of seventeen messages sent across a take-over were lost with no
  failure of any kind in play. Such messages are now held, capped at 1000
  and expiring after two seconds, and flushed into the instance in send
  order the moment it spawns. The hold is deliberately not conditional on
  the manager agreeing that it hosts, because the window exists precisely
  because it does not agree yet; a manager that has opted out of hosting
  via restartOnTermination is the one case that still dead-letters at
  once.

  *Migration:* A message routed to a manager that will genuinely never
  host now reaches deadLetters up to two seconds later than before; a test
  or alert that asserted an immediate dead letter needs a longer wait.

- **Documentation that misstated where serialization happens, in both
  directions (#450).**

  Six pages plus their German twins claimed either too little or too much
  about the cluster wire. serialization/json.mdx said the wire uses raw
  JSON.stringify so a cross-node tell gets no tag round-trip (it does now,
  through the same tagged tree); cluster/transports.mdx called
  TcpTransport over loopback "the JSON framing every cluster transport
  uses" (it is a tagged tree, and neither InMemoryTransport nor
  MessageChannelTransport frames anything at all); and the migration aside
  in serialization/overview.mdx gave the affected release pair as 0.15 to
  0.16 when the change is not an ancestor of v0.16.0, and illustrated it
  with an example that was wrong in both directions. In the other
  direction, http/marshalling.mdx still called the SerializationExtension
  "the right hook" for cluster-wire serialization, and the frontmatter
  descriptions of serialization/overview.mdx and serialization/custom.mdx
  still said the extension chooses the format by class binding,
  contradicting their own page bodies. Three CBOR asides described hazards
  that cannot occur because a binding never reaches the wire; they are
  re-aimed at the boundary where the hazard is real, a persistence row
  written through withSerializer(...) that names the serializer id it
  needs.

- **The SerializationExtension class JSDoc, which TypeDoc republishes
  verbatim into the API reference (#450).**

  It claimed the class would graduate to an ExtensionId once the
  Extensions mechanism landed and that it is constructed directly inside
  ActorSystem; both halves are false, the ExtensionId is declared in the
  same file and ActorSystem neither imports nor constructs the class. It
  now states how the registry is reached and how far a binding registered
  in it actually gets. The example
  examples/serialization/hello-serializer.ts no longer says its binding is
  "for compact binary transport".

- **Test coverage for the hazardous half of the wire-format rolling upgrade,
  which three separate prose descriptions asserted and no test pinned
  (#450).**

  A legacy frame carrying a reserved-tag shape at any depth throws out of
  the decoder and costs the whole connection plus every frame batched into
  the same TCP chunk, because the decoder throws rather than returning the
  frames it had already decoded; and the two tags that cannot throw,
  __bytes__ and __date__, corrupt the value silently instead, a malformed
  base64 string becoming a six-byte Uint8Array and a malformed date an
  Invalid Date. A third case pins that a class binding registered in a
  SerializationExtension does not reach the wire, so the corrected prose
  has something behind it.

- **BREAKING — DistributedData gossip is now bounded by a per-frame byte
  budget and sweeps a larger store across successive ticks (#691).**

  Previously gossipTick serialised the whole key set into one ddata-gossip
  frame with no size check on the send path, so a store past the
  receiver's remote.max-frame-bytes produced a frame rejected on its
  4-byte length prefix before any payload byte was buffered. The transport
  answers that decoder throw by dropping the connection, so the store did
  not converge slowly, it did not converge at all — no key ever reached
  the merge — while one peer association died per gossip interval, taking
  heartbeats, membership gossip and every cross-node tell with it, then
  reconnecting to die again. Slicing is safe because merge is per key and
  an absent key means no information rather than deletion.

  *Migration:* A store larger than 1 MiB now converges over several gossip
  ticks instead of one frame; set
  actor-ts.distributed-data.max-gossip-bytes higher (or 0) to restore
  single-frame gossip, bearing in mind it is still clamped to
  remote.max-frame-bytes.

- **An unserialisable value inside an LWWRegister (a function, a Promise)
  now costs only its own key in a gossip round (#691).**

  Transport.writeFrame catches the same failure but drops the entire
  frame, so one bad value silenced every other key that travelled with it.

- **Documentation corrections found while editing the same pages: the
  DistributedData class doc still promised full-state push was fine for
  small stores without defining small and still claimed no durable
  persistence, which has been untrue since durableStore landed; and both
  language versions of the replication page told readers to raise
  gossipIntervalMs, which is not the option's name (it is gossipInterval,
  HOCON actor-ts.distributed-data.gossip-interval). (#691).**

- **The WebSocket transport frame cap that Express and Fastify install is
  now asserted directly rather than only end-to-end (#373).**

  Six cases read the limit off the transport itself — Express's `noServer`
  `WebSocketServer` and, on Fastify, the `websocketServer` decoration
  `@fastify/websocket` adds — and pin that it is the route's own resolved
  `maxFrameBytes`, that it drops below the framework default when a route
  lowers it, that two routes on one server reconcile to the widest, and
  that a HOCON-only setting reaches it with no route option at all.
  Reverting either backend to the built-in constant turns all six red;
  before this, nothing anywhere checked the number either backend hands
  `ws`, because every discriminating test for the change binds the Hono
  backend and the shared backend suite's raised-cap case passes on Bun
  whether or not the fix is present.

- **Two comments that described behaviour their subject does not have
  (#373).**

  `transportFrameCapOf`'s rationale claimed a per-route cap is impossible
  because "Express builds one `WebSocketServer` for the whole app" — true
  of Fastify's single plugin registration and of `Bun.serve`, but a
  property of this backend on Express, where `completeUpgrade` already
  holds the matched registration when it calls `handleUpgrade`. It now
  says the shipped backends share one transport, names the cost of taking
  the widest (a 64 KiB route beside an 8 MiB one gets an 8 MiB buffering
  window), and records where the installed number is ignored. And the
  shared WebSocket backend suite explained its oversize-frame assertion
  with "this frame no longer reaches the connection actor at all: `ws`
  (Express, Fastify) answers the protocol violation with a clean 1009" —
  on Bun, the only runtime that executes that file, the frame does reach
  the actor and the 1009 is the actor's. The assertion was correct; the
  explanation was not.

- **A `ShardRegion` now hands off only a shard it currently owns, and only
  once (#584).**

  `onHandOff` had an origin gate and no precondition behind it, so a
  duplicate or late `HandOff` — authentic, from the coordinator's own
  node, which is what `Transport` produces when frames buffered before a
  handshake finally flush — marked the id `handing-off`, acknowledged, and
  fell straight into `completeHandOff`, deleting the region's cached
  "shard X lives on node N" entries for a shard it was never handing off.
  Ownership is judged by allocation, not by whether the shard actor is
  running, so a shard that passivated for being idle still hands off. The
  coordinator does not stall on a refusal: it only ever sends `HandOff` to
  the region its own allocation map names, and `handOffTimeoutMs` is the
  existing fallback for a disagreement. The correlation nonce echoed from
  `BeginHandOff` that the issue also proposed is recorded as won't-do:
  replaying a genuine `HandOff` needs an on-path position on a plaintext
  link, and that same position reads the nonce off the same link, while
  mTLS already binds the address claim to the peer certificate.

- **The `numShards` refusal now names a configuration key that exists
  (#633).**

  The region's rejection message told the operator to set
  `actor-ts.sharding.num-shards`; `reference.conf` ships
  `number-of-shards`. That message is the whole of the issue's "clear
  rejection" criterion, and it survived because no test looked at it and
  because `NoDeadConfigKeys` walks reference.conf to `ConfigKeys` — an
  invented key inside a free-text log string is outside its direction of
  travel. The path is now interpolated from `ConfigKeys` rather than
  spelled out, and a test asserts on the emitted line.

- **BREAKING — A persisted coordinator-state snapshot can no longer route
  around a `numShards` refusal (#633).**

  `loadCoordinatorState` wrote regions straight from the snapshot into the
  placement pool, filtered only by cluster membership, so with a
  `coordinatorStateStore` configured a leader change onto a differently
  configured node adopted its predecessor's allocation map and
  re-established the split routing through the load path — the one path
  where the registration handshake that compares the counts never runs.
  `CoordinatorStateData` now carries the shard count it was written under,
  and a snapshot taken under a different count is dropped whole rather
  than entry by entry, because every id in it was produced by
  `hash(entityId) % numShards` under the writer's modulus. A region
  already refused this term is skipped even when the snapshot names it,
  and that check sits inside the restore loop because the load is
  fire-and-forget.

  *Migration:* A snapshot written before this change states no shard
  count, so the first leader change after upgrading falls back to
  rebuilding from region registrations — one reallocation pass, which is
  what every cluster without a store already does; the next allocation
  change writes a stamped snapshot. A custom `CoordinatorStateStore` must
  round-trip `CoordinatorStateData` whole rather than reconstructing it
  field by field, or it drops `numShards` and disables the fast path
  permanently.

- **The `ws` optional peer is now a declared root devDependency (#676).**

  It was resolvable only as a transitive dependency of
  `@fastify/websocket` and `@hono/node-ws`, so the Express WebSocket
  upgrade suite and the cross-runtime `20-express-upgrade-middleware`
  smoke case passed on hoisting luck; dropping either upstream edge would
  have failed both with a "Cannot find module" pointing nowhere near a
  missing declaration. `memjs` and `fzstd` were in the same undeclared
  state and are now declared too, each with a test that imports the real
  module and asserts the surface its adapter destructures. `fzstd`'s
  covers the interoperability the documented pure-JS zstd read fallback
  rests on — it decodes a frame written by the native compress path —
  which was previously untestable because the package was never installed.

- **The documented-defaults guard no longer lets a new reference.conf block
  ship unasserted (#470).**

  Its only completeness check was a floor on the table's length, which a
  growing table clears by growing, and the whole actor-ts.dead-letters.*
  block was published one day after the guard landed with four
  DEFAULT_DEAD_LETTER_* constants behind it and no entry. The guard now
  partitions REFERENCE_CONF: every leaf must be in the assertion table, in
  the recorded deliberate divergences, or in one of four named unasserted
  groups (log-level names, empty-string placeholders, feature switches,
  values that are a literal at the read site). Walking the config also
  turned up seven more leaves with a constant behind them, so the table
  grows by eleven and coverage goes from 93 of 166 leaves to 104 asserted
  plus 2 divergences plus 60 explicitly unasserted.

- **The Node runtime page carried a package.json snippet inside a TypeScript
  fence, in both languages (#470).**

  It is a json fence now, which is what it always was, and the fence no
  longer takes the whole doc-sample check's semantic pass down with it.

- **BREAKING — Cluster singleton: a routine scale-up no longer runs two
  instances (#949).**

  Every node used to compute the host from its own gossip view and act on
  it alone — the incoming host promoted itself off its own `SelfUp`, which
  fires locally before gossip has told any peer anything, while the
  incumbent stopped its instance with a `PoisonPill` queued behind that
  instance's whole mailbox. No failure and no partition was needed,
  because the host is the lowest-addressed up-member. Both reconcile paths
  now send a `singleton.HandOverRequest` to every eligible peer and host
  only once each has confirmed its instance has actually terminated.

  *Migration:* Taking over hosting now costs one network round trip, so a
  singleton appears on its new host a few milliseconds later than before;
  a node that is eligible to host but never calls `start()` or `ref()`
  cannot answer and costs the incoming host the full `handOverTimeoutMs` —
  give the singleton a `role`, or call `ref()` on those nodes.

- **Cluster singleton with a lease: `lease.release()` is no longer called
  before the outgoing instance's `Terminated` has been observed (#949).**

  It used to be awaited directly behind `stopChild`, which returns as soon
  as the `PoisonPill` is enqueued — so a follower could win the lease and
  spawn while the previous instance was still draining, which gives away
  the entire guarantee the lease exists to provide.

- **Cluster singleton with a lease: a lost lease is re-acquired only after
  the stopped instance is gone (#949).**

  Re-entering `acquiring` immediately could resolve the acquire
  mid-`postStop`; the spawn behind it early-returned because a stop was
  still in flight; and the reconcile after `Terminated` read "lease held"
  as "already running" and did nothing. The manager then renewed a lease
  over no singleton at all, permanently, and no other node could take over
  — the #1175 shape reached by a path #1175 did not close.

- **Cluster singleton: a `tell` through a proxy now reaches a host whose
  ActorSystem is named differently from the sender's (#949).**

  The proxy addressed the manager path with its own system name, so the
  frame missed the recipient's per-path handler and arrived unwrapped
  through generic path resolution — logged as an unrecognised message and
  dropped, with nothing on the dead-letter stream to say a message had
  been lost. This affects any cluster whose members do not share one
  system name, which is what `MultiNodeSpec` sets up.

- **The shared persistence contract suite no longer fails a journal that
  legitimately omits the optional `raiseCompactionMark` (#536).**

  Two scenarios asserted the method's presence instead of skipping, which
  was invisible because all eleven in-tree journal harnesses implement it,
  and would have reported two failures for a conforming third-party
  backend the moment the suite was used to certify one.
  `JournalCapabilities` gains `compactionMark`, defaulting to true;
  declaring it false skips exactly those two scenarios, and leaving it
  unset still fails loudly so the flag cannot paper over a real
  divergence. No in-tree backend changes behaviour — the identical 370
  cases bind with the identical 7 skips.

- **The TestKit's `ManualScheduler` no longer keeps the raw-console
  behaviour the framework abandoned (#678).**

  It overrides every scheduling method, so the base class's guard never
  ran on its path; it now reports through the inherited sink, which means
  a system built with `ActorSystemOptions.withScheduler(new
  ManualScheduler())` sees a failing task on its logger and its event
  stream like any other. The message-delivery forms `scheduleOnce` and
  `scheduleAtFixedRate` deliberately do not publish here — a throw inside
  the target's handler is its supervisor's business.

- **`ParallelMultiNodeSpec` subscribed `message` and `close` on every worker
  it spawned and never `error`, so an uncaught throw inside a worker took
  the whole test process down with it — including the framework's own
  parallel multi-node suites (#700).**

  The containment added in #700 did not reach it: the Web-Worker adapter
  cancels the event from inside the listener that a subscription installs,
  and the Node adapter registers `on('error')` only when something
  subscribes, so with no subscriber Node re-raises on the host and Deno
  rejects an internal promise, both exiting 1. Bound by a new
  cross-runtime smoke case, because Bun contains the throw on its own and
  `bun test` spawns no OS thread at all.

- **`GET /cluster/shards?type=<name>` no longer returns 404 on a
  default-configured cluster (#682).**

  It read the shard coordinator's DistributedData snapshot, which required
  two things no default configuration has: nothing in the framework ever
  starts the DistributedData extension, and the snapshot is written only
  when the operator passes a `coordinatorStateStore`. The route now reads
  the shard map that every node's region already receives from the
  coordinator, so it needs no configuration at all. This also removes the
  last two `src/crdt/` imports from `src/management/`.

- **The Fastify backend silently emptied any `ReadableStream` response body
  whose first chunk was not ready in the same tick (#465).**

  Its async handlers returned nothing, so Fastify's own re-send path fired
  while the stream was still unwritten and ended the response over the top
  of it: the client received a `200` with `Content-Length: 0` and no
  bytes, with nothing logged. Any body sourced from real I/O — a file, a
  cursor, an upstream response — was affected, on the default backend.
  Both existing stream tests missed it because they enqueue every chunk up
  front, so the body was always already in memory.

- **Documentation: four claims about locks were wrong (#1080).**

  CacheLock.release() said a false return means the critical section
  overran its TTL; acquireLock and the cache overview said expiry is the
  only recovery path from a crashed or stalled holder; Cache.setIfAbsent
  listed three limits of its atomicity guarantee and omitted the only one
  that is on by default. Eviction is a second way the entry disappears, it
  needs no crash and honours no deadline, and a false from release() now
  documents both causes and says that nothing in the return value
  separates them. The in-memory page's eviction section is rebuilt around
  what is protected and what is not, the lock is named as a third victim
  beside the counter and the record, and the Memcached page now says
  server-side LRU is fine for caching and not for a guarantee. EN + DE.

- **BREAKING — Nested `Behaviors.supervise` wrappers now layer instead of
  collapsing into the innermost one (#638).**

  `TypedActor` held a single slot per supervision scope and the resolve
  walk overwrote it on every hop, so in
  `supervise(supervise(inner).onFailure(strategyInner)).onFailure(strategyOuter)`
  the outer strategy was unreachable on every path: an inner
  `Directive.Escalate` and a spent inner restart budget both rethrew
  straight past it to the actor's cell. The scopes are a stack now. The
  innermost strategy decides; a scope that declines — `Escalate`, or a
  restart budget it has spent — hands the same error one scope out; only
  falling off the outermost wrapper reaches the cell, where the parent's
  strategy applies. A `supervise` that a running behavior returns nests
  inside the scopes already active instead of replacing them, and a
  restart an outer scope decided rebuilds the wrappers below it, so the
  inner scopes come back with a full allowance. A non-nested actor has a
  one-entry stack and is unaffected.

  *Migration:* An outer `Behaviors.supervise` that was silently inert now
  gets consulted, so a decider (and any logging or counting inside it)
  runs where it previously never did.

- **BREAKING — A typed signal handler is scoped to the behavior that
  declared it (#928).**

  `resolve` only ever installed one and never cleared it, so a state
  machine written as `Behaviors.receiveWithSignal` followed by a plain
  `Behaviors.receive` per state kept the first state's handler for the
  rest of the actor's life, and went on diverting every `Terminated` away
  from its receive handler. Adopting a `receive` that declares no
  `onSignal` now unregisters it. The sentinels are deliberately exempt, so
  a behavior answering `Behaviors.stopped` still reaches the `post-stop`
  handler it was adopted with — clearing the field at the head of every
  resolve, which the issue proposed, would have dropped it there.

  *Migration:* Re-declare `onSignal` in every state that needs `post-stop`
  / `pre-restart` cleanup or wants a watched actor's death as a signal;
  without it the cleanup stops firing after the first transition and the
  death arrives at the receive handler as a `Terminated` message again.

- **A WebSocket upgrade whose hub refuses the connection no longer leaks its
  maxConnections slot or throws through the backend's upgrade callback
  (#717).**

  The admission release was chained onto the connection actor's
  setListeners, which is exactly what does not run when that actor was
  never spawned, so a refusal burned a slot permanently. wireConnection
  now guards the send, releases the slot directly, closes the socket with
  1013's quieter sibling 1011 ("connection setup failed"), and logs the
  refusal.

- **The nightly flake workflow had never uploaded a single report.
  actions/upload-artifact defaults include-hidden-files to false since v4.4
  and the report directory is .stress, so both jobs on both nights matched
  zero files, while if-no-files-found: warn inside continue-on-error jobs
  kept the run list green. The fourteen-night criterion for lifting the
  multi-node quarantine was defined in terms of a summary.json that was
  never kept, so nights before this cannot be counted. Both upload steps now
  set include-hidden-files: true and if-no-files-found: error, and
  tests/unit/ci/WorkflowHygiene.test.ts asserts both for every hidden upload
  path in .github/workflows/, keyed on the path so a future .coverage/ is
  covered too. (#290).**

- **tests/unit/InMemoryTransport.test.ts asserted a property of the whole
  process rather than of the transport it named: registry is a private
  static Map, peers() returns every entry but self, and bun test runs the
  whole tree in one process, so expecting an empty peers list after shutdown
  asserted that none of the 75 suites which build a transport had left one
  registered. That is why it passed alone and failed only in a whole-suite
  run, with no timing involved. It now reads the transition it causes
  through a live peer, which also makes it bind shutdown()'s unregistration
  for the first time; the previous form, running alone, could not tell
  whether shutdown unregistered at all. (#290).**

- **A watcher whose mailbox used `overflow: 'reject'` could hang
  `terminate()` for the whole actor tree (#729).**

  `MailboxFullError` was thrown synchronously on the dying cell's own
  stack, from inside its watcher-notify loop, and escaped
  `finalizeTermination` ahead of the parent's `childTerminated` — so the
  parent kept the dead child in `_children` forever, any teardown waiting
  on an empty children map never fired, every watcher after the throwing
  one in iteration order also went unnotified, and `ActorStopped` had
  already been published to observers. `reject` is `BoundedMailbox`'s own
  constructor default, so the documented bring-your-own-mailbox shape
  reached it without naming it. The notify loop is now guarded per
  watcher: a refusal costs that watcher its notification, as a dead
  letter, and costs the teardown nothing.

- **`throttle({ onExcess: 'drop' })` silently consumed a death-watch
  `Terminated`, which is the opposite of what `ActorContext.throttle` has
  always documented (#729).**

  The notification now bypasses the throttle gate and consumes no token: a
  death the framework announces once is not part of the budget a rate
  limit meters.

- **Stopping a broker actor while a reconnect attempt was in flight left a
  fully live broker connection attached to the terminated actor, or an
  unbounded reconnect loop (#708).**

  Reconnect runs on the system scheduler, detached from the mailbox, and
  the scheduler settles a one-shot handle before invoking it, so
  postStop's cancel is a no-op against an attempt that has already begun.
  That attempt then resumed on a dead actor: on success the base class
  adopted the connection (state connected, BrokerConnected published,
  buffer drained, live driver handles nothing could close, because
  postStop had already cleared the transport gate and deregistered the
  actor's CoordinatedShutdown service-stop task); on failure it re-armed
  the backoff timer, and since maxAttempts defaults to Infinity the cycle
  never ended. The base class now checks liveness at the entry to a
  connect attempt, again after the teardown that precedes the handshake,
  and again on both exits from connectImplementation, tearing the escaped
  connection down instead of adopting it. handleConnectionLost and the
  reconnect scheduler refuse to act on a stopped actor. Affects all
  fourteen BrokerActor subclasses; MqttActor exhibited the full shape
  because its entire handshake sits inside the awaited promise.

- **The four exact wait counts in the testing/diagnosing-flakes page had all
  drifted since they were taken on 2026-08-16 — the page's own framing says
  an exact figure is meant to be visibly stale the moment it stops matching,
  and it was (#418).**

  Both language versions now carry the re-measured figures and defer to
  the gate, which cannot go stale without going red, and the
  wait-with-a-reason rule in testing/overview says that it is checked
  rather than merely asked for. Two pre-existing waits that the widened
  pattern made visible were given their reason instead of a ledger row, in
  `tests/integration/lib/ControlRoutes.ts` and
  `tests/util/AsyncAssertions.test.ts`.

- **A ShardRegion now addresses the coordinator by the leader's system name
  rather than its own (#712).**

  An actor path carries the system it belongs to, so guessing it locally
  only worked when every member shared one name; where they differed the
  frame missed the leader's registered path and reached the coordinator
  through generic path resolution, which delivers with no sender at all.
  Invisible before because that fallback happened to resolve to the same
  actor.

- **`bun run smoke` exits again on Windows** (#1196).  The Deno arm ran every
  case, printed both green summary lines, and then hung forever — no exit
  code ever arrived, so the cross-runtime gate could only be read by a human
  rather than trusted by a script.  The leak was in the harness, not the
  framework: `20-express-upgrade-middleware` deliberately drives a *refused*
  WebSocket handshake, and on Deno a refused upgrade reaches the client as
  neither a response nor a close — so the case settled that outcome from its
  timeout and left the socket parked in `CONNECTING`.  That pinned two ops
  nothing would ever resolve: the client's own `op_ws_create`, and the
  backend's `op_http_close`, since a connection that never ends means the
  graceful `server.close()` never completes.  The helper now releases the
  socket on every outcome, and the same abandon-on-the-unhappy-path shape is
  fixed where it sat latent in `06-devtools`.  `run-cases.mjs` additionally
  arms an unref'd watchdog — exiting naturally stays the default, but if the
  loop is still alive 15 s after the last case the harness names the runtime
  and exits with the status the run earned, so the next leak costs a line of
  stderr instead of the gate.  CI never caught this because the
  `multi-runtime` matrix is `ubuntu-latest` only, where the same run exits in
  ~21 s; #816 tracks the Windows leg that would have.

- **A cluster singleton that dies unexpectedly comes back** (#1175).  The
  manager reacted to its child's `Terminated` only when it was the *expected*
  stop — the planned teardown of a handover.  Every other way the child could
  die fell through without effect: `context.stopSelf()`, or a crash loop that
  exhausted the supervision budget and had the supervisor stop it.  Afterwards
  the manager kept forwarding every routed message to a dead ref, and
  cluster-wide the singleton no longer existed anywhere, with nothing to
  revive it until the next `LeaderChanged` — which in a stable cluster may be
  never.  With a lease configured it was worse: the manager stayed alive
  holding and renewing the lease, so no other node could host either, and the
  one mechanism meant to guarantee "exactly one instance" guaranteed **zero,
  indefinitely**.

  An unrecognised `Terminated` for the live child now clears it, logs at
  `warn`, and re-spawns after a one-second backoff.  The backoff is not
  decoration: the death that reaches this path is often a supervision budget
  already spent, and re-spawning restarts that budget too, so coming straight
  back would turn a crash-looping singleton into a hot loop.

- **`throttle('pause')` waits instead of spinning** (#1167).  A paused message
  is still in the mailbox, and `run()`'s `finally` re-scheduled whenever the
  mailbox was non-empty — so the cell re-dispatched at full dispatcher
  frequency for the entire wait window: dequeue, fail `tryConsume`, put the
  message back, come round again.  Measured with a counting dispatcher, three
  ticks at `qps: 10 / burst: 2` cost **34 156 turns**; they now cost fewer
  than 30.  A throttled actor also no longer holds up `system.terminate()`
  for the length of its own pause (1804 ms before, under 1000 ms after).

  The armed resume timer is the parked indicator, so no second flag can drift
  out of step with it.  The guard is two-sided on purpose: while the pause is
  armed a turn is dispatched only for **system** messages, since parking the
  lifecycle along with the user queue would trade the spin for an actor that
  cannot be stopped or supervised until its window elapses.  `ref.stop()` is
  not such a message — it sends a `PoisonPill`, an ordinary user message, so
  a graceful stop stays ordered behind what is already queued and remains
  subject to the bucket by design.

  *Correction to the issue:* it predicted a hard livelock on
  `MicrotaskDispatcher`, on the grounds that microtasks starve the timer
  phase so the resume timer never fires.  That does not reproduce on Bun
  1.3.1 — `run()` is async and its awaits yield often enough for the timer to
  land.  It was a busy-spin on both dispatchers, not a spin on one and a
  livelock on the other.

- **A configured `numShards` now reaches the coordinator, not just the
  region** (#1026).  `ClusterSharding.start` called `ensureCoordinator`
  before it populated `numShardsByType`, and `ensureCoordinator` resolved the
  count out of exactly that map — so on the first (and only) start of a type
  the lookup missed and every `ShardCoordinator` was built with the built-in
  64 whatever the caller configured.  The region then hashed with the real
  value while the coordinator bounded with 64: every `GetShardHome` for a
  shard id at or above 64 was refused, the shard never received a home, and
  its messages accumulated in the region's unbounded buffer until the process
  ran out of memory.  With the `numShards: 1000` the sharding page recommends
  for large clusters, that is roughly 94 % of entities.

  The config is now resolved once at the top of `start` and the count travels
  into `ensureCoordinator` as an argument, so neither depends on which
  statement ran first.  `numShardsByType` goes back to being what it was
  meant to be — a lookup for later callers — rather than load-bearing for the
  first one.

- **A role-restricted cluster singleton no longer ends up running on two
  nodes at once when a lower-addressed role member joins (#637).**

  The host of a singleton is the first address-ordered up-member — the
  cluster leader, or under a role restriction the first member carrying
  that role. Both the manager and the proxy watched `LeaderChanged` to
  notice it move (the manager also `SelfUp` and `MemberRemoved`), and
  `LeaderChanged` fires only when the leader's *identity* changes. A
  role-carrying member joining *below* a role-less leader moves the host
  and changes no leader, so neither side was told anything. The joining
  node spawned anyway off its own `SelfUp`; the incumbent was never told
  to stop. The steady state after convergence was two live singleton
  children cluster-wide — the one thing a singleton exists to prevent —
  and it persisted until some unrelated event happened to move the leader.

  Unreachability looks like the same hole and is deliberately **not**
  covered.  An up member going `unreachable` drops out of `upMembers()`
  without being removed, so a role host falling silent under a stationary
  role-less leader leaves the singleton hosted nowhere until it is downed
  — and that stays true.  Reacting to it is worse than living with it: the
  peer that lost contact would promote itself while the incumbent, which
  never learns it is considered unreachable, keeps its child, and the
  leader never moves to resolve it.  That is a sustained two-host state,
  the exact condition this entry's headline is about.  On the no-lease
  path the two properties cannot both be had, because reaching the
  incumbent to ask it to stand down is precisely what failed.  Configure a
  `lease` where "at most one" has to survive a partition; that is what it
  is for.

  Both sides now reconcile on the events that can move the host —
  `LeaderChanged`, `SelfUp`, `MemberUp`, `MemberDown`, `MemberLeft`,
  `MemberRemoved` — matched
  through one shared predicate rather than two lists, because the manager
  deciding whether *this* node hosts and the proxy deciding where to send
  have to agree on when to look again, not only on what they see when they
  do. `MemberJoined` and `MemberWeaklyUp` are deliberately excluded:
  neither status appears in `upMembers()`, so neither can host.

  The proxy also drains its no-host buffer on those events. It previously
  had exactly two drain call sites, construction and `onLeaderChanged`, so
  a first role-carrying member joining a cluster whose leader does not
  change never drained the buffer at all — those messages sat there
  indefinitely while every later send routed normally.

- **BREAKING — A `persistAll` of differently-tagged events now tags each
  event on its own, instead of stamping the whole batch with the first
  event's tags (#631).**

  `PersistentActor.persistAll` called `tagsFor` once, on `events[0]`, and
  passed the result to `Journal.append` as a single batch-wide argument
  that every backend faithfully fanned out over every event. The damage
  was symmetric, and only one half of it is obvious: a by-tag query missed
  the later events of a mixed batch — `eventsByTag('payment')` never
  returned the `PaymentCaptured` written alongside an `OrderPlaced` — and
  it also returned events that were never tagged that way, because
  `eventsByTag('order')` matched the whole batch. A projection filtering
  on a tag therefore processed foreign events rather than merely skipping
  its own. `PersistentFSM`'s array transition shape is a real producer of
  such batches, so any FSM whose `tagsFor` keys on `event.kind` was
  affected.

  The cause was in the SPI, not the actor: `Journal.append(persistenceId,
  events, expectedSeq, tags?)` had room for exactly one tag list per call.
  It now takes `ReadonlyArray<JournalEntry<E>>`, a new exported type
  pairing one event with the tags belonging to it. Pairing them
  structurally rather than adding a parallel `tags[]` array is deliberate
  — a second positional array would have added the expressiveness and kept
  the alignment hazard that caused the bug. `JournalEntry` is the
  write-side mirror of `PersistentEvent`: the caller supplies payload and
  tags, the journal assigns sequence number and timestamp.

  All six `append` implementations index per entry, including
  `CassandraJournal`'s `events_by_tag` dual write — which previously
  emitted one row per (batch tag, event) pair — and `DynamoDbJournal`'s
  string-set attribute. The five relational subclasses inherit
  `RelationalJournal.append` unchanged. A batch is still one atomic
  append; per-event tags do not split it. Tag validation moved to
  `assertValidEntryTags`, which checks every entry before any write, so
  `MAX_TAGS_PER_EVENT` now counts one event rather than one call, as its
  name always claimed.

  Events already written by an affected version keep the tags they were
  stored with; nothing rewrites history, so a tag index built before this
  fix stays as wrong as it was and needs rebuilding from the journal if
  that matters.

  *Migration:* Applications need no change:
  `PersistentActor.tagsFor(event)` always took a single event and its
  signature is unchanged, so overriding it is now simply correct for every
  event of a batch. The break is confined to the plugin SPI — third-party
  `Journal` implementations and any direct caller of `journal.append`.
  Rewrite `journal.append(persistenceId, [eventA, eventB], seq, ['t'])` as
  `journal.append(persistenceId, [{ event: eventA, tags: ['t'] }, { event:
  eventB, tags: ['t'] }], seq)`, dropping the fourth argument; a custom
  `Journal` changes its `append` signature from `(persistenceId, events:
  ReadonlyArray<E>, expectedSeq, tags?)` to `(persistenceId, entries:
  ReadonlyArray<JournalEntry<E>>, expectedSeq)` and reads `entry.tags`
  inside its write loop instead of the batch argument. TypeScript flags
  every affected call site.

- **Stopping a `ShardRegion` no longer orphans its shards — it tells the
  coordinator on the way down (#648).**

  `postStop` unsubscribed from cluster events and cancelled four timers;
  it never told the coordinator. `RegionTerminated` was declared,
  dispatched and handled correctly, but its only construction site in the
  whole tree was the synthesis of one per region on a node that had left
  the cluster. So stopping a region on a node that stays in the cluster
  left every shard it held allocated to an actor that no longer existed.

  What that looked like is worth stating precisely, because it is easy to
  assume otherwise: senders do not buffer. A region buffers only while it
  has no cached home, and here it has one — the coordinator goes on
  answering with the dead region, so even a fresh sender caches it. The
  message is then forwarded to the dead path, the receiving node resolves
  it successfully, and it is told into a stopped cell. The symptom is
  dropped tells and timing-out asks, not a growing buffer. Nor did it
  heal: the placement candidate set is derived from the registry with no
  liveness check, so the rebalance tick saw a balanced cluster and moved
  nothing, and the handoff-timeout reallocation only fires for a shard
  already mid-rebalance. The state was permanent until the node left.

  A stopping region now sends `RegionTerminated` with the same region path
  and node address its registration sent — anything else misses the
  coordinator's registry key and the handler no-ops. Ordering is already
  safe: a cell runs `postStop` only after every child has terminated, so
  the shards and their entities are provably gone before the coordinator
  is free to place them elsewhere, and there is no window in which two
  nodes run one entity. The send is skipped when no coordinator was ever
  resolved, and a transport failure on the shutdown path is logged rather
  than failing `postStop`. It fires on whole-system shutdown too, which is
  idempotent against the membership-driven path that follows.

- **Broker reconnect backoff is jittered, so a fleet no longer retries in
  lockstep after a broker restart (#652).**

  The reconnect delay was `min(initialDelayMs * factor^(attempt - 1),
  maxDelayMs)` — a pure function of the attempt counter and the options,
  with no randomness anywhere. Every broker actor that lost the same
  broker in the same instant therefore woke in the same millisecond, on
  every wave, and the herd could keep the recovering broker down.

  The circuit-breaker path was a second, independently synchronised
  wake-up. When the breaker is open, the actor returns early and
  reschedules for exactly the time left on `resetMs`, never reaching the
  backoff calculation at all — so actors whose breakers opened in one
  failure burst would have stayed synchronised even after jitter was added
  to the backoff. Both paths are jittered now.

  `reconnect.randomFactor` (default `0.2`, i.e. ±20 %) and an injectable
  `reconnect.random` seam join the reconnect options. `randomFactor` also
  reads from the HOCON `reconnect` block and is bounded to `[0, 1]` by the
  shared broker validator, so a nonsensical fraction is rejected when the
  actor is constructed rather than during the outage that triggers the
  reconnect. `reconnect: { randomFactor: 0 }` restores the previous, fully
  deterministic schedule.

  The breaker spread is deliberately one-sided — `[resetMs, resetMs × (1 +
  randomFactor)]` — because a symmetric jitter would wake an actor before
  its own deadline, drop it straight back into the same branch and
  converge the whole fleet onto that deadline again. `reconnect.factor` is
  untouched: `exponentialBackoff` in `pattern/BackoffPolicy` hardcodes
  base 2 and cannot express it, so the broker keeps its own arithmetic
  rather than silently dropping a live public option.

- **The Hono backend now measures a chunked request body while it arrives
  instead of buffering it whole (#357).**

  A declared `Content-Length` over the cap has been refused before any
  read on all three backends for a while, but a chunked body declares no
  length, and the Hono backend read it with a single `await
  c.req.arrayBuffer()` and compared `byteLength` afterwards. What actually
  bounded such a request was therefore whatever the runtime happened to
  allow — 16 MiB on Bun, nothing in particular elsewhere — and not
  `maxBodyBytes`: the cap decided what the handler saw, not what the
  process allocated. Express has counted per chunk since the caps were
  unified and Fastify counts inside its own parser; this makes the third
  backend agree.

  The read now goes through `c.req.raw.body` chunk by chunk and cancels
  the stream the moment the running total crosses the cap, the same shape
  `HttpClient` already uses on the response side. That is runtime-neutral
  by construction, which matters here: neither `Bun.serve`, `Deno.serve`
  nor `@hono/node-server` exposes a request-body-size option, so no
  runner-level fix could have been portable across the three. Where no
  readable body stream is reachable — a runtime whose `raw` is not a Web
  `Request`, or a body a user's own Hono middleware already consumed — the
  buffered read stays as the fallback, so nothing that worked before stops
  working.

  An application that was relying on Hono accepting a chunked upload
  larger than its configured cap will now get the same `413 Payload Too
  Large` the other two backends already sent. Raise `maxBodyBytes` on the
  backend options where an endpoint genuinely takes more.

- **BREAKING — `entity()` answers 415 for a Content-Type it cannot decode,
  and decodes `application/x-www-form-urlencoded` form bodies (#669).**

  Every content type the request-side table did not recognise was handed
  to a `JsonSerializer`. For `text/xml` that surfaced as a misleading `400
  Cannot decode body: Unexpected token <`; for
  `application/x-www-form-urlencoded` — what a browser `<form>` and a bare
  `curl -d` both send — the same 400, so form POSTs were simply
  undeliverable. Worse, when an unrecognised type carried a body that
  happened to parse as JSON, the call did not fail at all: it succeeded on
  a codec the client never asked for. `Status.UnsupportedMediaType` had
  existed since the beginning and was referenced nowhere in `src/`.

  The request side now reduces the header to a bare media type and looks
  that up exactly, decoding form bodies into a flat record of strings and
  rejecting anything else with a 415 that names the accepted set — as an
  `Accept` response header (RFC 9110 §12.5.1: what to send next time) and
  as an `accepted` field in the body, both derived from the dispatch table
  so they cannot drift from what actually decodes.

  The matching was replaced rather than fenced off with a rejection
  branch, because the old table was not safe to make authoritative. It
  tested unanchored regexes against the *whole* header, so
  `multipart/form-data; boundary=----application/cbor` selected the CBOR
  entry off its boundary parameter. That was harmless noise while every
  miss fell back to JSON, and a straight bypass of the rejection the
  moment a miss became a 415 — a caller could pick a decoder, and slip
  past the 415, by naming one inside a parameter.

  Two shapes are deliberately still accepted. RFC 6839 structured-syntax
  suffixes follow their base type, so `application/vnd.api+json`,
  `application/merge-patch+json` and `application/problem+json` keep
  decoding — they had only ever worked by missing the table and hitting
  the fallback, and a strict 415 without this rule would have turned three
  working request shapes into rejections. And a *missing* Content-Type
  still defaults to JSON rather than joining the rejected set: RFC 9110
  §8.3 leaves a recipient free to guess when the sender states nothing,
  and `HttpClient.normaliseHeaders` sets the header only for object
  bodies, so a string body ships bare and a blanket rule would have
  rejected the framework's own client.

  Form decoding lives in the new `FormUrlEncodedSerializer` under
  `src/http/` rather than beside `JsonSerializer`, because form encoding
  is not a wire codec — no types, no nesting — and is deliberately not
  registered with `SerializationExtension`. It writes decoded fields with
  `Object.defineProperty`: plain assignment is `[[Set]]`, and a repeated
  `__proto__=a&__proto__=b` decodes to an array, which the inherited
  setter would use to re-parent the decoded record.

  Response-side 406 is not part of this and #669 stays open for it.

  *Migration:* Two behaviour changes need checking. First, a request whose
  Content-Type is outside `application/json`, `application/cbor`,
  `application/x-cbor`, `application/x-www-form-urlencoded` (plus `+json`
  / `+cbor` suffixes) now gets a 415 where it previously got the JSON
  fallback — set the correct header on the client, or branch on the media
  type before calling `entity()` if the endpoint really does accept
  something else. `application/*`, which the old regex matched, is no
  longer accepted as a *request* type; a wildcard is not a valid
  Content-Type and no in-repo caller sent one. Second, and much louder:
  `curl -d '{"id":"alice"}' …` with no `-H` sends
  `application/x-www-form-urlencoded`, and that request used to succeed
  because `JSON.parse` happened to accept the body — it now decodes as a
  form into `{ '{"id":"alice"}': '' }`, with no error and a wrong value.
  Any client posting JSON without an explicit `Content-Type:
  application/json` must set the header. Finally, `pickRequestSerializer`
  is exported from `actor-ts/http` and was a total function; it now throws
  `HttpError(415)`, so direct callers outside a route handler need a
  try/catch or a pre-check.

- **The typed `Behaviors.withStash` buffer now replays ahead of the
  mailbox, and reaches dead letters when the actor stops or restarts
  (#639).**

  `StashBuffer.unstashAll()` replayed with `self.tell`, which appends to
  the *tail* of the user queue. Every message that arrived while the stash
  was filling was therefore handled before the replay — the exact
  inversion stashing exists to prevent, and the opposite of the prepend
  `ActorContext.unstashAll()` has always performed and the docs promised
  for both forms. The typed buffer was also never drained on the way out:
  `TypedActor` collected its stash buffers into a field nothing in the
  repository read, so a stop or a restart discarded the parked messages in
  silence. That is the loss #518 fixed for the cell's own stash, in the
  half of the framework that fix did not reach — and it is the worst shape
  a lost message can take, because a stashed message arrived *before*
  everything still queued and is the one a sender is most likely waiting
  on.

  The replay now goes through the cell's mailbox prepend, so stashed
  messages come out ahead of anything queued behind the unstash trigger,
  still in the order they were stashed. Whatever is left parked is
  published as a `DeadLetter` on all three exits: the stop path, the
  cell's restart, and the restart a `Behaviors.supervise` strategy
  performs on its own — that last one re-resolves the behavior in place
  and never reaches the cell, so it needed its own drain.

  The typed buffer keeps its own storage rather than folding into the
  cell's, and that is deliberate: `StashBuffer.stash(message)` takes an
  arbitrary value where `context.stash()` can only park the message
  currently being handled, and the capacity stays the one passed to
  `withStash` rather than one actor-wide default. The one consequence is
  that a dead letter minted from this buffer carries no original sender,
  since there is no single sender to attribute a buffer of bare messages
  to.

- **`migrateBetweenJournals` now preserves a compacted source's sequence
  numbers instead of renumbering the copy from 1 (#630).**

  A journal compacted past a snapshot no longer starts at sequence 1, and
  one compacted completely holds no events at all while its high-water
  mark still remembers the numbers it handed out. The copy helper derived
  every written sequence from a locally incremented counter and ignored
  the source event's own, so both cases arrived on the target renumbered —
  detaching the paired snapshot, every read-side offset and every
  projection cursor, all of which name `(persistenceId, sequenceNr)`.

  Only one of the three resulting failures was loud. When the latest
  snapshot sat above the surviving-event count, recovery threw
  `SnapshotIntegrityError` and the entity would not start. But
  `PersistentActor.deleteHistory` deliberately keeps the snapshot *at* the
  compaction point, so the everyday layout passed the integrity check
  instead and folded a later tail onto an earlier state — no error, no
  `onRecoveryFailure`, an actor serving commands from a state that never
  existed. A fully compacted source was the third shape: nothing to copy,
  so the target's high-water mark stayed 0 while the copied snapshot set
  the actor's sequence to the source head, and every later `persist`
  failed with `JournalConcurrencyError` permanently.

  All three come from the same missing information, so one fix covers
  them. A new optional `Journal.raiseCompactionMark(persistenceId,
  throughSeq)` records a compacted prefix without there being anything to
  delete; every one of the ten built-in journals implements it, since each
  already stored the mark (`deleted_to`, `deletedTo`, `max_sequence_nr`)
  and simply had no way to be told one. It is monotonic by contract — a
  value at or below the current mark is a no-op, never a rewind. The
  migration raises the target's mark to just below the source's first
  surviving event before appending, so `expectedSeq` lines up and `append`
  reproduces the source's numbering exactly. A target journal without the
  method throws the new `CompactedSourceError` rather than writing a
  renumbered copy, and a source that breaks `Journal.read`'s contiguity
  promise now stops the copy instead of having its hole silently closed
  up. A legitimate mid-pid resume is unaffected: the gap test compares
  against the target's head, not against 1.

  `migrateBetweenSnapshotStores` gains `sourcePersistenceOptions` and
  `targetPersistenceOptions`. Two fields rather than one, because a re-key
  sweep is an ordinary reason to migrate and the two stores routinely hold
  different keys or keyrings. The read side already worked for a store
  built with `withEncryption(...)`, which falls back to its own
  configuration — the gap was per-call, actor-supplied keys. The write
  side was the worse half: with no options a target that encrypts per call
  resolved to `{ mode: 'none' }` and the migrated snapshot landed in the
  bucket as plaintext.

- **`typecheck:dev` is green and gated, and five exported declarations
  that no caller could actually use are fixed (#540).**
  `tsconfig.dev.json` is the only configuration that compiles `tests/`,
  `examples/` and `benchmarks/` alongside `src/`. Nothing ran it: `bun
  test` transpiles without type-checking and `bun run typecheck` uses the
  build tsconfig, which excludes all three trees. Between them an entire
  class of defect was invisible — anything that compiles for the library
  and breaks only for a caller.

  Five of those surfaced. `NoopLogger`, `NoopMetricsRegistry` and
  `HashAllocationStrategy` each declared fewer parameters than the
  interface they implement; `implements` accepts that, because a function
  ignoring its arguments is assignable to one that takes them, but all
  three are exported, so `new NoopLogger().info('hello')`, `new
  NoopMetricsRegistry().counter('a')` and the three-argument
  `allocate(shardId, candidates, currentShards)` the sharding
  documentation shows all failed to compile. `OtelContextLike` was `{
  readonly __opaque?: never }` — a type whose properties are all optional
  triggers TypeScript's weak-type check, so nothing at all satisfied it,
  including the real `@opentelemetry/api` `Context`; it now names the
  `getValue` / `setValue` pair that context actually has. And
  `SchemaRegistry` had two: `upcastFromPrev` was hard-typed `(prev:
  unknown) => …`, rejecting the `(v1: DepositedV1): DepositedV2 => …` form
  its own header and both documentation pages show, and `eventAdapter`
  returned `EventAdapter<E, unknown>`, which cannot be returned from
  `PersistentActor.eventAdapter()` — so the schema-registry feature was
  unreachable from the actor hook it exists to fill. Both gain a defaulted
  type parameter (`Previous`, `JournalShape`), which leaves every existing
  call site unchanged.

  The remaining 215 diagnostics were test and example drift, burnt down
  without weakening a single assertion: unions narrowed rather than cast,
  type arguments supplied where a generic had nothing to infer from, and
  stale fixtures brought back in line with the shapes they fake.
  `TestProbe` stays non-generic — the 28 `createTestProbe<T>()` call sites
  never compiled and the decision is now recorded in its JSDoc and on the
  TestProbe page — and `NoopMetricsRegistry`'s six assertions were kept
  exactly as written, since they were the only evidence the class was
  wrong.

  A `typecheck (dev)` workflow keeps it green. It is separate from `tests`
  because path filters are per-workflow: a step there would never fire on
  an `examples/**` or `benchmarks/**` change, which is precisely what this
  configuration covers. `tsconfig.dev.json` excludes the trees whose
  imports a different manifest resolves — the example frontends, the
  live-broker runners, three examples demonstrating an undeclared optional
  peer — and its header names the CI job that covers each instead. The two
  React example frontends joined the `examples` matrix in the same change,
  so excluding them leaves them with build coverage rather than none.

- **`npm ci` no longer fails in the two React example frontends (#545).**

  `examples/chat/frontend-react` and `examples/voice/frontend-react` each
  declared `ts-pattern@^5.9.0` in `package.json` while neither
  `package-lock.json` recorded it, so `npm ci` failed with EUSAGE in both
  and the two React legs of the `examples` workflow were red. The imports
  are real - `src/useChat.ts` and `src/useVoice.ts` - so a build would
  have failed too.

  This is the same manifest/lockfile desync that #903 was filed to
  eliminate, surviving in the two directories that were outside the matrix
  at the time. The legs were added later; their lockfiles were never
  regenerated, so the job started failing rather than started passing.
  Regenerated with `npm install --package-lock-only`, which touched
  nothing but the one missing entry in each file.

- **`Behaviors.supervise` now honours the strategy's restart budget
  instead of ignoring it (#638).** The typed supervisor consulted only
  `strategy.decider(err)` and re-resolved the wrapped behavior
  unconditionally, so `maxRetries` and `withinTimeRangeMs` were inert
  everywhere under `src/typed/` — a behavior that always threw restarted
  for ever inside one `TypedActor`, and invisibly, because swallowing the
  error also kept the enclosing cell's own budget from engaging. The typed
  pages already showed a `maxRetries` example and stated that the
  directive semantics apply identically, so this was a live doc/code
  divergence rather than a missing feature.

  A new `RestartBudget` (exported from the package root) carries the
  sliding window. It is kept apart from `SupervisorStrategy` because a
  strategy is an immutable description that `defaultStrategy` shares
  process-wide; a tally living on it would give every actor in the process
  one allowance. `TypedActor` holds one budget per supervision scope,
  keyed on the `supervise` node's identity, so the tally accumulates
  across the restarts it counts rather than resetting on each one. Only
  granted restarts are recorded, which also bounds the array by
  `maxRetries` and avoids the unbounded growth its `ActorCell` counterpart
  shows under `withinTimeRangeMs: 0`.

  Two semantics that the issue and the existing OO code left mutually
  inconsistent are settled here for the typed path. `maxRetries` is read
  literally — `maxRetries` restarts are granted and the next attempt is
  refused, so `maxRetries: 0` means "never restart" — where
  `ActorCell.registerRestart` returns `length <= maxRetries + 1` and
  therefore tolerates one more than it advertises. And past the budget the
  typed supervisor escalates rather than stopping, because a typed
  `supervise` is a wrapper inside the failing actor rather than a parent
  that stays around to observe a `Terminated`; stopping there would
  discard the error with nobody upstream any the wiser. Escalating hands
  the failure to the actor's own parent, whose restart builds a fresh
  actor with a fresh typed allowance, so the two budgets layer instead of
  competing.

  Be aware this changes runtime behaviour for code that already sets a
  bound: a supervised behavior that used to restart without limit despite
  `maxRetries` will now stop looping in place once the bound is reached.
  That is what the documentation always promised. Setting `maxRetries: -1`
  — the default for a hand-built `OneForOneStrategy` — keeps the old
  unlimited behaviour.

  The parent-supervised path is deliberately untouched; changing its
  off-by-one is a behaviour change for every existing actor and belongs
  with #917/#1019. The supervision documentation, which claimed that with
  `maxRetries: 10` "the 11th failure escalates", is corrected in both
  languages to describe what that path actually does (eleven restarts
  tolerated, then the affected children are stopped), and the remaining
  divergence between the two forms is called out where a reader setting a
  bound will hit it.

- **A chunked body over the cap is refused as documented, but the 413 may
  not reach the client (#357).**

  The #357 entry above promises that an application relying on Hono
  accepting an over-cap chunked upload "will now get the same `413 Payload
  Too Large` the other two backends already sent". The refusal is real and
  the handler never runs; receiving the 413 is not something the framework
  can promise for a *chunked* body, and the change makes no difference to
  that.

  Refusing a body mid-flight means cancelling the read and closing while
  the client is still writing. A close over unread inbound data goes out
  as a reset rather than a graceful FIN, and the platform then discards
  the receive queue - the 413 with it. Instrumented against the built
  backend, a cold Node process lost a genuinely-sent answer on every one
  of 15 attempts, with the handler call count still 0 each time; warm runs
  read the same 413 back cleanly after three 8 KiB chunks. A client that
  stops writing once it is past the cap gets the response reliably; one
  that keeps streaming until it sees an answer may only ever see the
  reset.

  So the guarantee is: the bytes past the cap are never received, the
  handler never runs, and the request is refused before the body
  completes. Clients streaming an upload should treat a mid-body hangup as
  a refusal in its own right rather than waiting for a status line that
  may have been dropped in transit. The declared-`Content-Length` path is
  unaffected - nothing is written after the request head, so there is no
  reset to lose the answer to.

  The cross-runtime smoke case and the `BodyStreamingCap` suite asserted
  on reading that status back, which made them fail on the platform's
  teardown timing and report it as a framework defect; they now assert
  that the exchange was settled without a terminating chunk and that the
  handler never ran.

- **The repeat-run flake harness survives a run that never exits** (#290).
  `scripts/stress-test.mjs` listened for the child's `error` and `close`
  events and had no timer, so the one failure it exists to measure was the
  one it could not survive: the quarantined multi-node suites' documented
  symptom on hosted runners is not a red test but a `bun test` that never
  exits — workers spawn, handshake and then never run. `runOnce` never
  settled, the loop never advanced, and the nightly job sat until its
  `timeout-minutes` and was killed with no per-run report and no
  aggregate.

  A per-run watchdog — `--run-timeout`, or
  `ACTOR_TS_STRESS_RUN_TIMEOUT_MS`, 20 minutes by default against a ~4.5
  minute local suite — now terminates such a run (SIGTERM, then SIGKILL,
  then settling regardless, because an unkillable child must not become an
  unkillable harness) and records it as a *hang*. A hang is kept apart
  from a failure and from a truncated JUnit report, since those three
  point at different causes and would send a reader after the wrong one.
  It surfaces on the console as `run N: HUNG`, in the GitHub step summary,
  in `summary.json` as `runsTimedOut`, and in the exit status — and then
  the loop continues, because whether the next run hangs too is the
  measurement. `nightly-flakes.yml` states the timeout explicitly in both
  jobs so it can be read against `timeout-minutes` (3 x 8 min inside 30, 5
  x 20 min inside 120); a watchdog that fires after GitHub has already
  killed the job would be decorative.

- **An `awaitCondition` budget larger than the per-test timeout no longer
  swallows its own diagnostic** (#418). Bun kills a test after 5 000 ms
  unless the test declares otherwise, and nothing in this repository
  raises that globally — so `timeoutMs: 10_000` was not a generous failure
  budget, it was an unreachable one. The run reported the runner's bare
  `this test timed out after 5000ms` instead of the label naming the state
  that never became true, which is the entire reason `awaitCondition`
  exists. Worse, the budget's own rejection still landed five seconds
  later as an *unhandled* error belonging to no test, inflating the run's
  error count and accusing whichever test was running by then.

  Seven tests across `Cluster`, `Router`, `MailboxVariants`,
  `DistributedPubSubAnycast`, `PersistenceIdEnforcement` and
  `PersistentActorRecoveryFailure` now declare the cap their budgets need;
  `ClusterBootstrap` gets one too, where a 4 000 ms budget fit the default
  with exactly 1 s of slack behind two `Cluster.bootstrap` calls — a coin
  toss rather than a decision.
  `tests/unit/ci/AwaitConditionBudgets.test.ts` gates this across the
  whole test tree (largest reachable budget plus 1 s must fit the cap),
  follows budgets reached through module-level helpers, and re-measures
  bun's behaviour in a child process rather than assuming it, so the day
  bun changes the gate says so instead of quietly meaning nothing.
  `docs/.../testing/diagnosing-flakes` gains the family, the hang verdict,
  and four re-measured conversion counts, in both languages.

- **The DevTools chapter now states the dividing line the example sweep
  actually applied, and its walkthrough runs again (#552).**

  The sweep was documented as "long-running versus finishes on its own".
  The line it applied was "calls `holdOpen()`", and those are not the same
  set. Seven examples kept the wiring and still finish on their own --
  `cluster/singleton-hello.ts`, `cluster/singleton-cron.ts`,
  `cluster/sharded-daemon-hello.ts`,
  `cluster/sharded-daemon-fixed-workers.ts`,
  `discovery/service-locator-cluster.ts`,
  `pubsub/event-bus-across-nodes.ts` and
  `management/opentelemetry-tracing.ts` -- because none of them had ever
  parked itself; they only attached. So the stated rule was false for
  seven of the twenty-five it kept, and the German mirror went further and
  said the examples that finish on their own "carry no DevTools wiring at
  all", which is false for exactly those seven.

  The damage was concrete rather than pedantic. The actor-visualizer
  walkthrough's only code fence told the reader to run
  `examples/cluster/singleton-hello.ts --devtools` and watch the actor
  tree; that process binds 9333/9334/9335, logs three URLs and exits after
  about 1.3 seconds, so the reader opened the UI and found nothing. The
  overview repeated the same command as its multi-port illustration.

  Both now point at `examples/cluster/counter-node.ts`, which the example
  gate already classifies as long-running, and the walkthrough is written
  from a run rather than from intent: one node fills the tree with a
  `ShardCoordinator`, a `ShardRegion`, seven `Shard`s and eight
  `CounterEntity` under `/system/cluster/sharding/region-counter`, while
  `/user` stays empty -- sharded entities hang off the sharding subsystem,
  not off the user guardian, which is worth saying on a page whose aside
  tells the reader `/user` is the whole story. Three terminals give 9333,
  9334 and 9335; killing the middle node moves the shard map from `9001=4,
  9002=1, 9003=2` to `9001=1, 9003=6` with the entities restarting on the
  survivors.

  `counter-node.ts` attached DevTools without passing its `Cluster`, so
  the cluster panel reported itself unavailable and half of that page was
  unreachable from the walkthrough. It passes it now. A sharding demo
  whose shard distribution cannot be seen is the wrong example to send
  anyone to.

  The harness's own header in `examples/devtools.ts` carried the same
  false line and now records the real one, including that the wiring left
  in those seven is inert rather than wrong.
  `tests/unit/devtools/ExampleWiringClaims.test.ts` holds the prose to the
  tree from here: no page may send a reader to watch an example the
  example gate has watched exit, and the overview must name the wired ones
  that do.

- **`CassandraJournal.delete` now compacts the `events_by_tag` side table
  instead of leaving it behind (#654).**

  `delete` issued one `DELETE` per partition against `events` and touched
  nothing else, while `append` dual-writes one `events_by_tag` row per
  (event, tag) pair whenever `useTagIndex` is enabled. That side table is
  a separate physical table rather than an index Cassandra maintains, so
  every compacted event stayed in it — and each of those rows carries its
  own copy of the payload, so `CassandraQuery.currentEventsByTag` went on
  serving deleted events indefinitely and the bytes were never reclaimed.
  A correctness defect and a data-retention one at the same time;
  Cassandra was the only backend with the gap, since SQLite and the
  relational family already delete their tag rows first.

  `delete` now fans out to the side table under the same `useTagIndex`
  guard, reading the compacted prefix's `(sequence_nr, timestamp, tags)`
  back to rebuild the side table's four-column key — `events_by_tag` is
  partitioned by `tag` and clustered on `timestamp`, neither derivable
  from `(persistenceId, toSeq)`. Tag rows are deleted before the events,
  so a crash between the two strands events whose tag rows are already
  gone (a re-run still reaches them) rather than tag rows whose keys can
  no longer be reconstructed. No schema change and no migration. Journals
  running with `useTagIndex: false` are unaffected and issue exactly the
  statements they always did.

  An existing `useTagIndex` deployment keeps whatever rows earlier deletes
  already stranded, and **re-running `delete` over the same range does not
  clear them** — measured, not assumed.  The new cleanup rebuilds each
  side-table key by reading `(sequence_nr, timestamp, tags)` back out of the
  `events` table, and a pre-fix `delete` has already removed exactly those
  rows, so the read returns nothing and no `events_by_tag` row is touched.
  Clearing a pre-existing backlog needs a manual sweep of `events_by_tag`
  or a backfill, not a second `delete`.

  The `Journal` contract records the obligation, and a new shared contract
  scenario — "a deleted event is invisible to `currentEventsByTag`" — runs
  it against every backend that has a query class: InMemory as the oracle,
  SQLite, MongoDB, and Cassandra in both the default and tag-index
  layouts.

- **A failing snapshot retention pass no longer fails the snapshot save
  (#393).**

  Nine of the ten non-object-storage snapshot stores ran their `keepN`
  prune inside the save's `try`, so a prune error surfaced as a save
  error. The caller was told to retry a write that had already succeeded,
  and a `PersistentActor` that treats a snapshot failure as fatal died
  over a housekeeping delete. Fixed in `RelationalSnapshotStore`
  (inherited by the Postgres, MariaDB, MsSQL, LibSQL and D1 stores) and in
  the SQLite, Cassandra, Mongo and DynamoDB stores. SQLite is worth
  calling out: it is the recommended local-production backend and it
  rethrew the prune failure as a `JournalError`.

  `SnapshotStore.save` now states the rule the object-storage store had
  always followed alone — retention is best-effort, the write is not. The
  two have opposite failure meanings: a failed write means the snapshot
  does not exist and retrying is correct, while a failed prune means one
  row too many exists, which `loadLatest` cannot see and the next save
  retries anyway. Implementations must therefore run the prune outside the
  write's error handling.

  The shared persistence contract gains "a failing prune does not fail the
  save", gated by a new `pruneFailure` capability and backed by a
  fault-injection seam that rejects the single driver operation the prune
  uses and the write does not. Seven backends declare the seam; all seven
  fail the new scenario when the store fixes are reverted.

- **The persistence-query page no longer claims every journal has a
  matching query (#391).**

  "Each journal has a matching query" stood over a three-row table listing
  `InMemoryQuery`, `SqliteQuery` and `CassandraQuery`. That was wrong in
  both directions: it omitted the `MongoQuery` that had already shipped,
  and it told a Postgres or MariaDB reader to construct a class that did
  not exist. Both language versions carried it.

  The table now lists every query that ships. The more useful half is new:
  what happens on a backend with none. `InMemoryQuery` works against any
  journal and is correct at any volume, but its by-tag methods scan the
  whole journal on every poll — and nothing warns you about the slower
  pairing, which the page now states outright rather than leaving to be
  discovered under load.

  The Postgres page gains a tag-query section covering what `events_tags`
  is for and which of the three filter shapes gets an index walk. MariaDB
  points at it and adds the caveat that belongs on its own page: `tag` is
  declared as a bare `VARCHAR(255)`, so a stock server compares it
  case-insensitively (#707). Results stay correct — the query re-checks
  every row against the event's own tag list — but the pre-filter is less
  selective than on Postgres, and `COLLATE utf8mb4_bin` is the fix for
  anyone pre-provisioning the schema.

- **The dispatcher-tuning guide told you to measure queueing with a metric
  that does not exist (#196).**

  Its "Measuring" section, in both languages, named
  `actor_message_duration_ms` and had the reader infer dispatcher latency
  from the spread between its p50 and p99. That metric appears nowhere in
  `src/` or the tests — only in those two pages — and the inference
  conflated queueing delay with variance in the handler itself. Both
  halves are now named metrics that do exist, `actor_mailbox_wait_seconds`
  and `actor_message_handler_seconds`, with the split between them spelled
  out as the thing that decides whether tuning the dispatcher can help at
  all.

- **The cluster's `ActorRef` walkers no longer flatten the values they
  walk through (#450).**

  `encodeRefs` / `decodeRefs` exist to swap `ActorRef`s for wire markers
  and back, but both rebuilt every container they passed through and both
  ended in a generic `Object.entries` tail. For any value whose data is
  not own-enumerable that tail is destructive: a `RegExp`, a `URL` and an
  `Error` all came out as `{}`, and an `Int32Array` came out as an
  index-keyed plain object — before the frame codec ever saw them, so no
  wire format could have rescued them.

  The decode direction was the lossier of the two. `walk` at least rebuilt
  a `Map` as a `Map`, but `walkDecode` had no container branch at all, so
  a collection that survived encode, the transport and the frame codec was
  still delivered to the actor as `{}`. That was visible on
  `InMemoryTransport` and `MessageChannelTransport` too, where nothing
  else in the path is lossy.

  Both walkers now hand back by reference everything that cannot hold a
  ref in a position they could reach (`Date`, `RegExp`, `URL`, `Error`,
  `ArrayBuffer` and its views) and share the container vocabulary
  `JsonTree` has — `Map`, `Set`, `BidirectionalMap`,
  `BidirectionalMultiMap` — so a ref inside one of those is rewritten in
  both directions.

- **A message body the wire codec cannot serialise no longer throws out of
  `tell` (#450).**

  `TcpTransport.send` wrote `encodeFrame(message)` with no guard, so an
  encode failure propagated out of `RemoteActorRef.tell` and into the
  calling actor's `onReceive` — and `tell` is fire-and-forget, which is
  exactly the contract that says it must not throw the way a failed `ask`
  rejects. The same `send` is also reached from the gossip and heartbeat
  timers, where a throw has no caller at all to catch it.

  The encode now sits behind a private `writeFrame` that drops the frame
  and logs at `error` with the frame kind and the peer. The
  buffered-handshake flush path goes through it too, so a frame that could
  not be encoded when it was queued fails the same way when the
  `hello-ack` releases it.

- **Documentation that misstated where serialization happens, in both
  languages (#450).**

  Three corrections are independent of the wire change and were wrong
  before it. `serialization/overview.mdx` and
  `testing/multi-node-spec.mdx` both sent readers to `MultiNodeSpec` /
  `ParallelMultiNodeSpec` "to ensure messages serialize correctly";
  neither serializes anything — the first delivers by reference, the
  second structured-clones — so both accept payloads the wire refuses, and
  they now point at a `JsonSerializer` round-trip instead.
  `serialization/cbor.mdx` said the journal / durable-state / snapshot
  stores "write their own JSON", false since #888, and steered readers to
  using `CborSerializer` directly when the supported route is that store's
  own `withSerializer(...)`, which the page now shows.
  `serialization/custom.mdx`'s per-class-vs-system-wide table implied
  `ext.bind(Class, id)` routes a class somewhere; it only affects
  `ext.encode`, which nothing in the framework calls.

  The rest follow the wire change: the "How it works" diagram and "Where
  serialization fires" list in the serialization overview, the four
  now-false "doesn't survive" bullets in `cluster/refs-across-nodes.mdx`,
  and one line each in `cluster/overview.mdx`, `cluster/worker-mesh.mdx`
  and `fundamentals/messages.mdx`. `routing/scatter-gather.mdx` and the
  `ScatterGatherRouter` JSDoc that generated its prose flip the other way:
  `AggregateError` now does survive the wire with its `errors` array,
  though its members arrive as plain `Error`s carrying the original
  `name`, so the page gives the name comparison that works across nodes.

- **Six documentation pages published an API that does not exist (#470).**

  All four WebSocket pages imported `jsonCodec` from
  `actor-ts/persistence` and then called it in the WebSocket codec's
  shape. Two unrelated subpaths export that name — the WebSocket one takes
  two type parameters and an options argument, the persistence one takes
  one type parameter and no arguments — so the sample was a type error the
  moment anyone compiled it. It is now imported from `actor-ts/http`,
  alongside `WebsocketRouteOptions`. Twelve lines below, the same page
  already imported `rawCodec` from the correct barrel: the rewrite that
  introduced this got every non-colliding name right and the one colliding
  name wrong.

  Both schema-registry pages still listed the pre-`d3f49a9e` signatures —
  `SchemaRegistration<Wire, Upcasted>` with `upcastFromPrev?: (prev:
  unknown) => Upcasted`, and adapters returning `EventAdapter<E, unknown>`
  / `SnapshotAdapter<S, unknown>`. That fix added the `Previous` type
  parameter precisely so `(v1: DepositedV1): DepositedV2 => …` compiles, a
  form the same pages use five times, so each page contradicted itself.
  Both now publish the three-parameter form.

- **A SIGTERM on a `Cluster.bootstrap` node ran no registered shutdown
  task at all (#549).** The bootstrap bound a raw `process.once` to a
  hand-rolled `leave(); terminate()`, and `terminate()` only enqueues a
  root system message — so the HTTP unbind task, registered correctly
  since `ac0124e8`, simply never fired on the one path operators actually
  use.

  On Deno nothing was wired at all, in any configuration: both
  `installProcessHooks` and the bootstrap's own handler called
  `process.on`, which on Deno registers on a shim that never delivers a
  signal. Smoke case 28 spawns a child and asserts both that the phases
  ran in order and that the child exited by itself with status 0 — the
  second because only a separate process can catch a handler left armed.
  Read what that assertion guards on a POSIX runner, which is where CI
  runs it: on Windows the case degrades to having the child start the
  pipeline itself, since `child.kill('SIGTERM')` there is
  `TerminateProcess` and no runtime can catch it — and a
  `Deno.addSignalListener` on Windows does not hold the event loop open
  either. With the detach taken out of `runUntilTerminated`, the case
  still passes locally on both Bun and Deno — so a green local `bun run
  smoke` is not evidence that the handlers came back off.

  A phase also no longer skips a task when one of its siblings unregisters
  itself mid-run: `runPhase` snapshots its task list before invoking
  anything. Two tasks now unregister themselves — the HTTP unbind and the
  cluster leave, each dropping the task named after the resource it just
  released — but only the cluster leave splices before its first `await`,
  which is what the hazard needs; the HTTP unbind drops its task after
  awaiting the backend, by which time `runPhase`'s `map` has long since
  returned. And `cluster-leave` carries exactly one task in a stock
  deployment, so a second would have to be the application's. The hazard
  stays latent; the snapshot is one array copy per phase to keep it that
  way.

- **BREAKING — Dead letters now name the actor the message failed to
  reach, on every path (#433).**

  Six sites handed a bare message to `system.deadLetters.tell(...)` and
  let `DeadLetterRef` do the wrapping. The ref only knows itself, so its
  wrap set `recipient` to `actor-ts://<system>/deadLetters` — the one
  address every dead letter in the system shares, and therefore no
  information at all. A subscriber could see *what* was lost but never
  *where*, which is the half that makes a dead letter actionable, and it
  made `list({ recipient })` and replay-to-original unimplementable.

  Repaired at the call sites, because the call site is the only place that
  knows the answer. `ActorSelection.tell` reports the path it looked up,
  through a new internal `UnresolvedPathRef` stand-in that carries the
  path and drops sends, like `Nobody` but addressed.
  `ClusterSingletonProxy` reports itself, which is what its synthetic path
  exists for, and both of its drop sites now carry the sender too.
  `ClusterSingletonManager` reports its own `self` for a wire delivery
  that reached a node that turned out not to be hosting, unwrapping the
  frame so the letter carries what the application sent.
  `TypedActor.forwardToDeadLetters` reports the actor whose behavior
  answered `unhandled`, plus the turn's sender.
  `ProjectionActor.reportSkipped` had `self` in the *sender* slot, which
  read as "the projection sent this to the dead-letter office"; nothing
  sent it anywhere and a read model is missing it, so `self` moves to
  `recipient` and the sender becomes `null`.

  The eight sites that already wrapped correctly — `ActorCell` in five
  places, the pub-sub mediator in two, `TypedActor.deadLetterStashBuffers`
  — are untouched.

  *Migration:* No signature changed, but the values on a public event did.
  A subscriber that matched `DeadLetter.recipient` against the uniform
  `actor-ts://<system>/deadLetters` path — the only value it could ever
  have held for these six sites — stops matching; match on the real
  recipient, or drop the filter, since the address is now the actor that
  could not be reached. And a subscriber reading `.sender` to identify a
  skipped projection now gets `null`: read `.recipient` instead.

- **The docs no longer claim dead letters are logged (#1000).**

  `fundamentals/actor-system.mdx` stated that "by default the system logs
  dead letters at `debug` level". It never did: `DeadLetterRef` holds no
  logger reference, the whole path is one `eventStream.publish`, and the
  only in-framework subscriber is the DevTools sampler, which is active
  only while DevTools is attached. With nothing subscribed the message is
  simply gone — so a reader who believed the sentence would go looking for
  log lines that do not exist, at exactly the moment they were trying to
  find out what had been dropped.

  `fundamentals/event-stream.mdx` said the same thing more mildly ("useful
  for alarms on lost messages") without mentioning that such an alarm
  needs a subscriber in place beforehand. Both pages now say that
  publication is all that happens, name the `recipient` each letter
  carries, and point at the queue for a record that outlives the moment.
  `operations/troubleshooting.mdx` gains the same correction where it
  tells you to subscribe before shutting down.

  Corrected in English and German. This addresses the claims in the two
  pages the re-triage of #433 named; anything else #1000 catalogues is
  untouched.

- **A node that has left the cluster, or is silently cut off from it, no
  longer reports READY (#655).**

  `Cluster.leave()` un-registered the cluster's two readiness checks at
  the top of the method, before self had even been moved to `leaving`.
  Those are the only readiness checks an ordinary cluster node has, so
  `checkReadiness()` came back empty, `results.every(…)` was vacuously
  true on `[]`, and `/ready` answered 200 with an empty check list — as
  did the gRPC `grpc.health.v1.Health` service, which reads the same
  registry. A pod that had deliberately gone out of service kept being
  sent traffic until the process stopped: the exact inverse of what a
  readiness probe is for, and worse than having no probe, because this one
  is trusted. `leave()` now leaves both checks registered and they report
  DOWN on their own, self staying `leaving` in its own member view. A
  later `Cluster.join` on the same system retires the previous pair at
  registration time — that is what the removal used to buy, and it is now
  the only thing that does it, which is what separates "stayed left" from
  "re-joined".

  The empty-set rule behind that is now stated once instead of emerging
  from `every`. `isHealthy` — moved to `HealthCheck.ts`, same export path
  from `actor-ts/management` — returns `true` for an empty result set
  through an explicit branch, and `/health`, `/ready` and the gRPC health
  service all call it, so the probes cannot diverge. An empty set stays
  healthy on purpose: readiness is the conjunction of the dependencies a
  node *declares*, one that declares none has none unmet, and a plain
  cluster-free system behind `managementRoutes` must not answer 503 for
  its whole life because nobody registered anything. Its safety condition
  is documented beside it — nothing may empty the registry on the way out
  of service, or "everything passes" and "nothing is reporting any more"
  become the same answer — and `addLiveness` / `addReadiness` now say what
  their undo is for: replacement, or a torn-down owner, never a trouble
  signal.

  `cluster-transport` also could not see the partition it exists for. It
  read `Transport.peers()`, which lists every handshake-completed
  connection and empties only on a FIN, an RST or `shutdown()`: nothing in
  `src/` calls `disconnect()`, and an established idle connection arms no
  deadline. So `iptables -j DROP`, a black-holed route or a wedged peer
  took the traffic away while the check went on reporting a reachable
  cluster for as long as the kernel kept retrying — minutes. "Reachable"
  now requires an open connection *and* a member the failure detector has
  not marked `unreachable`, which hands the half that needs noticing
  silence to the component that notices it; and it is asserted about an
  expected *member* rather than a bare connection, so a `ClusterClient`'s
  inbound socket can no longer keep an isolated node in rotation. Partial
  partitions still pass, downed peers still stop counting as expected, a
  single-node cluster still passes. Two limits are now documented rather
  than discovered: the failure detector's own latency, and a one-way
  partition in which this node still receives.

  `clusterMembershipResult` and `clusterTransportResult` are exported as
  pure functions over `(members, self, connectedPeers)`, which makes the
  detail an operator reads off `/ready` assertable — and they now tell the
  two transport failures apart, because "no socket at all" is a peer that
  went away and "sockets open, nobody reachable" is a black hole.

- **The explain plan's `atMs` is a clock reading again, so a mailbox wait
  can no longer come out negative (#411).**

  #411 removed the `Date.now()` at the top of the receive path on the
  grounds that it ran for every message and only the explain recorder
  consumed it. Both halves of that are true; deriving the start in the
  `finally` as `Date.now() - elapsedMs` is what does not hold.
  `Date.now()` floors to whole milliseconds and `elapsedMs` comes off
  `performance.now()` and is fractional, so the difference carries the end
  read's truncation and lands up to 1 ms before the handling began -
  one-sided, never late.

  `atMs` shrugs that off; `mailboxWaitMs` does not, because it is `atMs -
  env.enqueuedAtMs` and the enqueue stamp is an honest integer. On an
  actor idle enough that each message is handled the moment it lands, 1971
  of 2000 entries came out negative, low-water -0.56 ms, printed as such
  in the DevTools panel. Under load the same per-entry truncation put 662
  of 2000 stamps behind their predecessor's, in a ring whose contract is
  oldest-first.

  The read is restored, gated on `this._explain !== null` so an
  uninstrumented message still pays nothing for it - one field load and a
  compare on a path that already null-checks the same field. Every
  allocation #411 removed stays removed. The one message a start stamp
  cannot cover, the one whose own handler switched the recorder on, keeps
  the derivation, rounded up: the error is known to lie in [0, 1) ms and
  to be one-directional, so `Math.ceil` lands on the millisecond the clock
  would have shown at the start or the one after, never the one before.

  Three cases pin the invariants the reading has and the reconstruction
  did not - no negative wait on an idle actor, a whole-millisecond stamp,
  and a ring that reads oldest-first by `atMs` as well as by sequence
  number. All three fail 30/30 against the derived stamp. The mid-flight
  case #411 added was failing 15 times in 30 by 0.42 ms; the file is now
  450/450 over the same loop.

- **`runUntilTerminated()` now keeps the process alive while it waits,
  instead of letting a Node service exit before the signal it armed itself
  for could arrive (#549).**

  A signal handler is not by itself a reason for a runtime to keep
  running: Node unrefs its signal handles, Bun refs its, and a
  `Deno.addSignalListener` listener cannot be unref'd at all. The call
  relied on the handlers it had just installed to hold the event loop,
  which is true on two runtimes out of three. On Node a system with
  nothing else on the loop — no bound port, no open socket, every timer
  unref'd — drained it the moment it started waiting, and the process
  exited with not one shutdown phase having run; under a top-level `await`
  Node reported `Detected unsettled top-level await` and exited 13. A
  service that binds HTTP survived only by accident, because the listener
  refs the loop.

  The call now takes a keep-alive hold of its own and releases it in the
  same step that detaches the handlers, so a system that shuts down for
  any other reason still exits promptly. `installProcessHooks()`
  deliberately does not get the same treatment: it only promises to
  install handlers, and a permanent hold there would stop a Node program
  that bootstraps a cluster from ever exiting.

  The cross-runtime smoke case that covers this was passing locally only
  because its Windows branch started the shutdown pipeline the instant it
  printed READY, leaving no window in which the process had to survive on
  its own. It now idles first, and reproduces the failure on Windows
  verbatim — same exit code, same warning — so the case that missed this
  defect would now catch it.

### Security

- **Broker lifecycle events no longer carry the connection string's
  credential (#741).** `BrokerActor` embedded `endpointLabel()` verbatim in
  `BrokerConnected`, `BrokerDisconnected`, `BrokerReconnectFailed` and
  `BrokerReconnectAttempt`, and five of the shipped actors implement that hook
  as a bare pass-through of the configured URL. A broker URL is the one
  configuration value that routinely carries a secret inline — `AmqpOptionsType.url`
  documents its own shape as `amqp://user:pass@host:5672/vhost`, and the
  primary AMQP doc example is a URL with a password in it — so the credential
  was published on the system-wide `EventStream`, which has no authorization
  concept, on every successful connect and on every reconnect attempt. With
  the default policy (`maxAttempts: Infinity`, up to 30 s apart) that is one
  copy per backoff tick for the length of an outage.

  Every use inside `BrokerActor` — the four events and four log lines and
  error messages — now goes through a new `protected redactedEndpointLabel()`,
  which applies the existing `redactedUrlLabel` helper (#590, #592): userinfo
  and query string out, scheme, host, port and path kept, because the field's
  only job is telling one broker from another. Redacting in the base class
  rather than in the fifteen implementations is what covers an out-of-tree
  subclass following the documented recipe without its author knowing the rule
  exists; `endpointLabel()` itself is unchanged and still returns the string as
  configured.

  The composite labels were measured rather than assumed. A joined NATS or
  Kafka server list and the email bridge's `imap://… + smtp://…` are not
  parseable URLs, so they take the helper's scan fallback, which masks the
  userinfo of every `scheme://` it finds and leaves the rest of the string
  alone — `nats://***@a:4222,nats://***@b:4222`, not a single flattened host.
  A label that never carried a credential (`tcp://host:port`, `<unknown>`) is
  returned unchanged, which is pinned by its own test: over-redaction would
  cost the field its whole diagnostic value.

- **`WebsocketClientActor` can receive binary frames on Node and Deno at all,
  and the oversize-frame cap now covers them (#750).** Nothing in `src/` set
  the socket's `binaryType`, so the client took the runtime default —
  `nodebuffer` on Bun, `blob` on Node and Deno. A `Blob` has `size` rather
  than `byteLength` and matches no branch of `normalizeInbound`, which
  therefore returned `null` and sent every binary frame down the
  "unrecognised inbound frame type" path: dropped, socket left open, one
  warning per frame, whatever its size. So the cap did not apply on two of
  three supported runtimes, and the documented `rawCodec()` client example
  could not work there either.

  Fixed by setting `binaryType = 'arraybuffer'` at dial time in
  `connectImplementation` — not in the `WebsocketClientConstructor` seam,
  which is exported, so a custom constructor would reintroduce the defect from
  outside the file whose correctness depends on it. Teaching
  `normalizeInbound` about `Blob` was rejected in writing: `Blob` yields
  bytes only through `arrayBuffer()`, so `handleInbound` would resume on a
  later microtask, dropping the arrival-order guarantee and moving the
  `maxFrameBytes` check behind it — putting the next oversize frame in flight
  before the close for the first is issued, which is the property the cap
  exists to provide.

  A new smoke case covers it on all three runtimes; without the fix it is red
  on Node and Deno and green on Bun, which is also why every existing
  WebSocket test stayed green through the regression — they are text-only, and
  Bun's default hid it.

- **BREAKING (pre-1.0): `assertValidTags` now rejects empty and duplicate
  event tags (#740).** The validator exempted the empty tag on the documented
  grounds that "every backend already skips them on write". No backend did.
  The SQLite and relational journals dropped it from their tags *table* while
  still writing it into the comma-separated `tags` column they read back
  from, so `['order', '']` round-tripped verbatim; MongoDB indexed it as a
  queryable `''` bucket that a `{all: ['']}` query matches; the Cassandra tag
  index opened one hot `tag = ''` partition, the exact shape that index
  exists to avoid; and DynamoDB rejected the whole item, since a string-set
  member may be neither empty nor repeated. One `tagsFor` returning
  `[category, subCategory ?? '']` therefore had a different outcome on every
  store, up to a request-triggered hard write failure on one of them.

  Both rules are enforced centrally rather than as a filter copied into six
  write paths that can drift apart again — the same trade the existing comma
  rule makes. An empty tag is refused with a message naming its index, since
  `JSON.stringify('')` identifies nothing in a list of ten, and a repeat is
  checked last so a tag that is both malformed and repeated reports the flaw
  the caller can act on. Tags are compared byte for byte: `'Order'` and
  `'order'` are two tags, not a repeat.

  *Migration:* a `tagsFor` that can return an empty string or the same tag
  twice now throws instead of silently behaving differently per backend.
  Filter or de-duplicate before returning.

- **BREAKING (pre-1.0): a decoded CRDT counter slot is bounded by
  `MAX_COUNTER_SLOT` (2 199 023 255 551, or 2^41 − 1), and
  `GCounter.increment` refuses to build one past it (#720).** Grow-only
  counters merge by componentwise maximum, so a slot is a floor no honest
  operation lowers: before this, a peer able to gossip could write
  `Number.MAX_SAFE_INTEGER` into *any* replica's slot — a non-negative safe
  integer, so it passed every decode rule — pinning that counter
  cluster-wide, irreversibly, and through to the durable record.

  The bound is derived rather than chosen. `GCounter.value()` sums the slots
  and the decoder admits at most `MAX_CRDT_ENTRIES` (4 096) of them, so
  `floor(MAX_SAFE_INTEGER / MAX_CRDT_ENTRIES)` is the largest per-slot
  ceiling for which a fully saturated *decoded* counter still sums to an exact
  integer. The qualifier is load-bearing: `MAX_CRDT_ENTRIES` bounds one
  decode, and `merge` has no slot-count cap, so slots accumulate across
  frames. Four individually wire-valid frames of 4 096 disjoint replicas each
  merge into a counter of 16 384 slots whose `value()` is no longer a safe
  integer — and which can then be re-encoded by nobody, including this
  replica's own durable store. That path is not closed here.
  It is deliberately not configurable: raising it would be configuring
  `value()` into silent lossiness, which is the failure the bound exists to
  prevent. `MVRegister` vector-clock entries are bounded by the same rule —
  an entry claiming 2^53 − 1 writes dominated every honest entry and was
  never superseded — and `PNCounter` and `GCounterMap` inherit both halves
  through `GCounter`.

  *Migration:* count a coarser unit. Kibibytes rather than bytes is the only
  shape of counter the ceiling binds on in practice, and an aggregate above
  2.2e12 per replica had already left float64's exact range. Still open on
  #720: own-slot authority in `merge`, blocked on #955.

- **`KubernetesLease` no longer loses a lease to itself under ordinary
  API-server latency (#761).** `startRenewalLoop` fired `void renewOnce()` on
  a bare `setInterval` with no outstanding-request tracking, and the
  arithmetic makes an overlap ordinary rather than exotic: the default
  renewal interval is `ttlMs / 3` — 5 s at the recommended 15 s TTL — while
  the HTTP client's own timeout is 10 s, so one request may legitimately span
  two ticks. Both writes were then built from the same `currentLease`
  snapshot and carried the same `metadata.resourceVersion`, so the API
  server's optimistic concurrency rejected one of *this holder's own* writes.
  The resulting 409 was mapped to `onLost`, stopping a singleton whose lease
  was still on the record — and, since that record named this pod with a
  fresh `renewTime`, no other pod could take it over either.

  Two changes fix it: an in-flight guard that skips a renewal tick while one
  is still on the wire, and a re-GET before ownership is given up. A rejected
  PUT now fires `onLost` only when the object is gone or names a different
  `holderIdentity`, and otherwise adopts the server's `resourceVersion` and
  keeps holding. A re-read that itself fails still fires `onLost`: ownership
  that cannot be confirmed may not be assumed.

- **Bounded concurrent request handling on the DevTools tap (#758).**
  `DevToolsHubActor` answers a `request` frame off its mailbox on purpose — a
  slow journal read must not stall the other connected tabs — which also
  meant nothing counted the work: a client could send `request` frames as
  fast as it could write them and hold thousands of concurrent journal reads
  and full-state replays against the process it shares with the application's
  own actors. `replay.diff` folds an entire journal, twice, and the existing
  per-request paging clamps bound one window rather than the number of
  windows.

  In-flight requests are now capped at 32 per connection and 256 across all
  connections, and anything past either is refused with an `error` frame
  carrying code `unavailable` and the `requestId` it answers, rather than
  queued. The hub-wide cap is the one that binds: nothing capped how many
  sockets a client opened, so a per-connection cap alone would simply have
  multiplied by the connection count. The DevTools WebSocket route also sets
  `maxConnections` to 32 as defence in depth — a behaviour change for anyone
  opening more than 32 concurrent DevTools clients against one system, and
  not configurable.

  The slot release is bound on the rejection path as well as the resolve
  path. The cap releases in a `.finally` precisely so the slot comes back
  however the request ends, but nothing tested the rejection half — moving
  the release into the `.then` arm left every test under
  `tests/unit/devtools/` green while wedging the hub at its ceiling for a
  client that sends only requests it knows will fail. Rejection is the cheap
  path: `replay.state` and `replay.diff` reject the moment the registry has
  no such persistence id, without reading a byte of journal.

- **`retry()` now clamps every computed backoff delay to the 32-bit timer
  limit (#771)** — 2 147 483 647 ms, about 24.9 days — before awaiting it.
  `setTimeout` coerces its argument to a 32-bit signed integer, so a larger
  delay silently fired after 1 ms: an exponential backoff with `maxDelayMs`
  omitted did not wait longer as it grew, it stopped waiting altogether and
  turned into a hot loop against the dependency that was already failing — at
  exactly the attempt an operator believes is most conservative. With
  `delayMs: 1000, factor: 10` that was attempt 8. The same misconfiguration
  now degrades to a very long wait, which is visible and fixable.

  `RetryOptions` gains `randomFactor` (a jitter fraction in `[0, 1]`) and a
  `random` seam for deterministic tests. Without jitter the schedule is a
  pure function of the attempt counter, so every caller that failed on the
  same upstream event retried in the same millisecond and the synchronised
  herd could hold a recovering service down. `randomFactor` defaults to `0`,
  so this is additive and an existing `retry` keeps its exact schedule;
  `0.2` is the spread `exponentialBackoff` and the broker reconnect loop
  already default to.

- **`KubernetesLease` no longer memoises the Pod's ServiceAccount bearer
  token for the process lifetime (#760).** A projected token is time-bound,
  and the cached copy had no TTL, no re-read and no invalidation on an auth
  failure: the first 401 fired `onLost`, `ClusterSingletonManager`
  re-acquired on the same lease instance every 5 s, and every attempt
  replayed the same dead token — so the singleton, or the shard coordinator,
  stayed down until the pod was restarted. CWE-613.

  The two credential sources are now distinguished by lifetime rather than
  only by shape. An explicitly supplied `apiServerUrl` + `authToken` +
  `caCert` triple is still cached for the process lifetime, because there is
  nowhere to re-read it from. A credential read from the ServiceAccount mount
  is reused for at most the new `tokenReloadIntervalMs` (default 60 s), after
  which the token file's mtime decides between another interval on the same
  bytes and a fresh read — so the steady state costs one `stat` per interval
  per lease. On top of that, a 401 or 403 invalidates the cached credential:
  the mount is re-read and the operation retried exactly once, across
  acquire, renewal and release, before anything is reported as lease loss. An
  explicitly supplied token is never retried that way, which is what bounds
  the retry against a loop.

  `KubernetesLeaseOptions` gains `withTokenReloadIntervalMs(...)` and a
  `withCredentialLoader(...)` test seam; `K8sApi.ts` exports
  `MountedCredentials` and `MountedCredentialLoader`, which makes the
  in-cluster credential path drivable from a test for the first time. The
  documentation claimed the kubelet-mounted token "works seamlessly" — the
  exact inverse of the implementation, steering operators toward the path
  that carried the defect — and now states the actual reload semantics in
  both languages.

- **`FilesystemObjectStorageBackend` now confines every operation with
  `fs.realpath` rather than string comparison alone (#748).** A symlink
  planted inside the storage root and pointing out of it is refused instead
  of followed — at an intermediate key segment, at `<key>` itself on the read
  path, or at the `<key>.meta.json` sidecar — by `put`, `get`, `delete` and a
  prefixed `list`. A root that is itself a symlink keeps working: it is
  canonicalised and containment measured against the result. The prefixed
  `list` case became reachable only with #746, which moved the walk's start
  from the root to the prefix's directory.

  The metadata sidecar is written through a temp file and renamed into place,
  like the object body: its name is fully deterministic and therefore
  pre-plantable, and `writeFile`'s default `'w'` flag follows a link and
  truncates its target. Not `{ flag: 'wx' }`, because `get` reads that exact
  name back and a re-put must legitimately replace it.

  The JSDoc claiming the old lexical check caught "URL-encoded traversal,
  symlinks resolved at OS level" is corrected: it did neither —
  `path.resolve` does not URL-decode and never touches the filesystem — and
  it cannot fire at all today, because the key validator already excludes
  every input that could make `path.join(dir, key)` escape. Two limits are
  now written down rather than implied away: canonicalise-then-open narrows
  the symlink race without closing it, since portable `O_NOFOLLOW` is not
  reachable through `node:fs`; and the check confines the backend's own
  operations rather than sandboxing a directory other local processes may
  write to.

- **The management `GET /metrics` route no longer answers `200` with a
  zero-byte body when the installed `MetricsRegistry` cannot be read back
  through `collect()` (#744)**, and the DevTools overview no longer reports
  zeros for figures it could not read. Both happened with the
  `promClientRegistry` bridge installed — the documented "one scrape
  endpoint" wiring — because the bridge writes through to prom-client and
  keeps no snapshot, so its `collect()` is permanently empty. A zero-byte
  body is a *valid* empty Prometheus 0.0.4 scrape: the target stayed
  `up=1`, no target error was raised, and every framework series silently
  stopped existing, so threshold rules over them never fired again. On the
  DevTools side a busy node reported 0 messages processed, 0 mailbox drops
  and no handler latency — the framework's own overload signal reading zero
  on the screen an operator diagnosing a slow consumer is looking at.

  `MetricsRegistry` gains an optional `readonly collectable?: boolean`, with
  `isCollectable(registry)` as the reader's question; absent means `true`, so
  every existing implementation inside this repository and outside it keeps
  its meaning untouched. The `/metrics` route answers `503` naming the
  conflict, checked per request rather than while the route tree is built,
  because `useRegistry` commonly installs the bridge after
  `managementRoutes` has returned — `/health` and `/ready` are unaffected.
  `NodeFigures` and the DevTools `stats` sample gain an optional
  `metricsUnavailable`, which rides along from every peer and is carried by
  the totals when any one node is blind. That first pass covered the tiles
  and missed the Throughput chart beneath them; the entry under Fixed above
  records the follow-up. Two JSDoc blocks described
  `collect()` as a snapshot translated back from prom-client; they were the
  only API-level documentation of that method and promised the opposite of
  the implementation.

- **`ConsumerController`'s per-`producerId` deduplication map is now bounded
  (#728).** It previously kept one `{contiguous, above}` entry for every
  distinct `producerId` it had ever admitted, with no cap, no TTL, no
  eviction and no `postStop` trim, so its size was a function of how many
  ids had arrived rather than of how many producers exist. Sender-chosen ids
  off the wire made that an amplifier — one retained entry per delivery —
  and it leaked with no sender involved at all, because a `ProducerController`
  whose caller leaves `producerId` unset mints a fresh random one per
  construction, so a long-lived consumer served by short-lived producers
  accumulated an entry per producer.

  Two new options, both opted out of with `Infinity`: `maxProducers`
  (default 1024), a least-recently-used cap on the map, and
  `producerIdleTtlMs` (default 300000), a background sweep that drops entries
  no delivery has touched — the only mechanism that reclaims while nothing is
  arriving. Eviction is warn-logged rather than silent, paced to at most one
  line a minute and carrying the count it stands for, so a flood cannot trade
  a bounded heap for an unbounded log; the peer-supplied producer id is
  deliberately kept out of the message. Also new: a
  `ConsumerControllerOptionsValidator` and a `trackedProducers` getter, since
  the growth this bounds previously had no log line and no counter — the only
  symptom was the eventual OOM.

  *Behaviour change, and the price of the bound rather than a side effect:*
  past either limit an entry is dropped, that producer's duplicate
  suppression goes with it, and a retransmit arriving afterwards runs the
  handler a second time. That is an at-least-once duplicate the protocol
  already permits — it never drops a message — but a consumer legitimately
  serving more than 1024 producers, or with producers that idle for over five
  minutes between deliveries, should raise the corresponding value. Still
  open on #728: `maxOutOfOrder`, the cap on the per-producer out-of-order
  `above` set, which #643 claims in its own acceptance criteria.

- **`reEncryptObjectStorage` can now sweep a corpus written with the
  integrity HMAC (#739).** The tag authenticates the manifest bytes, so
  `decodeBody` refused a tagged body without the integrity key,
  `ReEncryptOptions` had no field to supply one, and the re-encode passed
  only compression + encryption so it would have stripped the tag regardless.
  Tamper protection and master-key revocation were therefore mutually
  exclusive: a deployment running both had to abandon the HMAC or leave a
  leaked key in `retired` indefinitely, because dropping it makes the
  historical corpus undecryptable.

  `integrity` takes the same shape the stores take — a flat `IntegrityConfig`
  or the same per-`persistenceId` resolver — and is resolved per key, so a
  deployment keyed per tenant resolves here exactly as its store does; tags
  are verified on read and recomputed on write over the new bytes and the
  storage-key binding, not copied across. `allowUntaggedBodies` mirrors the
  stores' option of the same name for a corpus mid-migration, and defaults to
  `false` for the same reason it does there. A tag is re-applied only where
  the body already carried one: promoting an untagged body would make it
  unreadable to any reader not yet holding the integrity key, and a rotation
  runs while the application is serving.

  The pre-sweep sampler now refuses a run whose sampled tagged bodies have no
  integrity key to verify them, so the gap surfaces before the first `put`.
  An unencrypted-plus-HMAC body was previously counted `skippedUnencrypted`
  and skipped, so for that configuration the sweep reported success having
  rewritten nothing and the context-binding migration (#612) could never
  finish; such a body is now re-framed once for its storage key. *Behaviour
  change:* a sweep over that corpus without `integrity` now fails where it
  previously returned a clean-looking result.

  What the sweep still cannot do is rotate the **integrity key** itself, and
  the documentation now says so instead of offering a procedure. The first
  draft recommended rolling it "the same way you turned integrity on"; that
  cannot be completed — `allowUntaggedBodies` re-admits bodies carrying no
  tag, while a body tagged under the old key still carries
  `FLAG_INTEGRITY_HMAC` and fails the HMAC comparison before that branch is
  reached, with the new key, without it, and with integrity disabled alike.
  Fail-closed in every direction, so it is a dead end for the operator rather
  than a silent half-roll. The per-call `PersistenceOptions.integrity`
  override does work, read and write independently, per `persistenceId`;
  #1354 carries the shape a real roll would need.

- **BREAKING (pre-1.0): broker actors can now be given TLS certificate
  material (#743).** `AmqpOptions`, `RedisStreamsOptions`, `MqttOptions`,
  `NatsOptions` and `JetStreamOptions` gain an optional `tls` block with a
  matching `withTls`, and `KafkaOptionsType.ssl` widens from `boolean` to
  `boolean | TlsTransportOptionsType`. Until now every one of these actors
  passed only a URL (or a boolean) to its driver and never the driver's
  options argument, so TLS was reachable only in its default-trust-store
  form: an operator behind a private CA, or one whose broker required a
  client certificate, hit a handshake failure that `BrokerActor` reads as a
  connection failure and answers with the reconnect policy — whose
  `maxAttempts` defaults to Infinity — so the retry loop had no path to
  success. The realistic workaround was a process-wide
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, which also disables verification on the
  cluster transport and on every HTTP client the process makes.

  The shape is `TlsTransportOptionsType`, the same one `TcpServerOptions`,
  `ClusterClientOptions`, `GelfSinkOptions` and `SyslogSinkOptions` already
  take, now re-exported from `actor-ts/io`. Forwarding goes through a single
  mapping rather than a spread, because it is not identity: Node spells the
  SNI override `servername` where this project spells it `serverName`, and
  all five drivers hand their TLS object to `tls.connect` unchanged — a
  spread would have carried `serverName` through, every driver would have
  ignored it, and the connection would have verified against the wrong name.
  None of it is readable from HOCON, deliberately, and Kafka's `ssl` config
  key stays boolean-only: a private key does not belong in a config file.
  Each validator now rejects a `cert` without its `key`, so the mistake fails
  the actor's start instead of throwing inside the driver's handshake and
  being retried forever.

  Documentation (EN + DE) loses two claims that were false: that amqplib
  takes TLS configuration through URL parameters, and that NATS mTLS material
  reached the underlying connection. `tls-everywhere.mdx` is rewritten around
  the distinction it was conflating — the URL scheme or `withSsl(true)` turns
  TLS on and verifies against the system trust store, `withTls` says what the
  handshake should trust — and now states plainly which client actors still
  take no certificate material: `WebsocketClientActor` and `TcpSocketActor`.

  *Migration:* `KafkaOptionsType['ssl']` is no longer `boolean`. Code that
  reads it and expects one needs a `typeof ssl === 'boolean'` narrowing; code
  that only writes `true` or `false`, and anything reading the value from
  configuration, is unaffected.

- **BREAKING (pre-1.0): duplicate HTTP route registrations are rejected at
  `bind()` (#759)** instead of silently resolving to whichever route was
  declared first. `HttpServerBackend.registerRoute` has always documented
  "Duplicate paths must be rejected", but only Fastify's router enforced it:
  `ExpressBackend` and `HonoBackend` replayed their registrations in
  insertion order and never fell through to a second handler, so `concat()`
  argument order silently decided whether an auth-guarded route or an
  unguarded twin at the same method and path was the one that served — with
  nothing logged and nothing thrown. `HttpExtension.bind` now rejects a
  repeated `method` + `pattern` pair over the whole compiled route tree,
  beside the websocket-duplicate and GET-vs-websocket checks it mirrors, so
  the answer is the same on every backend including third-party ones.

  *Migration:* an Express or Hono application whose route tree declares the
  same method and pattern twice used to start and serve the first
  declaration, and now throws at `bind()`. Remove the duplicate, or give one
  of the two routes a distinct path. Routes that merely *overlap* —
  `/users/:id` against `/users/me`, a wildcard against a literal — are
  unaffected and still resolve in the backend's own router. The route-DSL
  docs asserted the opposite in both languages, in an Aside whose own example
  throws `FST_ERR_DUPLICATED_ROUTE` on the default backend.

- **BREAKING (pre-1.0): messages a bounded or priority mailbox discards can
  now become dead letters (#773)** instead of vanishing into a counter.
  Overflow was the one loss path in the framework with no forensic record:
  the drop-reporting seam carried a `reason` and never the envelope, so
  `drop-head` bound the evicted message solely to decide whether to increment
  `actor_mailbox_dropped_total` and then dropped the reference, while
  `drop-new` never saw it again. An operator could tell that something had
  been shed, never what.

  The seam now carries the envelope, and each of the seven drop sites hands
  over the one it actually let go of — under `drop-head` the message evicted
  to make room, not the arrival. A new `deadLetterDrops` option
  (`withDeadLetterDrops(...)`, default `false`) routes every dropped envelope
  to `system.deadLetters`. It is opt-in on purpose: `enqueue` runs on the
  sender's stack and `DeadLetterRef.tell` is a durable capture followed by a
  synchronous event-stream publish, so unconditional routing would convert
  load shedding into per-message work under exactly the pressure the bound
  exists to absorb. Rate-limiting the dead-letter stream itself remains
  #1179. `BackoffSupervisor` dead-letters the stash entry it evicts
  unconditionally, because that eviction runs inside its own `onReceive` and
  not on a sender's stack, and its stash-overflow warning is now aggregated —
  first eviction, then each doubling — so a flood no longer turns a message
  flood into a log flood at the same rate.

  *Migration:* `observeDrops`, `reportDrop` and the `onDrop` option all take
  a second `envelope` argument. A custom mailbox that calls its own observers
  must pass the envelope it discarded; an observer that ignores the second
  parameter needs no change. Known limit: the dead letter carries message,
  sender and recipient, not the envelope's MDC `context` or tracing `trace` —
  `DeadLetter` has no slot for either.

- **`WebsocketClientActor` now closes the connection on an oversize inbound
  frame (#750)**
  with code 1009, instead of dropping the frame and leaving the socket open.
  As first landed this held for text frames only; the entry below closes the
  binary half on Node and Deno. A hostile, compromised or MITM'd peer could
  otherwise repeat the allocation indefinitely on a single connection — one
  full-size heap allocation and one warning line per frame, with nothing
  bounding either. The breach now routes through the actor's normal disconnect
  path, so another round costs the peer a full reconnect, which the inherited
  backoff and circuit breaker already throttle. An application that relied on
  oversize frames being dropped silently while the connection carried on will
  now see a disconnect and a reconnect instead.

  The client's `maxFrameBytes` is also now documented as post-hoc only,
  because no runtime lets it be anything else. #750 proposed pushing the cap
  into the transport, the way the server backends hand `maxPayload` to `ws`.
  Measured rather than assumed: constructing the socket with a payload limit
  and having a peer send a 4 MiB frame shows `maxPayload`,
  `maxPayloadLength` and `maxFrameBytes` are all accepted and all ignored on
  Bun 1.4.0, Node 26.7.0 and Deno 2.6.8, each reading back `undefined` while
  the frame is delivered whole. Setting the option and reading it back would
  have passed and proved nothing. The measurement is written down beside the
  code so it need not be repeated.

- **A `ProducerController` that generates its own `producerId` now draws it
  at random (#730)** — `producer-` plus 16 hex characters of crypto-grade
  randomness — instead of from a module-global counter. An `Acknowledgment`
  names a `producerId` and a `seq`; the seq is a small integer by
  construction, so a counter left a forger with only the producer's
  incarnation token to guess. That token is still what authenticates an ack,
  so this is defence in depth behind it and not a substitute — a
  `producerId` a caller configures stays exactly as guessable as the name
  they picked.

  The counter was also module-global, so it was never unique across the
  boundary that matters: two processes running the same service each minted
  `producer-1`. Two producers under one id reaching one consumer is a
  correctness bug, not an aesthetic one — the consumer keys dedup on
  `producerId` and swaps the entry whenever the incarnation changes, so each
  producer's first delivery reset the other's window and both sides
  re-handled messages they had already absorbed.

  A generated id is minted fresh on every construction, so leaving
  `producerId` unset no longer yields anything stable across a restart. Set
  it explicitly whenever something downstream — a log filter, a metric label,
  the consumer's map — has to recognise the producer after one.

- **BREAKING (pre-1.0): `ActorRef.ask` now requires `timeoutMs` to be a
  positive finite number (#765).** `0`, a negative value, `NaN` and
  `Infinity` throw `OptionsError` instead of producing an ask that can never
  settle. `AskResponseRef` arms its timeout only under `if (timeoutMs > 0)`
  and `tell` is the only other caller of its `settle()`, so an unanswered ask
  with such a deadline settled on nothing at all: the caller's `await` stayed
  pending for the life of the process, and once the ref had been encoded onto
  the wire it also left one permanent entry in
  `Cluster._envelopeHandlersByPath` — the map `dispatchEnvelope` consults on
  every inbound envelope — because `RefCodec.registerAskResponseRef` hangs
  that entry's removal on `_onSettled` and nothing else removes it.

  None of those values needs a typo to arrive: a computed budget
  (`deadline - Date.now()`) is negative the moment its deadline has passed, so
  under a request-driven workload a slow downstream turned every late request
  into a permanent leak. CWE-772 — the same shape #602 closed on
  `HttpClient`'s per-request limits. The check runs before anything is
  allocated or sent, and throws rather than returning a rejected promise: an
  argument outside its domain is a defect at the call site, and a rejection
  would surface as an unhandled rejection for the fire-and-forget
  `void ref.ask(...)` shape the cluster client uses.

  `0` is refused rather than reinterpreted as "use the default". Substituting
  five seconds for an expired budget would make the ask outlive the deadline
  its caller computed, and nothing can settle a deadline-less ask by hand —
  `ask` hands back the promise, not the ref. It also puts this positional
  argument in the same domain as every option-sourced ask timeout in the
  framework, all of which validate with `positiveNumber`.

  *Migration:* omit the argument (or pass `undefined`) for the five-second
  default — there is no "wait forever" mode. Code that computes a budget
  should check it is still positive before asking rather than passing an
  expired one through.

- **`WorkerBroker` now re-addresses every brokered frame to the
  `MessagePort` it arrived on, so a worker can no longer write a sibling's
  address into an envelope's `from` (#774).** The broker establishes a
  trustworthy port-to-address binding at registration — the host mints each
  worker's `NodeAddress` and hands it to `register` — but discarded it and
  re-posted envelopes verbatim, while the receiving
  `MessageChannelTransport` derives its peer identity from that field and
  hands it to `Cluster.handleWire`. One worker could therefore refresh a dead
  sibling's failure-detector timer, keeping it looking alive and blocking
  singleton and shard failover, and have its own envelopes attributed to that
  sibling for reply routing and every `maySpeakFor` rule. This is the rule
  #562/#564/#572/#574/#582 already applied elsewhere — take the peer from the
  connection, not from the payload — reaching the one path where it did not
  hold.

  Only the `system@host:port` slot is compared and corrected, because
  `toString`, `equals` and `compareTo` all exclude the incarnation, so that
  slot is what every member map, the failure detector and every authority rule
  keys on. The optional `incarnation` is still passed through as the sender
  wrote it, for as long as nothing in the cluster acts on it (#940). The
  testkit's `MultiNodeBroker` applies the identical rule via the same helper,
  so a `ParallelMultiNodeSpec` scenario cannot pass in the harness and fail in
  a real worker mesh.

- **`InMemoryCache` now ranks eviction by key prefix before it ranks by
  guarantee (#607).** The new `prefixQuotas` option — a table of key prefix to
  entry count, off by default — splits one map between the consumers writing
  into it. A quota is a cap and a reservation at once: as a cap, a prefix that
  has reached its quota takes its next victim from inside itself, so a caller
  who can mint keys under one prefix evicts only that prefix's entries; as a
  reservation, the entries a prefix holds below its quota are not available to
  anybody else. A key belongs to the longest configured prefix it starts with,
  or to a shared unreserved remainder.

  Two exposures #607 was left holding are closed by configuring it: a
  rate-limit counter flood evicting an idempotency record from a shared
  instance (a double charge), and an off-limiter `Idempotency-Key` flood
  resetting the flooder's own rate limit. #1080's guarantee split ranked what
  an entry is *for*; this ranks *whose* it is, and the two are independent.

  One exposure is declared **permanent** rather than pending, and the docs and
  tests now say so: a flood through `idempotent`'s own key space still evicts
  another caller's record, because attacker and victim write under the same
  prefix and share whatever is reserved for it. Bounding a caller rather than a
  prefix needs a key space the attacker does not choose; the answers remain
  sizing `maxEntries` and backing the consumer with `RedisCache`.

  `maxEntries` is unchanged as a hard cap — a configuration reserving the
  whole map leaves an unreserved write taking a reserved slot rather than the
  bound giving way. Quotas summing above `maxEntries`, an empty prefix and a
  non-positive-integer quota are refused at construction with `OptionsError`.
  Configurable through `withPrefixQuotas`, a plain object, or HOCON at
  `actor-ts.cache.<name>.in-memory.prefixQuotas`; the table is layered whole
  rather than leaf by leaf, because the quotas must sum to at most
  `maxEntries` and a half-inherited table is a sum nobody wrote down. An
  unconfigured cache is one bucket and behaves exactly as before.

- **BREAKING (pre-1.0): a replicated event's author is now bound to the node
  that sent it (#706).** `ReplicatedEventSourcedActor` took an envelope's
  `replica` — the id that keys the vector clock, prefixes every event id and
  breaks ties in the canonical order — straight out of the broadcast payload,
  so any cluster member could publish an event attributed to a peer and, with
  `timestamp: Number.MAX_SAFE_INTEGER`, make it sort last and win the fold on
  every replica, in the peer's name and in the peer's journal. The actor now
  holds `replica` against the node the connection authenticated, and refuses
  an envelope that reaches it with no authenticated origin at all — which also
  closes the second route, where `Cluster.dispatchEnvelope` resolves any path
  and delivers the raw body with no identity, so a pub-sub-only fix would have
  left the attack reachable one path over.

  `DistributedPubSub` can now tell a subscriber which node published:
  `new Subscribe(topic, ref, replyTo, /* deliverWithOrigin= */ true)` delivers
  a `PubSubEnvelope` carrying `topic`, `message` and `origin` instead of the
  bare body. Every other subscriber is untouched, which is why it is opt-in.
  `origin` is the connection's peer for a message that crossed the wire and
  this node for a local publish; `null` means unauthenticated rather than
  local. The identity rides through the mailbox inside an
  `AuthenticatedPubSubMessage` class, because a peer can reproduce any tagged
  object verbatim inside a payload and cannot mint a class instance.

  *Migration:* an application that overrides `replicaId` with anything other
  than its node's address must now also override
  `isAuthorizedAuthor(replica, origin)` to supply the replica-to-node mapping.
  The default is an equality against the sending node's address, which is
  exactly right while the id *is* that address and refuses every honest
  envelope once it is not. An application on the default `replicaId` needs no
  change. Handing an actor an envelope by telling it directly — tests,
  tooling — no longer works either: it is dropped with a `WARN` for want of an
  authenticated origin.

  The other half of the migration is the delivery narrowing: a subscriber
  that opts into `deliverWithOrigin` receives a `PubSubEnvelope` carrying
  `topic`, `message` and `origin` rather than the bare body, so a handler
  written against the old shape has to unwrap it. Every subscriber that does
  not opt in is untouched, which is why the flag exists.

  Two sub-remedies are refused rather than deferred, with the reasoning
  recorded at the check site: strict per-replica `seqAtReplica` monotonicity
  (pub-sub dead-letters a publish with no live subscriber and nothing
  retransmits, so a gap is normal and permanent, and a successor rule would
  suppress that replica forever) and a receive-time ordering key (`_compare`
  must be a function of the events alone, or two replicas holding the same set
  compute different states).

- **Fixed on the way: the pub-sub mediator addressed a remote publish with its
  own system name rather than the recipient's (#706).** A cluster whose members
  share one system name never noticed — the frame missed the receiver's
  per-path envelope handler and was delivered by generic path resolution to the
  very same mediator, identical delivery minus the sender. A cluster whose
  nodes do not share a system name lost the publisher's identity on every hop.

- **BREAKING (pre-1.0): metric series can now be evicted, and two stock
  families stopped minting series nothing paid for (#745).** Note what this
  does and does not close: #745's headline family,
  `actor_mailbox_dropped_total`, lost its unbounded `path` label in #658 and
  gained a per-family cap in #1148/#131, both before this change. What lands
  here is the residual the issue's own later comments named — no per-child
  eviction, and a stray `class="unknown"` series. Per-child eviction cannot
  help that family in any case: `remove` is documented as wrong for counters,
  and it is one.
  `MetricsRegistry` gains `remove(name, labels)`, implemented by
  `DefaultMetricsRegistry`, `NoopMetricsRegistry` and the prom-client bridge.
  Until now `clear()` was the only removal path and its own documentation
  called it a test hook, so a label tuple whose subject had gone kept its slot
  under the per-family cardinality cap for the life of the process. It is a
  call rather than a TTL on purpose: the registry cannot tell a finished entity
  from a counter for something rare, an age-based sweep would need a clock and
  a timer in a primitive that has neither, and a counter that ages out and
  returns reads downstream as a reset that never happened. The overflow series
  is the one child `remove` refuses, because it is the standing record that
  tuples were discarded.

  `actor_mailbox_size` retires a drained, relabelled or terminated actor's
  series instead of setting it to 0, so "on a healthy system this family is
  empty" holds after an incident and not only before one.
  `actor_mailbox_dropped_total` no longer mints a stray `class="unknown"`
  series: a burst issued in the same tick as a spawn overflows before the cell
  has an actor instance, and those drops are now held by reason and attributed
  once the class name is known. `unknown` stays reachable only from a cell
  whose actor failed to start, where it is accurate.

  The stock-label rule — a stock label's values must be bounded by what the
  deployment declares, never by traffic, by how many actors have been spawned,
  or by a value a remote party supplies — is now a gate rather than a note.
  `tests/unit/metrics/StockMetrics.test.ts` reads every stock family out of
  `src/` and checks the whole inventory against it, with
  `actor_mailbox_size{path}` and `persistence_projection_*{projection}` as
  named exceptions carrying the reason each is affordable. The dead-letter
  label had landed one commit-day after the rule was written down, because the
  only thing asserting it was a test pinning one family's label set.

  *Migration:* `actor_dead_letters_total` loses its `recipient` label, which
  under sharding is `entity-<entityId>` — chosen by whoever addresses the
  shard region — at a cost of one permanent series per undeliverable message.
  The
  path is unchanged on the `DeadLetter` published to the event stream and on
  the queue's own entries, so use `deadLetterQueue.list({ recipient })` for
  "which actor" and the counter for the rate. `MetricsRegistry` has a fourth
  method, so an external implementation must add `remove`; the prom-client
  bridge's structural `client` type now requires `Metric.remove`, present in
  every prom-client since v11.2. An alert written on `actor_mailbox_size`
  transitioning to 0 will no longer fire — alert on the series existing, or on
  its value.

- **Broker client actors now notice a peer that vanishes without closing the
  connection (#753).** `TcpSocketActor`, `SseActor` and
  `WebsocketClientActor` treated an explicit transport event — `close`,
  `error`, a stream's `done` — as the only way a connection could end, so a
  dropped NAT entry, a container killed with SIGKILL or a black-holing route
  left the actor reporting `connected` indefinitely: no `BrokerDisconnected`,
  no reconnect, and every send going into a socket that leads nowhere. The
  read-only direction — an SSE stream, an idle WebSocket — had no recovery
  path at all.

  `idleTimeoutMs` on `TcpSocketOptions`, `SseOptions` and
  `WebsocketClientOptions` declares the connection lost after that long
  without a single inbound byte, routing into the existing reconnect machinery
  so backoff, the circuit breaker and the outbound buffer behave exactly as
  they do for an observed drop. It is a *read* deadline — reset by inbound
  traffic and deliberately not by outbound — because a client writing into a
  black hole is the case it exists for. Off by default: a deadline below the
  peer's own heartbeat interval severs healthy connections in a loop.
  `connectTimeoutMs` on the same three bounds one connect attempt, since every
  transport settled its connect on a protocol event and none had a clock. Also
  off by default. `keepAliveMs` on `TcpSocketOptions` enables OS-level TCP
  keepalive and is **on by default** at 45 s (`0` disables it) — it is the one
  liveness knob that cannot be wrong about a healthy connection, because a
  probe is answered by the peer's kernel whether or not its application has
  anything to say.

  On the WebSocket client, `idleTimeoutMs` counts application frames and **not**
  pongs: a protocol-level pong is not delivered as a `message` event on any
  supported runtime, so `pingIntervalMs` does not refresh the deadline. Size it
  against the *server's* heartbeat interval. All three knobs are readable from
  HOCON under `actor-ts.io.broker.{tcp,sse,websocket}` and rejected by the
  options validators when negative.

- **WebSocket upgrades are no longer refused under response-decorating
  middleware (#757).** `compile()` signalled "proceed with the upgrade" by
  reference identity against a frozen sentinel, so every middleware that calls
  `next()` and returns a decorated *copy* of the result — `securityHeaders()`,
  `contentSecurityPolicy()`, `strictTransportSecurity()`, `requestId()`,
  `csrfProtection()` — broke that identity and turned every upgrade beneath it
  into a rejection carrying a bogus `{ status: 101 }` pseudo-response, with
  nothing logged. Acceptance is now tagged structurally with a module-private
  symbol that survives object spread. The direction was fail-closed, but the
  failure mode taught operators to carve the WebSocket subtree out from under
  their hardening middleware — and DevTools, which wraps its whole tree
  including the socket, lost its socket outright to a decorating `auth`
  middleware. Wrapping a whole route tree, socket included, is now correct.

  Headers a decorator adds reach a *rejected* handshake but not an accepted
  one, since the backend writes the 101 response itself. Nothing regresses: a
  decorated sentinel previously **was** a rejection.

- **Guarded two routes by which the optional-peer and audit rules could be
  bypassed with nothing going red (#676).** `bun audit` can be silenced by a
  dependency override as well as by an `--ignore` flag: an `overrides` /
  `resolutions` entry rewrites the resolved closure that lands in `bun.lock`,
  which is what the audit reads, so pinning a transitive dependency past the
  version that fixes an advisory clears the gate with no flag added and nothing
  to review. Measured on bun 1.4.0, both spellings are honoured.
  `tests/unit/ci/SecurityPolicy.test.ts` now requires any such pin to be
  written up under a `## Dependency overrides` heading in `SECURITY.md` — the
  same bijection the `--ignore` list already had. No override exists today; the
  guard is so the first one is a decision someone reviewed. It matters most for
  a library: npm-style overrides apply only while this package is the root
  project, so an override would clear this repo's audit while every consumer
  resolved the vulnerable range exactly as before.

  Nothing in `src/` may name an optional peer in a literal import specifier,
  asserted in `tests/unit/ci/OptionalPeerDeclarations.test.ts` across all 27
  optional peers and 670 source files with no exclusions. This withdraws the
  follow-up that asked for the hand-written `nats` type stubs to be replaced
  with the module's real types: `nats` is declared only in the brokers
  manifest, so the build compile cannot resolve it (TS2307, measured), and the
  stubs are exported through `src/io/index.ts`, so an imported specifier would
  be emitted into a published `.d.ts` that a consumer who took the optional
  peer at its word cannot resolve.

  `cassandra-driver` remains the one optional peer declared in neither
  dependency context, still blocked on GHSA-xcpc-8h2w-3j85. Its allow-list note
  now records four ways out rather than three, with the fourth measured and
  ranked last. Choosing between them is a maintainer decision, not an
  implementer's.

- **BREAKING (pre-1.0): a `Terminated` the runtime did not emit is no
  longer honoured (#769).** `ActorCell` retired a death-watch registration
  on the word of the message — which carries a ref and nothing else — so any
  in-process code holding a watcher's ref could construct a `Terminated`
  naming a **live** actor, consume the watch, and leave the watcher
  permanently blind to that subject's real death: the genuine notification
  then arrived against a registration that no longer existed and was dropped
  as unwatched. Framework-emitted instances now carry a module-private brand,
  checked before any watch bookkeeping is touched; an unbranded instance is
  consumed and dead-lettered with its sender attached rather than silently
  swallowed. `watchWith` substitutions pass through the same gate.
  `Terminated`'s constructor stays public and a hand-built instance still
  type-checks — it is simply no longer acted upon.

  *Migration:* if you constructed a `Terminated` to drive a watcher (a test
  double, or forwarding one you received), stop the actor for real instead,
  or send a domain message of your own.

- **`BackoffSupervisor` no longer respawns on the strength of a message
  (#769).** It matches the terminating ref by identity rather than by
  rendered path — which omits the incarnation uid — and asks the child's own
  cell whether it has actually terminated before nulling `currentChild`,
  bumping the backoff counter and scheduling a respawn; a claim about a
  running child is declined with a warning. It also stops a predecessor that
  is somehow still alive when its replacement is spawned, rather than leaving
  it orphaned with whatever it owned. Before, one fabricated or forwarded
  `Terminated` left `child-1` running unwatched and unreachable beside a
  fresh `child-2`, and skewed the backoff for every genuine failure after.

- **BREAKING (pre-1.0): the object-storage backends and the master-key
  rotation sweep now share one key policy (#747).** Three code paths
  validated the same key strings three different ways: the filesystem
  backend accepted a control character (legal in a POSIX filename),
  `S3ObjectStorageBackend` validated nothing at all, and the rotation sweep —
  the strict end — refused such a key on the way back out of the bucket,
  counted it in `skippedMalformedKey` and returned normally. The operator
  then followed the runbook, dropped the retired master key, and those bodies
  became permanently undecryptable.

  `ObjectStorageWriteKeyRules` is now the single declaration of the
  write-path *character* rule, spread into both backends and the sweep, so a
  key the framework can write carries no character the sweep chokes on. The
  qualifier matters: the `<pid>/<leaf>` shape rule the next bullet introduces
  is enforced by neither write path, so "a key the framework can write is by
  construction a key the sweep can process" holds for the character rule and
  not for the shape. Each
  backend has two rule sets: strict on `put`, unchanged on
  `get`/`delete`/`list` — tightening the read path would not reject a new bad
  key, it would strand an object an older version already wrote, unreadable
  and undeletable through the only backend that can reach it.
  `S3ObjectStorageBackend` validates at all four entry points, having
  validated at none; its rules are deliberately narrower than the
  filesystem's, since `..` does not resolve in a bucket. A new
  `maxLengthBytes` rule measures S3's 1024-byte ceiling in UTF-8 bytes rather
  than UTF-16 code units, so 600 CJK characters no longer pass a check the
  service then rejects.

  *Migration:* a `put` whose key contains a control character (0x00–0x1F or
  0x7F) now throws. Objects already stored under such a key stay fully
  readable and deletable. Nothing else about the write paths changed.

- **BREAKING (pre-1.0): `reEncryptObjectStorage` throws
  `ReEncryptIncompleteError` instead of returning when any object was skipped
  for a malformed key (#747).** A counter the operator has to remember to
  read is not a safeguard when the next runbook step — dropping the retired
  master key — is irreversible, and every skipped object is still encrypted
  under exactly that key. The sweep finishes its pass first, so healthy
  objects are still rotated and the operator gets every offender from one
  run; the error carries the full `ReEncryptResult` plus a bounded sample of
  the offending keys. A refused pass clears its progress store before
  throwing, so the next run cannot start past the malformed key and report a
  clean bill of health for the corpus that just failed.

  *Migration:* wrap the call and catch `ReEncryptIncompleteError` if you need
  the counts on the failing path; reading `skippedMalformedKey` off a
  returned result now only ever yields 0. There is no opt-out flag — the
  existing `skip` predicate is how you exclude objects that are not this
  framework's.

- **BREAKING (pre-1.0): `defaultPidFromKey` refuses a key that is not
  exactly `<keyPrefix><persistenceId>/<leaf>` (#747)**, instead of taking the
  first segment after the prefix and discarding the rest. The persistence id
  becomes the HKDF salt and the sweep then rewrites the body, so a
  plausible-but-wrong id was not a failed read — it was data re-encrypted
  under a salt the owning store never derives again. Two mismatches produced
  one: a `persistenceId` containing `/`, which collapsed every id under a
  tenant onto one salt, and a `keyPrefix` shorter than the store's own
  `prefix`, which yielded the same wrong segment for an entire corpus and
  survives the persistenceId validator from #133 entirely, because the
  offending segment does not come from the id.

  *Migration:* set `keyPrefix` to the store's `prefix` exactly. A layout that
  genuinely nests deeper supplies its own `pidFromKey`, which is unaffected.

- **`websocket()` routes now bound the buffer that holds inbound frames
  between the handshake completing and the connection actor attaching its
  listeners (#717).** That buffer is drained only by `setListeners`, so a
  socket whose actor never spawns turned a peer's frame stream into unbounded
  heap growth — reachable on every connection, on all three backends, with no
  configured mailbox bound and no flood needed, and not helped by the route's
  `maxFrameBytes`, which is enforced in the actor that has not spawned. Two
  new per-route knobs cap it: `maxPreAttachFrames` (256) and
  `maxPreAttachBytes` (4 MiB), resolved route options > HOCON
  (`actor-ts.http.websocket.*`) > built-in defaults and carried to the
  backends with the route registration. Past either, the socket is closed
  with 1013. `close` and `error` are never metered — shedding either is the
  permanent leak #570 fixed — and the first frame is always admitted whatever
  its size, since one frame is already bounded by the transport payload limit.

- **The WebSocket accept path is self-healing (#717).** An upgrade routed at
  a hub whose cell has already terminated used to be dead-lettered silently
  and leave the socket orphaned with its `maxConnections` slot burned,
  because `postSignalEnvelope` returns normally instead of throwing and the
  wiring layer's `catch` therefore never ran; it is now detected, the socket
  closed with 1011 and the slot released. Everything that cannot be seen
  synchronously — a hub that stops between the send and the drain, an
  `onReceive` an application overrode without handling `websocket-accept`, a
  connection factory that throws — is caught by a new per-route
  `acceptTimeoutMs` (10 s, `Infinity` disables it): if no connection actor
  has attached inside the window the socket is closed with 1013 and the slot
  released, and an actor that attaches after the deadline is handed the close
  rather than a socket the framework already killed.

  **BREAKING (pre-1.0):** `WebsocketRouteRegistration` now carries a required
  `preAttachBuffer` field. Only `HttpExtension` constructs one, so a custom
  `HttpServerBackend` that merely consumes registrations is unaffected; a
  test double that builds one supplies a `preAttachBuffer` of its own. The
  defaults are reachable as `DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES` and
  `DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES` from `actor-ts/http/websocket`;
  the bundled `DEFAULT_PRE_ATTACH_BUFFER_LIMITS` object is deliberately not
  exported, because the socket adapter is not part of the public surface.
  Behaviourally, a peer that sends more
  than 256 frames or 4 MiB before its connection actor attaches, or a hub
  that takes longer than 10 s to produce one, now sees the connection closed
  where it previously succeeded.

  Still open on #717, deliberately: delivering `websocket-accept` *ahead* of
  the hub's queued bulk frames. The command is undroppable but keeps its
  place in line, and routing control traffic ahead of data is the same
  decision #985 and #986 need — it should be taken once for all three rather
  than three times.

- **ROADMAP.md's statement of the gossip replay guard's bound is corrected,
  and #112's remaining dependency is re-pointed from #940 to #823.** The
  roadmap said the guard holds "while the sender is still a member". That is
  one of three ways a receiver can be missing the high-water mark the guard
  rests on, and it is not the ordinary one: the map holding those marks has a
  single writer and it runs in the gossip path, so a member this node learned
  third-party is `up` with no mark at all, and one recorded frame from it
  merges — with the sender a full member throughout and nothing evicted
  anywhere. The cluster-security page in both languages had already withdrawn
  that wording and told the reader in so many words that the changelog and
  roadmap entries said it and were wrong, so the docs pointed at a roadmap
  correction that never landed.

  The roadmap also no longer says #112 waits on #940. #940 landed
  `NodeAddress.incarnation` as an optional field and deliberately did not act
  on it, because a refusal keyed on an optional field is one an attacker opts
  out of by stripping it while a legitimate older peer walks into it. The
  issue that gates a refusal is #823, the wire break that makes the field
  required. `GossipReplayBoundDocumented.test.ts` grows a fourth guarded text
  and a fourth assertion, so both corrections are held by execution rather
  than by review. No behaviour changed; the replay class itself still waits
  on #823.

  Not corrected here, and needing a decision: the `[0.16.0]` entry for #112
  carries the same withdrawn wording ("while its sender is still a member").
  It describes a release that has already shipped, so amending it is a
  different call from fixing a roadmap — raised rather than taken.

- **The gossip replay guard's documented bound is corrected: a recorded
  frame is refused to a receiver that holds a high-water mark for that
  sender, not "while its sender is still a member" (#112).**

  The map that holds those marks has one writer and it runs in the gossip
  path, so a mark exists only for a peer this node has accepted a frame
  from directly. There are three ways to hold none, and only one is the
  sender's eviction: an evicted member's mark is dropped with it, a fresh
  or restarted process starts with none, and a member learned third-party
  never had one. That last case is the ordinary one rather than an edge —
  gossip is epidemic, so a node files C as `up` on B's word and has still
  never seen a frame from C, and one recorded frame from C then merges
  with the sender a full member and nothing evicted anywhere. Both
  remaining cases are now asserted by execution as counterfactuals in
  tests/unit/cluster/GossipReplayGuard.test.ts, and
  tests/unit/cluster/GossipReplayBoundDocumented.test.ts holds the prose
  in `admitsGossipSequence` and on the cluster-security page (both
  languages) to what those tests measure. No behaviour changed: refusing a
  frame from a peer with no mark refuses the first frame from every peer,
  which was measured and is why it is not the missing check. Closing
  either case needs a required incarnation identity on the wire and
  therefore waits on #823; a required incarnation would refuse a recording
  of a previous incarnation outright, while a node downed while still
  running and a first sighting at a receiver holding no earlier
  incarnation of the subject would survive even that.

- **BREAKING — `idempotent` now bounds the whole cache key it composes, not
  just the header half (#607).**

  `maxKeyLength` ran on the `Idempotency-Key` value; the `identity` scope
  was concatenated into the same key four lines later with no check at
  all, and `identity`'s own documented recipe reads a raw client header. A
  request carrying a two-character `Idempotency-Key` and a 64 KiB
  `x-account-id` was accepted with 200 and stored a 64 KiB cache key under
  a middleware whose documented cap is 255 characters. The scope is now
  held to the header's two rules — a length bound and no ASCII control
  character or space — with its own `maxScopeLength` option (default 255)
  so a long tenant id cannot spend an honest client's header budget and
  `maxKeyLength` stays exactly Stripe's published figure. An empty scope
  passes both rules, so a configuration with no `identity` is unchanged.

  *Migration:* An `identity` returning more than 255 characters, or one
  containing a space or control character, now answers 400 instead of
  storing the key; raise `maxScopeLength`, or derive the scope from the
  account id rather than free text such as a display name.

- **Corrected a false absolute claim about the rate limiter (#607).**

  `src/http/cache/RateLimit.ts` and the rate-limit page in both languages
  stated without qualification that a flooding client cannot reset its own
  limit, because `incr` bumps its counter to most-recently-used on every
  request. The premise holds and the conclusion does not: `rateLimit`
  calls `incr` in exactly one place, inside the handler it wraps, so a
  flood that bypasses the limiter never bumps anything. Measured on one
  shared `InMemoryCache({ maxEntries: 4 })`, a client answered 429 by
  `max: 2` was answered 200 again after twenty requests to an `idempotent`
  route the limiter does not wrap. The text now separates the two cases
  and names the measurement, and a new test suite both re-runs the
  reproduction and reads the three files so the unqualified wording cannot
  return silently.

- **The warm-hand-over payload is the one field of the singleton wire
  protocol that reaches user code, so the inbound guard now rejects an
  acknowledgment whose `state` is not a Uint8Array, and rejects the whole
  frame rather than stripping the field. Unknown wire kinds pass validation
  by design and the cluster wire carries no credential, so a peer that puts
  something else there is a peer to disbelieve rather than a frame to
  sanitise. The snapshot only reaches the hook from a socket-authenticated
  peer that this node itself asked to stand down, and its size is bounded
  before it is decoded. (#194).**

- **The known limitation that Bun's built-in `ws` shim accepts `maxPayload`
  and enforces nothing is now test-bound instead of documented only
  (#373).**

  Two cases assert positively that an oversize frame never reaches the
  application on Express. They no longer pin *which* layer refused it: the
  `client` branch of that expectation was guarded on
  `detectRuntime() !== 'bun'` while the file only ever runs under
  `bun test`, so it asserted nothing while reading as evidence. It was
  removed later in this same release cycle, and the runtime is now an
  asserted premise followed by the one outcome it implies. Measured on this
  tree: Bun 1.3.1
  stores both `maxPayload` and Bun's own `maxPayloadLength`, reads both
  back unchanged, and delivers a 4096-byte frame against a 1024-byte cap
  to the handler without closing, while Node 26.7.0 with `ws` 8.20.0
  refuses the same frame with `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` and
  1009. The real package cannot be reached on Bun as a workaround — the
  specifier is shadowed and `ws`'s own `exports` field blocks its
  subpaths. Pinning the outcome makes these a canary on the peer rather
  than an endorsement: the day Bun's shim honours `maxPayload`,
  `initiatedBy` becomes `'client'` and the test goes red, which is the
  signal to lift the caveat in the WebSocket docs.

- **A cluster singleton hand-over request is honoured only from the peer
  address the transport authenticated, carried to the manager inside an
  `AuthenticatedSingletonMessage` — a class, so `instanceof` is proof the
  frame came through the per-path handler and not out of a payload a peer
  chose. A node that believes it hosts additionally stands down only for a
  peer that sorts before it under the shared election rule. Without both, a
  request that stops the singleton would be a remote kill switch available
  to anyone who can reach the cluster, which is the shape #584 leaves open
  in `ShardRegion` on a wire that carries no credential (#964). (#949).**

- **A captured gossip frame can no longer be replayed by rewriting one field
  (#940).**

  The per-sender frame counter admitted any `sequence` above its
  high-water mark, and only refused to *adopt* an implausible one as the
  new mark — so a frame restamped `Number.MAX_SAFE_INTEGER` merged, left
  the mark untouched, and therefore merged again on every delivery,
  without limit, against a receiver holding a mark for a sender that was
  still alive. That is the one configuration the guard was claimed to hold
  in. Only the `sequence` is fabricated in the attack; the `members` array
  is still the recording, and nothing on the cluster wire binds the two
  together. The plausibility bound moves from "do not adopt" to "do not
  admit", so a frame whose sequence is not a finite number within
  `maxVersionSkewMs` of the receiver's clock is now dropped whole.
  Refusing it loses nothing: the mark stays where the last plausible frame
  put it, so the real node's next frame still out-numbers it and still
  merges — the pinning exploit closed on `version` in #114 is not
  reintroduced one field to the left. `reason="replayed-frame"` on
  `cluster_gossip_records_refused_total` now also covers this case.

- **A `PriorityMailbox` whose `priorityFor` cannot rank a message no longer
  inserts it at the head of the queue (#733).**

  `undefined`, `NaN`, `null` and a non-number all compared `false` against
  every queued priority under both `<` and `===`, so the arrival landed in
  the highest-priority slot — inverting the ordering the class documents —
  and the `sequence` tie-break broke the same way, so FIFO was lost among
  the unrankable messages too. Such a message is now ranked last and keeps
  FIFO among its peers. No attacker or malformed traffic is needed to
  reach this: `NaN` comes out of a fully type-correct `(m) =>
  Number(m.priority)`, and `ref.stop()` posts `PoisonPill` as a user
  message with no own fields, so the field-derived `priorityFor` the docs
  recommend silently discarded the entire queued backlog instead of
  draining it. The #647 bound made it worse rather than better, since the
  arrival head-inserted and the eviction pops the tail: a full mailbox
  lost its whole legitimate backlog to a burst of unrankable messages,
  each eviction reported as an ordinary `drop-head`.

- **A `priorityFor` that throws is now contained by the mailbox instead of
  propagating into the stack of whichever actor called `tell` (#733).**

  The sender is a bystander to the receiver's mailbox configuration, so
  the escape restarted the wrong actor under its own supervisor — the same
  shape that ruled `reject` out as the framework's default overflow
  policy. The message is kept at the lowest priority rather than dropped,
  and this covers all three routes into the priority insertion, including
  the `enqueueSignal` path that carries a lifecycle notification the
  framework cannot send twice.

- **InMemoryCache no longer hands a live lock out twice under a cache-key
  flood (#1080).**

  At the default configuration — maxEntries 10 000 — one acquireLock lock
  with a 60 s TTL followed by 10 000 distinct set calls through the same
  instance let the next acquireLock succeed while the first holder still
  believed it held the lock, and the original holder's release() returned
  false, which the documentation read as "the critical section ran longer
  than its TTL". Eviction now drains entries that carry no guarantee
  before it touches one that does, so the same flood also stops resetting
  another client's rate-limit counter and stops dropping a completed
  idempotency record inside its TTL — the two victims the shared-cache
  hardening documented but could not prevent (#607).

- **BREAKING — A delivery that carries no MDC now runs under a cleared
  context instead of inheriting whatever AsyncLocalStorage store happened to
  be ambient in the timer, socket callback or dispatcher tick that woke the
  actor (#718).**

  The leak was wider than a logging annoyance: LocalActorRef.tell
  re-snapshots the context it runs under, so a handler running under an
  inherited context forwarded another request's identifiers to whoever it
  messaged next, and RemoteActorRef.tell carried them across the cluster
  wire. It needed no timer either - up to `throughput` envelopes share one
  dispatcher turn, so a plain tell from a context-free scope landing in
  the same batch as a correlated one was delivered under that correlation
  id; run()'s finally re-schedules from inside the poisoned store, so one
  correlated message followed by forty bare ones came back forty-one out
  of forty-one poisoned; and ThroughputDispatcher arms one setImmediate
  for a queue holding several actors' turns, so a second actor's
  context-free delivery observed the first actor's tenant. Three seams now
  clear: ActorCell wraps each dispatcher turn, Scheduler fires every
  schedule cleared (covering both message forms and both bare-function
  forms, which never reach an ActorCell at all), and Cluster dispatches a
  context-less inbound frame cleared. ManualScheduler in the testkit does
  the same, so the double cannot hide a regression. A ReceiveTimeout is
  the part with no user-side remedy - the framework arms that timer after
  every message, so there was no call site at which an application could
  have cleared it.

  *Migration:* preStart / postStop, a context.timers tick and any
  Scheduler schedule no longer inherit the MDC of the request that spawned
  or armed them; pass a correlation id as data (constructor argument or
  first message), or capture LogContext.snapshot() at arm time and reopen
  it in the handler.

- **DynamoDB journal and snapshot reads that a sequence-number decision or a
  recovery depends on now set ConsistentRead: true (#736).**

  Previously only the durable-state store and the journal's compaction
  mark asked for strong consistency, while the head Query fourteen lines
  above that mark in the same function did not -- so a lagging read
  replica made an intact stream look rewound and the framework misreported
  it. Concretely: a stale head failed the next persist's expectedSeq
  compare, which PersistentActor routes to onSecondWriterDetected,
  clearing the lease flag and stopping the entity while logging that
  another live instance owns it; a stale replay page truncated history
  undetectably, because the replay integrity checks see holes, ordering
  and window bounds but nothing states where a stream should end, leaving
  the actor recovering onto superseded state; delete collected its doomed
  keys weakly and then raised the compaction mark over the whole range
  regardless, leaving events alive below a mark that said they were gone;
  and the snapshot store had four reads and no strong one, so once the
  journal was compacted past the newest snapshot a stale loadLatest folded
  from a point the surviving events no longer adjoin and recovery aborted
  with JournalIntegrityError over a perfectly intact store. Strong now:
  read, the head read inside readHead, delete's doomed-key query,
  loadLatest and loadBefore. Deliberately left eventually consistent, with
  the reasoning in the code: persistenceIds' full-table scan, and the
  snapshot store's prune and delete key queries, where a stale read can
  only under-delete.

- **A WebSocket hub given an explicit mailbox capacity can no longer lose
  the command that spawns a connection's actor (#717).**

  The precondition matters and is not the default: since #1148 the default
  mailbox is unbounded, so nothing is evicted from a hub nobody bounded,
  and #570 made the pre-attach socket buffer replay close and error, so a
  client that gives up inside the setup window unwinds its own tracker
  entry and admission slot. The permanently orphaned socket the original
  report describes is not reachable in a stock deployment. What was
  reachable was the configured case, and every policy destroyed the
  command in its own way: drop-head evicted it once roughly capacity
  further frames pushed it back to the head, drop-new discarded it on
  arrival, reject threw MailboxFullError out of hub.tell on the backend's
  un-guarded upgrade stack, a caller's PriorityMailbox with
  drop-lowest-priority shed it, and a hub's own throttle with onExcess
  'drop' consumed it. Since the command carries the only reference to a
  socket whose handshake already completed, and nothing retries, losing it
  cost a socket rather than a message: no listeners attached, inbound
  frames accumulating unread, and its maxConnections slot held until the
  client gave up. It now travels the lane #729 opened for a death-watch
  Terminated — queued at the tail of the user lane as before, so frame
  ordering is unchanged, but exempt from every load-shedding policy.

- **BREAKING — A cluster member could permanently suppress another replica's
  replicated events (#706).**

  ReplicatedEventSourcedActor identified an event cluster-wide by
  `${replica}#${seqAtReplica}`, both halves taken from the broadcast
  payload, and `seqAtReplica` is a plain counter — so a peer computed a
  victim's future identities by arithmetic rather than search. A
  deduplication hit means silently discard, so pre-claiming `victim#42`
  made every other replica drop the victim's genuine 42nd event, and the
  suppression survived a restart twice over: the forgery is appended to
  the receiver's journal and re-absorbed on replay, and the identity set
  is serialised into every snapshot. The envelope now carries an `eventId`
  minted from 96 bits of entropy at persist time, and deduplication keys
  on that. Same remedy as #722 took for the structurally identical ORSet
  tombstone pre-claim; `seqAtReplica` remains on the envelope only as the
  last tie-break in the canonical order.

  *Migration:* ReplicatedEventEnvelope gains a required `eventId`,
  changing both the wire and on-disk format. Envelopes already on a node's
  own journal or snapshot still recover and still deduplicate on the old
  key, so no history is lost — but a peer that does not send an `eventId`
  is refused, so replicas must be upgraded together; a mixed-version
  cluster loses cross-replica delivery (logged at WARN) until every node
  is on the new version.

- **A replicated event envelope arriving from a peer is now validated whole
  before any state is touched, and a failure drops that one envelope with a
  WARN naming the field instead of failing the actor (#706).**

  Previously `_absorb` added the deduplication key, spliced the event into
  the history and refolded state, and only then died inside
  `VectorClock.fromData` — so a three-field message with no vector clock
  was a repeatable one-message actor crash from any member that also left
  the in-memory history holding an event no journal had. Checked now:
  `replica` and `eventId` bounded non-empty strings, `seqAtReplica` a
  positive safe integer, `timestamp` finite, and the vector clock a plain
  object of bounded entry count whose components are finite and
  non-negative.

- **The canonical event history of a ReplicatedEventSourcedActor is now
  bounded by the new `maxObservedEvents()` hook, default 100 000 (#706).**

  There is no compaction yet (#535) and every accepted remote envelope
  also costs a journal write and a deduplication entry, so one member
  could grow another's memory, disk and refold cost without limit. At the
  ceiling remote envelopes are refused rather than evicted — dropping
  history changes the fold and dropping identities reopens double-apply —
  with one WARN rather than one per envelope, so the log is not the next
  unbounded resource. Local persist calls are never refused.

- **BREAKING — An event or snapshot adapter built by
  InMemorySchemaRegistry.eventAdapter(manifest) / snapshotAdapter(manifest)
  now reads only that manifest (#737).**

  Previously fromJournal resolved the codec, the latest version and every
  upcaster from stored.manifest alone and never compared it to the
  manifest the adapter was built for, so a journal row tagged with any
  other manifest registered in the same registry decoded cleanly and was
  returned as the requested type — type confusion on the replay path
  (CWE-843) that the caller could not detect, since the payload validates
  against the foreign codec and the static type claims it got what it
  asked for. A mismatch now raises MigrationError ("manifest mismatch:
  schema-registry adapter is for 'X', got 'Y'"), matching
  MigrationChain.upcast and defaultsAdapter, which have always refused
  that frame, and serializerCodec's serializerId check one layer down. The
  realistic trigger is a mis-wiring rather than an attacker — the manifest
  strings of eventAdapter and snapshotAdapter swapped, or the argument
  changed between deploys while old rows still carry the old value — since
  the registry's own write path can never emit a foreign manifest. On a
  recovery path the refusal surfaces through onRecoveryFailure instead of
  folding a foreign event into state.

  *Migration:* A journal stream whose _t values were written by something
  other than a registry adapter (e.g. wrapEventAsEnvelope with a per-event
  manifestFor) no longer replays through a single registry-built adapter;
  write a fromJournal that switches on stored.manifest and delegates per
  type, as MigrationChain already required for a multi-type journal.

- **IpAllowlist no longer documents an x-forwarded-for extractor that reads
  the leftmost, client-controlled entry (#715).**

  This was a guidance defect, not a live vulnerability: the shipped
  default reads the socket peer and fails closed, and Fastify's base `ip`
  getter is the socket peer without trustProxy, so nothing was exploitable
  unless an operator copied the snippet out of the project's own
  documentation. The premise that made it look safe was untrue — NGINX's
  $proxy_add_x_forwarded_for, AWS ALB's default xff_header_processing and
  Cloudflare all append the connecting peer rather than replacing the
  inbound header, so in exactly the deployment the recipe was written for
  its first entry is whatever the caller typed. The same value was
  reachable a second way the report never named: `app.set('trust proxy',
  true)` on Express and `trustProxy: true` on Fastify compile to a
  trust-everything function, so proxy-addr never truncates the address
  list and returns that leftmost entry byte for byte. Six pages in each
  language, five src JSDoc blocks and two test fixtures carried one or the
  other; all now describe trust-by-address, and the Express and Fastify
  backend pages carry an explicit warning against the `true` form.

- **A death-watch `Terminated` can no longer be discarded on its way to the
  watcher (#729).**

  It now takes `Mailbox.enqueueSignal` — the tail of the user queue,
  exempt from whatever bound the mailbox enforces — and carries
  `Envelope.undroppable`, which `Mailbox.removeOldest` steps over so a
  later eviction cannot reach it either. Both halves were needed: queueing
  it exempt is not enough when `drop-head` evicts the oldest message and
  the notification becomes the oldest after enough newer arrivals. This
  bites a mailbox you gave a capacity, not the default one: since the
  default mailbox became unbounded again there was no default-reachable
  path, but opting into a bound was silently opting into losing lifecycle
  signals, and all four policies destroyed the notification in their own
  way — `drop-head` evicted it after it was safely queued, `drop-new`
  discarded it on arrival, `drop-lowest-priority` shed it as least
  important, and `reject` threw. A notification that genuinely cannot be
  queued — the watcher has already stopped, or its own `Mailbox` subclass
  refuses it — now becomes a dead letter instead of vanishing, so the loss
  is observable. Every consumer built on the notification was affected
  while it was not: `BackoffSupervisor`'s respawn, `Router`'s routee
  pruning, `ShardRegion`, `ClusterSingletonManager`, `Shard` and
  `GracefulStop` all stall on a death they never hear about.

- **An uncaught throw, an unhandled rejection, or a bootstrap that fails to
  load inside a worker no longer kills the host process (#700).**

  The runtime worker abstraction gained an `error` event that both
  backends subscribe, so the failure reaches `restartPolicy` instead of
  the host's own crash path. Measured before the fix: Node re-raised the
  worker's error via `process.nextTick` and never fired `exit`, so the
  restart path was never reached, and Deno rejected an internal promise —
  both exited 1, and only Bun contained the throw. On Deno a bare listener
  is not enough, so the Web adapter now cancels the event; the parent-side
  `Worker` there emits no `close` at all, which is why restarts on Deno
  are error-driven only. Close and error share one per-worker latch,
  because Node and Bun emit both for a single throw and routing the new
  event into the existing path would respawn twice per crash. An error
  arriving before `worker-ready` now rejects the handshake immediately
  instead of burning the full `readyTimeoutMs`. A new cross-runtime smoke
  case covers it on Bun, Node and Deno, which is the only place either
  claim can be proven — no un-quarantined unit test spawns an OS thread.

- **One malformed `worker-transport` frame from a worker no longer
  terminates the host (#701).**

  `WorkerBroker.onMessage` took its argument as a validated envelope and
  read `to` straight into `NodeAddress.fromJSON`; it now takes the frame
  as unknown, checks the `to` and `from` addresses, and drops what does
  not clear the check, with a try/catch behind it. Five shapes each exited
  the host 1 before this, and only two of them threw the documented
  `TypeError` — a missing or null `to` throws a plain `Error` from
  `fromJSON` instead. Note the direction of travel: hardening `fromJSON`
  to throw made this path worse, not better. A frame carrying `to.port` as
  a string used to construct an address and be routed or dropped as an
  unknown destination, and became fatal once the validator threw, because
  a throwing validator is right behind a frame guard and wrong in front of
  a bare call site. Malformed frames are dropped without a log line: the
  broker has no logger, and the frame's `payload` is still validated by
  the receiving transport rather than here.

- **A replacement worker that misses its handshake deadline no longer
  terminates the host as an unhandled rejection (#702).**

  The respawn was a discarded promise with no handler; it is now a handled
  call that reports the failure and asks the slot's restart budget for
  another attempt, so a permanently broken bootstrap degrades the mesh by
  one worker and then stops instead of looping. There is no supervisor
  above the worker mesh to escalate to — `WorkerCluster` is a
  static-constructed plain object, not an actor — so the report follows
  the dispatcher's precedent of a prefixed `console.error`.

- **BREAKING — Worker threads no longer outlive the failure that dropped
  them (#735).**

  A handshake that times out terminates its own worker before rejecting; a
  partial `spawn()` failure tears down every sibling that did come up,
  including ones still mid-handshake, since the instance that owns them is
  never returned; a respawn suspended across shutdown is cleaned up
  instead of registering into a closed broker; and `terminate()` now waits
  for the threads rather than firing and forgetting. Adding an `await` was
  not the fix: only Node returns something awaitable, so the completion
  wait moved into the runtime adapters, where the Web adapter registers
  its close listener before the native call and caps the wait at 250 ms
  because Deno emits no completion signal at all — treat Deno shutdown as
  best-effort, not confirmed. `WorkerBroker.register` also refuses
  registration after `close()`, which previously repopulated the port map
  permanently with an inert port that kept its worker alive for the
  process lifetime.

  *Migration:* `WorkerLike.terminate()` now returns `Promise<void>`
  instead of `void | Promise<number>`; a custom `WorkerBackend` must
  return a promise that resolves when the thread is gone, or
  `Promise.resolve()` where the runtime cannot say.

- **BREAKING — A `ProducerController` now stamps a crypto-random
  per-incarnation token on every `Delivery`, and the `ConsumerController`
  keys its deduplication state on `(producerId, incarnation)` rather than on
  `producerId` alone (#726).**

  Before this, a restarted or re-created producer numbered from 1 again
  while its configured `producerId` survived unchanged, so the consumer
  matched the whole post-restart prefix against a deduplication window
  that was still live, absorbed those messages as duplicates before the
  handler ran, answered each with an ordinary acknowledgment, and drove
  the caller's `confirm(null)` — reporting messages as successfully
  delivered that the handler never saw. It needed no crash and no
  attacker: two sequential `ReliableDelivery.producer(...)` calls with the
  same `producerId` against one surviving consumer reproduced it. A new
  incarnation replaces the deduplication entry for its `producerId` rather
  than adding one, so the map stays at one entry per producer; the cost is
  that a straggling delivery from the outgoing incarnation resets the
  window again, so a few already-handled sequence numbers may run twice
  around a changeover — an at-least-once duplicate, which the protocol
  declares tolerable, where absorbing the whole prefix was not bounded at
  all.

  *Migration:* `Delivery` gains a required `incarnation` field: code that
  builds a `Delivery` envelope by hand (a relay that reconstructs rather
  than forwards, a hand-rolled sender) must supply it.

- **BREAKING — `ProducerController.onAcknowledgment` now requires the
  acknowledgment to echo the producer's own incarnation token before it acts
  on it (#730).**

  It previously authenticated an acknowledgment by comparing the payload's
  own `producerId` against its id, and both that and `seq` are enumerable
  — so anything able to address the producer could cancel the retransmit
  and fire the caller's `confirm(null)`, silently downgrading the stream
  from at-least-once to at-most-once while reporting success. The check is
  deliberately not on the envelope sender, which is `None` for every
  acknowledgment the producer will ever see because both the consumer and
  the cluster's envelope dispatch tell with a single argument, and not
  against `options.consumer`, which the documented relay topology makes a
  forwarder rather than the acker; with no channel identity available the
  identity has to travel in the message. It also rejects a straggling
  acknowledgment from the previous incarnation of the same `producerId`,
  which would otherwise settle whatever the new incarnation had parked
  under that sequence number.

  *Migration:* `Acknowledgment` gains a required `incarnation` field: a
  test double or hand-rolled consumer that acknowledges manually must
  carry it through from the `Delivery` it is answering, or the producer
  will ignore the acknowledgment and keep retransmitting.

- **The `ConsumerController` now admits a `Delivery` envelope before using
  any of its fields, and dead-letters one that fails: a missing or non-ref
  `replyTo`, a `seq` that is not a positive safe integer, or an empty or
  over-long `producerId` or `incarnation`. Every one of those fields is
  declared non-optional on the public type, which is exactly why nothing
  guarded them — a wire body that omits `replyTo` satisfies the type at
  compile time and dereferences to `undefined` at run time, and because the
  handling runs on a promise detached from `onReceive` that `TypeError`
  settled as a rejection nothing was watching and exited the process on Bun,
  Node and Deno alike. A refusal is a dead letter rather than an actor fault
  on purpose: faulting would restart the consumer, and the deduplication map
  is a field initialiser, so one malformed message would cost duplicate
  suppression for every healthy producer on the node and then loop as the
  retransmit arrived. Sending the acknowledgment is guarded for the same
  reason — an acknowledgment is best-effort by design, so losing one costs a
  retransmit, which is the mechanism the protocol already has. The
  producer-side options validator now enforces the same identifier bound the
  consumer admits, so a `producerId` the consumer would refuse fails at
  construction instead of silently dead-lettering every delivery. (#727).**

- **A broker connection could outlive the actor that owned it, with no
  reference through which anything could close it, and — for MQTT — re-issue
  every remembered SUBSCRIBE, so a terminated actor stayed a fully
  subscribed consumer feeding dead letters. The failure path was worse: a
  dead actor kept opening real connections to the broker on every backoff
  window until the whole ActorSystem terminated. Both are now closed by an
  explicit liveness check on every path out of a connect attempt. (#708).**

- **A ShardCoordinator now derives a region's identity from the
  authenticated connection instead of the payload (#712).**

  Every coordinator-inbound sharding kind is a claim about the sender's
  own node, and the coordinator read all of it out of the frame: its only
  gate was "am I the leader (and do I hold the lease)", never "may this
  sender speak for that region". One well-formed sharding.Register naming
  another node's address seized every shard of a type and redirected
  honest regions' entity traffic to an attacker-chosen host; one
  sharding.RegionTerminated evicted a region, and because that path sends
  no HandOff the victim kept its shard actors and entities running,
  leaving two owners for one live shard — the same entity id instantiated
  twice and, for a persistent entity, two writers on one persistenceId.
  The coordinator now claims its own well-known path on the envelope
  router, requires each frame to arrive inside the
  AuthenticatedShardingMessage wrapper that a JSON wire body cannot mint
  (which also covers the non-canonical-to bypass, where a trailing slash
  misses the handler lookup and the actor tree delivers unwrapped), and
  requires the address the payload names to be the peer's own. Under mTLS
  the peer is certificate-backed, so the comparison is authentication; on
  a plaintext cluster it stops a member speaking for another member.
  Mirrors the region-side origin gate from #584, which does not blunt this
  on its own because the attacker never sends a ShardHome — it poisons the
  coordinator's map and the genuine coordinator emits the redirect itself.
  A side effect: a numShards mismatch can no longer park another node's
  region key in refusedRegions and mute its GetShardHome answers for the
  rest of the leader term.

- **A region's hostedShards claim is validated against the shard range and
  capped (#712).**

  It was the only caller-sized input the coordinator had — onRegister
  wrote an allocation entry per array element with no range check and no
  length cap, into state that is broadcast to every region and persisted
  to coordinatorStateStore, so one frame could plant millions of
  out-of-range ids and the growth survived restarts. Entries outside
  0..numShards-1 are dropped, duplicates collapse, and the accepted set
  cannot exceed numShards. This is the bound-and-cap half of #948's third
  proposal; the live-owner conflict check, the previous-owner
  RegionInfo.shards cleanup and the region-side give-up-when-downed remain
  open there.

- **A `ShardRegion` now honours a coordinator directive only when the
  authenticated peer that sent it is the node hosting the coordinator
  (#584).**

  The region treated any message whose `kind` started with `sharding.` as
  a framework directive, with no notion of who sent it. Five of those
  kinds are things only the coordinator may say: `HandOff` marks a shard
  `handing-off`, forgets its entities and stops the shard actor —
  terminating every entity under it; `ShardHome` moves ownership;
  `RememberedEntities` pre-creates entities; `RegisterAcknowledgment`
  settles the register loop; `ShardMapUpdate` publishes an allocation map
  to every local subscriber, DevTools panel and application listener
  included. One well-formed frame from anyone who had completed the
  cluster `hello` did any of them, repeatably.

  The region could not have checked. Sharding registered no per-path
  envelope handler, so an inbound frame reached the actor through generic
  path resolution, which delivers with no sender at all — the
  authenticated peer the transport knows was discarded one frame short of
  the actor that needed it. The region now claims its own path on the
  envelope router, which hands the handler the connection's peer, and
  re-enqueues the frame wrapped in a class instance. The wrapper is
  deliberately a class and not a `{ kind }` tag: a wire body is always
  plain JSON, so `instanceof` is proof the frame came through the router
  rather than out of an attacker's payload, which a tagged object could
  reproduce verbatim.

  Both halves of the check are load-bearing. Without the wrapper test, a
  non-canonically addressed frame — a trailing slash, a doubled separator
  — misses the exact-string handler lookup, still resolves to the same
  region through the actor tree, and arrives unwrapped. Without the origin
  test, an authenticated peer is merely some cluster member.
  `ShardCoordinator.replyTo` builds the same wrapper on its local leg,
  which is what keeps a single-node rebalance working; a bare local
  `ref.tell` is byte-identical to what an attacker's frame produces after
  the tree walk, so exempting it would have undone the fix. Refused frames
  are dropped and logged at `WARN` instead of the previous silent no-op,
  and `onHandOff` picks up the out-of-range shard-id check `onShardHome`
  has had since #569.

  This is authorization, not authentication: on a cluster without peer
  certificates any party that can reach the port can become a member and
  then the leader. Run mTLS if the network is not fully trusted.

- **BREAKING — Object-storage bodies are now bound to the storage key they
  live at, and a durable-state revision cannot silently go backwards
  (#612).**

  Neither authenticator said anything about *where* a body lived.
  AES-GCM's tag proves the holder of the subkey produced this ciphertext;
  the HMAC proves the holder of the integrity key produced these framed
  bytes. Both cover the bytes and stop there, so an attacker with bucket
  write access could take an authentic body and replay it somewhere else.
  The unencrypted-plus-HMAC configuration was the sharp end, and it is the
  documented one: `integrityKey` is a single flat deployment-wide secret
  with no per-`persistenceId` derivation, and `load` returns the
  *requested* pid with the *body's* state — so one account's object copied
  onto another account's key came back as that other account's state, with
  every check in the frame satisfied. Client-side encryption narrowed this
  without closing it, because HKDF salts the subkey with the pid: that
  separates two pids but not two objects of one pid, leaving a snapshot
  replayable onto a different sequence number of the same actor.

  The storage key now goes into `subtle.encrypt`/`decrypt` as
  `additionalData` and, length-prefixed, ahead of the framed bytes in the
  HMAC input. A new manifest flag at bit5, `FLAG_CONTEXT_BOUND`, records
  that it was done, and bodies written before this keep decoding — the
  same backwards-compatible flag migration `FLAG_KEY_VERSIONED` (#8) and
  `FLAG_INTEGRITY_HMAC` (#116) already made. That tolerance is also the
  remaining gap, since bit5 is a manifest byte like any other: until
  unbound bodies stop being accepted, one authentic pre-binding body is a
  replay token for every key in the bucket. `requireContextBinding` on
  both object-storage stores (and on the plugin) closes it, mirroring how
  #579 made the integrity tag mandatory. It is off by default because an
  existing bucket is full of unbound bodies; `reEncryptObjectStorage` now
  rewrites those even when their key version is already active, so a sweep
  is what earns the right to turn it on.

  Binding the key cannot catch the same-pid rollback, and binding the
  revision would not either — the revision already sits inside the sealed
  payload, and `load` has no expected revision to check it against. An
  authentic *older* body replayed over a newer one is a valid body in
  every respect except that it is stale, and an ordinary actor restart was
  enough to make the store adopt it. `ObjectStorageDurableStateStore`
  therefore keeps an in-process floor of the highest revision it has seen
  per `persistenceId` and refuses to go below it
  (`rejectRevisionRollback`, on by default). The floor lives in its own
  map rather than in the ETag cache: that cache is deliberately dropped on
  a CAS rejection (#117), which an attacker can provoke, and a floor that
  evaporated with it would protect nothing.

  The encryption threat table stopped claiming client-side encryption
  covers "account compromise" unqualified. Someone who can write to the
  bucket is a different attacker from one who can only read it, and the
  row is now split accordingly.

  *Migration:* Two things change behaviour without any code edit. First,
  bodies written by this version carry a binding when encryption or
  integrity is configured, and a reader from an earlier release cannot
  decode them — finish a rolling upgrade of readers before writers, or
  accept a window in which old nodes cannot read new bodies. Second,
  `rejectRevisionRollback` defaults to `true`, so a durable-state `load`
  that returns a lower revision than this process has already seen now
  throws instead of succeeding; this only fires when another writer
  legitimately deletes and recreates a record in the same bucket (a delete
  through this store drops its own floor), and
  `withRejectRevisionRollback(false)` opts out. To harden further, rewrite
  the corpus so every body carries a binding — a `load` + `upsert` per
  `persistenceId` for durable state, `keepN` pruning for snapshots, or
  `reEncryptObjectStorage` for a bucket that is mid-rotation — and only
  then set `withRequireContextBinding()`; turning it on over unbound
  bodies makes reads fail. Note that the binding covers the whole storage
  key including `prefix`, so changing a store's `prefix` after the fact
  breaks verification exactly the way changing the HKDF `info` does.

- **BREAKING — A WebSocket route's transport frame cap is now the cap you
  configured, in both directions (#373).**

  Every backend has installed a transport-level payload limit since the
  WS-3 fix — `maxPayload` on the `ws` server for Express and Fastify,
  `maxPayloadLength` or `@hono/node-ws` for Hono — and every one of them
  installed the framework's 1 MiB default, because the route policy was
  resolved inside the `websocket()` closure on the first connection and a
  backend binds before that. The configured cap therefore governed what
  the connection actor accepted and not what the process buffered first.

  Both directions were wrong, and the one the issue did not mention is the
  one that mattered for memory: an operator who lowered
  `actor-ts.http.websocket.maxFrameBytes` to 64 KiB still got a 1 MiB
  buffering window, which is exactly the allocation amplification the cap
  exists to prevent. The other direction was the visible one — raising
  `maxFrameBytes` above 1 MiB left frames between the two silently cut off
  by the runtime.

  The route now carries a memoised `resolvePolicy(system)` through
  compilation to `HttpExtension.bind`, the one place holding both the
  routes and the `ActorSystem`, and the resolved `maxFrameBytes` reaches
  the backend on the registration. Because a server has a single transport
  shared by all of its WebSocket routes — one `WebSocketServer` on
  Express, one plugin registration on Fastify, one `Bun.serve` — the
  backends install the widest cap any registered route resolved to. A
  stricter route is unaffected in what it accepts, since the connection
  actor still refuses its oversize frames; it simply does not get a
  narrower socket than a permissive sibling. On Deno the first layer still
  does not exist at all: `Deno.upgradeWebSocket` has no payload option, so
  there an oversize frame is buffered first and rejected second,
  unchanged.

  *Migration:* Three things can be observed. A route or HOCON setting that
  *lowers* `maxFrameBytes` now narrows the transport window too, so an
  oversize frame is refused by the runtime rather than by the connection
  actor — on `ws` (Express, Fastify, Hono on Node) the peer still sees a
  clean `1009`, but Bun drops the connection and the client synthesises
  `1006`, so a client that switches on `1009` alone should accept both.
  `WebsocketRouteRegistration` gains a required `maxFrameBytes` and the
  `websocket` node of `Route` gains a required `resolvePolicy`, so a
  third-party backend or a test double that *constructs* either shape by
  hand needs the new field; backends that only read a registration are
  unaffected. And an `OptionsError` from a malformed WebSocket policy (a
  bad HOCON enum, a non-positive byte cap) now throws from `bind()`
  instead of from the first upgrade.

- **Security scanning and a security policy: CodeQL, an advisory gate over
  `bun.lock`, a CycloneDX SBOM from v0.17.0 onward, and a
  `SECURITY.md` that names a channel (#539).**

  The repository had never been statically analysed once —
  `code-scanning/alerts` answered 404 "no analysis found" — and had no
  security policy, while the security issue template told reporters to
  "first check the project's security policy in `SECURITY.md` (or, if
  absent, contact the maintainer privately)". Both halves of that sentence
  pointed nowhere: the file had never existed in the history, and no
  private channel was named anywhere. Anyone following the instruction
  either disclosed in public or gave up.

  `SECURITY.md` now names GitHub private vulnerability reporting as the
  channel, with a fallback that works even before that repository setting
  is enabled: a content-free `[Security]` placeholder asking for a private
  channel, which discloses nothing. It also writes down the scope
  boundary, which is the part a generic policy cannot carry — the cluster
  transport ships as plain TCP without peer authentication **on purpose**,
  documented next to the TLS recipe, so a report of that default is not a
  vulnerability, while a documented mitigation that fails to deliver what
  it promises is one. The issue template drops the hedge and links the
  policy.

  `codeql.yml` analyses the whole repository on pull requests, on pushes
  to `main` and `develop`, and weekly — weekly because CodeQL ships new
  queries continuously, so a file that was clean when it was written can
  be flagged months later with nobody having touched it. It started on
  the default high-precision query suite rather than `security-extended`,
  because the first analysis of a codebase this size produces an unknown
  number of alerts and each one has to be fixed or dismissed with a
  recorded reason before the baseline means anything. That baseline came
  back clean — nine alerts, eight fixed and one dismissed, none open — so
  #1297 widened the suite to `security-extended`. Not to
  `security-and-quality`: its extra queries are maintainability findings,
  which `knip` and `typecheck:dev` already gate, and routing those through
  the code-scanning alert list would dilute the list `SECURITY.md` points
  a reporter at.

  The advisory gate is `bun audit` rather than
  `actions/dependency-review-action`, and the difference is not stylistic.
  GitHub's dependency graph does not resolve this repository's root Bun
  lockfile — it records `fastify ^5.10.0`, the unresolved range out of
  package.json, and carries no `find-my-way` entry at all while `bun.lock`
  pins 9.6.0. That is why every Dependabot alert this repository has ever
  raised comes from the npm lockfiles under `examples/` and none from the
  shipped closure. `bun run lint:audit` reads the lockfile directly and
  gates `package-health.yml`, on the existing triggers plus a weekly cron,
  because an advisory is published upstream against a lockfile that did
  not change. It ships baselined: the eleven high advisories already
  present are suppressed by ID and listed in `SECURITY.md`, with a test
  that fails if the two sets drift apart, so the gate is green from its
  first run and still fails on everything new.

  The release pipeline now builds a CycloneDX SBOM and attaches it to the
  GitHub Release. The two jobs landed after v0.16.0 had already been
  published, so the first release to carry the asset is the next one;
  v0.16.0 and everything before it have none. `--provenance` already
  answered who built a tarball; the SBOM answers what is inside
  it, so "is release X affected by advisory Y" no longer requires
  reconstructing the closure by hand. It is generated in its own job and
  uploaded from a second one, because a job that can push to the
  repository must not also run the postinstall scripts of the entire
  dependency tree, and the scan is narrowed to what the package actually
  ships — otherwise the ten manifests under `docs/`, `tests/` and the
  example front-ends would land in the document as though they shipped.

- **The outbound `HttpClient` bounds can no longer be disabled from the
  caller's side, and no longer break the D1 journal (#602).**

  Every bound the client enforces is enforced by a comparison, and a `NaN`
  loses a comparison without complaining. Only the client-wide settings
  were validated, at construction; a request's own overrides went straight
  to those comparisons. So a `timeoutMs` of `NaN` or a negative number
  made `timeoutMs > 0` false and armed no timer at all, a
  `maxResponseBytes` of `NaN` or `Infinity` made `total > maxBytes`
  permanently false and let the body buffer without limit, and a
  `maxRedirects` of `NaN` made `hops >= maxRedirects` false and followed a
  hostile chain forever. Each of those is the unbounded call the issue was
  filed about, reached from the caller rather than from the client, and
  none of them needs a typo to arrive — a computed budget such as
  `deadline - Date.now()` gone negative gets there on its own. A request's
  `timeoutMs`, `maxResponseBytes`, `redirect` and `maxRedirects` are now
  checked once per call, before a socket is opened, and an out-of-domain
  value throws `OptionsError` naming the field. The per-request rule set
  is deliberately not the client-wide one and the two must stay apart:
  `timeoutMs: 0` remains the documented way to opt a single call out of
  any deadline, while `defaultTimeoutMs: 0` on a client would disarm every
  call that named no deadline of its own and stays rejected there.

  The same 8 MiB default silently broke the shipped Cloudflare D1 backend.
  `buildD1Client` constructed a bare `new HttpClient()`, so the transport
  inherited a ceiling sized for an untrusted third-party API — while the
  peer here is the operator's own database, reached with the operator's
  own token, returning the operator's own rows. Worse, there is no page to
  truncate: `RelationalJournal.readFrom` selects an actor's entire event
  history in one statement with no `LIMIT`, and this transport is one
  statement per HTTP response, so the ceiling bounded a whole replay. An
  actor whose history had grown past 8 MiB of JSON stopped recovering,
  having recovered fine the day before. `D1Connection` now carries its own
  `maxResponseBytes`, defaulting to 64 MiB and reaching the client
  explicitly, settable on all three D1 option families through the shared
  connection base. It stays a bound rather than becoming unbounded again,
  because the body is still materialised in memory before it is parsed.

  The bounds are also operable at last. `actor-ts.http.client` carries
  `maxResponseBytes`, `defaultTimeoutMs`, `redirect` and `maxRedirects`,
  in naming lockstep with the builder and the fields, applied by
  `HttpExtension` to the system's shared client and to any
  `newClient(...)` that leaves a field unset. Precedence is the project's
  usual one: a request beats the client it was made on, which beats HOCON,
  which beats the built-in defaults. Until now the shared client took the
  built-in numbers and offered no way to change them, so a deployment that
  needed a different ceiling had to abandon the shared client entirely —
  and a ceiling nobody can raise is a ceiling that gets raised by deleting
  it. A `new HttpClient()` built directly, with no system to read config
  from, still gets the built-in numbers.

  One upgrade note that is not a migration but is worth knowing: a caller
  that was passing a computed `timeoutMs` which could go negative, or a
  `maxResponseBytes` of `Infinity`, will now see an `OptionsError` where
  it previously saw an unbounded request succeed. That previous behaviour
  was the defect rather than a supported mode, so nothing is being taken
  away that could have been relied on deliberately.

- **The WebSocket transport frame cap is not enforced on Bun with the
  Express or Fastify backend (#373).**

  The #373 entry above says every backend installs a transport-level
  payload limit - `maxPayload` on the `ws` server for Express and Fastify,
  `maxPayloadLength` or `@hono/node-ws` for Hono. On Bun that is true of
  the call and not of the effect. Both backends hand `maxPayload` to a
  `ws` `WebSocketServer`, and on Bun the `ws` specifier resolves to the
  runtime's built-in shim rather than the npm package: the shim accepts
  the option, reads it back unchanged, and enforces nothing. Measured
  against a 1 MiB cap, a 2 MiB frame reached the handler intact on Bun
  where the identical script on Node refused it at the socket and closed
  1006 server-side, 1009 to the client.

  What still holds everywhere is the guarantee that matters: the
  connection actor refuses an oversize frame on the fully received body,
  before the codec decodes it, with a clean 1009 - so no frame over
  `maxFrameBytes` ever reaches an application actor. What is missing on
  these two pairs is the allocation defence, the reason the transport
  layer was added at all: the frame is buffered in full before it is
  rejected. Hono on Deno was already documented as an exception for the
  same reason; Bun with Express or Fastify is a second one, and a quieter
  one, because setting the cap and reading it back both appear to succeed.

  Bun with the Hono backend is unaffected - it goes through `Bun.serve`'s
  own `maxPayloadLength` and never touches `ws`. For an internet-facing
  endpoint on an affected pair, put a proxy with its own frame limit in
  front of it. Both languages of `http/websocket.mdx` and
  `http/security.mdx` now say so, and state the two layers as a guarantee
  plus an optimisation on top of it rather than two equal checks.

- **URL redaction and path trimming are linear again — a hostile redirect
  could block the event loop for 484 ms (#1198).**

  `redactUrlCredentials` searched for a URL scheme from every start
  position, so a run of scheme characters with no `://` after it cost
  O(n²). It is reached from `HttpClient`'s redirect path, which redacts
  the `Location` header before logging it — and that header is chosen by
  whatever server the caller was pointed at. Measured on Bun: 7 ms at 2
  000 characters, 116 ms at 8 000, 1 790 ms at 32 000, and 484 ms at the
  16 KiB header limit the runtimes actually enforce. On a single-threaded
  runtime, concurrent requests to one hostile endpoint multiply that. It
  now locates `://` and validates the scheme backwards, with no length
  cap, so a 300-character scheme still redacts.

  What gets redacted is unchanged, and that is pinned rather than
  asserted: the suite runs the new implementation and the old pattern over
  20 000 generated inputs and compares byte for byte, 8 826 of which
  actually redact.

  Eight further trailing-run strips became non-backtracking index scans.
  Two of them are also remote-reachable and neither was reported by the
  scanner that prompted this: the decoded remainder of a static-file
  request path, which every request under a static mount passes through
  (385 ms at 16 KiB, now 0.83 ms), and a hostname from a DNS or Kubernetes
  API response.

  *Correction to the issue:* the route-segment regex was filed as a false
  positive on the grounds of being anchored. It is an alternation and only
  the first branch carries the anchor, so a slash run in the middle of a
  segment does scan quadratically — the measurement that cleared it used a
  leading run, which the anchored branch consumes whole. It is fixed
  rather than dismissed.

- **The cheapest way for a remote party to mint stock metric series is
  closed (#745).**

  With `path` removed from `actor_mailbox_dropped_total`, the stock family
  whose label values an attacker could widen most cheaply — by addressing
  distinct sharded entity ids and then overflowing each entity's mailbox —
  no longer carries them. Each such entity previously contributed one
  permanent child series that survived the entity's own passivation,
  costing heap for the life of the process and scrape size on every
  collection.

  It is not the only family an entity id can reach. `actor_mailbox_size`
  still carries `{class, path}`, and `src/metrics/Constants.ts` documents
  that same `entity-<id>` vector against it. What separates the two is
  price rather than reachability: the gauge mints nothing below a 10 000
  message high-water mark, so a series there costs a sustained backlog per
  entity instead of a single overflow, and a healthy system exports none
  at all — which is why the removal was the right answer for the counter
  and not for the gauge.

  This closes the framework-made half of the finding. The registry's lack
  of per-child eviction, and the `class="unknown"` series a cell can mint
  when it drops before its actor instance exists, remain open under #745.

## [0.16.0] — 2026-08-15

### Changed

- **BREAKING — the root `'actor-ts'` export is core-only; subsystems moved
  to subpath exports** (#414).  The root barrel re-exported every subsystem,
  which dragged the whole framework through one entry point — the testkit
  shipped in the production entry (#685), and `import { ActorSystem }` paid
  for whatever any subsystem pulled in eagerly (#1005).  Core — actors,
  supervision, scheduler/dispatcher, EventStream, system messages, config,
  mailboxes, patterns/Router, typed behaviors, the util value types and the
  base loggers — stays at `'actor-ts'`; everything else lives at its own
  entry: `actor-ts/cache`, `/cluster`, `/coordination`, `/crdt`, `/delivery`,
  `/devtools`, `/discovery`, `/fsm`, `/http`, `/io`, `/logging`,
  `/management`, `/metrics`, `/persistence`, `/serialization`, `/testkit`,
  `/tracing`, `/worker`.

  *Migration:* import moved symbols from their subsystem entry — e.g.
  `import { PersistentActor } from 'actor-ts/persistence'`,
  `import { Cluster } from 'actor-ts/cluster'`,
  `import { FileSink } from 'actor-ts/logging'`.  Aliased root names keep
  working as spelled aliases: `import { Subscribe as ReceptionistSubscribe }
  from 'actor-ts/discovery'`, `import { Transition as FsmTransition } from
  'actor-ts/fsm'`.

- **The default Fastify backend loads lazily** (#1005).  `import
  { ActorSystem } from 'actor-ts'` no longer parses Fastify and its ~20
  transitive packages; the default backend resolves on the first bind,
  exactly like the express and hono arms always did.  fastify remains a
  hard dependency.

- **The package no longer ships source maps** (#1007).  `declarationMap` and
  `sourceMap` were on while `files` publishes only `dist/`, so all 1262 maps
  in the tarball — one `.js.map` and one `.d.ts.map` per module — pointed at
  a `../src/*.ts` that was never packed, and not one of them carried
  `sourcesContent` as a fallback.  A dangling map is worse than an absent
  one: a missing map degrades cleanly to the `.d.ts`, a dangling map sends
  the editor and the debugger looking for a file that will never arrive.
  Published, the package goes from **8.07 MB over 2360 files** at v0.15.0 to
  **6.07 MB over 1268 files** — and that is with the whole logging-sink
  subsystem added in the same window, so the like-for-like saving is larger
  than the 2 MB the totals show.  Go-to-definition still lands on the
  `.d.ts`, which is exactly where it landed before.

- **The build resolves modules as `NodeNext`** (#1008).  The build tsconfig
  said `moduleResolution: "Bundler"`, but no bundler runs — `tsc` emits ESM
  into `dist/` and the consumer is Node ≥ 24 or Deno going through the real
  ESM resolver.  `Bundler` relaxes exactly the rules that resolver enforces,
  so the compiler was validating the emitted specifiers against a ruleset
  nothing downstream applies.  The project's mandatory `.js` suffix happened
  to satisfy `NodeNext` already, which is why the switch compiles clean and
  leaves the emitted JavaScript byte-identical; what it buys is that the
  *next* forgotten suffix is a compile error here instead of an
  `ERR_MODULE_NOT_FOUND` in a consumer's process.  It also makes `.d.ts`
  resolution `exports`-map-aware, which starts to matter now that #414 gives
  the package eighteen subpaths, and it settles the standing disagreement
  between the compiler and `attw --profile esm-only` about which resolver is
  authoritative.

- **BREAKING — `MemcachedClientLike` is typed in `Uint8Array`, not `Buffer`**
  (#1006).  The shipped declarations used Node-only types in public
  signatures while `@types/node` was declared only as a devDependency, so a
  consumer type-checking with `skipLibCheck: false` got errors out of
  `node_modules/actor-ts/` that were not theirs to fix.  Two of the three
  offending surfaces are gone:

  - `NodeJS.Signals` is replaced by the new `ProcessSignal`, exported from
    the root entry.  It mirrors `NodeJS.Signals` member for member, so it is
    assignable in both directions and every existing call keeps compiling —
    `installProcessHooks(['SIGTERM', 'SIGINT'])`, `ProcessTerminateReason
    .signal` and the cluster bootstrap's `shutdownOnSignals` are unchanged at
    the call site.
  - `MemcachedClientLike` speaks `Uint8Array`.  A real memjs client still
    satisfies it — `Buffer` *is* a `Uint8Array` — and so does any custom
    stand-in that returns one.  Internally the value is decoded with
    `TextDecoder` rather than `Buffer.toString('utf8')`, since the type
    change alone would have left the Node dependency alive at the value
    level.

  *Migration:* only code that reads a value **through** the
  `MemcachedClientLike` type is affected, and only where it used a
  `Buffer`-specific method: `value.toString('utf8')` becomes `new
  TextDecoder().decode(value)`.  Implementing the interface, and passing a
  memjs client to `MemcachedCache`, both need no change.

  `node:http` in `ExpressBackend` deliberately stays: `ServerResponse` is
  constructed at run time there, and a structural stand-in for a Node class
  the code actually instantiates would be regression risk for a cosmetic
  gain.  Instead `@types/node` is now declared as an **optional peer
  dependency**, which is what it always was in practice — npm can surface it,
  and a Deno-or-browser consumer that never touches those entries is not
  forced to install it.

  Measured against the packed tarball, installed into a tree with no
  `@types` package at all, under `skipLibCheck: false` / `types: []` /
  `lib: ["ES2022", "DOM"]`: importing `'actor-ts'` reports **zero** errors,
  and importing all nineteen entry points reports **two**, both of them the
  `node:http` line above.  Installing the now-declared peer takes every count
  to zero.  (A strict consumer needed it regardless — fastify's own
  declarations and its `pino` / `light-my-request` / `sonic-boom`
  dependencies account for 33 further errors without it, which no change on
  this side could have removed.)

### Added

- **Per-subsystem subpath exports** (#414, #1001).  The exports map grew one
  entry per subsystem barrel (sixteen new entries next to `./testkit` and
  `./devtools`), so the subpaths the documentation already used —
  `actor-ts/http`, `/coordination`, `/serialization`, `/discovery` — resolve
  now, and the smoke suite loads every declared entry on Bun, Node and Deno
  (#1003).

- **`getSqliteDriver` and the `SqliteDriver` type are published** via
  `actor-ts/persistence`, next to `buildSqliteDatabase` and for the same
  #124 reason — the last documented symbols no entry point served (#1002).

- **Logging grew a sink architecture** (#1150).  The logger wrote to exactly
  one place; it now fans one record out to as many destinations as you
  configure — console, rotating files, and ten log platforms — each with its
  own minimum level, bounded delivery and a flush on shutdown.  The
  individual entries below cover the pipeline (#1151, #1152), the file sink
  (#1153) and the platform sinks (#1154–#1161).

  Nothing about the existing surface changed: `Logger`, `ConsoleLogger`,
  `JsonLogger` and `NoopLogger` are untouched, `this.log` behaves as before,
  and a system whose config nobody edited logs exactly what it logged
  yesterday.  Every integration is dependency-free — the two that could have
  pulled an SDK, OpenTelemetry and Sentry, take the opposite routes and say
  why on their own pages.

- **Multi-sink logging — one record, several destinations** (#1151).  The
  logger wrote to exactly one place: `system.log` was a single `Logger`, and
  the only knob was `actor-ts.logger.level`.  Sending the same record to the
  console *and* a file *and* an aggregator meant hand-writing a `Logger` that
  multiplexes and re-implements level handling, MDC merging and formatting.

  `MultiSinkLogger` fans each record out to a list of `LogSink`s, each with
  its own minimum level:

  ```ts
  const consoleSink = new ConsoleSink({ minLevel: LogLevel.Info });
  const auditSink = new ConsoleSink({ minLevel: LogLevel.Error, format: 'json' });
  const systemOptions = ActorSystemOptions.create().withLogSinks([consoleSink, auditSink]);
  const system = ActorSystem.create('my-app', systemOptions);
  ```

  Or from configuration — every sink ships disabled, and enabling one
  replaces the default single `ConsoleLogger`:

  ```hocon
  actor-ts.logger.sinks.console { enabled = true, min-level = "info", format = "json" }
  ```

  The pieces: `LogRecord` (built once per call, carrying the MDC captured
  **synchronously at emit**, since a sink that flushes later runs in another
  async context and could not read it), the `LogSink` contract
  (`{ name, minLevel, write }` is a complete sink, with `attach` / `flush` /
  `close` optional), `ConsoleSink`, and `formatTextLine` / `formatJsonLine` —
  which reproduce `ConsoleLogger` and `JsonLogger` byte for byte, key order
  included, so existing log parsers keep working.

  The level gate runs at the call site, so a suppressed call costs a
  comparison.  A sink that throws is caught, reported through a rate limiter
  to `console.error` — never through the logger it is part of — and skipped,
  while the other sinks still get the record.  `withSource` / `withFields`
  return views over one shared pipeline, so a thousand actors still mean one
  set of sinks, attached once and closed once.

  `terminate()` now flushes and closes the logger before `whenTerminated()`
  resolves, bounded by the new `actor-ts.logger.close-timeout` (3 s).  That
  seam covers both shutdown paths, since `CoordinatedShutdown` ends by
  calling `terminate()`, and it runs after the last `postStop` so a parting
  message is still in the batch.  Any logger with a `close()` is flushed —
  the check is structural, so a third-party one benefits too.

  `Logger`, `ConsoleLogger`, `JsonLogger` and `NoopLogger` are untouched;
  `Logger` remains a documented extension point and gained no members.

- **`BatchingSink` — bounded, batched, retrying log delivery** (#1152).  The
  base class every sink that writes somewhere slower than memory extends.  A
  subclass implements one method, `emitBatch(records)`, and inherits a
  bounded queue, batching, retry with jittered backoff, drop accounting and
  a drain on close.

  Settings live in a nested `delivery` block (`maxBatchSize` 100,
  `flushIntervalMs` 2000, `queueCapacity` 10 000, `overflow` `drop-new` |
  `drop-head`, `maxRetries` 5, `minBackoffMs` 1000, `maxBackoffMs` 30 000,
  `randomFactor` 0.2), shared by every sink so the same word means the same
  thing everywhere.

  `SinkDeliveryError` carries whether a failure is worth retrying, plus an
  optional server-supplied `retryAfterMs`.  A non-retryable failure — a 401
  from a wrong key — is dropped at once instead of being retried five times
  with backoff.  Anything that is *not* a `SinkDeliveryError` counts as
  retryable, which is what a socket reset or a failed `fetch` looks like.

  The queue is bounded on purpose: an unbounded buffer does not save the
  records, it converts "some logs were lost" into "the process died".
  Losses are counted on `droppedCount` and reported to the console at most
  once a minute per reason.  On close the queue is drained with retries
  switched off, since the caller already holds a deadline.

- **`FileSink` — log files on disk, with rotation and retention** (#1153).
  There was no way to write logs to a file; every deployment that is not a
  container scraping stdout had to build it.

  ```ts
  const fileSinkOptions = FileSinkOptions.create()
    .withDirectory('/var/log/my-app')
    .withRotateInterval('daily')
    .withMaxFiles(14);
  const systemOptions = ActorSystemOptions.create().withLogSinks([new FileSink(fileSinkOptions)]);
  ```

  Files are named `log-<yyyy-MM-dd>-<HH-mm-ss>.txt` after the moment they
  were opened, and roll over on size (`maxFileBytes`), on the clock
  boundary (`rotateInterval`: `off` | `hourly` | `daily`), or both.
  Retention takes a file count and an age; rotated files can be gzipped.

  **Rolling over opens a new file — the active one is never renamed.**
  Windows will not rename an open file, and a crash can never catch a file
  mid-rename this way.  **No record is split across two files**: the
  rotation check runs before each line, not per batch.  **Retention only
  deletes this sink's own files** — matching prefix, extension and
  timestamp shape, never the active file and never anything else in the
  directory.

  A directory that cannot be written disables the sink after one console
  message instead of failing every flush forever.

  `AppendOnlyFile` is the first long-lived file handle in the codebase: one
  lazy `node:fs/promises` import serving Bun, Node and Deno, with writes
  looping until every byte is accepted, since a single `write` is not
  guaranteed to take the whole buffer and half a line in a log file is
  worse than none.  A smoke case runs the sink on all three runtimes.

- **`OtlpHttpSink` — OpenTelemetry logs over HTTP** (#1154).  One endpoint
  format reaches Grafana Loki 3+, Parseable, SigNoz, Datadog, Axiom,
  Honeycomb, New Relic and every OpenTelemetry Collector, so this is the
  sink to reach for before a platform-specific one.

  ```ts
  const otlpSinkOptions = OtlpHttpSinkOptions.create()
    .withUrl('http://collector:4318/v1/logs')
    .withGzip(true);
  ```

  Records go out as an `ExportLogsServiceRequest` in proto3 JSON — no
  protobuf library and, deliberately, no OpenTelemetry SDK: the protocol is
  stable and its JSON encoding specified, while the JavaScript logs SDK is
  still an experimental 0.x whose releases may break.  Levels map onto the
  OTel severity bands, fields become typed attributes, `service.name`
  defaults to the actor system's name, and the body can be gzipped.

  Timestamps go through `BigInt`.  `ms * 1e6` lands 64 ns short for a 2026
  timestamp — and `String()` hides it, because JavaScript prints the
  shortest decimal that round-trips to the wrong double.

  Retry classification follows the specification: 429, 502, 503 and 504 are
  retried honouring `Retry-After`; everything else describes the request and
  is dropped rather than resent unchanged.  Request headers are code-only,
  with no HOCON leaf, because they carry credentials.

  `HttpDelivery` factors that classification out for the platform sinks
  still to come.

- **`GelfSink` — Graylog over UDP, TCP or HTTP** (#1155).  The one platform
  the OTLP sink cannot reach: Graylog's OpenTelemetry input accepts OTLP
  over **gRPC only**, so there is no HTTP path to it without a collector in
  between.  GELF also lands structured fields as first-class searchable
  keys rather than `otel_attributes_*`.

  ```ts
  const gelfSinkOptions = GelfSinkOptions.create()
    .withHost('graylog.internal')
    .withProtocol('udp');
  ```

  No SDK — GELF is a JSON document, and the transports are a datagram, a
  null-delimited stream and an HTTP POST.  UDP datagrams are gzipped by
  default (the server detects it from the magic bytes) and chunked with the
  spec's 12-byte header when they outgrow one packet; the default 1420-byte
  datagram keeps the whole packet inside an Ethernet MTU with room for a
  tunnel header.  A record needing more than the protocol's 128 chunks is
  dropped and reported rather than retried — a retry cannot make it
  smaller.  TLS for the TCP transport is code-only: those fields carry the
  key material itself, not a path to it.

- **`ParseableSink` — Parseable's REST ingestion** (#1156).  A batch becomes
  a JSON array POSTed to `/api/v1/ingest` with the dataset in the
  `X-P-Stream` header; Parseable creates the dataset on first use.  No SDK
  exists and none is needed.

  Records are sent flat, because Parseable flattens nested objects at
  ingest anyway — flat keeps every field individually queryable and skips a
  round of server-side rewriting.  Authentication is an API key **or**
  basic-auth credentials, and the validator rejects both-at-once and
  half-a-pair at construction rather than letting every flush fail.

  A batch over Parseable's 10 MiB request cap is split rather than sent and
  rejected: exceeding it is not a retryable failure, so an oversized batch
  would be lost in full.

  Parseable also accepts OTLP/HTTP, so `OtlpHttpSink` reaches it too — this
  sink is for the simpler record shape.

- **`sentrySink()` — Sentry through your own SDK** (#1157).  A factory, not
  a class, mirroring `otelLogger`: you pass your initialised `@sentry/node`
  import and the framework never imports it, declares no dependency, and
  has no version to keep in step.

  ```ts
  const sentry = await import('@sentry/node');
  sentry.init({ dsn: process.env['SENTRY_DSN'] });
  const systemOptions = ActorSystemOptions.create()
    .withLogSinks([new ConsoleSink(), sentrySink(SentrySinkOptions.create().withSdk(sentry))]);
  ```

  Error-level records with an `Error` argument go to `captureException` —
  which is what gives Sentry a stack to group on — and without one to
  `captureMessage`.  Everything else that passes the level gate goes to the
  structured-logs product when the SDK has one.  A warning is deliberately
  *not* an issue.

  The default `minLevel` is `warn`, stricter than every other sink: Sentry
  is priced per event, so a debug firehose pointed at it is a billing
  incident rather than a preference.

  There is no `actor-ts.logger.sinks.sentry` block, because the sink needs
  a live SDK object; `reference.conf` says so where a reader would look for
  it.

  Delegating rather than speaking Sentry's envelope protocol is the point:
  grouping, stack-trace processing, release detection and breadcrumbs all
  live in the SDK, and a hand-rolled transport would duplicate them badly
  or lose them.

- **`LokiSink` — Grafana Loki's native push API** (#1158).  A batch becomes
  one push to `/loki/api/v1/push` in plain JSON, which Loki accepts as an
  alternative to snappy-compressed protobuf.

  **Labels are static by construction.**  They are Loki's index, and a
  per-record value in there multiplies streams without bound — the standard
  way to make a Loki cluster unusable — so the options type does not accept
  one.  Variable data (the actor path, the fields, the level) goes into
  structured metadata, which Loki stores per entry instead of indexing.
  `service` defaults to the actor system's name.

  Timestamps are nanosecond strings: Loki answers a JSON number with a 400.
  `nanosecondsOf` moved to its own module now that two sinks need it.

  Loki 3+ also ingests OTLP, so `OtlpHttpSink` reaches it too — this sink
  is for direct push and explicit label control.

- **`SeqSink` — Seq over CLEF** (#1159).  A batch becomes newline-delimited
  CLEF POSTed to `/ingest/clef`: the NDJSON the framework already emits
  with four keys renamed.  Levels use Serilog's vocabulary, so `info`
  becomes `Information` — the value Seq rejects if you guess it.

  A field whose name starts with `@` has its sigil doubled, per CLEF's own
  escaping rule, so a `@t` arriving over the cluster wire cannot forge the
  record's timestamp.

- **`SplunkSink` — the HTTP Event Collector** (#1160).  A batch goes to
  `/services/collector/event` with `Authorization: Splunk <token>`.  Events
  are concatenated back to back rather than wrapped in a JSON array —
  newer Splunk versions accept an array, but concatenation is the batch
  format every version understands.

  `fields` carries indexed fields flat, because HEC rejects a nested value
  there and the key only works on the `/event` endpoint at all.  `host`
  defaults to the actor system's name.

- **`SyslogSink` — RFC 5424 over UDP, TCP and TLS** (#1161).  The one
  integration that needs no vendor: rsyslog, syslog-ng, journald's
  forwarder, Papertrail and a long tail of appliances all speak it.

  ```
  <134>1 2026-08-12T09:41:02.113Z web-01 orders 1234 - - placing order {tenant=acme}
  ```

  The priority is `facility · 8 + severity`; `facility` defaults to 16
  (`local0`), the range reserved for applications.  `APP-NAME` defaults to
  the actor system's name.

  The structured-data element is deliberately `-`: a well-formed `SD-ID`
  needs an IANA private enterprise number, and inventing one would file
  records under somebody else's identifier.  Fields ride in `MSG` in the
  same `{k=v}` form the console uses.

  Stream framing defaults to `octet-counting` (RFC 6587) — the only framing
  that survives a message containing a newline, which a stack trace always
  does — and counts **bytes**, so a multi-byte character cannot make the
  receiver cut the frame short.  `lf` is available for receivers that
  accept nothing else, and collapses the newlines it cannot represent.

- **`redactUrlCredentials` and `redactedUrlLabel`** (#590, #592).  Both are
  exported from the package root, next to `safeStringify`.  The framework
  runs every connection URL it reports through them, but it cannot redact
  what your own log line prints.  `redactUrlCredentials(value)` masks the
  userinfo and changes nothing else, and is a strict no-op on anything
  without a `scheme://…@` authority, so it is safe to apply to a value that
  only might be a URL.  `redactedUrlLabel(value)` goes further and reduces a
  URL to a stable identity — scheme, host, port and path — dropping the
  query string as well, for a line you emit repeatedly.  Both are also what
  you call inside a `MultiSinkLogger` `transform` when a credential reached
  a record's fields rather than its message.

- **`cluster_envelope_from_mismatch_total{frame}`** (#121).  It counts
  envelopes whose payload names a sender other than the connection they
  arrived on.  Nothing the node does depends on that field any more, but a
  claim contradicting the connection is still worth a number: it is either a
  client old enough to still send it and wrong about its own address, or
  someone probing whether this node routes on payload, and an operator wants
  to see both.  A matching claim is not counted — that is the compatibility
  direction that has to keep working.  It is a new family rather than a fifth
  reason on `cluster_gossip_records_refused_total`, whose subject is a
  gossiped member record a merge-path guard refused: this is neither a
  gossip record nor a refusal, since the envelope is delivered and only the
  hint in it ignored.  The `frame` label is the wire kind, drawn from code
  and never from the payload, so the series count is bounded by how many
  wire handlers make the check — one today — and the same question asked of
  another seam lands as a second label value instead of a second metric
  name.  The claimed address is deliberately neither a label nor log text: as
  a label it is one series per address a sender cares to invent, and as log
  text it is an unvalidated payload string.  The log line is `debug` and the
  counter carries the signal, because every envelope is its own frame and a
  warning per envelope would let a client write the node's log at line rate.

- **A gRPC client can now be faked without installing the `@grpc/*` peer
  dependencies** (#1040).  `GrpcClientActor.createServiceClient()` is a
  protected hook holding the module load and client construction that used
  to sit inside `connectImplementation` — the same test seam
  `JetStreamActor.createNatsConnection` provides — and the structural shims
  an override has to satisfy (`GrpcServiceClient`, `GrpcCallOptions`, the
  four call-shape interfaces, `GrpcReadableCall`, `GrpcWritableCall`,
  `GrpcDuplexCall`) are exported from the broker barrel.  That makes the
  client's call sites and its client-stream registry assertable in the unit
  suite for the first time: seven new tests cover the deadline reaching the
  wire and the fact that the stream handle's token, not its stream id, is
  what grants access to a stream.  The client-side `GrpcServerStreamCall`
  interface is renamed `GrpcReadableCall` — it was module-local and collided
  with the server actor's exported type of the same name.

- **`DispatcherError` is a new event on the `EventStream`, and `Dispatcher`
  has an optional `onError` sink** (#410).  The event carries the failing
  dispatcher's `id`, the `cause`, and the `ActorRef` whose turn it was
  (`null` for work handed straight to `dispatcher.execute`).  It is not an
  `ActorLifecycleEvent` — it is no transition in an actor's life and its
  `actor` may be `null`, so subscribing to the lifecycle base must not start
  delivering failures.  The sink is optional, so a custom dispatcher stays a
  two-member implementation; `ActorSystem` fills it in only when the slot is
  free, leaving a sink you wired yourself untouched.

- **`IdempotencyOptions` gained a `maxKeyLength` field, with
  `withMaxKeyLength()` on the builder** (#607).  It bounds the accepted
  `Idempotency-Key` and defaults to the newly exported
  `DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH` (255).  `IdempotencyOptionsValidator`
  rejects a non-positive or non-integer value at consume time, like every
  other bound in the family.

### Changed

- **BREAKING — `Lease.release()` reports a failure instead of swallowing it**
  (#600).  `KubernetesLease.release()` used to discard a failed DELETE and
  resolve as though the lease had been dropped, which left the record claimed
  on the server while the process had locally forgotten it — exactly the
  ambiguity `LeaseMajority`'s fail-safe exists for, and what made that fail-safe
  dead code.  It now rejects, after stopping the renewal timer so a failed
  DELETE cannot leave a lease being quietly renewed.  Every caller inside the
  framework already treated release as best-effort and catches.

  *Migration:* wrap `lease.release()` in `.catch(...)` where it is used purely
  as cleanup; third-party `Lease` backends should propagate a release failure
  rather than swallow it.

- **BREAKING — `HttpRequest.path` is the bare pathname on every backend**
  (#601).  The Fastify backend passed Fastify's raw request target straight
  through, so `GET /orders?page=2` arrived as `path: '/orders?page=2'` on
  the default backend while Express and Hono both reported `'/orders'` — the
  field's meaning depended on which backend was serving, which is exactly
  the kind of divergence a backend-agnostic request type exists to prevent.
  It is now the pathname everywhere, with the parameters in `query`, and the
  contract is documented on the field itself so the next backend has
  something to normalise against.

  *Migration:* code that read the query out of `request.path` on Fastify
  must read `request.query` instead.  Nothing typechecks this: a
  response-cache key built from `request.path` alone silently stops varying
  by query, and a hand-rolled `request.path.split('?')[0]` quietly becomes a
  no-op.  Debug access logs on Fastify now print the pathname only, which
  matches what the other two backends already logged.

- **BREAKING — Every HTTP backend now caps a request body at the same 1
  MiB** (#357).  Express and Hono each hardcoded 10 MiB while Fastify was
  never handed a `bodyLimit` at all and sat on its own 1 MiB default, so how
  large a request the framework accepted changed with the backend rather
  than with anything the application asked for.  The shared value is
  `DEFAULT_HTTP_MAX_BODY_BYTES` in the new `src/http/Constants.ts` — 1 MiB
  rather than 10 because it is the stricter of the two and the number the
  default backend already enforced; raising it instead would have widened
  the accept-anything window for every application that never made a choice.
  Lift it where an endpoint genuinely takes more: `withMaxBodyBytes(bytes)`
  on the Express and Hono backend options, `bodyLimit` in the
  `FastifyBackend` options bag.

  *Migration:* an Express or Hono backend that relied on the implicit 10 MiB
  cap now answers 413 above 1 MiB.  Restore the old cap explicitly:
  `ExpressBackendOptions.create().withMaxBodyBytes(10 * 1024 * 1024)`,
  likewise `HonoBackendOptions`.

- **BREAKING — Raising a Hono route's `maxFrameBytes` above 1 MiB no longer
  lets frames over 1 MiB through** (#586).  Backends cannot see a route's
  policy when they bind — it is resolved lazily on the first connection — so
  every backend installs the shared 1 MiB default as its transport limit.  On
  Express and Fastify this has been true since the WS-3 fix; the Hono
  transport cap now extends it to the third backend.  A route configured for
  larger frames still has them cut off by the runtime, and because Bun drops
  the connection rather than sending a policy close, the peer observes an
  abnormal close (1006) instead of the application layer's clean 1009.
  Lowering `maxFrameBytes` is unaffected.

  *Migration:* superseded by #373, which sizes the transport cap from the
  route's own policy on every backend — `withMaxFrameBytes(...)` raises the
  transport window again and no proxy is needed.  The advice originally given
  here, to keep the route on Express or Fastify until then, never worked:
  as the paragraph above says, those two have installed the identical 1 MiB
  transport cap since the WS-3 fix, so moving a route to them changed
  nothing.

- **A decompression-cap violation now reports one wording whichever
  mechanism caught it** (#580).  zlib's own `Cannot create a Buffer larger
  than N bytes` names neither the algorithm nor the fact that a configured
  bound stopped the read, and it is the text an operator sees — the snapshot
  store re-throws a decode failure as-is and the durable-state store wraps
  it in a `JournalError` whose own message only says "integrity / decode
  failure".  All three algorithms now throw `<algorithm> decompression
  exceeded maxOutputBytes=<n>`, with a tail that distinguishes the two
  mechanisms: `(aborted before the output was allocated)` versus `(got
  <n>)`.  Anything matching on the raw zlib string for an over-cap gzip read
  needs updating.

- **BREAKING — The gRPC server's four call shims now share one exported
  `GrpcCallMetadata` type** (#611).  Each previously declared `metadata?: {
  get?: (key: string) => string[] }` inline, describing a method nothing
  ever called — reading a full header set needs `getMap()`, which the shim
  did not expose.  `GrpcServerUnaryRequest` and `GrpcServerReadableCall` are
  exported so a caller can build a fake call or host the health service
  standalone, so the shape change is visible from outside.

  *Migration:* a hand-built fake call object declares `metadata?:
  GrpcCallMetadata` and supplies `getMap()` in place of the former `get()`;
  the type is re-exported from the broker barrel.

- **BREAKING — `DEFAULT_MIME_TYPES` now has a null prototype instead of only
  being frozen** (#608).  Freezing blocked writes and said nothing about
  reads, and the table is public API — a downstream
  `DEFAULT_MIME_TYPES[ext]` reproduced the same prototype-chain defect in
  the caller's own file.  Bracket reads, `Object.keys`, `in`, spreading and
  `JSON.stringify` are unaffected, and the 44 entries are unchanged.

  *Migration:* `DEFAULT_MIME_TYPES.hasOwnProperty(ext)` and string-coercing
  the map now throw — use `Object.hasOwn(DEFAULT_MIME_TYPES, ext)` and
  `JSON.stringify(...)`.  It also logs as `[Object: null prototype] { … }`.

- **`DeathPactError` is documented as manual-use only, and tests now hold
  that line** (#453).  The class is public API with no producer anywhere in
  `src/`, and both halves of that are the contract: the runtime never raises
  it, and an application throws it deliberately when a watched actor's death
  leaves the watcher without a purpose.  Until now that contract lived in a
  single JSDoc line, reachable only through the generated API reference —
  nothing stopped it from being deleted, and a half-implemented automatic
  throw would have turned nothing red.  The death-watch page (EN + DE) gained
  an *Ignoring a `Terminated`* section covering what an ignored death
  actually costs in each API — a silent no-op under `Actor.onReceive`, a
  supervision restart under the `match(…).exhaustive()` idiom this project
  documents everywhere, dead letters in the typed API — plus a worked
  example of raising the error yourself and letting a decider, rather than
  the framework, price a broken pact.  Three tests in `DeathWatch.test.ts`
  pin it: an ignored `Terminated` raises nothing and the watcher keeps
  processing; an application-thrown `DeathPactError` reaches supervision
  carrying the dead actor's path; and a `Terminated` that no `.exhaustive()`
  arm covers fails as ts-pattern's own error rather than as a death pact.
  The JSDoc's "an unhandled Terminated is swallowed" went with it, because
  there is no framework-level swallow: the cell dispatches the signal and
  reads nothing back.  That is also precisely why no pact can be automatic —
  `Actor.onReceive` returns `void`, so "handled" and "ignored" are
  indistinguishable from the outside.  Raising it automatically still waits
  on the dedicated termination hook in #662.

- **BREAKING — `serializeCookie` is now safe by omission** (#626).  An
  attribute the caller does not mention resolves to the strict end —
  `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` — so
  `serializeCookie('session', id)`, previously a bare `session=<id>` with no
  protection at all, is a cookie you can ship, and one that satisfies the
  `__Host-` prefix rules without further argument.  `Path` is always emitted,
  because omitting it lets the browser derive the scope from the request
  URI, covering `/account` or `/` depending on which endpoint happened to
  mint the cookie.  The three Secure-related throws (`SameSite=None`,
  `__Secure-`, `__Host-`) consequently fire only on an explicit `secure:
  false`, which is the point: they existed to catch a cookie the browser
  would silently drop, and an omitted attribute no longer produces one.  The
  CSRF middleware is unaffected — it already passed every attribute
  explicitly.

  *Migration:* a cookie that same-origin JS must read now needs `httpOnly:
  false`, and a plain-HTTP deployment needs `secure: false`; a scope
  narrower than `/` needs `path` spelled out.

- **BREAKING — `@hono/node-ws` must be 1.2.0 or newer for `websocket()` routes
  on the Hono backend under Node** (#586).  The transport frame cap added in
  this same release installs itself by writing `maxPayload` onto the `ws`
  server the adapter exposes as `wss` — a member that only exists from 1.2.0.
  On 1.0.x and 1.1.x that server is a closure variable with no way out, so the
  cap cannot be installed at all, and the backend refuses to build the
  WebSocket bridge rather than bind an uncapped socket where a peer could
  buffer 100 MiB per frame.  The declared peer range moves from `^1.0.0` to
  `^1.2.0` so the supported window matches what the code can actually run on;
  it was previously wider than the implementation, which turned a working
  server into a startup error for anyone pinned below 1.2.0.

  *Migration:* on the Hono backend under Node, upgrade the peer dependency —
  `npm install @hono/node-ws@^1.2.0`.  Nothing else is affected: Bun and Deno
  get their WebSocket helpers from `hono` itself and never load this package,
  and a Node application with no `websocket()` route never reaches the bridge.

### Removed

- **BREAKING — The `shard-map` wire kind (`ShardMapMessage`) is gone from
  `WireMessage`, together with its per-field arm in wire validation and the
  `Cluster.onUnhandledWire` comment that claimed the wire-handler registry
  handled it — nothing ever registered it, so such a frame was validated,
  forwarded and dropped. Its live replacement is the sharding-level
  `ShardMapUpdate`, which carries more and travels inside an envelope. There
  is no wire-format change: no release ever emitted a `shard-map` frame, so
  node-to-node interoperability is untouched. (#681).**

  *Migration:* `WireMessage` is re-exported from the cluster barrel and
  narrows by one member, so code that constructs a `{ kind: 'shard-map',
  ... }` value and assigns it to `WireMessage` — a custom `Transport`,
  most plausibly — stops compiling. Reading or forwarding a `WireMessage`
  is unaffected.

- **The sharding kind `sharding.BeginHandOff` and the private
  `ShardRegion.registered` field (#681).**

  `BeginHandOff` was declared, listed in the `ShardingMessage` union, and
  never constructed, sent or matched in any release; the live sequence has
  always been `HandOff` then `BeginHandOffAcknowledgment` then
  `HandOffComplete`, and the acknowledgment leg stays. `registered` was
  assigned in three places and read in none — its sibling
  `registerRefused` looks like the same kind of flag, is read in
  `ensureRegistered`, and stays. Neither name was exported from any
  barrel, so there is no public surface change.

- **BREAKING — the ClusterClient envelope no longer carries a sender field**
  (#121).  `cluster-client-envelope` used to repeat, on every message, the
  address the client's `hello` handshake had already established.  The
  receptionist stopped reading it when it started replying down the
  connection the request arrived on: the payload's copy was absent often
  enough to throw a `TypeError` out of the frame-dispatch loop, and when
  present but forged it made the node send a reply — and open a connection —
  to an address of the sender's choosing.  What was left was a field with
  exactly one correct value, and that value is one the receiver already
  holds.  That is not information, it is a second answer to a question that
  already had one, and it survives only until the next reader reaches for
  the cheaper of the two.  A client states who it is once now, in the
  handshake, where the transport binds the claim to the socket.

  *Migration:* `ClusterClientEnvelopeMessage` is publicly re-exported and no
  longer has `from`; drop the field if you compose the frame yourself.
  Compatibility runs one way and only one way: a current node still serves a
  pre-upgrade client that sends the field — the value is ignored, and a
  value that contradicts the connection is counted on the new mismatch
  metric.  The reverse does not work: a current client against a node older
  than v0.14.0 hits `NodeAddress.fromJSON(undefined)` and throws out of that
  node's frame-dispatch loop.  Upgrade the cluster nodes before the clients.

- **The internal WebSocket path matcher is gone** (#623).
  `matchWebsocketPattern` existed only because, as its own doc comment put
  it, "the `upgrade` event bypasses the router entirely" on the Express
  backend.  Now that upgrades are dispatched through the app, Express matches
  the pattern and populates `req.params` itself, so the hand-rolled matcher
  has no caller.  It was never exported from a barrel, so nothing public
  changes.

- **The dead raw WebSocket upgrade-response writer is gone, taking an
  unreachable response-splitting hole with it** (#624).
  `writeRawHttpResponse` stripped CR/LF from every app-supplied header name
  and value but interpolated the app-supplied `contentType` raw onto the
  content-type line above the header/body boundary, so a guard echoing
  attacker-influenced data there could inject header lines and a body.  Its
  only caller vanished when #623 rerouted Express upgrade rejections through
  a synthesised `ServerResponse`, whose `setHeader` makes the runtime itself
  reject a CR or LF — which removes the injection class structurally — so
  the module was deleted rather than patched.  It was never exported from a
  barrel and the package `exports` map has no wildcard subpath, so no
  consumer could reach it.

### Fixed

- **A lease built without `name`, `owner`, `ttlMs` — or `namespace` for the
  Kubernetes backend — is now rejected at construction** (#596).  It used to
  come up silently and then disable mutual exclusion on the wire: without an
  `owner` the CREATE/PUT carries no `spec.holderIdentity` (the undefined key
  drops out of the JSON body) and a holder-less lease reads as free to every
  node, so every `acquire()` returned true; without `ttlMs` the expiry is
  `NaN`, which is never later than now, and the renewal interval is `NaN` too,
  which `setInterval` clamps to about a millisecond.  Both shipped backends
  were affected.  Required-ness is checked separately from the value rules,
  because the options-validator helpers are contractually a no-op on unset
  fields.

- **`LeaseMajority`'s release-on-abandon and fail-safe do something now**
  (#600).  The release fired from the timeout branch while the acquire it meant
  to undo was still in flight — and a lease is a no-op to release before its
  acquire resolves, so the abandoned attempt went on to land, take the lease
  and renew it forever on a node whose own strategy had written the attempt
  off.  An acquire is abandoned two ways: it blows `acquireTimeoutMs`, or a
  partition heal or changed unreachable set retires its epoch — the second being
  the likelier, since the acquire budget is 5 s by default.  Both are now
  tracked the same way: the undo waits for the abandoned attempt to report back
  and releases only if it won, and no fresh acquire starts in the meantime — a
  same-owner re-acquire would win trivially and claim survival, and a release
  landing after that would delete the very record being claimed.  The fail-safe
  on a failed release, previously unreachable for both shipped backends, is now
  both reachable and covered.

- **Directory listings classify entries by the followed `stat`** (#575).  An
  in-root symlink to a directory was rendered as a file — it carried the
  directory's size and linked without a trailing slash — because the directory
  flag came from the raw directory entry while size and mtime came from the
  followed `stat`.  Both now come from the same source, so a link to an
  in-root directory is listed as a directory.  The internal `readDirectory`
  helper returns names accordingly; directory-entry type flags are unreliable
  anyway (a filesystem answering `DT_UNKNOWN` reports every kind as false).

- **Query-bearing URLs no longer produce mangled redirects and headings on
  the Fastify backend** (#601).  Everything that builds a target by appending
  to `HttpRequest.path` was doing so with the query still inside it, and so
  was correct on two backends and wrong on the default one: the static-file
  directory redirect answered `Location: /static?a=1/` instead of
  `/static/?a=1`, breaking the query-preserving redirect the static-files
  documentation already promised; the DevTools shell redirect answered
  `Location: /devtools?x=1/`, putting the trailing slash inside a query
  value and defeating the relative-asset resolution that redirect exists to
  guarantee; the directory listing was headed `Index of /files/sub?a=1`; and
  WebSocket handlers received a query-bearing `upgrade.path`.  All four
  follow from the pathname fix and needed no change of their own.

- **A TCP peer can no longer stall the event loop by never completing a
  frame** (#610).  The `lines` extractor decoded all buffered bytes and
  restarted the delimiter search at offset 0 per chunk — O(buffered) each
  time, O(N²) over a delimiter-free stream, entirely inside a cap the docs
  call a DoS limit.  The scan now runs over the raw bytes against the encoded
  delimiter, only completed lines are decoded, and the search position is
  carried across chunks.  Appending the chunk was the other half, and the
  larger one: the inbound buffer was re-allocated and copied in full per
  chunk, so the stream stayed O(N²) with the scan already fixed.  Both TCP
  actors now accumulate into a buffer grown by doubling behind a read cursor —
  sized from what arrived rather than from any length a peer claims, compacted
  in place instead of reallocated, and released once it drains above 64 KiB.
  256 KiB delivered in 64-byte chunks now moves 516 KiB instead of 512 MiB,
  and `length-prefixed` loses its per-pass re-slice of the leftover along the
  way.  The same
  rewrite fixes a corruption bug: a chunk boundary splitting a multi-byte
  character used to be decoded to U+FFFD and re-encoded into the leftover,
  so the continuation byte arriving next could never repair it.  Applies to
  the listener too, per accepted connection.

- **`maxLineLen` now counts bytes, the unit its validator has always
  claimed** (#752).  Both cap checks compared the length of the decoded
  string, i.e.  UTF-16 code units: 1,048,576 CJK characters are exactly the
  default cap in code units and 3,145,728 bytes, so a peer could hold three
  times the configured limit with no overflow reported.  This is a semantic
  tightening you can observe — the same `maxLineLen` now trips up to 3x
  earlier on a non-ASCII line protocol, and the 1 MiB default means 1 MiB of
  bytes rather than up to 3 MiB.

- **A rejected WebSocket upgrade now reaches the client on Bun** (#623).  The
  Express backend wrote its rejection straight to the hijacked socket, which
  under Bun 1.3.1 delivered zero bytes — a client refused by an upgrade
  guard saw a bare connection close instead of the guard's 401, while the
  same code under Node delivered the full response.  Routing the rejection
  through a `ServerResponse` bound to that socket delivers it on both.  Deno
  delivers neither, before or after: its `'upgrade'` socket is write-only in
  the direction of a completed handshake, so a refused client there sees no
  response *and* no close, and only notices when its own timeout fires.  The
  handshake is refused correctly on all three either way — only the
  explanatory body was missing.

- **A body-size refusal now reads the same whichever backend served it**
  (#357).  All three answer 413 with the `text/plain` body `Payload Too
  Large` and the server-wide default response headers, written through the
  backend's own response writer.  Fastify used to let its own
  `FST_ERR_CTP_BODY_TOO_LARGE` JSON envelope through — and, once
  `withErrorHandler` was installed, reported the refusal as a 500, because
  the app-level hook maps every non-`HttpError` to one.  That hook is now
  installed for every server and answers the refusal itself: a body cap is a
  transport decision, and the Express and Hono backends never consulted the
  user's error handler for it either.  Every other error on a server without
  an error handler is still handed back to Fastify's default serialisation
  untouched.

- **The Express backend refuses an over-long declared `Content-Length`
  before reading a byte of the body** (#357).  It used to stream and count
  instead, so a client announcing a gigabyte still had a full cap's worth
  read and buffered before the 413 went out.  Hono and Fastify already
  refused up front; the shared predicate now sits beside the backend
  contract in `HttpServerBackend.ts`.  A chunked body that declares no length
  is measured as it arrives on Express and Fastify — that is the one path a
  size cap cannot short-circuit without help from the runtime adapters.  On
  Hono it is still buffered whole before the check, because the adapter hands
  the body over as one `arrayBuffer()`; that gap is not closed here.

- **A work unit that throws on a dispatcher now reaches the system logger
  and the event stream** (#410).  It went to `console.error` and nowhere
  else, which made it invisible to every configured log sink, to
  `JsonLogger`, to MDC and to tests — the three unit tests that covered it
  did so by silencing the console and asserting only that nothing
  propagated.  That was already a blind spot before the multi-sink logging
  work and a much bigger one after it.  The catch sits at the actor cell, so
  it attributes the failure to an `ActorRef` and covers per-actor and
  third-party dispatchers the system never sees; `console.error` remains
  only as the last resort for a dispatcher used outside an actor system.

- **zstd on Deno now fails with a sentence instead of dying inside a missing
  native binding** (#580, #321).  Deno's `node:zlib` exports
  `zstdCompressSync` and `zstdDecompressSync` as present functions with no
  binding behind them, and both resolvers accepted a candidate because the
  symbol existed.  A read therefore threw `binding.ZstdDecompress is not a
  constructor` with the documented `fzstd` fallback sitting unreachable
  underneath it, and a write threw `binding.ZstdCompress is not a
  constructor` downstream of the `probeCompressionAvailability` call that
  exists to catch exactly that at plugin-init — the class of bug #321
  closed.  Both resolvers now select by calling a candidate against a 17-byte
  canary frame, once per process and memoised alongside the implementation
  it picked.

- **The gRPC documentation no longer implies `deadlineMs` bounds a streaming
  call** (#611, #577).  The client-side deadline reaches unary calls only, by
  design — a gRPC deadline covers a whole RPC, so one value cannot both fail
  a request/response call promptly and let a long-lived stream run.  The
  pages still described an unqualified per-call deadline, which read as
  though the three streaming modes were covered too.  Both language versions
  now name the call class it applies to and say why the others are left
  unbounded.

- **The in-memory-cache page claimed `setIfAbsent` moves a key to the
  most-recently-used end; it does not** (#607).  It returns early on a
  present key without touching the iteration order, so a claimed idempotency
  record is not kept hot by repeated probes and ages towards eviction from
  the moment it is stored -- only `get`, `incr` and `mget` bump.  The HTTP
  overview's middleware sample also passed a `Route` into
  `cached(...)(...)`, which takes a handler, and its English prose still
  called the three middlewares `Route -> Route` transformers where the
  German mirror had already been corrected to "handler wrapper".

- **The documentation no longer claims that cross-node messages travel
  through the pluggable serializer stack** (#450).  Four pages per language —
  `cluster/refs-across-nodes`, `cluster/transports`, `fundamentals/messages`
  and `fundamentals/pattern-matching` — described a
  `SerializationExtension`-mediated cluster wire with selectable CBOR, told
  readers the serializer reads `kind` to reconstitute a value, and suggested
  `TcpTransport` over loopback to exercise the CBOR codec.  In fact the
  cluster frames each envelope with a bare `JSON.stringify`, no cluster
  transport can reach the CBOR codec, and the wire carries no type identity
  of its own.  The pages now state that messages must be JSON-safe, that a
  `bigint` throws where a symbol is silently dropped and that registering a
  serializer changes neither, and that `kind` is what the receiving actor's
  `match(...)` dispatches on.  German mirrors updated 1:1.  The
  serializer-on-the-wire work itself remains open.

### Security

- **GELF field names cannot be forged by a remote peer** (#1155, relates to
  #573).  The MDC can carry values that arrived over the cluster wire, so
  the GELF sink sanitises additional-field names to what the spec permits,
  drops the forbidden `_id`, and drops any field that would land on one of
  GELF's own top-level keys — `short_message`, `timestamp`, `level`,
  `host`.  Without that, a peer could overwrite the message, the severity
  or the origin of the record reporting on it.

- **A redaction seam for log records** (#1151).  `MultiSinkLoggerOptions`
  takes a `transform` hook applied once, before fan-out, that rewrites a
  record or drops it by returning `null` — one place to mask a token or a
  credential-bearing URL that reached the MDC, rather than one per sink
  (relevant to #590, #592, #741).  No sink option that carries a credential
  is readable from HOCON.

- **BREAKING — a recorded gossip frame can no longer be played back while its
  sender is still a member** (#112, relates to #940).  A gossip frame is a
  snapshot of the member map, and a
  member's version only moves when its status does, so a frame captured off
  the wire stayed valid indefinitely.  Against a converged receiver that was
  harmless — every record lost the "higher version wins" comparison — but not
  against an entry the receiver had *deleted*: the failure detector's down
  path deletes outright so a healed partition can re-discover the peer, an
  expired tombstone is pruned for the same reason, and the branch that files a
  first sighting had no lower version bound at all.  Replaying a downed
  member's own pre-down record therefore brought it back at its old version,
  `up`, carrying its roles — and roles are what shard placement, singleton
  hosting and downing quorums are computed from.

  Every frame now carries a sequence its author stamps, seeded from that
  node's wall clock at startup so a restart out-numbers its own previous
  incarnation, and a receiver drops any frame that does not out-number the
  highest it has accepted from that connection peer.  There is no new knob:
  the comparison is between a peer and itself, so it needs no clock-skew
  budget, and a sequence too far ahead to be plausible is merged but never
  adopted as the mark — otherwise one frame numbered `Number.MAX_SAFE_INTEGER`
  would silence the real node forever.  Refusals are reported through the
  existing `cluster_gossip_records_refused_total` under a fourth reason,
  `replayed-frame`, rather than a new metric series.

  *Migration:* `GossipMessage` gains a required `sequence` field, and a frame
  without it is refused at the decode boundary.  Nothing outside the framework
  composes gossip frames, so application code is unaffected — but **a rolling
  upgrade is not gossip-compatible in either direction**: an upgraded peer
  refuses an old node's frames for the missing field, and an old node ignores
  the new one.  Upgrade the cluster in one step, or accept that membership
  does not converge while both versions are running.

- **Cluster frame decoding is linear in the bytes received** (#588).
  `FrameDecoder` rebuilt its whole accumulator on every arriving chunk, and
  the peer chooses how a frame is split across TCP writes — so assembling one
  frame cost work quadratic in the chunk count.  A frame just under the 16 MiB
  cap delivered in ~1400-byte writes is roughly 12 000 chunks and about 100 GB
  of memory copying, an amplification of ~6000x on bytes the attacker never
  had to send, on a path that runs before the `hello` gate and therefore needs
  no membership and no certificate.  The decoder now appends into a buffer it
  grows by doubling, so each byte is copied once on arrival.  Growth is sized
  from what actually arrived and never from the length a peer claims, which is
  what keeps the pre-sizing variant of the original OOM vector closed, and a
  buffer larger than 64 KiB is released once it drains so a single oversized
  envelope does not pin memory per connection.

- **An idle inbound cluster socket is now bounded in both directions** (#588).
  A connection holding a half-received frame is closed if no further byte
  arrives within 30 seconds — a stall bound rather than a budget for the
  frame, re-armed on every chunk, so a peer shipping a large frame over a
  congested link is never punished for being slow.  Concurrent inbound
  connections are capped at 1024, refusing the newest rather than evicting an
  established peer, because eviction would let an attacker push real members
  off the node.  The handshake itself is on the same clock in both directions,
  from the moment each connection exists: an accepted socket that has not sent
  its `hello` within `HANDSHAKE_TIMEOUT_MS` is closed and gives its slot back.
  That is the case a stall deadline cannot see — a socket sending nothing is not
  stuck mid-frame, so nothing about it is tracked — and without it the cap would
  have become the exploit rather than the defence, since silent sockets held
  every slot for the life of the process.  Only the outbound dial was ever
  bounded before; on Bun the inbound gap was reachable even under mTLS, because
  a socket's `open` callback fires before the TLS handshake completes, so the
  slot was taken while there was still no certificate to check.  The bound is on
  the handshake and not on the connection, and it is the same deadline the
  dialling side already applies to itself from an earlier moment, so a peer that
  is still trying has always given up first and an established peer idle between
  gossip rounds is never dropped.

- **BREAKING — `getFromDirectory` enforces `symlinks: 'within-root'` on every
  filesystem hop** (#575).  The confinement check ran once, against the path a
  URL resolved to, so the two hops a directory request takes afterwards
  escaped it: the index file it serves, and every entry of a browsable
  listing.  The static directives use `stat`, not `lstat`, so a link is
  followed silently and `isFile` says nothing about where the bytes live —
  under the documented default policy `GET /static/sub/index.html` was
  correctly refused while `GET /static/sub/` returned the out-of-root file's
  bytes, and a listing exposed out-of-root names, sizes and mtimes.  The
  canonical root is now resolved once per request and checked against each
  hop: an escaping index file counts as absent (the next index name is tried,
  then the listing or a 404) and an escaping listing entry is omitted.  The
  mount root's own `index.html` was affected the same way, which is the
  likelier real-world precondition — a build output or a package-manager link
  farm plants exactly that link.

  *Migration:* a tree that deliberately links outside its root now 404s under
  the default policy, and those entries disappear from directory listings.
  Opt in with `withSymlinks('follow')` (field `symlinks: 'follow'`).

- **BREAKING — CSRF origin checks compare whole origins** (#604).
  `csrfProtection` and `requireSameOrigin` compared bare hosts, so
  `http://app.example` — and any other scheme that parses an authority,
  `foo://` and `file://` included — passed as same-origin for an HTTPS site.
  The `allowedOrigins` arm degraded the same way, silently matching by host
  despite both option families documenting "full origins".  Both arms now
  compare normalised origins (scheme + host + port, default port dropped,
  case-insensitive), and an opaque `Origin: null` or an origin-less scheme is
  rejected outright.  Since a `Host` header carries no scheme and a forwarded
  scheme header is client-settable and untrusted, the site's own scheme comes
  from a new `expectedScheme` option on both option families: default
  `'https'`, except that `csrfProtection` reads `'http'` when `cookie.secure`
  is explicitly `false`, because turning off the Secure cookie already
  declares a plain-HTTP deployment.  `requireSameOrigin` also gained a
  `SameOriginOptionsValidator` — it had no construction-time validation
  before.

  *Migration:* a plain-HTTP site using `requireSameOrigin` must add
  `.withExpectedScheme('http')` or it will reject its own unsafe-method
  requests; `allowedOrigins` entries must be full origins
  (`'https://app.example'`, not `'app.example'`) or construction throws an
  `OptionsError`.

- **BREAKING — the CSRF cookie defaults to the `__Host-` prefix, and the HMAC
  claim is corrected** (#605).  The module header, the `verifyToken` JSDoc and
  both docs pages stated that a cookie an attacker plants fails HMAC
  verification.  It does not: a token is bound to the server secret and to
  nothing else, and every safe-method request — anonymous ones included — is
  handed a freshly signed one, so a planted signed pair verifies.  What
  actually closes both vectors named there is the cookie name, because a
  `__Host-` cookie can be written neither by a sibling subdomain (the prefix
  forbids `Domain`) nor from a plaintext origin (it requires `Secure`).
  `DEFAULT_CSRF_COOKIE_NAME` (`'__Host-csrf-token'`) is now the default for
  both `csrfProtection` and `readCsrfToken`, which each carried their own
  hardcoded literal, and the prefix's attribute rules are checked by
  `CsrfOptionsValidator` when the middleware is built rather than by
  `serializeCookie` while every response is assembled — a wiring-time
  `OptionsError` instead of a 500 per safe-method request.

  *Migration:* the cookie is now `__Host-csrf-token`, so browser code reading
  `document.cookie` must use the prefixed name, and cookies in flight under
  the old name are ignored (the next safe-method request mints a fresh token).
  A plain-HTTP deployment must opt out with `withCookieName('csrf-token')`,
  since a `__Host-` cookie cannot be set over plain HTTP at all.

- **Cassandra: the exported CQL DDL helpers now validate what they
  interpolate** (#616).  `keyspaceDdl` spliced `connection.keyspace` straight
  into `CREATE KEYSPACE IF NOT EXISTS`, emitted every `replication.dataCenters`
  key inside single quotes unescaped, and concatenated the replication factors
  in as bare numbers; `tagIndexDdl` had the same gap on its keyspace and
  table.  This is the earliest of the Cassandra identifier sites because it
  runs before any store's own guard — the journal and the snapshot store both
  call `keyspaceDdl` from `doStart()` ahead of `ensureTables()`, and the
  remember-entities store called it with no guard at all — so exactly one
  attacker-shaped `CREATE KEYSPACE` reached the cluster before the next
  statement failed.  Identifiers now go through `assertSafeIdentifier`.
  Data-center names are CQL *string* values rather than identifiers, so they
  are quote-escaped instead and keep the hyphens an `Ec2Snitch`-derived name
  like `us-east-1` carries; replication factors must be integers, checked at
  runtime because the connection object is routinely built from environment
  variables.

  Together with the two entries that follow, this closes the raw-interpolation
  sites that the 0.13.0 note for #136 already described as "the last
  raw-interpolation gap in the Cassandra backend".  That claim was premature —
  three more remained, plus `tagIndexDdl` and `keyspaceDdl` themselves.

- **BREAKING — Cassandra tag-index queries no longer build their table
  reference by hand** (#614).  `CassandraQuery.fetchTagPartition` concatenated
  `keyspace.tagIndexTable` itself instead of going through
  `CassandraJournal.qualified()`, and it was the one Cassandra site nothing
  else covered: a query-only process never runs `ensureTables()` (skipped
  entirely with `autoCreateTables: false`) and never appends, so both names
  first reached CQL there, unvalidated.  The journal now exposes
  `qualifiedTagIndexTable`, which returns the validated `keyspace.table` form,
  and the bare name is private again — there is no longer any way to obtain
  the unqualified name from outside, which is what kept inviting the
  hand-built copy.  This mirrors `SqliteQuery`, which reads the table name
  `SqliteJournal` already validated at construction.

  *Migration:* `CassandraJournal.tagIndexTable` is no longer public.  Read
  `qualifiedTagIndexTable` for the validated `keyspace.table` form, or use the
  name you passed to `withTagIndexTable(...)`.

- **Cassandra remember-entities store: both of its CQL identifier paths are
  guarded** (#615).  `CassandraRememberEntitiesStore.qualified()` concatenated
  `keyspace.table` raw — one string feeding four differently-shaped statements
  — and the exported `rememberEntitiesDdl` did the same.  The DDL helper
  mattered as much as the runtime one: unlike the sibling Cassandra stores,
  whose `ensureTables()` builds its `CREATE TABLE` through the guarded
  `qualified()`, this store's auto-create (on by default) calls the exported
  helper directly, so guarding only `qualified()` would have left open the
  door the store itself walks through.  Both now use `assertSafeIdentifier`.
  Worth knowing for anyone who read the original report: the pre-fix failure
  mode was quieter than described, because `ShardCoordinator` catches every
  remember-store error and downgrades it to a `log.warn` — a bad identifier
  degraded remember-entities to an empty entity set behind one warning line
  rather than failing the coordinator.

- **Base64 decoding no longer hands out a view into the shared `Buffer` pool**
  (#619).  On Node and Deno, `Buffer.from(str, 'base64')` decodes into a pool
  and returns a view at an arbitrary offset, so a decoded `__bytes__`
  payload exposed unrelated payloads' plaintext to anything
  that read its `.buffer` instead of the view — measured at `byteOffset` 1656
  of a 65536-byte pool on Node 26.7.0 and offset 96 of an 8192-byte pool on
  Deno 2.6.8, at every size from 1 byte to 8 KB.  It reached user code through
  HTTP `entity()` bodies decoded by the default `JsonSerializer`, and through
  every journal, snapshot and durable-state read, where `PayloadCodec` passes
  the view straight to a custom `Serializer.fromBinary`.  Decoded bytes are
  now copied into an exact, offset-0 `Uint8Array`.  Bun does not pool base64
  decodes, so a unit test on the project's own runner cannot see this on its
  own; a cross-runtime smoke case carries the guarantee on Node and Deno.

- **HOCON substitutions and `Config` accessors no longer read through the
  object prototype** (#589).  Both path lookups descended with a bare property
  read, so every member of `Object.prototype` answered a config path:
  `${toString}` spliced a native function into the resolved config,
  `hasPath('toString')` returned `true`, and the typed getter behind it then
  failed with a type error on a function instead of a missing-path error.  The
  refusal list added in #406 covers three key names, and a blocklist can never
  enumerate a prototype chain, so reads are now guarded positively with
  `Object.hasOwn` — in `HoconParser.lookup`, in `Config.lookup`, and in the
  environment fallback, where `process.env` is prototype-backed and hands back
  a native function on Node and Deno (Bun returns `undefined`, which is why the
  hole was invisible on the primary toolchain).  `Config.fromObject`'s deep copy
  also gained the forbidden-key filter `deepMerge` and `stripUndefined` already
  had, so an own `__proto__` from `JSON.parse` can no longer re-parent the
  cloned tree.  Verified on Bun, Node and Deno via the cross-runtime smoke case.

  *Migration:* a config path naming an inherited member now misses instead of
  resolving — `hasPath('toString')` is `false`, and `${toString}` fails as an
  unresolved substitution rather than silently yielding a function.  Declaring
  the key in the config itself still works unchanged; an own key shadows the
  inherited member.

- **Security headers, CSP, HSTS and the request id now survive a throwing
  short-circuit** (#606).  The four response-decorating middlewares were written
  as `applyHeaders(await next(), headers)`, so a rejected `await` skipped the
  decoration entirely — and throwing `HttpError` is the framework's idiomatic
  short-circuit, which is exactly what `csrfProtection`, `BasicAuth` and
  `BearerTokenAuth` do.  A cross-origin POST against the documented stack came
  back as a 403 with no `X-Frame-Options`, `Referrer-Policy`, COOP, HSTS, CSP or
  request id — and CSP and the id were unreachable by any other route, since
  neither has a server-wide equivalent.  The four now rethrow an `HttpError`
  copy carrying their headers, merged *under* whatever the thrower set itself;
  anything that is not an `HttpError` is rethrown untouched, because it maps to
  the generic 500 that deliberately carries nothing from the thrown value, and
  those responses stay the backend seam's job
  (`newServerAt(…).withSecurityHeaders(…)`).  Error responses therefore arrive
  with headers they previously lacked, so a test asserting an exact header set
  on a 401/403 may need updating.  The documented security stack also moves
  `handleErrors` outside `csrfProtection`, so the error mapper finally sees that
  403 while the response it hands back still flows out through the header
  layers.

- **The DevTools node agent answers the connection, not the payload** (#595).  A
  `devtools-node-query` used to carry its own return address and the agent
  replied wherever it pointed, so a single forged frame on the cluster port made
  any DevTools-enabled clustered node open an outbound connection to an
  attacker-chosen host and post it the node's entire actor tree — every path,
  class name, mailbox depth and dispatcher — plus its figures, unprompted.  The
  reply now goes to the peer the transport supplied, which is the connection the
  query arrived on, and the query's return-address field is removed rather than
  validated: a field whose only correct value is one the receiver already holds
  can only be got wrong later.  This is the same defect class swept out of the
  cluster in #562/#564/#572/#711, which missed this agent.  The node-to-node
  DevTools vocabulary carries no compatibility promise, but during a rolling
  upgrade an unpatched agent drops a patched collector's query, so those peers
  read as stale on the overview until the upgrade finishes.

- **The DevTools federation collector no longer takes a peer's word for who it
  is** (#593).  Peer readings were cached under the address written inside the
  report, so a member could file its figures under another node's name and
  overwrite that node's row, or under a name no node has and conjure a peer
  complete with a fabricated actor tree that the overview and the actors panel
  then showed as real.  Nothing checked membership, and nothing bounded the map
  — the only eviction pass refuses to drop an entry under an hour old, so forged
  addresses accumulated an hour at a time.  Reports are now keyed on the address
  the transport supplied (and that address replaces the one the report claims,
  so the actors panel still resolves), accepted only from a node the cluster
  currently holds as a member, capped in number with the oldest reading evicted
  first, and capped in reported actor-tree size.  The payload check was
  `typeof figures === 'object'`, which passed an array or a half-populated
  object through to the cluster-wide totals where the counters are summed; every
  counter, both latency percentiles and every mailbox-depth row must now be a
  finite number, because one `undefined` among them used to turn every number on
  the overview into `NaN`.

- **A Kubernetes lease no longer believes the previous holder's expiry claims
  without bound** (#598).  Liveness was computed as
  `renewTime + leaseDurationSeconds` from two fields the previous holder wrote,
  so one write of a 68-year duration or a `renewTime` in the year 3000 kept the
  lease reading as held for decades — no pod ever acquires it again, no
  singleton ever spawns — and the write needs only the Lease CRUD permissions
  the framework's own RBAC example prescribes.  The remote duration now counts
  for at most four times the challenger's own `ttlMs` (a generous multiple
  rather than a straight clamp, so a rolling upgrade that raises the TTL cannot
  make one node steal a live lease from another), a `renewTime` further ahead
  than one TTL counts as expired, and a non-positive duration falls back to the
  local TTL.  An unparseable `renewTime` now counts as live like a missing one;
  it used to count as free for the taking.

- **BREAKING — the pod's mounted ServiceAccount token is never paired with a
  caller-supplied API-server address** (#599).  `apiServerUrl`, `authToken` and
  `caCert` were merged field by field against the in-cluster credentials, so
  naming only an `apiServerUrl` sent the cluster's own bearer token to that host
  — a credential travelling to an address it was not issued for.  The pinned CA
  bounded the damage, but the target of the request is operator-supplied and the
  token is not.  The three fields are now all-or-nothing: supply all of them, or
  none and the in-cluster mount is used whole.  `apiServerUrl` is also
  restricted to `https`, since the client builds its request with `node:https`
  regardless of what the URL's protocol says.

  *Migration:* supply `apiServerUrl` + `authToken` + `caCert` together, or none
  of them; a partial set now throws `OptionsError` at construction, and an
  `http://` API-server URL is rejected.

- **Every GitHub Actions workflow pins its actions to a commit SHA** (#585).
  All 32 `uses:` references across the 11 workflow files were mutable tags.  A
  tag is a pointer its owner can move, so an action author — or whoever takes
  over their account — could have swapped the code that runs inside
  `publish.yml`'s job, which holds `id-token: write` and publishes to npm with
  provenance.  Each pin carries its release tag in a trailing `# vX.Y.Z`
  comment, which is what keeps Dependabot updating it; drop the comment and the
  repository silently freezes on a stale action instead.
  `tests/unit/ci/WorkflowHygiene.test.ts` asserts both halves, because workflow
  YAML is invisible to every other gate the project runs.

- **The GitHub Pages deploy credentials are scoped to the job that deploys**
  (#621).  `docs.yml` granted `pages: write` + `id-token: write` at workflow
  level, so the build job — the one that installs the root and docs dependency
  trees, downloads Chromium and runs `astro build` — held them too, even though
  its only Pages step authenticates with the Actions runtime token and needs no
  scope at all.  Both grants moved down to `deploy`, which is a single step and
  no checkout.  The seven workflows that declared no permissions at all now
  state `contents: read` explicitly, so a change to the repository default
  cannot silently widen them.

- **The README-badge push no longer shares a job with the test suite** (#622).
  `test.yml` ran the entire devDependency tree in a job holding
  `contents: write` plus a git credential `actions/checkout` had persisted into
  `.git/config`, purely so the last two steps could update a badge — reachable
  from any postinstall script in the installed tree.  The suite now runs with
  `contents: read` and `persist-credentials: false`, and a separate `badge` job
  that installs nothing consumes its numbers and pushes.  The suite still runs
  exactly once.  Every `bun install` in CI is `--frozen-lockfile`, so no check
  can pass against a dependency set the lockfile never recorded; note that
  Dependabot does not regenerate `bun.lock`, so its pull requests fail until it
  is synced by hand (#817).

- **The generated DevTools UI bundle shows up in diffs** (#620).
  `.gitattributes` had marked `src/devtools/generated/uiAssets.ts` `-diff` since
  the rule was first written, which made git and GitHub report it as binary.
  `bun run check:ui` proves only that the committed `source-hash` matches the UI
  sources it claims — it deliberately does not compare the bundle's bytes, since
  those are not reproducible across operating systems and Bun releases — so
  nothing binds the embedded payload to those sources, and `-diff` removed the
  one remaining way a human could notice.  (GitHub still collapses a
  `linguist-generated` file by default, so a reviewer has to expand it.)  A payload edited without touching
  `devtools-ui/**` now shows up as `gzipBase64`, `size` and `etag` moving while
  `source-hash` stays put.  `linguist-generated`, `text` and `eol=lf` are
  unchanged, and a regenerate is 7 changed lines, only 2 of them large.

- **BREAKING — A rejected connection URL is no longer reported with its
  password** (#590).  `OptionsValidator.url()` and the connection-URL rules
  of the Mongo, libSQL, D1 and DynamoDB stores rendered the value exactly as
  given, and a connection URL is the one setting that routinely carries a
  secret inline (`amqp://user:pass@host/vhost`,
  `mongodb+srv://user:pass@cluster`, `redis://:token@host`).  That message is
  not private: `BrokerActor.preStart` runs the validator, `ActorCell`
  catches the throw and logs it at ERROR, so one mistyped protocol shipped
  the password to whatever log aggregator the deployment has — and
  `OptionsError.value` carried the raw string too, which the default
  `ConsoleLogger` prints alongside.  The userinfo is now replaced with `***`
  in both the message and `OptionsError.value`.  Nothing else about the value
  changes — no normalisation, no trailing slash, no lowercased host — so you
  still recognise what you typed, and a value that is not a URL at all
  (`":memory:"`, `"file:local.db"`) comes back verbatim.  All fourteen `url`
  rule call sites benefit, including the six log-shipping sinks (Loki,
  Splunk, Seq, GELF, Parseable, OTLP).  Note this masks the userinfo half only:
  a credential a sink carries in a query parameter is not touched, and in this
  framework those sinks take their token in a separate option field anyway.

  *Migration:* `OptionsError.value` now holds the redacted string rather
  than the raw one.  Code that catches an `OptionsError` to re-derive the
  configured URL gets `***` in place of the userinfo; read the URL from your
  own settings instead.

- **The WebSocket client's oversize-frame warning names a redacted label
  instead of the connection URL** (#592).  The warning is written once per
  offending frame with no latch, so the peer decides how often it appears —
  a hostile or simply broken server could drive an unbounded number of
  copies of whatever the URL carried into the log, and a WebSocket endpoint
  is commonly authenticated with a `?token=…`.  The line now names the
  connection as `wss://host:port/path`, with the userinfo and the query
  string stripped.  The path is kept on purpose: it is what tells two
  connections to the same host apart, so the line still identifies which
  client dropped the frame.

- **The idempotency-key fingerprint now covers the query string** (#609).
  `computeRequestFingerprint` hashed only method, path and body, and
  `HttpRequest` keeps the query in a field of its own — so `POST
  /refunds?amount=1` and `POST /refunds?amount=9999` sent with the same
  `Idempotency-Key` and an identical body fingerprinted the same, and the
  second request replayed the first one's stored response instead of
  tripping the 422 that exists to catch a key reused for a semantically
  different request.  Reachable on the Express and Hono backends; the Fastify
  default escaped only because it reported the raw request target in `path`,
  which is the very thing the request-path fix removes.  The fingerprint
  prelude now carries a canonical serialisation of the query: parameter keys
  are sorted, so a retry that reorders `?a=1&b=2` into `?b=2&a=1` still
  replays instead of being rejected, while the values of a repeated key keep
  their original order, so `?tag=a&tag=b` stays distinct from
  `?tag=b&tag=a`.  Anything from the first `?` onward is stripped off `path`
  before the canonical query is appended, so pods running different backends
  against one shared cache compute the same fingerprint for the same
  request.  Note the direction: folding the query in makes the guard
  **stricter**, so a request that used to replay may now be answered with
  422.  The 422 message no longer says "body", since the mismatch can be
  method, path, query or body.

  *Migration:* cached records written by an earlier build carry the old
  fingerprint, so during a rolling upgrade a genuine retry that lands on a
  new pod can see one 422 until those entries age out (24 h by default).
  There is no fingerprint-version field to tell an old record apart from a
  real mismatch.

- **A breached TCP framing cap now drops the pending bytes and the socket,
  not just a log line** (#578).  The client actor reported the overflow and
  returned above the only assignment that would have cleared its inbound
  buffer, and reporting a lost connection never touches the transport — so
  with `reconnect: false`, or once `maxAttempts` ran out, the socket stayed
  attached with its `data` listener live and the same peer went on growing
  the buffer the cap had just refused to clear.  The buffer also survived a
  reconnect, splicing one peer's partial line onto the next connection's
  first chunk.  The connection is now torn down for real, and the listener
  releases a closed connection's partial frame as well.

- **An empty `framing.delimiter` is rejected instead of wedging the
  process** (#789).  An empty delimiter matches at every offset without
  consuming anything, so the extraction loop never advanced — a synchronous
  spin no timeout can interrupt, accumulating empty frames until memory ran
  out, reachable from the client and from the listener per accepted
  connection.  The shared framing rule now refuses it during options
  validation, before any socket exists, and the extractor refuses it
  outright as a precondition that cannot occur.

- **BREAKING — Express WebSocket handshakes now run the app's middleware**
  (#623).  The Express backend answered Node's `'upgrade'` event itself, so
  the request never entered the Express app and nothing registered with
  `app.use(...)` ran for a handshake — an application that gated `/ws` with
  `app.use(requireLogin)` was not gated, and sessions, authentication and
  rate limiting were all skipped.  That is precisely the ecosystem this
  backend exists to reuse, and Fastify (a `preValidation` hook) and Hono (a
  plain `app.get`) both already routed their handshake through the
  framework, so Express was the sole outlier of the three.  The upgrade is
  now dispatched through the app the way `@fastify/websocket` dispatches
  through `fastify.routing`: each `websocket()` route registers as an
  ordinary Express `GET`, and reaching its handler means the whole chain let
  the request through.  A middleware that answers instead cancels the
  handshake; the DSL's own `withMiddleware()` / `allowedOrigins` guard still
  runs last and keeps the final word.

  *Migration:* two things change for Express users.  Native middleware now
  sees WebSocket upgrades, so a catch-all `app.use` that rejects
  unauthenticated requests will start refusing handshakes it previously let
  through — which is the point, but check any middleware that answers
  unconditionally.  And `ExpressAppLike` gained the call signature every
  Express app already has, so a hand-written implementation of that
  interface must become callable; a real `express()` app needs no change.

- **BREAKING — An HMAC integrity tag can no longer be stripped to skip
  verification** (#579).  `FLAG_INTEGRITY_HMAC` lives in the body manifest,
  so an attacker with write access to the bucket could clear it, drop the 16
  trailing tag bytes, and hand `decodeBody` a well-formed frame it waved
  through — `requireIntegrity` defaulted to false and `withIntegrity()`
  never set it, so the control was bypassable in exactly the configuration
  the API leads you to.  Stripping a tag is far cheaper than forging one.
  Supplying an `integrityKey` on decode now means *this corpus is
  protected*: a body without a tag is refused.  The demand lives in the
  codec, so it covers the store-level config and a per-call
  `PersistenceOptions.integrity` alike.

  *Migration:* `withRequireIntegrity(true)` is removed — it is what the
  default does now.  Its inverse `withAllowUntaggedBodies(true)` (default
  `false`) re-admits untagged bodies.  A deployment that called
  `.withIntegrity(...)` against a bucket still holding pre-integrity bodies
  must add `.withAllowUntaggedBodies(true)`, rewrite every object (a `load`
  + `upsert` per persistenceId re-frames it with a tag), then drop the
  option.  Note that `reEncryptObjectStorage` still cannot read
  integrity-tagged bodies (#739), so finish any pending master-key rotation
  before enabling integrity.

- **BREAKING — A unary gRPC call is now bounded by the configured deadline**
  (#577).  `GrpcClientOptions.deadlineMs` was declared, exposed as
  `withDeadlineMs`, read from HOCON, validated and defaulted to 30 s — and
  never handed to grpc-js, so every call ran unbounded.  A server that
  accepts a call and then never answers left a live grpc-js call plus a
  retained closure over the reply target for as long as the application kept
  issuing RPCs.  `onUnary` now passes a per-call options object carrying an
  absolute deadline minted from the configured duration.  The bound is
  unary-only: a gRPC deadline covers the whole RPC, so applying the same
  single value to the server-stream, client-stream and bidi call classes
  would tear down every stream that outlives it, and long-lived streams are
  a supported pattern.  Detecting a stream whose peer has gone quiet is a
  channel-level concern (HTTP/2 keepalive, #790).

  *Migration:* a unary call that previously hung forever now fails with
  `DEADLINE_EXCEEDED` after 30 s by default.  Raise it with
  `withDeadlineMs(...)` (or the `deadlineMs` HOCON leaf) if you relied on
  the old unbounded behaviour — and note that a small value which used to be
  inert is now load-bearing: `deadlineMs: 1` passes validation and will fail
  every unary call immediately.

- **BREAKING — The Kubernetes API seed provider now percent-encodes the path
  segments it builds** (#597).  `namespace` and `serviceName` go into
  `/api/v1/namespaces/…/endpoints/…` through the same kind of helper the
  sibling lease client has always used.  Both values arrive straight from the
  pod's environment — `CLUSTER_NAMESPACE` / `CLUSTER_SERVICE_NAME`, via
  `autoDiscovery` and via the `Cluster.bootstrap({ discovery: 'kubernetes'
  })` shorthand — so a `/` or `..` in either one previously walked the GET
  to a different API resource with the pod's ServiceAccount token attached,
  and a trailing `?watch=true` turned the one-shot GET into a stream whose
  response accumulator never finished.
  `KubernetesApiSeedProviderOptionsValidator` additionally requires the
  names Kubernetes itself would accept: a DNS-1123 label for `namespace`,
  the wider DNS-1123 subdomain for `serviceName` (an `Endpoints` object may
  carry a dotted name), so a mangled value is rejected by field name at
  construction instead of arriving later as a puzzling 404.

  *Migration:* a `namespace` or `serviceName` outside the DNS-1123 shape is
  now an `OptionsError` at construction, and `Cluster.bootstrap({ discovery:
  'kubernetes' })` still fails loudly on one.  The rule is scoped to the
  default in-cluster fetcher — supply `fetchEndpoints` if you use those two
  fields as plain labels rather than to address a Kubernetes object.  On the
  env-driven `autoDiscovery` ladder only the rejected rung is dropped: the
  rest of the chain still runs.

- **One rejected rung no longer takes down the whole discovery ladder**
  (#597).  `autoDiscovery` builds every rung up front, so the DNS-1123 shape
  rule above threw from outside `AggregateSeedProvider.lookup()`'s
  fall-through and outside `ClusterBootstrap`'s lookup `.catch()` — one
  out-of-shape environment variable killed bootstrap before any provider ran,
  including the `ConfigSeedProvider` already built from `CLUSTER_SEEDS`, which
  does not read `serviceName` at all.  That mattered because the same variable
  drives the DNS rung, where SRV names (`_actor-ts._tcp.example.com`),
  trailing-dot FQDNs and uppercase are all legal hostnames and none is a
  DNS-1123 subdomain.  Each rung's construction is now guarded: a rejected
  rung is dropped and reported through the bootstrap log, and the rest of the
  chain runs.  The guard covers all three rungs — a `CLUSTER_SEEDS` value that
  parses to nothing failed the same way.

- **BREAKING — `DevTools.mount()` now demands the same acknowledgement a
  routable `attach()` does** (#594).  `attach` refuses a non-loopback bind
  that nothing gates — DevTools reads every actor's class, mailbox and, with
  time travel, persisted events — while `mount` returned the identical route
  tree, WebSocket included, with no check at all.  It did not bypass the
  validator, as first reported: it ran the same one, but the rule had
  nothing to bite on, because `host` is read only by `bind()`, so on the
  mount path it describes an interface nobody binds and its loopback default
  made every ungated mount look safe.  There is no fact in the options a
  mount could reason from — the routes go to a server the extension never
  sees — so it now asks instead: `auth`, `ipAllowlist`, or the new
  `allowUngatedMount` acknowledgement, which also logs one line recording
  that DevTools is running without a gate of its own.  `attach`'s host rule
  is unchanged; the validator is simply told which entry point it serves, so
  both paths enforce one policy.

  *Migration:* `DevTools.mount(system)` throws `OptionsError` unless the
  options carry `auth`, `ipAllowlist`, or `allowUngatedMount: true`.  Pass a
  gate, or add `.withAllowUngatedMount()` to keep the previous behaviour.
  `new DevToolsOptionsValidator()` now takes the exposure it validates for
  (`'attach'` or `'mount'`), required rather than defaulted so a forgotten
  argument cannot silently pick the laxer rule.

- **The Hono backend now caps inbound WebSocket frames in the transport, not
  only after the runtime has buffered them** (#586).  `maxFrameBytes` was
  previously checked by the connection actor on a frame that had already
  been materialised in full, while the runner handed the socket to the
  runtime with no payload limit at all — so a hostile peer could force 16
  MiB (Bun's `ServerWebSocket` default) or 100 MiB (`ws`'s `maxPayload`
  default) of buffering per frame and have it discarded afterwards.  Express
  and Fastify had passed the cap down to `ws` since the WS-3 fix; Hono was
  the last backend without that first line of defence.  The runner now
  receives the cap as a parameter — `src/runtime/` sits below `src/http/`,
  so a runner importing the constant would invert that dependency — and
  installs it as `maxPayloadLength` on Bun and as `wss.options.maxPayload`
  on Node.  Because the Node write depends on a `ws` internal, it is verified
  rather than assumed: a `ws` version that stops exposing a numeric
  `options.maxPayload` fails the upgrade wiring with an explicit error
  instead of quietly serving uncapped.  Hono on **Deno** is the one runtime
  still without a transport cap: `Deno.upgradeWebSocket` offers a
  subprotocol and an idle timeout and no payload limit, so there is nothing
  to set — the frame is buffered first and rejected second, which is now
  stated in the WebSocket and security docs rather than glossed over.

- **A zstd body over the object-storage decompression cap is now refused
  before its output is allocated** (#580).  The cap was previously checked
  only against the finished buffer, so a stored object of a few KB could
  claim hundreds of MB first and be complained about afterwards — the
  decompression bomb working as designed.  Measured on Bun 1.3.1, a
  9,619-byte frame declaring 300 MB of output grew the resident set by 317
  MB before the cap looked at it; it now costs 0 MB.  The algorithm is read
  from the ATS1 manifest, which is attacker-controlled cleartext, so a
  deployment that writes every body as gzip was never off this path.  The fix
  is which zstd implementation the decompress resolver prefers: `node:zlib`
  (the only one that takes `maxOutputLength`) ahead of
  `Bun.zstdDecompressSync` (which takes no options at all).  No configuration
  changes and no wire-format change — `maxDecompressedBytes` keeps its 512
  MiB default and its meaning.

- **gRPC handlers now receive the client's real request metadata** (#611).
  `GrpcServerActor` built every call's `metadata` from a stub that returned
  an empty record, on all four call classes, while four exported interfaces
  declared the field and the docs promised it.  That is worse than offering
  no metadata at all: a per-call authorisation check written against it
  compiles, runs, and passes for every caller, including one that sent no
  credentials.  The record is now read from grpc-js `Metadata.getMap()` and
  built on a null-prototype object.  Both halves of that matter — a client
  may legally send a header named `__proto__` or `constructor`, and with no
  prototype the assignment has no inherited setter to reach, while a lookup
  of a header nobody sent answers `undefined` instead of resolving to an
  `Object.prototype` member.  Repeated headers collapse to their first value
  and binary (`-bin`) headers are omitted, both consequences of the record
  holding strings and both now stated in the docs.

- **BREAKING — The `Idempotency-Key` header is now validated before it
  becomes a cache key** (#607).  A value longer than `maxKeyLength` (default
  255, Stripe's published cap), or carrying an ASCII control character or a
  space, is refused with `400 Bad Request` instead of being stored.  The
  header is client-chosen and was copied verbatim into a cache key that the
  rate limiter and the response cache typically share, so without a bound
  one request decided how much of that cache it occupied.  The charset rule
  mirrors the memcached key rules: those characters are command delimiters
  in Memcached's text protocol and CR/LF are the classic header-injection
  pair, so accepting them would make the middleware's safety depend on which
  `Cache` happened to sit behind it.  The rejection names the limit and the
  offending index, never the key -- reflecting attacker bytes into a
  response body is how an error message becomes a payload.

  *Migration:* clients sending an `Idempotency-Key` longer than 255
  characters, or containing a space or a control character, now receive 400
  where they previously got service.  Raise the bound with `maxKeyLength` (or
  `withMaxKeyLength()`) if you control a client fleet that genuinely mints
  longer keys; the charset rule is not configurable.

- **Handing one `Cache` to `rateLimit`, `cached` and `idempotent` voids both
  the rate limit and the exactly-once guarantee** (#607).  `InMemoryCache` is
  LRU-bounded and evicts on recency alone, with no idea which entries carry
  a guarantee, so a caller who mints distinct keys through any of the three
  pushes the others' state out: another client's counter disappears and
  their limit silently resets, an idempotency record disappears and their
  honest retry re-executes the handler.  Under the composition the HTTP
  overview documented -- one shared cache, 100 requests per second --
  turning over the 10 000-entry map takes about 100 seconds, entirely inside
  the limit.  The three JSDoc headers, the HTTP overview sample, the three
  middleware pages, both cache pages and
  `examples/cache/redis-rest-service.ts` now use one named cache per
  consumer, and say plainly that this narrows the blast radius rather than
  removing it: an attacker-controlled key space still floods its own cache,
  which is where Redis belongs.

- **BREAKING — Every `HttpClient` call now carries a deadline and a
  response-size ceiling** (#602).  The client buffered a whole response with
  `res.arrayBuffer()` and armed its abort timer only when the caller named a
  `timeoutMs`, so both of the things a remote peer controls — how long it
  takes to answer and how many bytes it sends — were unbounded.  The deadline
  is the load-bearing half: fetch's abort signal tears down an in-flight
  body read, so a request *with* a timeout was already bounded by bandwidth
  times deadline, while one without was bounded by nothing.  Defaults are 30
  s and 8 MiB, both configurable through the new `HttpClientOptions` family
  and overridable per request.  The body is now read chunk by chunk and
  refused at the crossing chunk with `HttpResponseTooLargeError`, because a
  cap checked on `arrayBuffer()`'s result is a cap enforced after the
  allocation it was meant to prevent.  BREAKING: a call that previously ran
  without a deadline now aborts after 30 s, and a response over 8 MiB now
  throws.

  *Migration:* pass `timeoutMs: 0` on a request that legitimately has no
  deadline; raise `maxResponseBytes` on the request or on the client for one
  that legitimately downloads more than 8 MiB.

- **BREAKING — `HttpClient` has a redirect policy of its own instead of
  inheriting the platform's** (#625).  No `redirect` was ever passed to
  fetch, so redirects were followed unconditionally, 20 hops deep, with no
  way for any caller to opt out.  Severity is low and honestly so — there is
  no attacker-reachable path to it in this repo, and the runtime already
  strips credentials on a cross-origin hop — but the safe behaviour was
  simply unreachable from the API, which is the actual defect.  `redirect`
  (`'follow'` | `'error'` | `'manual'`) and `maxRedirects` join the same
  options family, per client and per request.  Following now happens in the
  client rather than the platform, so the decisions land between hops rather
  than after them: a cross-origin hop drops
  `authorization`/`cookie`/`proxy-authorization`, a 303 (and a 301/302 after
  a POST) continues as a GET with the body dropped per the Fetch spec, a
  non-HTTP(S) target is refused outright, and the deadline and byte ceiling
  stay cumulative across the chain.  `HttpClientResponse` gains `url`, the
  hop that actually answered.  BREAKING: the hop budget drops from 20 to 5.

  *Migration:* raise `maxRedirects` on the client or the request if a chain
  legitimately needs more than 5 hops; `redirect: 'follow'` remains the
  default, so nothing else changes.

- **CORS decoration no longer discards a handler's own `Vary` header**
  (#603).  The decorator resolved the response's existing `Vary` with an
  exact-key `headers['vary']` lookup, and nothing normalises a handler's
  header record on the way there — so a handler that answered `Vary: Cookie`
  was invisible and the response went out as a bare `Vary: Origin`.  That
  tells shared caches the response does not depend on the cookie, which lets
  one user's response be served to the next.  The existing value is now
  resolved case-insensitively and merged, so the response carries a single
  `Vary: Cookie, Origin`.  Relatedly, `applyHeaders(…, { overwrite: true })`
  now replaces a differently-cased key instead of leaving two spellings of
  one header name in the record, where only insertion order decided which
  reached the wire.

- **A file extension can no longer resolve a content-type through the
  prototype chain** (#608).  `contentTypeFor` indexed both its override map
  and the built-in table with a bare `map[ext]`, and the extension comes
  straight off the request path.  A served file named `report.constructor`
  therefore threw a `TypeError` out of the static-file handler — a 500 where
  the documented answer is `application/octet-stream` — and when an override
  map was passed, the same lookup returned the `Object` function itself out
  of a signature that promises `string`, which nothing downstream catches
  because `HttpResponse.contentType` is typed `string | undefined`.  Both
  reads are now gated on `Object.hasOwn` and narrowed to a non-empty string,
  stated positively rather than as a list of names to refuse: an own key a
  caller deliberately maps still wins, an inherited member never does.  Only
  `constructor` and `__proto__` were ever reachable, since the extension is
  lowercased before lookup.

- **`serializeCookie` validates the `Path` and `Domain` attributes it
  writes** (#626).  Both were interpolated into the header verbatim while the
  guard block covered only the cookie name, the value, the two prefixes and
  `maxAgeSeconds` — so a `Path` of `/;Domain=evil.example` appended an
  attribute of somebody else's choosing, and because `Domain=` is emitted
  before `Path=` and RFC 6265 §5.3 keeps the *last* `Domain` it saw, the
  smuggled one overrode a legitimate one rather than losing to it.  `Path`
  must now be a slash-rooted printable-ASCII string free of `;`, `,` and
  space; `Domain` must be RFC 1123 labels, optionally with the legacy
  leading dot, which means an internationalised domain has to arrive
  punycoded.  An invalid `expires` Date is rejected too, instead of
  stringifying to `Expires=Invalid Date` and sessionising the cookie
  unnoticed.  Nothing shipped was exploitable: the only in-repo caller is the
  CSRF middleware, which passes a constant attribute bag, so this is
  hardening rather than the closing of a live hole.

- **A node whose configuration sets `actor-ts.remote.tls.enabled = true` now
  says at startup that its cluster wire is still plaintext** (#591).  The key
  shipped in `reference.conf` and was documented on four pages, but nothing
  under `src/` read it and the `Cluster` constructor hard-codes `null` for
  the TLS argument of the transport it builds — so an operator who
  configured encryption got none, with no error, no log line and no way to
  tell from the running node.  The constructor now reads the key and logs one
  `WARN` naming it, stating that the wire is unencrypted and pointing at
  #941, where TLS itself is implemented.  The warning is raised only for the
  transport the cluster builds for itself — an injected
  `ClusterOptions.withTransport(…)` may carry its own TLS material — and
  only for an explicit `true`, so a configuration file that spells the
  shipped `false` out stays silent.  Reading the key also empties the
  dead-key guard's exemption list: no key in `reference.conf` is excused
  today.  TLS for the built-in transport is still not implemented.

- **Snapshots stored in object storage can now be integrity-protected**
  (#613).  `ObjectStorageSnapshotStore` had no integrity plumbing at all and
  silently discarded `PersistenceOptions.integrity` on both the write and
  the read path — and recovery folds events *on top of* a snapshot, so
  whoever could rewrite one dictated the state an actor came back as.  It now
  takes `integrity` and `allowUntaggedBodies`, signs bodies on `save`, and
  verifies on `loadLatest` and `loadBefore`.  `registerObjectStoragePlugins`
  forwards both to the snapshot store **and** the durable-state store, which
  previously had no way to reach the option through the one-call wiring
  either.  `IntegrityConfig`, `IntegrityResolver` and `resolveIntegrity` are
  exported from the package — the option was typed with names it did not
  export.

## [0.15.0] — 2026-08-12

### Added

- **`EventStream` channels can be `kind`-discriminated types, not just
  classes** (#1143).  `subscribe`/`unsubscribe` took a class constructor and
  matched with `instanceof`, which locked the one API the project offers for
  loosely coupled fan-out to exactly the message style the project argues
  against: `AGENTS.md` mandates `kind`-discriminated named variant types, and
  `fundamentals/messages` says outright to prefer plain objects over classes.
  Such a type has no constructor, so there was nothing to hand `subscribe`.
  The asymmetry was visible in the signatures — `publish(event: object)` has
  always accepted a plain object, so you could publish something nobody was
  able to subscribe to.

  A channel is now named three ways.  By a **class**, exactly as before.  By an
  **`EventKey`** — a new export mirroring `ServiceKey`/`ShardKey`, a `kind`
  plus a phantom type parameter, so a type and a `const` of the same name give
  a plain event the call shape a class gets for free:

  ```ts
  export type UserLoggedInEvent = { readonly kind: 'user-logged-in'; readonly userId: string };
  export const UserLoggedInEvent = EventKey.of<UserLoggedInEvent>('user-logged-in');

  eventStream.subscribe(self, UserLoggedInEvent, (event) => event.userId !== 'system');
  eventStream.publish({ kind: 'user-logged-in', userId: 'user-42' });
  ```

  Or by the bare **kind string**, the shorthand — which costs the type, since
  `TEvent` has nothing to be inferred from and falls back to `unknown`.
  Supplying the argument brings the typing back and makes the string itself
  checkable: `EventKey.of<UserLoggedInEvent>('user-loged-in')` and
  `subscribe<UserLoggedInEvent>(ref, 'user-loged-in')` are both compile errors,
  which is the one thing the bare string cannot give you.

  A key and its string are the **same** channel — subscribing both ways dedups,
  and either form unsubscribes the other, including a freshly built key.  That
  is why a subscription is filed under the kind string rather than the key
  object: `EventKey.of` mints a new instance per call, so an object identity
  would make the obvious `unsubscribe` call a silent no-op.  A class and a kind
  are **two** channels even when the class's instances carry that `kind`; they
  select overlapping events exactly like a base class and its subclass.

  Internally the channel is resolved once at subscribe time into an identity, a
  `matches` closure and a label, rather than being discriminated per delivery:
  `publish` runs on every actor start, every actor stop and every dead letter.
  Class channels are untouched — `instanceof` matching, subclass instances
  still reaching base-class subscribers, and dedup identity still the
  constructor object.

  **Not included:** prefix or wildcard families (`'billing.*'`).  A kind channel
  matches exactly one kind, and the docs say so.  Turning "name a channel" into
  "name a pattern" forces answers on dedup identity, unsubscribe identity and
  precedence against exact channels; it is purely additive later.

  Two behaviour changes fall out.  `unsubscribe` now tests `channel !== undefined`
  instead of truthiness — with kind strings legal, `''` is a *supplied* channel
  that reads as falsy, and the old shape would have taken the omitted-channel
  branch and dropped every subscription the actor held.  And both operations
  reject a channel that is neither a usable `instanceof` right-hand side nor a
  non-empty kind.

### Changed

- **BREAKING — the default mailbox is unbounded again** (#1148).  Every actor
  spawned without an explicit `mailboxCapacity` now gets the plain, unbounded
  `Mailbox`.  Since #310 it got a `BoundedMailbox` with `capacity = 10_000`
  and `overflow = 'drop-head'`, which silently discarded the *oldest* queued
  message on overflow — no dead letter, no exception, only a counter.

  #310's trade was worst-case message loss for a guaranteed memory ceiling.
  The ceiling turned out not to exist: the system-message queue was never
  bounded (#794), so the framework was paying the loss without collecting the
  guarantee.  And the loss was not confined to the telemetry-shaped workloads
  `drop-head` suits, because a mailbox cannot tell a stale sample from a
  control message — the bug tracker has one entry per victim: death-watch
  `Terminated` evicted and the watcher blinded (#729), ReliableDelivery sends
  discarded with their `confirm` never settling (#732), DistributedData
  `updateAsync` promises stranded unsettled (#1078), and three WebSocket-hub
  defects where the evicted envelope was a spawn command, a `close()` or a
  disconnect signal (#717, #985, #986).  None of those are reachable under the
  new default.

  **Migration.**  Nothing to do if you want the unbounded shape — it is the
  default.  To keep a bound, say so at the spawn site:

  ```ts
  // before — the bound was implicit, and so was the drop policy
  system.spawn(Worker, 'worker');

  // after — bounding is the deliberate act, and it names its own loss
  const workerOptions = ActorOptions.create<WorkerMessage>()
    .withMailboxCapacity(10_000)
    .withMailboxOverflow('drop-head');
  system.spawn(Worker, 'worker', workerOptions);
  ```

  Unbounded does not mean unobserved.  `ActorCell` warns when a mailbox
  crosses 10 000 queued messages and again at every doubling, and metrics
  gained the `actor_mailbox_size` gauge that the tuning docs had been
  documenting for a gauge that did not exist.  `actor_mailbox_dropped_total`
  still exists and now only counts drops someone asked for.

  Also in this change: `mailboxOverflow` / `withMailboxOverflow` is a real
  `ActorOptions` field (default `drop-head`; setting it without a capacity is
  rejected rather than silently ignored), and `Mailbox` + `Envelope` are
  exported from the package root — the escape hatch the docs described was
  previously impossible to import (#661).

- **Every mailbox reports its drops, not just the one the framework built**
  (#1149).  `actor_mailbox_dropped_total` was fed by an `onDrop` the cell
  passed into the `BoundedMailbox` it constructed, so a mailbox supplied
  through `withMailbox` was invisible to it.  That was a corner while the
  default was bounded; #1148 made bounding an opt-in and both ways of opting
  in equally idiomatic, so it became a trap.

  The cell now registers its observer *after* choosing the mailbox, on
  anything implementing the new `DropReportingMailbox` contract —
  `BoundedMailbox` does, and a `Mailbox` subclass of your own can by adding
  `observeDrops`.  A structural probe rather than an `instanceof` check,
  because #661 made the base class public and a queue that discards for its
  own reasons should not be second-class in the telemetry.

  Registration is **additive**: a `BoundedMailboxOptions.onDrop` of your own
  keeps firing alongside the stock counter.  New exports:
  `DropReportingMailbox` and `MailboxDropReason`, the latter now naming the
  `'drop-head' | 'drop-new'` union that was written inline in four places.

- **Three of the framework's own identifier draws go through the `exists`
  predicate** (#1146).  The follow-up #1141 deferred.  The framework mints
  twelve identifiers; the interesting result of the survey is that only three
  of them should check anything, and the other nine are recorded on the issue
  with the reason rather than left to be re-derived.  `ActorCell`'s anonymous
  child names now draw against `this._children`, `ORSet.add` against the
  element's live tags *and* its tombstones, and `ClusterClient.ask`'s id
  against the pending map.  What they have in common is a registry in scope and
  a failure that is silent or costly: `_createChild` throws over a duplicate
  name, `pending.set` overwrites so a repeat leaves the earlier ask's promise
  hanging until it reports a timeout that never happened, and a repeat of a
  *tombstoned* ORSet tag is vetoed by the rule that stops a slow peer
  resurrecting a removed tag — the element simply fails to appear on the next
  merge, with no error anywhere.  `nextAskId` takes the pending map rather than
  a ready-made predicate, so the one thing a call site could get wrong — the
  polarity, where `true` has to mean *taken* — is written once and covered by a
  test.  The nine sites left alone have nothing to check: a reply ref that is
  never entered in a visible map, trace ids that have to be unique across
  processes anyway, a lock token whose "is it taken" question `setIfAbsent`
  already answers atomically, a correlation id that only reaches a log line.
  `DistributedData` is the one exclusion with a real registry — its `pendingId`
  is minted a `tell` away from the map it keys and is part of a wire-visible
  message contract, so moving the mint is a design change, tracked as #1147.
  No public API changes, and no behaviour change on the happy path: the entropy
  already made every one of these collisions astronomically unlikely, so the
  new tests replace the entropy with a constant to force the repeat and assert
  the specific damage it used to do.

- **Constants have a placement rule, and follow it** (#1142).  `src/` held
  ~300 module-level `SCREAMING_SNAKE` constants across 130 files with no
  documented rule for where any of them belonged; nine lived in
  `src/util/Constants.ts` and the rest sat wherever they were first needed.
  A constant now has exactly four possible homes, checked in order: beside
  its field in `XOptions.ts` when it is an options default; where it already
  is when it *is* its file's implementation (a codec's tag vocabulary, a
  parser's regex, a singleton, a derived value, a frame-schema bound); in
  `src/<subsystem>/Constants.ts` for every other tuned cap, bound or
  timeout; and in `src/util/Constants.ts` only when two or more subsystems
  consume it.  The rule is written down in AGENTS.md, and
  `docs/…/reference/configuration.mdx` now says where the built-in default
  behind a `reference.conf` key lives.

  Eight `Constants.ts` modules hold 42 values; ~20 misplaced options
  defaults moved next to the option they back.  **Every public name is
  unchanged** — the barrels re-export from the new location, so no import
  breaks.  Two structural gains fall out of it: an `XOptions.ts` no longer
  imports a functional module to reach a default it shares with another
  options type (`DEFAULT_SQLITE_BUSY_TIMEOUT_MS`,
  `RESERVED_SERIALIZER_IDS_BELOW`), and `ClusterSharding` no longer
  value-imports the 700-line `ShardRegion` actor for one integer.

### Fixed

- **One faulty `EventStream` subscription no longer breaks the bus for
  everyone else** (#1010).  `publish` guarded the subscription's *predicate*
  but not its *channel*: the `instanceof` test sat one line above the `try`
  and `subscriber.tell` ran unguarded below it, so of the three things that
  can throw per subscription exactly one was covered.  `subscribe` was the
  other half — it deduplicated, pushed and returned `true` without ever
  checking that the channel could sit on the right-hand side of `instanceof`.

  A single bad entry therefore raised a `TypeError` into whoever called
  `publish`, and because the throw escaped the loop, every subscription
  registered *after* it silently stopped receiving anything — in an order
  decided by subscription order, which no caller controls.  That reached
  further than the bus: `publish` runs on every actor start, every actor stop
  and every dead-lettered `tell`, so it turned `ref.tell(…)` — an API that
  does not throw by contract — into one that did, broke actor creation, and
  raised an unhandled dispatcher rejection during shutdown.

  `subscribe` now rejects a channel that is not a usable `instanceof`
  right-hand side, throwing on the line that wrote the subscription instead
  of poisoning an unrelated `publish` in another actor later.  It throws
  rather than returning `false`, because `false` already means "duplicate
  rejected" and conflating the two destroys the signal the return value
  carries.  The realistic route to a bad channel is one types do not cover:
  a JavaScript consumer, a channel read out of a loosely-typed registry, or
  an ESM import cycle in which the class binding is still uninitialised at
  subscribe time.

  Subscribe-time validation cannot be total, which is why the delivery guard
  is not belt-and-braces: an arrow function is callable but has no
  `prototype`, so `instanceof` throws on it regardless, and a throwing
  `[Symbol.hasInstance]` passes any structural check and fails at delivery.
  So `publish` now runs the match test, the predicate and `subscriber.tell`
  under a guard, logs through the existing logger hook and carries on to the
  next subscriber.  The predicate keeps its own inner guard: "no match for
  this delivery, subscription stays active" (#85) is a specific documented
  meaning that a generic delivery guard would flatten into an unexplained
  skip.  The warning path no longer reads `channel.name`, which was itself
  unsafe precisely when the channel was the thing that was wrong.

  **Behaviour change:** a `subscriber.tell` that throws is now logged and
  swallowed rather than propagated out of `publish`.

- **A collision predicate on every random-id helper** (#1141).  `randomString`,
  `randomHex`, `randomId` and `randomUuid` now take an optional `exists`
  callback and draw again while it answers `true`, so the loop every caller
  wrote by hand — `do { id = randomUuid(); } while (state.users.has(id))` —
  collapses into `randomUuid((id) => state.users.has(id))`.  The polarity is the
  design: the callback *is* that `while` condition, which is what keeps the `!`
  off the call site and lets the two shapes read as one sentence; an
  accept-predicate would have been the negation of the loop it replaces, and
  would have put a `!` on every `Map`- or `Set`-backed call site.  The retry is
  bounded at 1 000 draws and then throws an `Error` naming the helper and the
  count — the same bound, and the same reasoning, as `freeActorName` in
  `src/devtools/internal/ActorNames.ts`.  Unbounded, a space with nothing free
  left in it and a predicate written the other way round both become a call that
  never returns, and this module had already decided that question when it made
  an empty alphabet throw.  `randomString` reaches the predicate through
  overloads — the second slot when the character classes are left alone, the
  third when they are not — so no call site needs a `{}` placeholder to get
  there, and `randomId` deliberately forwards no predicate into its `randomHex`
  delegation, which would otherwise nest a second bounded retry inside the first
  and name the wrong helper in the error.  `ExistsPredicate` is exported from
  the root barrel next to `RandomStringOptions`, for anyone naming the callback
  rather than inlining it.  Nothing changes without one: the argument is
  optional and trailing, the no-predicate path is a single draw with no loop,
  and `randomUuid` is still the `() => string` that
  `RequestIdOptions.withGenerate` defaults to.  The predicate reads and does not
  write — the accepted value is not recorded for you.  Migrating the framework's
  own draws onto it is not part of this change.

- **A dead constant and its live duplicate** (#1142).
  `DEFAULT_SNAPSHOT_CACHE_TTL_MS` had zero importers while the consumer its
  own docblock named, `CachedSnapshotStore`, declared the same five minutes
  locally as `DEFAULT_TTL_MS`.  Exactly the drift the shared-constants
  module was introduced (#257) to prevent, and invisible because knip's
  `exports` rule is off.  One declaration now, in
  `CachedSnapshotStoreOptions.ts` where the `ttlMs` field is.

- **`reEncryptionSweep` rebuilt the ATS1 magic prefix** (#1142) instead of
  importing the `ATS1_MAGIC` that `BodyCodec` already exports — a second
  copy of a format definition, in a file that already imported four other
  things from the codec.

- **The heartbeat interval existed twice** (#1142).
  `defaultFailureDetectorOptions` and `defaultPhiAccrualOptions` each
  carried `heartbeatIntervalMs: 500`, so swapping detectors could silently
  change how often a node talks to its peers.  Worse, only the first was
  pinned to `reference.conf` by a test; the φ-accrual copy was pinned to
  nothing.

- **Two independently-introduced redraw caps** (#1142).  `randomId`'s
  `exists`-predicate loop and DevTools' `freeActorName` each declared
  `MAXIMUM_ATTEMPTS = 1_000`, and the second one documented the coupling in
  prose ("the same bound, and the same reasoning, as `freeActorName`") —
  which is precisely the kind of coupling a comment cannot hold.  Now one
  `MAXIMUM_DRAW_ATTEMPTS` in `src/util/Constants.ts`, since both subsystems
  answer the same question for the same reason.

- **Unnamed literals mirroring `reference.conf`** (#1142): the dispatcher
  throughput was written out as a bare `16` in three places
  (`ActorSystem`, and twice in `Dispatcher`), and `ShardCoordinator`
  resolved its rebalance interval and hand-off timeout against `?? 2_000`
  and `?? 10_000`.  All now named, and verified to match the HOCON leaves
  they mirror.  Also de-duplicated: `LOCAL_ADDRESS` and `TOP_MAILBOX_COUNT`
  in devtools, the DynamoDB batch limit, and the explain ring's default
  capacity, which the runtime API and the DevTools RPC each answered
  separately.

### Security

- **One path-traversal denylist instead of two** (#1142).  `ActorPath` and
  `PersistenceIdValidator` each declared `new Set(['.', '..'])` under a
  different name.  Both guard against the same attack — a persistence id
  becomes a filesystem or object-storage key where `..` climbs out of the
  configured prefix (#133), a path segment reaches actor-selection
  resolution — and neither imported the other, so extending one would have
  left the other accepting what it now rejects.  Shared as
  `PATH_TRAVERSAL_SEGMENTS`, typed `ReadonlySet` so a caller cannot delete
  from it.  No behaviour change: both sites reject exactly what they did
  before.


## [0.14.0] — 2026-08-11

### Added

- **`randomUuid()`** (#1109).  A random version-4 UUID, exported from
  `src/util/RandomString.ts` next to `randomId` and re-exported from the root
  barrel alongside it.  It closes the one identifier question that module could
  not answer with an alphabet and a length: `randomId(12)` is ~48 bits and only
  has to be unguessable among the names one process holds live at once, while a
  `PersistenceId`, a correlation id crossing a broker, or a key another system
  will read later has to stay distinct from identifiers minted in other
  processes, on other machines, years apart, with nothing coordinating them —
  122 random bits are what makes that hold.  Until now the docs answered it by
  sending the reader out of the framework to `crypto.randomUUID()`, which is
  also what three call sites in `src/` do, in two different spellings.  It
  delegates to `globalThis.crypto.randomUUID()` rather than dashing up a
  `randomHex(32)`: six of the 128 bits are the version and variant fields RFC
  9562 fixes, so a hex string with dashes in the right places only looks like a
  UUID and anything parsing a version out of it reads garbage.  No `length`
  parameter — slicing a UUID down is the mistake the module exists to make
  unnecessary.  Smoke-tested on Bun, Node and Deno, since `crypto.randomUUID` is
  a second Web API off the same object as `getRandomValues` and a runtime can
  carry one without the other.  Migrating the existing call sites onto it is not
  part of this change.

- **`CborSerializer` carries the same rich types as the JSON tree** (#1036).
  `Map`, `Set`, `BidirectionalMap` and `BidirectionalMultiMap` used to fall
  into the CBOR encoder's generic object branch, where `Object.entries` is
  `[]` or near enough: they encoded as an empty `{}` and every entry was
  lost, with nothing raised.
  Anyone who set `withSerializer(new CborSerializer())` on a store — for row
  size or for speed — silently lost data the default codec kept.  `RegExp`,
  `URL`, `Error` and the typed arrays were flattened the same way, and `-0`
  came back as `+0`.

  All of them now round-trip as real instances.  Registered CBOR tags are
  used wherever one fits the type faithfully — 258 for `Set`, 259 for `Map`
  (over a native CBOR map, so the entries cost what a plain object's would),
  32 for `URL` — and everything else goes under tag 27, the IANA
  "serialised language-independent object with type name and constructor
  arguments", decoded through a fixed name allow-list.  `Map` needs its tag
  despite CBOR having a native map type: that is exactly what a plain object
  encodes to, so the two would be indistinguishable coming back.

  A shared suite (`tests/unit/serialization/RichTypeParity.test.ts`) runs one
  value table through both codecs and asserts they agree, guarded by the JSON
  tree's `TYPE_TAGS` — a new type tag with no CBOR counterpart fails the
  suite rather than shipping as silent data loss.  It earned its keep
  immediately: `BidirectionalMultiMap` (#1037) landed on `develop` while this
  was in flight and the guard caught the missing CBOR side on the merge.

  RFC 8746 registers typed arrays as tags 64–87 and this deliberately does
  not use them: `DataView` and `ArrayBuffer` have no tag there, `Uint8Array`
  already travels as a bare byte string, and 8746 would force a CBOR-only
  endianness table with no counterpart on the JSON side.  Both codecs now
  read one shared binary-kind table instead.  Non-`Uint8Array` binary is
  little-endian, which the JSON tree has quietly assumed since #889 and which
  is now written down.

- **`cluster_gossip_records_refused_total{reason}`** (#114, #138).  Counts
  gossiped member records a merge-path guard turned away.  `reason` is closed to
  `version-skew`, `map-cap` and `timestamp-skew` so the series count cannot
  follow an attacker's record count — the cardinality lesson from #131 applied at
  the point where it would have hurt most.

- **Utility helpers on the public surface** (#1034).  `randomString`,
  `randomHex`, `randomId`, `safeStringify` and `lazyImportModule` are now
  re-exported from the root barrel, together with the `RandomStringOptions`
  and `LazyImportOptions` types.  All five already existed under `src/util/`
  and the framework runs on them; nothing but the barrel kept them from
  consumers, since `package.json` ships only `dist/` and its `exports` map has
  no wildcard.  Each answers a problem that does not stop at the framework
  boundary: `randomId` names something so the name cannot be guessed — an
  actor name ends up in an actor path, and a path is an address that anything
  on the cluster wire can send to, which is why a counter is the wrong shape;
  `safeStringify` renders a value on a path where `JSON.stringify` would throw
  on a cycle or a `BigInt` and so replace the error being reported with one
  thrown from inside the reporting code; `lazyImportModule` imports an
  optional peer dependency or fails with a message naming the package and the
  install command — the pattern the docs already recommend for user-written
  integrations.  `wrapError`, `mergeOptions`, `CidrMatch` and the shared
  `Constants` stay internal, and `TokenBucket` deliberately so: #636 is an
  open bug in it and #666 changes its options shape, so exporting it now would
  turn both into breaking changes to a published API.  Documented on the new
  bilingual `reference/utility-helpers` page.

- **`actor-ts.distributed-data` HOCON block** (#856).  DistributedData read
  no configuration at all before this; it now layers `gossip-interval`,
  `max-pending-quorum-requests` and `max-quorum-timeout` under the explicit
  options in the documented precedence (options > HOCON > built-in
  defaults).  The block is top-level rather than under `cluster.*` because
  the module ships from `src/crdt/` and takes its cluster as a positional
  argument to `start`.  Only keys something actually reads are shipped, so
  the delta-CRDT, pruning and subscriber-notification keys the issue lists
  stay out until the features behind them exist.

- **Scatter/gather router** (#153).
  `Router.scatterGatherFirstCompleted(size, routee, options?,
  routeeOptions?)` asks every routee at once and answers the caller with the
  first reply — Akka's `ScatterGatherFirstCompletedPool`, the hedged-request
  pattern for tail latency.  The fan-out is fired without being awaited in
  the handler, so concurrent scatters overlap instead of serialising the
  router's mailbox; every failure rejects with an `AggregateError` carrying
  one error per routee (the message distinguishes "nobody replied in time"
  from "everyone failed"); the winning reply is attributed to the routee
  that produced it; and stopping or restarting the router fails its open
  scatters immediately rather than running out the configured clock.
  Configured through the new `ScatterGatherOptions` (`withTimeoutMs`,
  default 4 500 ms — deliberately under the 5 000 ms `ActorRef.ask`
  defaults to, because the router can only name the failing routees after
  its own deadline has passed and it has collected their errors.  At an
  equal 5 000 the caller's own `ask` won that race, so on the documented
  entry point — `scatterGatherFirstCompleted(n, R)` plus a bare
  `pool.ask(msg)` — you got `AskTimeoutError` and never the
  `AggregateError` the router exists to produce (#1088).  Validated at the
  factory call), instrumented with
  `router_scatter_gather_resolved_total{outcome}` and
  `router_scatter_gather_latency_seconds`, and documented on the new
  bilingual `routing/scatter-gather` page.
- **TCP listener actor** (#158).  `TcpServerActor` binds a port and serves
  every connection it accepts, closing the one half of the raw-TCP API that
  was genuinely missing — framing applied per accepted connection with its
  own re-assembly buffer, TLS and mTLS through the same cross-runtime TCP
  layer the cluster transport uses, and a `maxConnections` admission cap
  that refuses at the door rather than accepting a socket nobody reads from.
  Connections are addressed by an opaque `connectionId` instead of getting
  an actor each, because an actor's restart semantics cannot resurrect a
  peer's TCP connection; the configured `target` receives one kind-tagged
  union (`connectionOpened` / `frame` / `connectionClosed`) and the actor
  takes `send` and `close` for a single connection.  A frame past its size
  cap drops only the offending connection, a half-configured `tls`
  credential fails the actor's start instead of retrying forever behind the
  reconnect policy (#144), and `outboundBuffer` defaults to `0` because a
  write buffered while the port is down names a connection id that can never
  come back.  Configurable under `actor-ts.io.broker.tcp-server`; `tls` is
  code-only on purpose, since a config file is the wrong place for a private
  key.
- **`TcpFraming` moved to its own module** (#158).  The three framing
  strategies and their two size caps are now shared by `TcpSocketActor` and
  `TcpServerActor` rather than copied, so the parsing that four open
  security issues hang off exists once.  Behaviour is unchanged and the
  package-root export is unchanged; only a deep import of `TcpFraming` from
  `io/broker/TcpSocketActor.js` has to move to `io/broker/TcpFraming.js`.
- **Cluster subscriptions: `CurrentClusterState` snapshot replay +
  `ReachabilityChanged`** (#161).  `cluster.subscribe(listener, {
  replayMode: 'snapshot' })` replaces the per-member replay burst with one
  `CurrentClusterState` carrying the members, the unreachable subset and the
  leader — one callback instead of one per member, and it marks where the
  replay ends, which the event form cannot; the default stays `'events'`,
  unchanged for every existing subscriber.  The same change fixes what that
  replay used to say: it walked the raw member map and stopped after `up`,
  so a `removed` tombstone — kept for up to `tombstoneTtlMs`, a day by
  default — was replayed as `MemberJoined` for that whole day, and an
  `unreachable`, `leaving` or `down` member reached a late subscriber as
  nothing but `joined`.  The replay now follows `getMembers()` in address
  order and announces each member in the status it actually holds.
  `ReachabilityChanged(address, reachable)` is new alongside it:
  `MemberUnreachable` is a membership transition, so it also fires for a
  peer that *someone else* stopped hearing from — status travels in gossip —
  and it is only ever emitted for a member that was `up`, leaving a peer
  that falls silent while `joining` or `leaving` with no reachability signal
  at all; the new event is strictly the local failure detector's verdict,
  emitted on transition.  It carries no observer set — that needs an
  observer-to-subject table on the wire.  `MockCluster.subscribe` mirrors
  the real replay event for event, and the DevTools `cluster` stream gains a
  `reachability-changed` payload.

- **JetStream Key-Value actor** (#74).  `JetStreamKeyValueActor` +
  `JetStreamKeyValueOptions` bring JetStream's KV view into the actor
  system: `put` (with an optional `expectedRevision` for compare-and-swap
  writes), `get`, `delete`, `purge`, `keys`, and a `watch` / `unwatch`
  change feed.  Replies are `kind`-tagged messages delivered to the `target`
  the command carries, the same request/reply seam `GrpcClientActor` uses; a
  `watch` is held as desired state by `BrokerActor`, so it survives a
  reconnect and one issued during an outage lands on the next connect.  A
  per-key failure — a compare-and-swap conflict, say — is reported as
  `keyValueOperationFailed` rather than thrown, because throwing out of the
  dispatch path is how the base class learns the transport died.
  Configurable under `actor-ts.io.broker.jetstream-key-value`.
- **JetStream Object Store actor** (#74).  `JetStreamObjectStoreActor` +
  `JetStreamObjectStoreOptions` cover the object-bucket view with `put`,
  `get`, `delete`, `info` and `list`.  v1 moves an object as a **single
  message** and enforces that with `maxObjectBytes` (1 MiB by default): an
  oversized `put` is refused before the body enters the bounded outbound
  buffer, and an oversized `get` is refused from the object's metadata
  before the body is fetched — the buffer is sized in messages, not bytes,
  and evicts oldest-first, so a multi-megabyte body riding it would mean
  unbounded resident memory and silently discarded uploads.  Both refusals
  answer `objectStoreOperationFailed` naming the limit; `info` and `list`
  are unaffected.  Configurable under
  `actor-ts.io.broker.jetstream-object-store`.
- **DistributedPubSub anycast** (#155).  `Publish` takes a third argument,
  `delivery`, and `'one-subscriber'` hands the message to exactly one
  subscriber cluster-wide instead of all of them — the work-queue shape,
  where N workers share a topic and every task is handled once, and the one
  thing a broadcast bus cannot do without the workers coordinating among
  themselves.  Selection rotates a per-topic cursor over the local
  subscribers and the remote nodes claiming the topic, so ten tasks over
  three workers land 4/3/3 rather than "probably roughly even"; a remote
  node counts as one candidate however many subscribers sit behind it,
  because the gossip frame deliberately carries topic names and not
  subscriber counts (#80), which is also the granularity Akka routes at.
  `ClusterRouter` has load-balanced across cluster members since 216db160,
  but only over routees it spawns or looks up — anycast is for a recipient
  set that registers and leaves at runtime and that the publisher never
  names.  An anycast with no candidate, and one that crossed a hop to find
  the far side's subscribers gone, both go to dead letters; the second is
  not re-routed, which would trade the at-most-one-hop guarantee for a race
  against the gossip round about to correct the sender.  **BREAKING:** the
  third constructor slot used to be `sendOneMessageToEachGroup`, Akka's
  per-consumer-group anycast flag, which nothing ever read because this
  mediator has no groups for it to range over — `new Publish(topic, message,
  true)` broadcast to every subscriber, exactly as `false` did.  Migrate by
  **dropping the argument**: `new Publish(topic, message)` keeps the
  behaviour both values actually had.  Do **not** rewrite `true` to
  `'one-subscriber'` — the old flag was a no-op and the new value is not, so
  the swap silently turns a fan-out to every subscriber into a delivery to
  exactly one.  Reach for `'one-subscriber'` only where anycast is what you
  want.
- **Live and cursor-paginated persistence-id queries** (#156).
  `PersistenceQuery` gains `allPersistenceIds()` — a live stream of every
  persistence id the journal has seen plus each new one as it first appears,
  the fan-out primitive for starting a per-entity consumer as its entity
  shows up — and `currentPersistenceIdsPaginated()`, which walks the same
  ids a page at a time (`pageSize`, default 256; `afterPersistenceId` to
  resume) instead of materialising all of them into one array.  The cursor
  is a persistence id rather than an opaque token, so a checkpoint stays
  readable and reconstructible.  Paging is pushed into the backend wherever
  a sorted key over ids exists — `ORDER BY … LIMIT` on SQLite and on all six
  relational backends via `SqlDialect.rowLimit`, a clustering-column range
  over the `all_persistence_ids` partition on Cassandra — through a new
  **optional** `Journal.persistenceIdsPaginated`, which no journal
  implementer has to add; MongoDB (`distinct` has no cursor) and DynamoDB (a
  `Scan` has no order across partition keys) have no such index and fall
  back to an in-process page.  **BREAKING:** the two query methods are
  required on `PersistenceQuery`, so an out-of-tree `implements
  PersistenceQuery` must add them — extend `InMemoryQuery` to inherit both,
  or implement them over `Journal.persistenceIdsPaginated` and the exported
  `persistenceIdPage` helper.  `currentPersistenceIds()` is unchanged and
  deliberately not deprecated: a small journal is a permanent case, not a
  legacy one.

- **gRPC client-streaming as its own call mode** (#5).  `GrpcClientCommand`
  gains `clientStreamStart` / `clientStreamSend` / `clientStreamClose`, and
  `GrpcHandler` a fourth `clientStream` kind carrying a
  `GrpcClientStreamCall` (consume the request stream via `onData`, answer
  once via `respond` / `respondError`) — so all four gRPC call classes are
  now genuinely covered, which the documentation had already claimed in both
  languages while the mode was simply absent.  The handshake deliberately
  does **not** copy bidi's: `clientStreamStart` answers with a new
  `stream-started` inbound frame carrying a `GrpcStreamHandle` whose `token`
  is 64 bits of crypto-grade randomness, so the registry lookup is itself
  the ownership check rather than a guessable sequential id — bidi keeps its
  in-band `{ __streamId }` handshake until #788 migrates it onto the same
  seam.  **BREAKING:** `GrpcInbound` gains `stream-started`, so an
  exhaustive `match` over it needs one more arm.
- **Request-stream chunks are no longer lost before the handler subscribes**
  (#5).  `handler.target.tell(call)` only enqueues, so a `clientStream` or
  `bidi` handler cannot have called `onData` by the time grpc-js starts
  pushing — the opening chunks were silently dropped, which for a
  client-streaming call is the entire request.  Both modes now hold what
  arrives early and replay it on the first subscribe.
- **`buildGrpcMethodImplementation` exported from `src/io/broker`** (#5).
  The server's method-implementation builder is now a free function over a
  handler descriptor, the same seam `grpcHealthCheckImplementation` already
  uses, so all four call shapes are exercisable without `@grpc/grpc-js`, a
  bound socket or an actor system; its four arms dispatch through
  `match(...).exhaustive()`, so a fifth call class cannot be added without
  handling it.
- **Avro and Protobuf serializers** (#73).  `AvroSerializer` and
  `ProtobufSerializer` take a compiled schema you bring — an `avsc` type, a
  `protobufjs` reflection type, a JSON descriptor, or generated static code
  from pbjs / ts-proto — so neither library becomes a dependency of
  actor-ts, the same call `zodCodec` makes with `ParserLike`.  They own the
  parts that are easy to get wrong by hand: the `Buffer` coercion `avsc`
  needs on the read path (a plain `Uint8Array`, which is what base64 framing
  yields, throws deep inside its decoder on every runtime), detaching
  protobufjs's pooled writer output before it reaches a journal row, running
  `verify()` before encoding, converting a decoded `Message` to a plain
  object with defaults filled in, and refusing a payload written under a
  different manifest — which is the only guard, since Avro carries no field
  tags and Protobuf no message name.  Wire ids below 100 are rejected at
  construction.  Round-trip and byte hygiene are verified on Bun, Node and
  Deno.
- **`serializerCodec(serializer)`** (#73).  Adapts any byte-native
  `Serializer` into a migration `Codec`, so a `SchemaRegistry` can hold a
  different wire format per `(manifest, version)` — a v1 already on disk in
  Avro and a v2 written in Protobuf coexist in one stream, which a
  store-wide `withSerializer(...)` cannot express.  The bytes ride the
  journal's existing tagged-JSON framing instead of a second base64 layer,
  and the `serializerId` travels with the row so reading it back with the
  wrong serializer is a named error rather than silent nonsense.
- **Stable-observation cluster bootstrap** (#148).  `StableObservation` in
  `src/cluster/bootstrap/` polls a `SeedProvider` until the contact-point
  set has been unchanged for `stableMarginMs`, then elects the
  lowest-addressed node as the initial seed and returns both the seed list
  and the `selfElection` policy to hand to `Cluster.join`; a failed lookup
  counts as *no* observation rather than an empty set, and a set that never
  settles throws a `StableObservationError` instead of joining anyway.  Opt
  in with `ClusterBootstrapOptions.withStableObservation(...)`, tune it
  under `actor-ts.cluster.bootstrap.*`.  It closes the cold-start split
  brain (each node forming a cluster out of the subset discovery happened to
  show it) and the symmetric-seed-list deadlock, where every node listing
  every node left no node with the empty seed list ordinary self-election
  requires, so no member ever reached `up`.
- **`ClusterOptions.selfElection`** (#148).  Decides whether — and when — a
  node may declare itself the first member of a new cluster: `'immediate'`
  (the unchanged default, self-elect only on an empty seed list), `'never'`,
  or a millisecond grace after which it self-elects if no peer has promoted
  it.  The grace is what makes an address-ordered election safe against a
  cluster that is already running: the elected node dials its seeds like
  everybody else and forms a cluster only if that produced nothing, so a
  scaled-up pod whose address happens to sort first joins instead of
  splitting.
- **`CLUSTER_HOST` environment variable** (#944).  `bootstrapCluster` reads
  it ahead of `POD_IP` / `HOSTNAME` as the host a node advertises, and the
  stable-observation phase refuses a wildcard advertised host outright — an
  election ordered on `0.0.0.0` puts every node first, so every node would
  believe it won.

- **gRPC health checking** (#4).  `GrpcServerActor` can now host the
  standard `grpc.health.v1.Health` service alongside your own, so
  `grpc_health_probe`, the Kubernetes gRPC probe and gRPC load balancers can
  ask a node whether it is ready.  Enable it with
  `GrpcServerOptions.create().withHealth(registry)`, handing it the same
  `HealthCheckRegistry` that feeds the management server's `/ready` endpoint
  — `Check` answers `SERVING` only while every readiness check passes, is
  re-evaluated per call, and returns `NOT_FOUND` for an unknown service
  name; `Watch` stays `UNIMPLEMENTED`, the documented signal for clients to
  poll `Check`.  There is deliberately no boolean toggle and no HOCON leaf:
  a health service that answers `SERVING` unconditionally would keep a pod
  in rotation straight through an outage, so switching it on requires naming
  where the status comes from.  No new peer dependency — the service
  definition is generated through the `@grpc/proto-loader` the actor already
  requires.  Server reflection, the other half of #4, is not included and
  the issue stays open for it.
- **`smallest-mailbox` for the cluster router** (#69).  `ClusterRouter`
  gains the load-aware strategy the local `Router` already had: each message
  goes to the node whose routee last reported the shortest queue.  Routees
  are ordinary user actors that cannot be made to answer a framework
  question, so a responder on the fixed envelope path
  `/cluster/mailbox-depth-agent` answers for them — and because the routing
  path is synchronous, the readings are cached and refreshed on a background
  tick rather than asked for per message, which keeps the decision as cheap
  as round-robin's modulo.  A node with no usable reading is skipped rather
  than assumed idle, and a cold or fully expired cache degrades to
  round-robin order instead of dropping anything.  Tune it with
  `mailboxDepthRefreshMs` (default 200 ms) and `mailboxDepthStaleAfterMs`
  (default 1000 ms, `0` disables the expiry); a window shorter than the
  refresh that refills it is rejected at construction.  A router serves
  depths on its own node, so a single node and the homogeneous deployment
  need nothing extra — nodes that host routees but no router call
  `ClusterMailboxDepthAgent.serve(cluster)`.

- **Smallest-mailbox router** (#154).  `Router.smallestMailbox(size, routee,
  routeeOptions?)` and the exported `smallestMailboxStrategy()` send each
  message to the routee with the shortest queue, so one expensive message no
  longer parks the next 1-in-N arrivals behind it — the load-balancing
  round-robin structurally cannot do.  Ties rotate, which makes an idle pool
  behave exactly like round-robin and makes a saturated one spread its
  overflow evenly instead of piling onto a single routee; the scan stops at
  the first empty mailbox, so a pool that is keeping up costs one depth read
  per message regardless of its size.  A routee that has stopped is skipped
  rather than chosen: a terminated cell dead-letters instead of enqueueing,
  so its depth would otherwise read `0` forever and make the dead routee the
  permanently emptiest one in the pool.  A routee whose depth cannot be read
  — one that is not locally hosted — is weighed as empty instead of being
  passed over, so a mixed pool cannot starve it.  Local only in the sense
  that matters: mailbox depth is in-process state, and it stays internal to
  the runtime rather than becoming a public `ActorRef.mailboxSize`.

- **Death watch with a custom termination message** (#159).
  `context.watchWith(ref, message)` — and its `TypedActorContext`
  counterpart — registers a death watch that delivers a message of the
  watcher's own protocol instead of `Terminated(ref)`, so an actor that
  watches several kinds of actor no longer has to carry the signal in its
  message union and tell the deaths apart by ref identity.  Last call wins
  over a previous `watch`/`watchWith` of the same ref, `unwatch` removes
  either, and the registration is keyed by incarnation — a re-spawned name
  is a fresh subject that needs its own call.

- **Typed `Behaviors.intercept` / `monitor` / `logMessages`** (#152).  Three
  combinators for the concerns that cut across an actor's own logic: a
  generic interceptor that observes, transforms, drops or short-circuits
  every message before the wrapped behavior sees it; a tap that forwards
  each message to another actor (a probe, an audit trail) first, swallowing
  that delivery's failures; and per-message logging at `debug` or `info`
  with an optional formatter.  Unlike the other decorators an interceptor is
  not resolved away at startup — it stays wrapped around whatever the inner
  behavior becomes, so a behavior that returns a fresh `Behaviors.receive`
  on every message is still intercepted on the next one.

- **`acquireLock(cache, key, ttlMs)` — mutual exclusion over any `Cache`
  backend** (#141).  Exported from the package root.  It writes a random
  128-bit token and releases only while that token is still in place, so a
  holder that overran its TTL cannot evict its successor mid-critical-section;
  `release()` returning `false` reports exactly that overrun.  `ttlMs` is
  required — expiry is the only recovery path from a crashed holder.

- **The `Cache.setIfAbsent` atomicity contract is written down** (#141).  It
  was previously unstated: a hard per-key guarantee on every backend (Redis
  `SET … NX`, Memcached `ADD`, and a `Map` read/write pair the single-threaded
  event loop cannot interleave), the rule that `ttlMs` applies only to the
  write that wins, and the limit that matters — the scope is one key on one
  server, so a Memcached topology change can rehash a key onto a node that has
  never seen it and hand the same lock out twice.

- **`LogContext.runFresh(fn)` and `LogContext.runEach(entries, fn)`** (#129).
  MDC primitives for work that outlives the turn that started it.
  `AsyncLocalStorage` binds a store when an async resource is *created*, not
  when it runs, so an un-awaited promise, a later-flushed buffer or a batched
  queue drain keeps whatever context was ambient at creation time and stamps it
  onto every `tell` its continuation makes; across a tenant boundary that is a
  data leak rather than a confusing log line.  `runFresh` runs with the context
  emptied — for deferred work that belongs to nobody.  `runEach` runs each
  entry sequentially under the context captured when that entry was enqueued,
  ignoring the context ambient at drain time — for batches that mix principals.

- **Logging docs cover deferred work, tenant isolation and
  `LogContext.snapshot()`** (#129).  `snapshot()` was missing from the
  operations table despite being the only safe way to carry a context across a
  boundary — `get()` returns the live readonly reference for the whole scope,
  `snapshot()` copies afresh on every call.  The same page carried an inverted
  warning claiming raw `setTimeout` loses the MDC while `context.timers`
  preserves it; both halves were wrong — both paths propagate — and the
  corrected text names the real failure mode.

- **DevTools overview: an `actor-ts` tile in the Common section** (#911).
  The running framework version now sits beside the actor system's name —
  together they are the identity of what you are looking at — instead of
  living only in the connection badge's tooltip.  It is the first thing a
  bug report quotes, and a tooltip does not survive the screenshot people
  actually paste.  Hovering the tile still gives the tap protocol
  version.  Read from the existing `welcome.serverVersion`, so no
  protocol change.

- **`BidirectionalMap<K, V>`** (#1035).  A `Map` that also answers
  `value → key`.  It exists because a reverse index written by hand is two
  maps that have to be updated in lockstep, and the failure mode when they
  drift is silent: a stale entry keeps answering for a pair that is already
  gone.  Values back the reverse map, so they are unique and the relation is
  1:1 in both directions.  `set` binds the pair unconditionally, evicting
  whatever held either side before — the one departure from the `Map`
  contract it implements, deliberate so the type stays usable wherever a
  `Map` is expected, with `trySet` for callers that want the collision
  reported instead of absorbed.  Both directions compare by SameValueZero, so
  `NaN` works as a key and a value and two structurally equal objects are two
  different values.  `inverse()` is a view over the same storage rather than
  a copy.

- **`BidirectionalMap` round-trips through every store** (#1035).  It is the
  first framework class the tagged JSON tree knows about, under
  `__bidirectionalmap__` alongside `__map__` and `__set__`, so it can be held
  in an actor's state directly — no snapshot adapter, no serializer
  registration, nothing at the boundary.  Only the forward pairs are written;
  the inverse is rebuilt on decode, which also means a row carrying a
  duplicate value resolves last-wins rather than restoring a map whose halves
  disagree.  A store configured with `withSerializer(new CborSerializer())`
  carries it too, since #1036.

- **`JournalIntegrityError` and `SnapshotIntegrityError` on the public
  surface** (#1053).  Both live in `src/persistence/Replay.ts`, which neither
  barrel re-exported — so the two classes the recovery documentation tells you
  to branch on could not be named from outside the package.  Since #122 the
  *Persistent actor* page states that a journal breaking its contract raises
  `JournalIntegrityError`, which reads as an invitation to discriminate on it
  in `onRecoveryFailure`; what was actually reachable was
  `reason.name === 'JournalIntegrityError'` or a regex over the message, and
  both break on any rewording.  They are two classes rather than one precisely
  so that a caller can tell a journal apart from a snapshot store — separate
  trust domains, and which of them broke its contract is the first thing an
  operator needs — and that distinction was the part the barrel dropped.  The
  #122 integration test had been reaching straight into
  `src/persistence/Replay.js` to get at the class; it now imports from the
  barrel, so the export has a test that fails if it goes missing again.

- **`LogContextEntry` on the public surface** (#1062).  `LogContext.runEach`
  takes `Iterable<LogContextEntry<TItem>>`, but the type could not be named
  from outside: `src/index.ts` exported `LogContext` and `LogContextData` and
  stopped there, and `package.json` has no wildcard subpath to reach the module
  directly.  Its own JSDoc argued the export was unnecessary because callers
  build an entry inline — which is true only for a queue that never leaves the
  turn it was built in.  `runEach` exists for the opposite case: work deferred
  to a *later* turn, where the entries live in a field between the enqueue and
  the drain, and a field has to be typed.  The project's own test typed one
  that way (`Array<LogContextEntry<string>>`) by importing out of `src/`, which
  is the route an application does not have.  The *Logging* page (EN + DE) now
  shows the field and its import instead of starting at the `push`.

- **`TcpServerActor`'s message variants on the public surface** (#1095).
  `SendCommand`, `CloseCommand`, `ConnectionOpenedMessage`, `FrameMessage` and
  `ConnectionClosedMessage` were module-local; only the unions
  `TcpServerCommand` / `TcpServerMessage` left the file.  That is the right
  default — a variant type belongs next to its union — but it does not survive
  the union crossing the package boundary: the configured `target` handles the
  variants one at a time, and a handler takes the **named variant type**.  The
  echo server on the *TCP* page types `onFrame(message: FrameMessage)` for
  exactly that reason, so anyone copying it got `TS2304`, with the only way out
  being `Extract<TcpServerMessage, { kind: 'frame' }>` — the spelling the
  project's own conventions rule out for a handler parameter.  Both language
  versions of the page now show the import.

### Changed

- **The `cb` short form is spelled out** (#1113).  152 occurrences across 34
  files, the sibling of #1112 — and unlike `fn`, `cb` carried **two
  unrelated meanings**, so it could not be renamed on the string alone.  105
  occurrences meant *callback*; **42 meant `CircuitBreaker`** (`const cb =
  new CircuitBreaker(…)` in the pattern tests and the example, `const cb =
  common.circuitBreaker` in `BrokerOptions`), and a further two were a
  paired `ca`/`cb` standing for "counter A"/"counter B" in
  `Extension.test.ts`.  Those became `breaker` / `circuitBreaker` /
  `counterA`+`counterB`; nothing there is a callback.

  The public surface this reaches is larger than #1112's: `persist(event,
  cb)` and `persistAll(events, cb)` on `PersistentActor` — the call every
  persistence page leads with — plus `ReplicatedEventSourcedActor.persist`
  and `FSM.onTransition`.  The persistence parameter is now `afterPersist`,
  naming what it is *for* rather than what type it is; `onTransition` takes
  `listener`, matching the `transitionListeners` it lands in.  In the ~12
  vendor-shape declarations (mqtt.js, `net.Socket`, `dgram`, gRPC, amqplib,
  `ws`, Express `listen`) the split is by role: event registration
  (`on`/`once`/`addEventListener`) takes `listener`, completion callbacks
  (`publish`, `write`, `end`, `close`, `listen`, `bindAsync`) take
  `callback`, and amqplib's `consume` takes `onMessage`, the name amqplib
  itself uses.  Member names are untouched.  **Not breaking** — arguments
  are positional and no exported shape moved.

  Two spellings deliberately survive: the left column of the
  `migration/from-akka-jvm` table, which is Akka's own curried
  `persist(event)(cb)` and is the whole point of the page, and the
  `'cb-realistic'` actor-system name in an example, which is string data.

- **Documentation corrected where it named a parameter that never
  existed** (#1113).  `coordination/overview` and the JSDoc on
  `src/coordination/Lease.ts` both documented `onLost(cb)`; the parameter is
  and was named `handler`.  Pre-existing drift, fixed in EN and DE together
  — the same class of error #1112 found on the FSM pages.

- **BREAKING — `CborSerializer` encodes several values differently** (#1036).
  All of these previously produced something wrong rather than something
  different, so the migration is usually "delete the workaround":

  - `Map`, `Set`, `BidirectionalMap`, `RegExp`, `Error` and the typed arrays
    no longer encode as `{}` (or, for a numeric view, as an index-keyed
    object).  *Migration:* drop any conversion to arrays or plain objects you
    were doing before encoding.
  - `undefined` encodes as CBOR simple value 23 and decodes back as
    `undefined`, not `null` — including as an object property, where the key
    is kept.  This makes `CborSerializer` the more permissive of the two
    codecs, since `JsonSerializer` rejects `undefined` outright.
    *Migration:* write `null` explicitly where the coercion was relied on.
  - `-0` encodes as a float64 rather than the single byte `0x00`, so it keeps
    its sign.
  - A plain object with a `toJSON()` method now encodes as that method's
    result, matching `JSON.stringify` and the JSON tree.  The same HTTP
    endpoint answering `application/json` and `application/cbor` no longer
    returns two different shapes.  *Migration:* none, unless you relied on
    CBOR ignoring `toJSON`.
  - Encoding a `Promise`, `WeakMap` or `WeakSet` throws a `CborEncodeError`
    instead of writing `{}`.  Nothing that relied on the encode succeeding
    could have been reading entries back — there were never any.

- **`BidirectionalMultiMap<L, R>`** (#1037).  The many-to-many sibling of
  `BidirectionalMap`, for the shape a subscription registry has: one
  subscriber holds many topics, one topic has many subscribers, and the
  message telling you a subscriber is gone carries only the subscriber.
  Written by hand that is two maps of sets, re-derived at every site, where
  dropping a participant means reaching into every set it appears in.  The
  invariant it adds over the 1:1 version is that **there is no such thing as
  an empty participant** — losing your last partner removes you from both
  directions.  That is where the leak lives in a many-to-many relation: a
  topic left holding an empty subscriber set is invisible to a pair count,
  keeps occupying whatever cap bounds the topics, and would let `inverse()`
  hand back something related to nothing.  `size` counts pairs rather than
  participants, since that is what a cap is usually written against.
  Equality is SameValueZero, as with the sibling.  Two deliberate
  departures from it, both documented on the class: `get()` returns the
  **live** internal set typed `ReadonlySet`, not a copy, because the
  relation is read on fan-out paths once per published message where an
  O(n) copy is not payable — so casting it back to `Set` and mutating it
  corrupts the inverse; and it does not implement `Map`, which it could not
  honour anyway since `get` returns a set.

- **`BidirectionalMultiMap` round-trips through every store** (#1037).  The
  second framework class the tagged JSON tree knows, under
  `__bidirectionalmultimap__`, so a many-to-many relation can be held in an
  actor's state with no adapter and no registration.  It needs the tag more
  than its sibling did: a `BidirectionalMap` falling through to the plain
  object encoder would at least come back with its data intact and only its
  class gone, where this one holds both directions as `Map<_, Set<_>>`
  behind private fields the walker never reaches — the row would be a pair
  count and no pairs.  Written as a forward adjacency list rather than a
  flat pair list, because one participant with many partners is the shape
  every call site has; the inverse is rebuilt on decode, so the two halves
  cannot be restored disagreeing.  The `CborSerializer` exception applies
  here too (#1036).

- **UUIDs in `src/` are minted through `randomUuid()`** (#1110).  Three call
  sites still called the platform primitive themselves, in two different
  spellings: `ClusterClient.nextAskId` and
  `ClusterClientReceptionist.onAskFailure` used `globalThis.crypto.randomUUID()`,
  while the `requestId` middleware imported `randomUUID` from `node:crypto`.
  All three now go through the helper #1109 added, which puts the choice of
  primitive back in the one module that owns where identifiers come from —
  relevant the day it has to change (a runtime without `crypto.randomUUID`, or
  UUIDv7 for a lexicographically ordered persistence key), since a `grep` for
  `randomUuid` previously found none of them.  The middleware change also
  removes the last `node:crypto` import in `src/` that had a Web Crypto
  equivalent; the three remaining ones (`timingSafeEqual`, `createHmac`,
  `randomBytes` in `BasicAuth`, `BearerToken` and `Csrf`) do not, so they stay.
  No behaviour or API change — both spellings return a lowercase v4 UUID, and
  the middleware's `VALID_ID` guard already had to accept one, since it also
  vets client-supplied ids.  Docs samples that predated the helper (the K8s
  lease test name, the `LogContext` correlation id, the `requestId` default)
  now show `randomUuid` instead of sending the reader to the raw primitive.

- **The receptionist, the pub-sub mediator and the broker base index their
  subscribers through `BidirectionalMultiMap`** (#1037).  All three kept the
  same relation by hand, each with a comment explaining why it had to, and
  all three now converge on the same pair: the relation plus a
  `path → ActorRef` map for the fan-out target and the unwatch handle.
  Behaviour is unchanged; what goes away is the lockstep discipline and one
  latent defect with it.  `Receptionist.totalSubscribers` no longer exists —
  it was exactly the pair count, so it is `subscriptions.size`, and with it
  goes a counter that decremented *before* its own "did this subscriber
  exist" guard.  Today's single caller happened to guard it, so the count
  stayed right; a second one that did not would have drifted the subscriber
  cap downward permanently, and a derived value cannot drift.  In the
  mediator, `SubscriberSet` becomes `TopicState` — what a topic holds
  besides its subscribers — and the four hand-written copies of the
  empty-topic guard become one `maybeDropTopic`.  The fan-out paths there
  gain one map lookup per local subscriber per publish, the price of keying
  on paths rather than on ref identity — identity keying is what does not
  survive death watch.  Measured on `benchmarks/cluster/pubsub-fanout.ts`
  at 1000 local subscribers, three runs each, it does not show: 63.3 / 61.5
  / 61.9 µs per delivery before against 60.0 / 62.8 / 55.9 µs after.  The
  lookup is inside the noise of the mailbox hop it sits next to.

- **The `fn` parameter name is spelled out across the API** (#1112).  136
  sites in 34 files under `src/` still used `fn`, the short form `AGENTS.md`
  bans by name alongside `Cmd`/`Msg`/`Ctx`/`Impl`/`Ctor`.  Parameter names
  reach users — they are part of the published `.d.ts`, the generated
  TypeDoc and IDE signature help — so this touches public surface:
  `Dispatcher.execute(task)`, `Scheduler.scheduleOnceFunction(delayMs,
  task)`, `LogContext.run/with/runFresh/runEach(…, callback)`,
  `Tracer.withActiveSpan(span, callback)`, `TestKit.within(durationMs,
  callback)`, `SqliteDb.transaction(body)`,
  `HealthCheckRegistry.addLiveness/addReadiness(check)`,
  `DistributedData.update/updateAsync(key, factory, mutator)`,
  `ORMap.updateWith(…, mutator)`, `EventDispatcherBuilder.on(kind,
  handler)`, and the four HTTP middleware builders, where the new name is
  the field the builder writes (`withGenerate(generate)`,
  `withValidate(validate)`, `withOnTimeout(onTimeout)`,
  `withOriginPredicate(predicate)`).  **Not breaking:** arguments are
  positional, and every type whose *field* was renamed (`ManualScheduler`'s
  task record, DistributedData's update message, the Node worker adapter's
  listener map) is module-local or private.  No behaviour change.

  Three declarations that transcribe a vendor shape — better-sqlite3's
  `transaction`, `@opentelemetry/api`'s `context.with`, and the
  `bun:test`/Vitest/Jest `beforeAll`/`afterAll` hooks — were renamed too:
  structural assignability ignores parameter names, so only the *member*
  names have to stay verbatim, and those did.

- **Documentation corrected where it named parameters that no longer
  existed** (#1112).  `persistence/fsm/*` documented `onEnter(state, fn)` /
  `onExit(state, fn)` / `onTransition(fn)` where the source says `hook` /
  `hook` / `cb` and the method is `onExitState` (`onExit` is a private
  field); `fundamentals/event-stream` documented `cluster.subscribe(fn, …)`
  against a parameter named `listener`; and the
  `operations/upgrades/rolling-migration` helper table listed
  `migrateSnapshotStore(store, pids, fn)` for `(store, persistenceIds,
  manifestFor)`.  All pre-existing drift, fixed in EN and DE together.

- **BREAKING — `ClusterOptions.firstSightMaxVersionSkewMs` is now
  `maxVersionSkewMs`** (#114).  *Migration:* `withFirstSightMaxVersionSkewMs(ms)`
  → `withMaxVersionSkewMs(ms)`, same default (5 min), same unit; the option never
  had a HOCON key, so `reference.conf` is unchanged.  The old name stopped being
  true once the cap applied to every merge rather than to a first sighting.
  Behaviour changes with it: a refusal is now permanent — a node whose clock runs
  further ahead than the budget stays in the member list without roles until its
  clock comes back, instead of getting through on its own second frame.  That was
  always this cap's verdict; the second frame was the bypass.

- **Sharding resolves entities and regions by index instead of scanning**
  (#1035).  `Passivate` and `Terminated` arrive carrying a ref and nothing
  else, so `Shard` found the entity they refer to by walking every entry in
  its entity map — O(n) per entity stop, and therefore O(n²) to drain a shard
  during handoff, on the one path that runs once per entity and precisely
  when a shard is at its largest.  It now keeps a `BidirectionalMap` of
  entity id ↔ actor path; the path *string* is indexed rather than the ref,
  because that is what `ActorRef.equals` compares.  `ClusterSharding`
  likewise suffix-matched every registered path to resolve a region by type
  name, on a path reached for every message sent through a sharded type, and
  now keeps a direct index.  No behavior change.

- **A resumed actor's children are resumed with it** (#635).  A failure
  suspends the failing actor's subtree so nothing in it runs while the
  supervisor decides, but `Directive.Resume` only ever reached the actor that
  failed.  Its children stayed suspended permanently: mailboxes filled,
  nothing was processed, and there was no error and no dead letter to notice
  it by.  `suspend` and `resume` now walk the same tree.

- **BREAKING — a restart stops the actor's children** (#634).  A restart
  replaces the `Actor` instance while the cell, and with it the child map,
  survives.  Children were therefore inherited by the new incarnation — which
  made an ordinary pattern impossible: `postRestart` re-runs `preStart`, so an
  actor that spawned a *named* child there hit `Child name … is not unique` on
  its first restart and never recovered.

  The children are now stopped after `preRestart` and **before** the
  replacement is built, and the restart waits for them, so the fresh instance
  starts from an empty child map.

  **Migration:** an actor whose children should outlive a restart overrides
  the new `Actor.stopChildrenOnRestart()` to return `false`, and adopts the
  survivor in `preStart` — `this.child = this.context.child('name')
  .toNullable() ?? this.context.spawn(Child, 'name')`.  An instance field
  cannot carry that across a restart: `preStart` runs on a fresh instance, so
  `this.child ??= …` is always unset and re-spawns into the name the surviving
  child still holds.  It is a hook rather than a
  `preRestart` override because the teardown has to be awaited, and
  `preRestart` cannot tell the framework it started something worth waiting
  for.

- **BREAKING — a sharded entity's child name escapes its id injectively**
  (#568).  `entityName()` folded every character outside `[A-Za-z0-9_-]` to
  `_`, which is many-to-one.  Two ids that differed only in punctuation
  produced the same child name, and when they also hashed into the same
  shard the second one missed the shard's id-keyed map, called
  `createEntity`, and `_createChild` threw `Child name … is not unique`.
  That throw kills the Shard actor — and with it every unrelated entity
  living in that shard, including other tenants'.  It needed no attacker:
  `a.b@x.com` and `a-b@x.com` collided, and `extractEntityId` is documented
  as reading the id straight off an inbound message.

  A code unit outside `[A-Za-z0-9_-.@:+]` is now escaped as `~` plus four
  hex digits.  Ordinary ids are unchanged — `user-42`, `a.b@x.com` and
  `tenant:eu` all read as themselves — and the escape works per UTF-16 code
  unit rather than percent-encoding UTF-8, so it is total: a lone surrogate
  cannot make it throw inside the shard, which would recreate the very
  failure being fixed.

  **Migration:** entity actor *paths* change shape for ids containing
  escaped characters — visible in the DevTools tree, in log lines, and in
  remote path rendering.  Nothing persists a path (remembered entities store
  ids), so there is no data migration.  Code that recovered an id by slicing
  the `entity-` prefix off `context.path.name` must read `this.entityId`
  instead; that accessor has existed since #832 and is the supported route.
  Nothing decodes a path segment, and `parsePathSegments` now says so — the
  escape is injective only while it stays escaped end to end.

- **BREAKING — the cluster wire protocol's discriminator is `kind`** (#494).
  The framework had three spellings for the same concept: `t` on the cluster
  wire (`hello`, `gossip`, `envelope`, `leave`, …) and on the internal
  coordinator/singleton event unions, `$t` on the sharding protocol
  (`sharding.Register`, `sharding.ShardHome`, …), and `kind` everywhere else —
  which is the one AGENTS.md prescribes. All three are now `kind`.

  **Migration:** a rolling upgrade is not possible. A v0.13.0 node and a
  v0.14.0 node cannot talk to each other — the discriminator they read is
  absent in the other's frames, so every frame is unrecognised. Stop the
  whole cluster, then start it again on the new version. Nothing in the
  public API changes; this affects only the bytes on the wire between nodes
  (and anything speaking that protocol directly, e.g. a hand-rolled
  `ClusterClient` peer or a test that constructs raw frames).

  The DevTools tap protocol already used `kind` and is untouched, so the
  embedded UI bundle and any tap client keep working across the upgrade.

### Fixed

- **The CBOR encoder no longer overflows the stack, or writes bytes it
  cannot read back** (#1036).  `encode()` on a cyclic object and on a
  deeply nested one both died with `RangeError: Maximum call stack size
  exceeded`: the decoder has capped nesting since #618, the encoder had no
  bound at all.  It now refuses a cycle with a `CborEncodeError` (a shared
  reference still duplicates, as `JSON.stringify` does) and measures depth in
  the levels the *decoder* will spend, so "the encoder accepts it" and "the
  decoder accepts it" are the same statement.  That distinction is not
  academic: a `Set` costs two decode levels where a `Map` costs one, and the
  tagged forms put their payload two or three levels down, so an empty `Set`,
  a `RegExp` or an `Error` near the limit used to encode fine and then fail to
  decode — a snapshot the node could never read back.

- **An unbuildable rich-type payload reports as a `SerializationError`**
  (#1036).  A `__regexp__` with an unbalanced source or bad flags, a `__url__`
  holding a relative reference, and a `__typedarray__` whose byte length is
  not a whole number of elements all escaped as a raw `SyntaxError`,
  `TypeError` or `RangeError` naming neither the tag nor the value.  HTTP hid
  it, because `Marshalling.entity()` catches everything and answers 400; a
  journal replay did not.  The check lives in the codec-independent module, so
  CBOR inherits it.

- **`BrokerActor` now actually prunes a subscriber that stops** (#1111).
  `subscribeRef` death-watched the ref and its documentation — the class
  JSDoc and `docs/io/broker-actor-base` alike — promised the subscription
  was removed automatically when it stopped.  Nothing implemented it.
  `Actor.onReceive` is abstract, so the base class never sees a message,
  and the reverse index commented "for O(1) cleanup on Terminated" had no
  reader on that path at all; a stopped subscriber stayed in every topic it
  held and cost a dead-lettered `tell` on each fan-out.  Sealing
  `onReceive` in the base class would have taken the dispatch table away
  from all thirteen subclasses for the sake of one hook, so the seam is
  explicit: **subclasses call `pruneTerminatedSubscriber(ref)` from their
  `Terminated` arm**, as the corrected docs now show.  It deliberately does
  not `unwatch` — the cell has already dropped the watch by the time it
  delivers `Terminated`.  The index is also keyed by path now rather than
  by ref object, which is what makes it work on that path at all: a
  `Terminated` carries the cell's own `self` ref, which need not be the
  object that subscribed.  `postStop` clears the ref sidecar too, which the
  old pair left behind.

- **SQLite persistence now sets an explicit `busy_timeout` on every
  connection it opens** (#124).  Until now no `busy_timeout` was set
  anywhere in the tree, so the value in force was whatever the driver
  happened to default to — and the drivers disagree: measured, `bun:sqlite`
  0, `node:sqlite` 0, `better-sqlite3` 5000.  The identical journal
  therefore failed a contended write on the first tick under Bun and Deno
  but blocked for five seconds under Node, which makes this a break of the
  project's identical-behaviour-on-Bun/Node/Deno promise rather than merely
  an unset knob.  Every handle now gets 1000 ms by default, settable per
  store through `busyTimeoutMs` (`0` disables the wait, a negative value is
  rejected because SQLite reads it as "retry forever"); the default stays
  well below the failure detector's 2000 ms unreachable threshold on
  purpose, because `SqliteDriver` is synchronous and the whole wait is
  event-loop freeze — inheriting `better-sqlite3`'s 5000 would let one
  contended write stall a node long enough for its own cluster to evict it.
  `SqliteJournal.append` additionally takes its write lock up front (`BEGIN
  IMMEDIATE`) instead of using the driver's deferred `transaction()` helper,
  because a transaction that reads before it writes makes SQLite return
  `SQLITE_BUSY` without ever consulting the busy handler — measured at 1 ms
  to failure with an 800 ms timeout configured, against 956 ms for the same
  statements under `BEGIN IMMEDIATE`.
- **`DEFAULT_SQLITE_BUSY_TIMEOUT_MS` and `buildSqliteDatabase` are exported
  from the package root** (#124).  The root barrel is the only published
  entry point, so both were previously reachable only through the internal
  `src/persistence/index.ts` — which left the new default unobservable from
  outside the package and made the documented "share ONE handle across
  stores" route unusable.

- **HOCON `include` now refuses itself with an explanation instead of a
  syntax error** (#135).  `include "base.conf"` reported `Expected '=' or
  ':' after key "include"`, which names the keyword but not the reason and
  left the reader to discover from the parser source that the omission was
  deliberate.  The parser now states that the directive is refused, quotes
  line, column and the include target, and points at the composition that
  does work — `Config.parseFile(base).merge(Config.parseFile(app))`.  All
  forms are covered (`"…"`, `file(`, `url(`, `classpath(`, `required(`), at
  any nesting depth, while a key legitimately named `include` — `app {
  include = "x" }`, `include { a = 1 }`, `include.a = 1` — keeps parsing
  untouched.
- **The configuration reference no longer documents `include` as a working
  feature** (#135).  `reference/configuration.mdx` advertised HOCON "with …
  includes" and carried an active "Includes" section describing the
  directive as supported, and `extras/design-decisions.mdx` listed "File
  includes" among the reasons to prefer HOCON over YAML/TOML — so following
  our own reference led straight into the parse error.  Both pages now state
  the refusal and its rationale and show the in-code merge instead (EN +
  DE).

- **A `PersistentFSM` state timeout could fire after a transition had already
  renewed it** (#143).  A `_timeout` fire travels through the mailbox, so it
  becomes irrevocable the moment the timer callback enqueues it — `cancel()`
  can no longer reach it, and the FSM may process any number of commands
  before it is dequeued.  `fireTimeoutTransition` compared only the state
  name, which cannot express "this window was replaced": a heartbeat command
  transitioning `active → active` — the archetypal idle-session timeout —
  re-armed the timer, and the queued fire still expired the session.  A fire
  now carries the arm generation it was scheduled under and is dropped once a
  re-arm has superseded it; the state-name check remains as a second layer.

- **A fully compacted journal no longer blocks every later `persist`**
  (#628).  Recovery raised its sequence only from a snapshot or from
  replayed events, so an actor whose journal had been compacted past
  everything recovered at 0.  That used to be harmless, because the journal
  said 0 too — but since #379 the backends remember what they deleted, so
  `highestSeq` correctly reports N while recovery reported 0, and the next
  `persist` sent `expectedSeq=0` into a journal that had seen N.  The result
  was a `JournalConcurrencyError` on every attempt, permanently, with no way
  out short of editing the store.  Recovery now falls back to the journal's
  high-water mark when there was nothing to replay — one extra query only in
  that case, and a no-op for a brand-new actor.

- **`deleteHistory(toSeq)` keeps the snapshot it compacts past** (#629).
  `SnapshotStore.delete` is documented as inclusive, so compacting past a
  snapshot deleted that snapshot along with the events it replaced — leaving
  an actor with neither.  It now prunes snapshots strictly before `toSeq`,
  and `toSeq <= 0` prunes nothing.  This is the first test the method has
  ever had; it had no caller in the repo either.

- **A terminated `ActorSystem` no longer keeps the process alive** (#641,
  #762).  `Scheduler.shutdown()` set a flag, which suppresses the scheduled
  callbacks but leaves the underlying `setTimeout` / `setInterval` handles
  armed — and an armed interval holds the event loop open.  A flag could
  never have fixed it: each handle lives inside the closure that created it.
  Schedules now register with the scheduler, so `shutdown()` has something to
  clear.

- **A fired one-shot timer reports itself finished** (#642).  `Cancellable`
  only flipped its flag on an explicit `cancel()`, so a timer that simply ran
  claimed to be pending for the rest of the process: `isCancelled` stayed
  false, `cancel()` returned `true` for a schedule that had already fired,
  and `context.timers` listed dead keys as active while its map grew by one
  entry per key for an actor that cycles through them.  A repeating schedule
  still ends only when cancelled.

- **`CoordinatedShutdown.removeProcessHooks()` removes only its own
  listeners** (#644, #764).  It called `process.removeAllListeners(signal)` —
  every SIGTERM/SIGINT listener in the process, including the application's
  own graceful shutdown, other libraries', and a second `ActorSystem`'s.
  `installProcessHooks` recorded only the signal name, so the handler it had
  just installed was unreachable; the pair is now kept and removed with
  `process.off`.

- **A stopping actor releases its event-stream subscriptions** (#645, #763).
  `unsubscribe` had one caller in the entire framework, so the subscriber
  list only grew — every publish walked entries for long-gone actors and
  turned each into a dead letter.  `publish` also iterated the live array
  while a synchronous `tell` could mutate it; it now iterates a snapshot, so
  the recipient set is fixed when `publish` is called.  The docs' advice to
  "rely on the dead-letter cleanup" described something that never existed,
  and is corrected in both languages.

- **A Deno node can join an mTLS cluster** (#576).  `Deno.connectTls` accepts
  a client `key`/`cert` pair, but `DenoTcpBackend.connect` never passed them —
  so a Deno node could not answer a listener that (correctly, since #565)
  demands a certificate, and could not join at all.  The same call passed the
  SNI override as `hostname_`, which is not a Deno option; the adapter's
  hand-written `DenoGlobal` interface declared the typo, so the compiler could
  not see it and the value was silently dropped.  Deno takes the SNI name from
  `hostname`.

  Hosting an mTLS *listener* on Deno remains impossible — `Deno.listenTls`
  takes only a cert and key, with no way to request or verify a peer
  certificate — and is still refused at bind time rather than started in a
  state weaker than it reads as.  The error now says which half is
  unavailable.  `rejectUnauthorized` has no Deno equivalent and is documented
  as unmapped rather than silently ignored.

- **The DevTools handshake reported the wrong framework version** (#657).
  `DEVTOOLS_SERVER_VERSION` is hand-maintained and had said `0.11.0`
  since that release, so every DevTools session misreported the version
  through `0.12.0` and `0.13.0` — in the one field you trust when
  triaging.  It is now correct, and a test asserts it against
  `package.json`, so a release that forgets the bump fails the suite
  instead of shipping the lie.

- **Anycast stopped leaving the node in the topology it exists for** (#155,
  #1091).  The two `'one-subscriber'` paths shared one rotation cursor but
  rotated over different candidate lists: an originated publish walks local
  subscribers *plus* remote claimants, an anycast that already crossed a hop
  walks local subscribers only.  Since `rotate` writes the cursor back modulo
  the count it was handed, every inbound frame left the cursor below the local
  subscriber count and the next publish this node originated was guaranteed to
  pick a local subscriber again.  A symmetric work queue — every node both
  hosting workers and publishing — alternates the two paths, so nothing ever
  crossed: measured at eight bodies delivered locally and zero frames sent.
  The two paths now have a cursor each.  Two more defects in the same
  rotation: remote candidates were walked in `Set` insertion order, which the
  gossip round re-draws (a claimant moved to the end merely by gossiping, so a
  peer could be served twice running or skipped for a full turn on timing
  alone) — they are now sorted by address, which also makes every mediator
  agree on the order; and an unroutable frame was dropped in `otherwise` with
  no delivery, no dead letter and no log, which is the silent direction of
  version skew.  It now warns and dead-letters.

  **Rolling upgrade:** a peer that predates `pubsub-publish-one` still cannot
  *deliver* an anycast that reaches it — it can only now say so.  The frame
  becomes a dead letter on that node and a warning naming the kind, instead of
  a task disappearing.  Nothing is re-routed, deliberately: re-routing would
  trade the at-most-one-hop guarantee for a race against the gossip round
  about to correct the sender.

- **`TcpServerActor` refuses at the cap by aborting, not half-closing**
  (#1096).  `onSocketOpened` turned an over-cap connection away with
  `socket.end()`, which is a FIN and nothing more: a peer that does not answer
  it keeps the socket — and its file descriptor — alive, still writable from
  its side.  That socket was never registered, so `connections` never counted
  it and the cap did not bound it either; the limit held only against peers
  that cooperate, which is not what a limit is for.  The refusal now calls a
  new `TcpSocketLike.destroy()`, implemented per runtime (`socket.destroy()`
  on Node, `socket.terminate()` on Bun; Deno's `Conn.close()` already tears
  down both halves, so its `end()` was never the half-close the other two
  had).  **The refused peer now sees a connection error rather than a clean
  close** — which is what being turned away at capacity looks like at the TCP
  level, and the *TCP* page says so in both languages.

  Worth recording for whoever writes the next one of these: the client cannot
  tell the two apart.  Measured against a plain Node listener with an
  `allowHalfOpen: true` peer, `end()` and `destroy()` leave it in exactly the
  same state — `end` fired, `close` did not, `writable` still true, and a
  further `write()` succeeds either way.  The only signal that separates them
  is the *server* socket's `close`, which never fires for `end()`.  The
  regression test therefore asserts the refusal path's choice rather than the
  client's view, because a client-side assertion passes with the defect in
  place.

- **`securityHeaders()` says what `false` actually does** (#1060).  The bundle
  documented every header as "disable-able", and the `securityHeaders()`
  middleware cannot disable one: it only ever adds — `applyHeaders` merges in
  and never deletes.  Since #127 every backend writes
  `x-content-type-options: nosniff` ahead of every response it emits, so
  `securityHeaders({ contentTypeOptions: false })` leaves the header exactly
  where it was, on all three backends.  No behaviour change here; the option,
  its type and both language versions of the *Security headers* page now say
  which seam `false` bites on.  It is honoured server-wide —
  `newServerAt(…).withSecurityHeaders({ contentTypeOptions: false })` replaces
  the backend's default map — and inert as a middleware.  There is no
  per-subtree opt-out on purpose: the backend's copy is the last word so that
  the 404s, body-parse 413s and error short-circuits which never reach a
  middleware are covered too.  The suite drove the middleware in isolation,
  where the resolved map really does lose the header, which is how the claim
  survived; a test now composes the two layers the way a response meets them.

- **The `runFresh` / `runEach` examples no longer discard their rejection**
  (#1063).  Both showed `void LogContext.run…(…)` as the recommended shape,
  directly above an aside explaining that an error *propagates immediately* —
  which is exactly what makes the `void` dangerous.  Nothing awaits that
  promise, so the rejection is unhandled, and on Node an unhandled rejection
  has been fatal by default since v15: reproduced on node 26.7, the process
  exits 1 rather than losing one batch item.  Both examples now end in
  `.catch`, the aside says why, and the framework's own precedent is named —
  `Scheduler.scheduleOnceFunction` wraps its task in `runGuarded` instead of
  firing it bare.  `tests/unit/MdcPropagation.test.ts` had copied the same
  `void`; it now follows what the page teaches.

### Security

- **CIDR matching only accepts canonical IPv4 addresses** (#145, #312).
  `ipv4ToBigInt` parsed every octet with `Number()`, which understands far
  more than a dotted quad — `Number('1e1')`, `Number('010')` and
  `Number('0x0a')` are all `10` — so `1e1.0.0.1`, `010.0.0.1`, `0x0a.0.0.1`,
  `0xa.0.0.1` and `10.0.0.0x1` all matched `10.0.0.0/8`.  That is a bypass
  rather than a cosmetic flaw because `net.isIP` scores each of them `0`:
  the transport hands the same string to `net.connect({ host, port })`,
  which resolves it through DNS, so a `pinnedAddresses` check that concluded
  "inside the pinned network" produced a connection to wherever the
  attacker's resolver pointed.  The same primitive backs the HTTP
  `IpAllowlist`, which carried the identical bypass since #312 — a spoofed
  `X-Forwarded-For: 1e1.0.0.1` walked through a `10.0.0.0/8` allowlist via
  the extractor its own JSDoc recommends.  Octets are now decimal-canonical
  only (no leading zero, no `0x`, no exponent, no sign, no whitespace), and
  `ipv6ToBigInt` was audited and does not share the weakness.
  **Migration:** a pin or allow entry written non-canonically
  (`'010.0.0.0/8'`) now throws at construction instead of silently pinning a
  different network — rewrite it in canonical form.
- **Prefix lengths are decimal-only, so a trailing-slash typo no longer
  means `/0`** (#145).  `parseCidr` read the prefix with `Number()` too, and
  `Number('')` is `0`, so `'10.0.0.0/'` parsed as `/0` — a pin meant to
  admit a single network admitting the entire address space instead.
  `'/0x8'`, `'/8e0'`, `'/ 8'`, `'/+8'` and `'/010'` were accepted just as
  loosely; all of them now throw `invalid prefix length`.
- **An all-numeric host-suffix pin is rejected** (#145).  Suffix matching is
  string comparison, so an entry like `'0.1'` matched the tail of any
  address ending `.0.1`.  No DNS zone is all digits; write a CIDR instead.
  This closes the path by which a non-canonical address — now classified as
  a hostname rather than an IP — could otherwise have reached the suffix
  pins.

- **Every gossiped record is held to the merge-path caps, not just the first**
  (#114, #138).  The version cap was split in two — tight where a record
  *introduces* an address, 24 h where it updates one — and both halves were
  reachable with the same move, because "already on the list" is a property of a
  map the attacker can write to first: two records for one address inside a
  single frame (`mergeMember` re-reads the map per record), or a frame carrying
  no member records at all, whose sender fallback enters the address itself.
  Either one then pushed through attacker-chosen roles and a version dated 23 h
  ahead, which the address's real owner could no longer outbid.  There is now one
  cap, `maxVersionSkewMs`, for every gossiped member version; the flat 24 h
  remains only for the two fields that are timestamps rather than versions,
  `removedAt` and the heartbeat `ts`.  `maxMembers` / `maxTombstones` are
  likewise charged to the bucket a record moves *into* rather than only when an
  entry is created: a tombstone reborn as `up` otherwise cleared the tombstone
  bucket without giving back a map slot, and alternating that with a fresh
  tombstone flood grew the member map without bound while every single step
  honoured both caps — measured at 6, 11, 16, 21, 26, 31 entries against a
  ceiling of 11.  The mirror direction (a live member gossiped as `removed`)
  pumped the tombstone bucket the same way and is closed with it.

- **A refused gossip record is reported once per frame, not once per record**
  (#114, #138).  The version guard and the `removedAt` guard each wrote a WARN
  line per record — precisely the log amplification the memory caps were meant to
  remove, reachable by anyone able to send one large frame.

- **BREAKING: `persistenceId` is validated before it becomes a storage key**
  (#133).  The new `PersistenceIdValidator` rejects an empty id, one longer
  than 255 characters, a `/` or `\` path separator, a whole-id `.` / `..`,
  and control characters — the rules `assertValidName` (#134) already
  applies to actor names, mirrored onto the one identifier in the
  persistence layer that had no validator at all.  It runs in
  `PersistentActor.preStart` and `ReplicatedEventSourcedActor.preStart`
  (both ahead of any journal access), in the new
  `DurableStateOptionsValidator` where a violation is an `OptionsError` on
  the `persistenceId` field, and again in the `append` of all six journals
  as defence in depth.  Banning the separators also closes an object-storage
  collision: the stores lay an id out as a directory
  (`<prefix><persistenceId>/<seq>.json`) and read it back by listing that
  prefix, so `a/b` nested inside `a` — `a`'s `loadLatest` returned `a/b`'s
  snapshot and its `delete` pruned it.  Commas and `|` stay legal on
  purpose: the comma-separated journal column carries tags rather than ids,
  and the projection offset store puts the id last in
  `<projection>|seq|<persistenceId>`, which is what keeps the chat example's
  `dm-channel-alice|bob` working.  Migration: read paths are deliberately
  not validated, so `journal.read(oldId, 1)` still returns data stored under
  a now-invalid id and it can be copied to a corrected one; check your ids
  ahead of the upgrade with the newly exported `assertValidPersistenceId`.

- **Replay refuses a journal that breaks its read contract** (#122).
  `replayState` folded whatever `journal.read()` returned and took
  `sequenceNr` from the last entry *delivered*, so a shuffled stream
  replayed history in an order it never happened in — non-commutative events
  landing the wrong way round — and left recovery one sequence short, after
  which every `persist` failed with a `JournalConcurrencyError` pointing at
  a perfectly healthy journal, one restart away from its cause.  The
  returned slice is now checked before the fold, so a rejected stream never
  reaches user code: sequence numbers must be safe integers ≥ 1, strictly
  ascending, contiguous and inside the requested window, otherwise
  `JournalIntegrityError`.  The ordering half has no in-tree trigger — all
  eight journals sort, Cassandra explicitly — and defends the plugin
  contract against third-party journals and store manipulation; the
  contiguity half does fire on shipped code, through
  `CassandraJournal.append`'s claim-then-write window.  DevTools time travel
  opts out of the compacted-prefix part, so the panel still opens on
  entities whose history was compacted.
- **BREAKING — recovery over a journal compacted without a covering snapshot
  now fails instead of inventing a state** (#122).  It previously folded the
  surviving tail onto `initialState()` and handed that to `onCommand` as the
  current state.  Reachable through the public API, not just through
  tampering: `deleteHistory(n)` on an actor that never snapshotted.
  Migration: compact only past a snapshot — `deleteHistory(seq)` keeps the
  snapshot at `seq` for exactly this reason — or take one before compacting.
- **Seed providers can pin the addresses they accept** (#145).
  `DnsSeedProvider` and `KubernetesApiSeedProvider` gained `pinnedAddresses`
  plus a `log` callback that reports every drop, so a spoofed DNS answer or
  a written-to `Endpoints` object can no longer steer the bootstrap at an
  arbitrary peer.  Entries are CIDRs for resolved IPs and host suffixes —
  matched on a label boundary, so `svc.cluster.local` never admits
  `evilsvc.cluster.local` — for the target hostnames SRV records carry; a
  list that cannot match anything in the configured mode is rejected at
  construction rather than silently discarding every seed, and non-matching
  addresses are filtered and logged rather than failing the whole lookup.
  This is defence in depth behind mTLS (#565, #912) and the only
  discovery-layer control left standing where mTLS is not configured.
- **CIDR matching moved to `util/CidrMatch`** (#145).  Extracted verbatim
  from the `IpAllowlist` HTTP middleware (#312) so the cluster bootstrap and
  the HTTP edge share one IPv4/IPv6 implementation instead of growing a
  second hand-rolled parser that drifts; `IpAllowlist` behaviour and error
  messages are byte-identical and its test file is unchanged.

- **AES-GCM IVs are generated inside the encrypt call** (#110).
  `aesGcmEncryptSafe(subkey, plaintext)` derives a fresh IV per call and
  returns it beside the ciphertext, so the object-storage body codec no
  longer holds an IV it could recycle; the IV-taking `aesGcmEncrypt` and
  `randomIv` remain for that wrapper and the decrypt-side tests but are
  marked `@internal`.  No IV was ever actually reused — `aesGcmEncrypt` is
  re-exported from no `index.ts` and the package `exports` map has no
  wildcard subpath, so this was in-tree misuse potential rather than
  anything a consumer could reach — but nothing asserted IV freshness
  either, and regression tests now do at both the primitive and the manifest
  layer.
- **`X-Content-Type-Options: nosniff` on every response** (#127).  All three
  HTTP backends now write the header before a response's own headers — an
  explicit header from a handler still wins — so it also reaches what no
  middleware ever sees: the backend's own error mapping, the `fallback()`
  404 and the body-too-large 413.  Static files get it too; until now only
  the directory listing sent it while the served file right beside it did
  not, which is exactly the upload-echo case the header exists for.  **The
  response headers of every endpoint change**;
  `newServerAt(…).withSecurityHeaders(false)` opts out.
- **`newServerAt(…).withSecurityHeaders(…)` applies the security-header
  bundle server-wide** (#127).  Passing `SecurityHeadersOptions` (or a plain
  object) stamps the full `securityHeaders()` set — its own defaults
  included — at the backend chokepoint instead of as a middleware, which is
  the only way to cover the error, not-found and upgrade-reject paths;
  `false` disables the mechanism.  Only `nosniff` is on without
  configuration: `X-Frame-Options` and `Cross-Origin-Resource-Policy` would
  break iframes, cross-origin embedding and OAuth popups, so they stay
  opt-in.
- **A ClusterClient no longer learns why an ask failed inside the cluster**
  (#130).  A ClusterClient is not a peer — it never joined the membership
  ring, carries no gossip or heartbeat duty, and a contact point is by
  design reachable from outside whatever boundary protects the cluster's own
  links — so the receptionist stopped forwarding the rejection text, which
  is authored by arbitrary actor code and routinely carries file paths, SQL
  fragments, driver internals or a stack.  The client gets a fixed sentence
  plus a correlation id drawn on the node, and the full text is logged there
  under that id at `warn`, so an outside caller quotes the id and an
  operator greps for it.  The unknown-path reply also drops the node's own
  `selfAddress`, which behind a load balancer or NAT is not the address the
  client dialled.  **BREAKING:** `ClusterClient.ask()` rejects with the
  generic message; model a failure a client must act on as a reply the actor
  authors (`{ kind: 'rejected', reason: 'out-of-stock' }`), which is still
  passed through untouched.
- **An HTTP throw that becomes a redacted 500 is now logged where operators
  actually look** (#130).  Redaction only works if the detail survives on
  the server, and it did not: the escaped-throw branch logged `err.message`
  at `debug`, a level nothing runs at in production, so the generic 500 was
  the sole trace of the failure anywhere.  It now logs at `error` and passes
  the error *value* through so a sink that formats stacks still gets one,
  excludes a deliberate `HttpError` such as a 404 (a response the handler
  chose does not belong in the error log), and covers `fallback()`, which
  maps to a 500 without re-throwing.  The line carries the caller's
  `x-request-id` when it is well-formed, read through the newly exported
  `requestIdOf(request)` — the same shape check the `requestId` middleware
  applies, which is what stops a client-controlled string from forging a log
  record through an embedded newline.
- **DistributedData bounds its pending quorum requests** (#140).
  `updateAsync` / `getAsync` now share a `maxPendingQuorumRequests` budget
  (default `1000`, `0` disables) and a `maxQuorumTimeout` ceiling on the
  caller-supplied `timeoutMs` (default `30s`, `0` disables); a request past
  the cap is rejected outright instead of tracked, and an oversized deadline
  is clamped.  The default is deliberately an order of magnitude below the
  replicator's mailbox (10 000, `drop-head`): at mailbox saturation the
  oldest queued envelope is discarded together with the caller's
  `resolve`/`reject`, so the `updateAsync` promise never settles and nothing
  is logged — a cap set at 10 000 would never fire first and would convert
  nothing, while a cap of 1000 turns that silent drop into an explicit
  rejection naming the knob.  Four bounded-cardinality metrics come with it:
  `distributed_data_quorum_pending`,
  `distributed_data_quorum_timeouts_total`,
  `distributed_data_quorum_rejected_total` and
  `distributed_data_dropped_values_total`.

- **Ambiguous master-key rings are now rejected** (#111).  A `MasterKeyRing`
  whose `active` and `retired` entries claimed the same version was accepted
  and then resolved silently in favour of `active` — bodies written under
  the older of the two keys decrypted with the newer one and failed on the
  AES-GCM authentication tag with an error that named nothing.
  `validateMasterKeyRing` refuses duplicate versions, versions outside `[0,
  255]`, and keys that are not 32 bytes, at plugin registration, at the
  store's own encrypt/decrypt entry points, and at the start of
  `reEncryptObjectStorage` (where it replaces a range check that covered
  only `active`).  Reaching this state needed no exotic key history —
  promoting a key without renumbering it is enough — so a deployment
  carrying such a ring today will now fail loudly at startup instead of
  corrupting reads.
- **Warning when the master-key version space runs low** (#111).  From
  active version 240 on, `registerObjectStoragePlugins` warns and points at
  the remedy.  The single manifest byte is not a cap on how often a
  deployment may rotate: it caps how many versions may be live in one corpus
  at once, and a completed re-encryption sweep frees every other number for
  reuse.  The proposed wide-version wire flag was deliberately not reserved
  — bit 4 is `FLAG_INTEGRITY_HMAC` since #116, and the case it would address
  is one the sweep already resolves.
- **Prometheus cardinality is capped per metric family** (#131).  A label
  value derived from user-controlled input — a URL path, a header, an id —
  used to mint one time series per distinct value with nothing bounding it,
  growing the exposing process's resident memory (prom-client never expires
  a series) until the Prometheus server OOMed ingesting them.
  `DefaultMetricsRegistry` and the `promClientRegistry` bridge now stop
  minting at `maxSeriesPerFamily` (default 10 000, `0` disables) and fold
  every further tuple into a single overflow series, so a family gains at
  most one extra series no matter how many distinct tuples arrive; the first
  overflow logs one warning naming the family and the rejected tuple.
  Configure it with
  `MetricsRegistryOptions.create().withMaxSeriesPerFamily(n)` passed to
  `MetricsExtension.enable(...)`, or `withMaxSeriesPerFamily(n)` on
  `PromClientAdapterOptions`.  The default is 10 000 rather than a lower
  round number because `actor_mailbox_dropped_total` carries a
  per-actor-path label, so a node hosting a few thousand sharded entities
  under back-pressure legitimately crosses 1 000 series and a tighter cap
  would discard real operating data.  Deployments already producing more
  than 10 000 tuples in one family see those folded into the overflow series
  — raise the cap or bound the label to keep them separate.
- **`bucketize(value, allowed)` exported** (#131).  Maps a
  possibly-unbounded label value onto a fixed allow-list, returning
  `'other'` for anything outside it, so a family can never hold more than
  `allowed.length + 1` series.  This is the fix for a high-cardinality
  label; the registry cap is only the backstop for the labels nobody
  bounded.
- **Cluster membership is capped** (#138).  The local member map grew
  without bound from gossip: both paths that create an entry —
  `mergeMember`'s first-sighting branch and the sender fallback in
  `onGossip` — set unconditionally, and every guard in front of them decides
  whether a claim is *believable*, never how many believable claims one peer
  may make.  Two caps now bound it, `actor-ts.cluster.max-members` (default
  `1000`) and `actor-ts.cluster.max-tombstones` (default `10000`), settable
  in code as `withMaxMembers(…)` / `withMaxTombstones(…)` and disabled with
  `0`.  The tombstone cap is the load-bearing one, which inverts how the
  issue ranked its tracks: a phantom in an active status is reclaimed by the
  failure detector within `down-after`, while a gossiped `removed` record is
  reclaimed by nothing until `tombstone.time-to-live` a day later — so it is
  the only variant that accumulates.  The practical damage arrives well
  before an out-of-memory kill: gossip carries the whole member list, so at
  roughly 110 000 entries a node's own frame outgrows the 16 MiB wire cap
  and every peer terminates the connection on the length prefix.  Tombstones
  a node mints itself (`leave`, a downing decision, `down()`) convert an
  existing entry and bypass the cap, and the failure detector's sample map
  is bounded on the same path so the leak does not simply move one map to
  the left.

- **Membership housekeeping is configurable from HOCON** (#841).
  `weakly-up-after` and `tombstone.{time-to-live, prune-interval,
  min-retention}` under `actor-ts.cluster` were code-only `ClusterOptions`
  fields with no config form at all; a deployment can now move them into
  `application.conf`, where they layer under explicit options as usual.
  `min-retention = 0s` means *derive the floor from
  `failure-detector.down-after`* — the same thing an unset field means — so
  a file that spells the default out behaves like one that omits it, and
  `ClusterOptionsValidator` accepts `0` where it used to reject it.
- **A TLS cluster listener no longer binds in plaintext when only half the
  credential is configured** (#144).  All three TCP adapters decided for
  themselves whether to bind TLS by testing `cert && key`, so a `tls` option
  carrying only one of the two made the listener conclude "no TLS" and bind
  **in the clear** — while the dialing half of the very same options object
  treats any `tls` value as TLS, so the cluster still formed and the node
  still looked TLS-configured.  A half-applied secret rotation or one typo'd
  environment variable was enough.  The rule now sits in
  `assertListenerTlsIsCoherent` beside the existing #565/#576 guards, and
  every adapter reaches it through a new `listenerUsesTls` that welds the
  check to the decision — after this, "plaintext" can only mean "no `tls`
  was supplied at all"; anything else either binds TLS or throws.  Empty
  material counts as absent, since that is what an unset variable or a
  mis-mounted secret looks like on arrival.  The dial path is deliberately
  untouched: `{ ca }` with no client certificate is ordinary one-way TLS and
  `ClusterClient`, which never listens, depends on it.  **Operator note:** a
  node that has been quietly serving plaintext this way now fails at bind
  instead of starting mis-secured, so a rolling restart can take such a node
  down — intended, but check for a half-set `cert`/`key` before rolling.

- **BREAKING — the HKDF `info` parameter is now required for client-side
  encryption** (#108).  `EncryptionConfig.info` was optional and
  `deriveSubkey` substituted the constant `'actor-ts/snapshot/v1'`.  HKDF's
  `info` is its context binding (RFC 5869 §3.2), so a framework-wide
  constant meant any two deployments holding the same master key derived
  byte-for-byte the same subkey for the same `persistenceId` — a staging
  environment restored from a production dump, or a DR region, could read
  production's blobs, and nothing in the config or docs said so.  `info` is
  now mandatory on both `client-aes256-gcm` arms of the exported
  `EncryptionConfig`, and `deriveSubkey` takes it positionally without a
  default.  *Migration:* add `info` to every client-side encryption config,
  encoding environment + purpose + version (`info:
  'acme/prod/snapshot/v1'`); to keep an existing corpus readable without a
  sweep, pass the old default `'actor-ts/snapshot/v1'` verbatim.
- **HKDF context rotation for the re-encryption sweep** (#108).
  `reEncryptObjectStorage` gains `newInfo`: bodies are decrypted under
  `info` and rewritten under `newInfo`, so a deployment can move off a
  shared derivation context without a second tool.  Because the key version
  is stamped in the body manifest but the context is not, the version
  fast-path is disabled while `newInfo` differs from `info` — without that
  the sweep would report every object as `skipped-current` and change
  nothing.  Re-runs stay idempotent: a body that fails to decrypt under
  `info` is retried under `newInfo` and counted as skipped, while failure
  under both re-raises the original decrypt error.
- **Eager rejection of a missing or blank `info` at plugin registration**
  (#108).  `registerObjectStoragePlugins` now validates every reachable
  client-side encryption config — including ones behind `encryptionByPrefix`
  resolvers — and `deriveSubkey` guards at the call itself.  The type
  already covers TypeScript callers; these guard JavaScript consumers, `as
  any` call sites and configs deserialised at runtime, where a missing
  `info` would otherwise be encoded as the literal string `"undefined"` —
  the same deployment-wide constant, only invisible.
- **A first-sight gossip record is held to a tight version-skew cap**
  (#114).  Versions are seeded from `Date.now()`, so "highest version wins"
  also decided what happened the *first* time an address was mentioned at
  all — and a self-announcement is the one claim the authority rules from
  #562 never refuse.  A stranger could therefore claim an address before the
  node that owns it exists, date the claim up to a day ahead and attach
  roles of its choosing; the leader's promotion loop then lifted the phantom
  into the active set, where roles decide routing, sharding placement,
  singleton hosting and downing quorums, and the real node's own record —
  versioned from its own clock, therefore lower — lost every merge
  afterwards.  A record that *introduces* an address must now be within
  `firstSightMaxVersionSkewMs` (default 5 min,
  `ClusterOptions.withFirstSightMaxVersionSkewMs`) of the local clock,
  against the 24 h that still governs every later merge.  A rejection is not
  exclusion: a self-announcing node is still recorded and its next frame
  merges through the normal path, so the cost is one gossip round.
- **BREAKING — `redirect()` now rejects off-origin targets** (#125).  The
  helper wrote the caller's URL into the `location` header unchecked, and
  `location` is set nowhere else in `src/http/`, so nothing behind it caught
  a bad target.  Forwarding a `?next=` parameter into it was therefore a
  textbook open redirect: a phishing link bounced a freshly authenticated
  victim to a look-alike host.  `redirect` now accepts same-origin targets
  only (a relative reference); an absolute URL, a protocol-relative `//host`
  target, or a control character throws `HttpError(400)`.  Classification
  mirrors the browser — leading whitespace is ignored and backslashes read
  as slashes, so `/\host`, `\/host` and `\\host` are caught too — and the
  rejection never echoes the target back to the client.  *Migration:*
  replace a deliberate off-origin `redirect(...)` with
  `redirectExternal(...)`, or compute a relative target.
- **`redirectExternal(url, status?)` for the deliberate off-origin hop**
  (#125).  Same signature as `redirect`, minus the origin rule.  A separate
  function rather than a flag on purpose: `grep redirectExternal` enumerates
  every off-origin redirect in a codebase, which a boolean in a third
  argument never could.  Control characters stay rejected on both helpers —
  measured on Bun and Node, CR/LF/NUL are already refused at header-write
  time (so the check only trades an opaque 500 for a 400 that names the
  reason), but a TAB is *accepted* by both `fetch` Headers and Node's
  `setHeader` while browsers strip it before parsing, which let a TAB hidden
  inside `javascript:` reach the browser as a working scheme.

- **BREAKING — the two cluster-wide subscriber registries are bounded and
  watched** (#137, #139).  `Receptionist` gained `maxSubscribersPerKey` /
  `maxSubscribersTotal`, `DistributedPubSubMediator` gained
  `maxSubscribersPerTopic` / `maxTopics` / `maxRemoteNodesPerTopic`, and both
  now watch their subscribers — one that stops without `Unsubscribe` releases
  its slot instead of being pinned forever.  The topic caps also apply to
  **gossip**, which is the axis worth naming: a peer claiming 100 000 topics
  allocated an entry per name on every receiving node, with no local
  `Subscribe` involved.
  **BREAKING:** a refused `Subscribe` is answered rather than discarded, so
  `Receptionist`'s `Subscribe.replyTo` / `Unsubscribe.replyTo` widen from
  `ActorRef<Listing<T>>` to `ActorRef<Listing<T> | SubscribeRejected<T>>` — a
  subscriber that matches its inbox exhaustively has to handle the new variant
  (exported from the package root as `ReceptionistSubscribeRejected`).

- **BREAKING — `DistributedPubSub`'s `Subscribe` takes an optional `replyTo`**
  (#139).  It names where the `SubscribeAcknowledgment`, or the new
  `SubscribeRejected`, is delivered.  The acknowledgment used to run through
  `context.sender`, which is empty for the documented
  `mediator.tell(new Subscribe(…))` call from outside an actor — the caller
  most in need of a refusal was the one that could not receive it.  Existing
  calls compile unchanged and keep following the sender; pass `replyTo` where
  you want to observe the answer.

- **An unbounded `keys` map in the `Receptionist` gossip path** (#137).  A
  peer's contribution is replaced wholesale on every round, but `maybeDrop`
  never ran afterwards, so a key that existed only because that peer named it
  left an empty entry nothing removed.

- **`actor-ts.cluster.pub-sub.*` and `actor-ts.cluster.receptionist.*` HOCON
  sections** (#857).  Gossip intervals, every cap above, and
  `send-to-dead-letters-when-no-subscribers`.  With the toggle on (the
  default), a publish that reached nobody goes to `system.deadLetters` instead
  of vanishing, so a mistyped topic is distinguishable from one whose
  subscribers have not gossiped in yet.  `routing-logic` and
  `removed-time-to-live` from the original proposal are deliberately absent
  rather than shipped inert — the first needs a send-to-one protocol this
  implementation does not have, the second the tombstones its gossip model
  does not use — so #857 stays open for them.

- **DistributedData credits the connection, not the payload** (#719, #723,
  #768).  `Cluster._onWire` has always handed its handlers the peer whose
  connection a frame arrived on; this extension registered a one-parameter
  arrow and dropped it, then read the payload's self-declared `from`.  So a
  write- or read-request naming a third party made the node dial that
  address and queue a full CRDT snapshot in a buffer that is never drained;
  a quorum counted votes by self-declared name, letting one member ack under
  every other member's and have its own state accepted as agreed; and a
  reply was matched on its correlation id alone, with no check that it
  concerned the same key or came from a node that was asked.  Frames now
  travel with the authenticated peer, and the handlers take it as a
  parameter rather than being free to read `from` by accident.

- **A failed durable load no longer wipes the persisted replica** (#725).
  `DurableDistributedDataStore.load()` adopted the stored revision before
  decoding, so a decode that threw left the caller with no state and the
  store holding a valid concurrency token — the next save of the empty view
  then passed the check and replaced the record.  Since the load failure is
  only logged as a warning, one undecodable entry silently destroyed the
  whole durable replica.  The revision is adopted only after every entry has
  decoded; a save then fails loudly instead of overwriting.

- **CRDT payloads are validated before they are merged** (#699, #720, #722,
  #724, #767).  `src/cluster/WireValidation.ts` forwards frame kinds it does
  not know, on the stated grounds that the extension validates its own
  payload — and DistributedData did not.  Every `fromJSON` checked `kind`
  and trusted the rest, so whatever `JSON.parse` produced went into the
  merge machinery.

  That is worse than a handler throwing, because absorbing a peer's state
  and keeping it is what a CRDT is for.  Each decoder now checks the shape,
  the types and the plausibility of what it is handed: a `GCounter` slot must
  be a non-negative safe integer, so `value(): number` can no longer return a
  string (#720); `ORSet` tombstone and element lists must be bounded arrays
  of strings (#722); an `LWWRegister` timestamp must be finite,
  non-negative and within five minutes of local time, so a year-3000 stamp
  no longer beats every honest write from then on (#724); and the
  CRDT-internal maps — the replica-id and tag keyed ones — reject a
  `__proto__` key rather than accept one no re-encode can carry (#767).

  What validation does **not** settle is a defect whose payload is
  well-formed, and three of the issues above are exactly that.  Each needed a
  second change, listed separately below: a value that will not decode has to
  be *dropped* rather than thrown out of a wire handler (#699); an `ORSet`
  tag has to be unguessable, because a forged tombstone is a well-formed
  string and passes every check here (#722); and a store key has to survive
  re-encoding, which is a defect in the encoder that no decoder can reject
  its way out of (#767).

  Still open, and deliberately not claimed here: `Number.MAX_SAFE_INTEGER`
  *is* a non-negative safe integer, so a peer can still write it into another
  replica's `GCounter` slot and pin it there, since max never decreases
  (#720).  The own-slot authority rule that issue proposes is not the answer
  — a replica legitimately relearns its own slot from peers after restarting
  without a durable store, and refusing that leaves two replicas permanently
  disagreeing about the same key.  Nor does it close the inflation itself: a
  peer can reach the same ceiling through `increment` on its own slot, which
  is a legal local operation.

  **BREAKING:** previously-accepted frames are now rejected — in practice,
  malformed or hostile ones.

- **A malformed peer value is dropped, not escalated** (#699, #721).
  Validating means `decodeCrdt` *throws*, and every call site is a wire
  handler — so the checks above made the reachable throw paths more numerous
  rather than fewer, and an exception out of one is an actor failure: twelve
  of them exhausted the DistributedData actor's restart budget and terminated
  it for the life of the process, taking every unsettled read and write
  promise with it.  A value that will not decode is now dropped and logged
  with the peer and the key it came from, per entry rather than per frame —
  entries that travel in one frame are independent CRDTs that merely share a
  ride, and a state-based replica re-sends everything on the next tick, so a
  dropped entry costs a gossip round and nothing else.

- **A `__proto__` store key gossips and persists like any other** (#767).
  `JSON.parse` makes `__proto__` an own enumerable property and every decode
  target is a `Map`, so the key went in fine — but every re-encode built an
  object literal and assigned into it, and for that one key an assignment
  invokes `Object.prototype`'s inherited setter instead of creating a
  property.  The entry vanished from every outbound frame and every durable
  snapshot while `get`/`keys` still reported it locally, with nothing logged
  anywhere; when it was the only key, the empty-payload short-circuit
  suppressed the gossip tick outright.  Store keys are the exposed layer
  because they are raw application strings — a key derived from untrusted
  input, a username or a tenant id, is the realistic trigger rather than a
  planted frame.  Payloads are now built with `Object.fromEntries`, which
  defines the property, in `gossipTick`, in the durable save, and in the four
  collection encoders whose keys are identity-fn output.  Same remedy as the
  CBOR map decoder under #581.

- **A decoded `LWWRegister` replica id must be a string** (#724).  `ReplicaId`
  is a bare `type ReplicaId = string`, so nothing at runtime kept the wire
  from carrying something `assign` could never produce — and the field is
  compared, not merely carried.  `>` between a string and a number is false
  in *both* directions, so a numeric replica id makes a same-timestamp merge
  non-commutative and the two replicas never converge on that key; an array
  is the mirror image, coercing to its single element so that one holding a
  high code point wins every tie while not being a string at all.  A
  legitimately typed id that sorts above every real `system@host:port` still
  wins those ties — that is what a deterministic tie-break costs, and the
  timestamp bound is what keeps it from mattering.

- **A gossip frame cannot exhaust the stack or freeze the event loop**
  (#698, #721).  `decodeCrdt` recursed once per nested `ORMap` level with no
  depth bound, and `MVRegister.merge` scanned every entry against every
  other over an unbounded, peer-supplied array: a 442 KiB frame — far under
  the 16 MiB frame cap — froze the loop for ~33 s, and since none of the
  entries dominated another they were all kept, so every later merge was
  slower than the last.  Nesting is capped at 32; multi-value registers get
  their own tighter entry cap, since an entry there is a concurrent write
  nobody has superseded rather than ordinary collection data.  Merge also
  skips already-dominated entries as dominators, which makes the common
  causal-chain case linear.

- **A cluster `hello` identity is bound to the TLS peer certificate** (#912).
  mTLS decided *whether* a peer belonged in the cluster; nothing decided
  *which* member it was.  The `hello` frame carries a `NodeAddress` and no
  credential, so a single CA-signed node could announce itself under another
  member's address — and since the gossip-authority rules from #562, #564
  and #572 all key off the connection's peer, it inherited that member's
  standing along with the traffic addressed to it.  The duplicate-identity
  guard did not cover it: a fresh claim, or one made after the real holder's
  connection dropped, is not a duplicate.

  When a peer presents a certificate, the claimed address must now be one
  the certificate vouches for — its host, or the full `systemName@host` for
  deployments that mint per-node identities — with leftmost-label wildcards
  honoured for the host, as in TLS hostname verification.  Two nodes sharing
  one host certificate remain indistinguishable, which is documented rather
  than papered over.

  Clusters with no certificate to read are untouched: plain TCP, one-way
  TLS, and Deno (whose `TlsConn` exposes no peer certificate at all) behave
  exactly as before.  There is no new configuration key, so the check cannot
  be left switched off on a deployment that thinks it has mTLS.

- **The DevTools WebSocket enforces the same-origin default it documented**
  (#566).  `DevToolsOptions` and the DevTools page both promised
  "same-origin only", but `routes()` passed no origin rules when
  `allowedOrigins` was unset, and an empty allowlist built no upgrade guard
  at all — so the tap accepted a handshake from any origin.  A WebSocket
  upgrade is not subject to the same-origin policy, so the loopback bind
  that makes the default feel private stops nothing: any page the developer
  visited could open `ws://127.0.0.1:9333/api/ws`, complete the
  unauthenticated handshake and read the actor tree, mailboxes, spans and —
  time-travel being on by default — raw persisted events and reconstructed
  actor state.  `DevTools.mount()` put the same socket on an application's
  own server, behind whatever ambient auth that server had.

  The tap now always requires the upgrade's `Origin` to name the tap
  itself.  `allowedOrigins` widens that rule instead of replacing it, so
  configuring one cannot lock out the tap's own UI, and a request with no
  `Origin` is still allowed — CSWSH needs a browser, and a browser always
  sends one.

  Routes get `requireSameOrigin` for the same purpose.  It belongs on the
  route's upgrade `authorize` rather than in middleware: an upgrade is a
  GET, and `requireSameOrigin` from `Csrf.ts` waves safe methods through.

- **A CBOR map key can no longer pick the decoded object's prototype**
  (#581).  Map decoding assigned each pair with `out[key] = value`, and
  assignment consults the prototype chain — so a 21-byte payload whose key
  is `"__proto__"` reached `Object.prototype`'s setter and re-parented the
  decoded object instead of adding a field to it.  Keys are now defined
  rather than assigned, which ignores setters: `__proto__` becomes an
  ordinary own property, so the value survives the round-trip instead of
  being rejected or silently dropped.

- **A CBOR body can no longer stall the event loop** (#567, #618).  Two
  unbounded paths in `CborDecoder`, both reachable from an ordinary
  `entity()` route: `Content-Type` alone selects the codec, so an
  application that only ever meant to accept JSON still handed an
  attacker's `application/cbor` body to the CBOR decoder.

  Tag 2 / tag 3 bignums were rebuilt one byte at a time with
  `value = (value << 8n) | BigInt(byte)`, which reallocates the whole
  accumulated bignum per iteration — quadratic in the declared length, and
  the only ceiling was the 10 MB body limit.  A few hundred KB bought
  seconds to tens of seconds of blocked event loop, during which no other
  request, actor message or cluster heartbeat is served.  The magnitude is
  now parsed in one pass, and capped at 1024 bytes (8192-bit) as a
  backstop.

  Separately, `readValue` recursed once per array, map and tag level with
  no depth bound, so a couple of hundred KB of `0x81` bytes exhausted the
  JS stack.  Nesting is now capped at 256.

  Journals and snapshots are unaffected — nothing under `src/persistence/`
  serializes through this codec.

- **A socket that closes during the upgrade window is no longer lost on Hono**
  (#570).  The per-connection actor attaches its socket listeners from
  `preStart`, two mailbox hops after the upgrade returns.  The `ws`-package
  adapter buffers everything that arrives in that window; the Hono adapter
  buffered messages only, so `close` and `error` hit a null listener and
  vanished.  Nothing else stops the connection actor — the hub's `_clients`
  entry, the `ConnectionTracker` entry and the `maxConnections` decrement all
  hang off that one dropped callback — so every client that closed inside the
  window leaked an actor and a connection slot for the life of the process.
  With `maxConnections` configured, the hardening knob became the denial of
  service: a burst of open-then-close connections exhausted the budget
  permanently.  Sequential clients almost never hit it, which is why it
  survived a green suite; concurrency is what widens the window.

  The buffer is now one function, `bufferWebsocketEvents()`, that both
  adapters share, rather than a per-adapter array each is free to get
  half-right.  A burst test in the shared backend suite covers all three
  backends.

- **Extension wire handlers credit the connection, not the payload** (#574,
  #582, #711).  `Cluster._onWire` has always passed the connection's peer to
  every handler; the receptionist, the pub-sub mediator and the
  cluster-client receptionist each ignored it and read the payload's
  self-declared `from` instead.  Both gossip handlers *replace* a sender's
  contribution wholesale — that is how deregistrations propagate — so any peer
  could name another node and wipe what that node had registered cluster-wide.
  The cluster-client receptionist additionally threw a `TypeError` out of the
  frame-dispatch loop when `from` was absent, and sent its reply to whatever
  address the payload named.

- **Shard ids are bounded by `numShards`** (#583, #569).  A shard id is
  `hash(entityId) % numShards`, so no honest region can ask for one outside the
  range — but neither side checked.  The coordinator allocated, recorded and
  *persisted* whatever id it was handed, and the allocation map is durable
  state replayed at every coordinator start, so the growth survived restarts.
  On the region side the id becomes a **child actor name**, minting a permanent
  child under an attacker-chosen name.  `ShardCoordinatorOptions` gained
  `numShards` (`withNumShards`) for the coordinator half.

- **Two `.exhaustive()` matchers no longer fail their actor on an unrecognised
  message** (#713).  `Receptionist` and `ClusterSingletonManager` both sit at
  resolvable paths, so anything a peer addresses to them lands in their
  matcher.  The receptionist's arms all match on `instanceof`, and a body
  delivered over the wire arrives as a plain JSON object — so one remotely
  delivered envelope failed the actor holding the node's whole service
  registry.  Both now drop the message through an `otherwise` arm and log it.

- **Gossip claims need authority, not just a high version number** (#562,
  #564, #572, #573).  The merge was decided purely by version magnitude, and
  versions are seeded from `Date.now()` — so an attacker could always pick a
  winning number.  Nothing checked *who* was entitled to say what:

  - One frame set the receiving node's **own** record to `removed`, which
    dropped it out of its own active set and flipped `isLeader()` to false, so
    the cluster stopped admitting new members (#562).
  - `onLeave` read the departing node from `message.node` instead of the
    connection, and writes a tombstone at `version + 2` — above anything the
    victim can say about itself.  One 120-byte frame evicted any member
    cluster-wide for the 24-hour tombstone TTL (#564).
  - `onHeartbeat` credited liveness to `message.from` and sent the
    acknowledgment there, so a peer could keep a dead node looking healthy —
    blocking singleton and shard failover — and make the receiver dial an
    attacker-chosen `host:port` (#572).
  - The envelope's MDC went unfiltered into `LogContext.run`, letting a peer
    overwrite `JsonLogger`'s own `ts`/`level`/`source`/`msg` (its record
    spreads the context last) and inject newlines into `ConsoleLogger`'s
    one-line-per-record output, forging whole log lines (#573).

  Claims are now keyed on the **connection's** peer rather than the payload's
  self-declared `from`.  A node is the author of its own status — except for
  promotion into `up`, which is the leader's call and is therefore carved out
  explicitly.  Claims about a *third* node require the sender to be a member
  this node already considers active.

  Unreachability is deliberately still merged from third parties: "I cannot
  reach C" is inherently a third-party observation, and every node must
  converge on the same view before a downing provider decides.

  This is not authentication — `hello` still carries no credential, so an
  unauthenticated peer can announce itself and wait to be promoted.  It removes
  the free-for-all; mTLS remains the control for untrusted networks.

- **Wire frames are validated before anything reads them** (#563, #571,
  #705, #587).  `FrameDecoder` ended in `JSON.parse(json) as WireMessage` —
  a cast, not a check — and every layer downstream read the frame as if the
  type were true.  Three things followed from that, all remotely reachable:

  - A `null` frame (8 bytes, `JSON.parse('null')`) was dereferenced by
    `TcpTransport.onMessage` above the handshake gate, so **no `hello` was
    needed**: an unauthenticated remote process kill on Node.
  - A gossiped member `status` outside the seven legal values reached
    `emitStatusTransition`'s `match(...).exhaustive()`, which throws — from
    a socket callback, and *after* the member had been written to the map.
    The node died **and** re-gossiped the poisoned entry, so one frame at one
    reachable node propagated to the whole cluster.
  - A `port` arriving as the string `"2552"` keyed every map identically to
    the number but never compared equal, permanently desyncing a node's view
    of its own identity.

  Frames now pass shape validation at the decode boundary (`WireValidation.ts`),
  `NodeAddress.fromJSON` and `Member.fromData` reject impossible values rather
  than constructing from them, and the frame-dispatch loop is wrapped: a
  malformed frame is dropped and the connection survives, while a handler that
  throws drops the connection instead of escaping into the runtime's socket
  callback.  `ClusterClient` got the same treatment — its `decoder.push` call
  was unguarded, so one malformed frame from a contact point killed the client
  process (#587).

  `MemberStatus` is now *derived* from a runtime `MEMBER_STATUSES` list, so the
  type and the values it is checked against cannot drift apart.

  Extension frame kinds (sharding, pub-sub, receptionist, DistributedData,
  DevTools) deliberately pass this layer and validate their own payloads.

- **`ORSet` tags are minted from entropy instead of a counter** (#722).  A tag
  was `${replica}#${seq}` off a per-replica sequence that travelled in the
  payload, so both halves were readable from any gossip frame and the tags a
  replica had not issued yet were arithmetic.  Tombstones veto by tag on
  merge, are unioned unconditionally and are never pruned — so one frame of
  forged tombstones made a victim's next writes vanish on the following merge,
  indistinguishable from a concurrent remove and with no API to take a
  tombstone back.  Tags now carry 96 bits from the platform's cryptographic
  random source, which is the conclusion #120 already reached for
  `ClusterClient` ask ids and #896 for quorum correlation ids.

  The two other parts of the reported fix are deliberately not implemented:
  requiring a tombstone's tag to name the sending peer stops removes from
  propagating at all, because `remove` legitimately tombstones tags other
  replicas minted; and dropping tombstones for tags no side has observed
  resurrects removed elements under out-of-order gossip.

  **BREAKING:** the `counters` field is gone from the `ORSet` wire shape,
  since nothing mints from it any more.  A frame — or a durable record — from
  an older peer still carries it and is accepted; an older peer *requires* it
  and rejects one without it.

  **Migration:** upgrade every node.  During a rolling upgrade `ORSet` values
  flow only from old nodes to new ones, and the not-yet-upgraded side logs one
  dropped value per gossip round; nothing is lost, because a dropped entry
  does not mutate state and state-based gossip re-sends everything, so
  convergence resumes once the last node is up.  Tags minted by either version
  keep working on both — a tag is an opaque string to every comparison it
  takes part in, and the two formats cannot collide.

## [0.13.0] — 2026-08-05

### Removed

- **BREAKING — `Props` is gone from the public API** (#547).  Spawning takes
  the actor class or a factory directly, and per-actor configuration is an
  ordinary options family:

  ```ts
  // before
  system.spawn(Props.create(() => new Greeter()), 'greeter');
  system.spawn(Props.create(() => new Worker(db)).withMailboxCapacity(500), 'w');

  // after
  system.spawn(Greeter, 'greeter');                      // zero-arg class
  const workerOptions = ActorOptions.create<WorkerMessage>().withMailboxCapacity(500);
  system.spawn(() => new Worker(db), 'w', workerOptions);
  ```

  `Props` bundled two unrelated things — *what* to construct and *how* to run
  it — and 75 % of its ~970 call sites used only the first.  The second half
  is now `ActorOptions`, a regular `XOptions` family (`ActorOptionsType` /
  `ActorOptionsBuilder` / `ActorOptions` / `ActorOptionsValidator`), which is
  what per-actor configuration should have been all along; it was the one
  place in the framework that did not follow that convention.

  **Migration:** drop `Props.create(` and its closing `)` — what is left is
  already a valid factory, and a zero-argument class needs no closure at all.
  Move each `.withX(…)` into a third `ActorOptions` argument; `asInternal()`
  becomes `withInternal()`.  Renamed carriers: `entityProps` → `entityActor`
  (+ `entityOptions`), singleton `props` → `actor` (+ `actorOptions`),
  `singletonProps` → `singletonActor`, `childProps` → `child`
  (+ `childOptions`), `routeeProps` → `routee` (+ `routeeOptions`),
  `behaviorFor` → `actorFor`; `BackoffSupervisor.props` → `.factory`,
  `ClusterRouter.props` → `.factory`, `typedProps` → `typedActor`.

  Two behavioural notes.  `ActorOptions` **mutates in place** where `Props`
  was copy-on-write, so a builder is one configuration — sharing one and
  re-chaining it no longer branches.  The settings are snapshotted at spawn,
  so mutating a builder afterwards never reconfigures a running actor.  And a
  class whose constructor takes arguments is now rejected at the spawn call
  naming the factory form, instead of being constructed with `undefined`
  dependencies and failing later — this also closes the same hole in the
  existing `ClusterSharding.start` / `ClusterSingleton.start` shorthands.

### Added

- **`ActorOptions`** (#547) — `withSupervisorStrategy`, `withDispatcher`,
  `withMailboxCapacity`, `withMailbox`, `withInternal`, `withEntity`,
  `withDisplayName`, plus an `ActorOptionsValidator` that rejects a
  non-positive `mailboxCapacity` at the `spawn` call rather than from inside
  the mailbox constructor.  Accepted as a builder or as a plain object, like
  every other options family.

- **`ShardInfo.resident`** (#901).  `ClusterSharding.shards()` now reports
  whether each shard actor was materialised when its region answered.
  `entityCount: 0` cannot say that on its own — a running-but-empty shard and
  one that passivated report the same count — so this is what to read when
  tuning `shardPassivationIdleMs` or counting the actors a node really holds.
  It says nothing about reachability: `ref` works either way.

- **`Actor.displayName()` — a readable name for an actor in logs and DevTools**
  (#891).  A path is an address, not a name: under sharding the log source
  grows to ~120 characters of machine identifier, and the business identity it
  stands for had to be repeated by hand in every message the entity logged.
  Override `displayName()` and the actor says it once; the name joins the line
  as its own segment after the source
  (`... - User(test-user-590) - recovery complete`), and labels the row in the
  DevTools actor tree — worth the most for `Behaviors` actors, whose class
  column reads `TypedActor` on every row.  Also settable from the spawn site
  with `ActorOptions.withDisplayName(...)` (which outranks the method, as
  `withSupervisorStrategy` does) and at runtime with
  `context.setDisplayName(...)` (which outranks both) — the latter being the
  way in for a `Behaviors` actor, which has no subclass to override, and for a
  name that only settles after recovery.
  Resolved on every record rather than captured once, so it may be derived from
  state and follows a restart; a throw or a non-string falls back to the path
  and warns once.  Defaults to the path, so **existing log output is unchanged**
  — and it stays a label: metric labels, tracing attributes, dead letters,
  `ActorRef.toString()` and every cluster-wire identifier keep using the path.
  Structured loggers get a separate `displayName` field beside `source`;
  `interface Logger` is untouched, so third-party implementations keep working.
- **Empty shards passivate** (#892).  A shard actor used to outlive its
  entities indefinitely: it appears when the coordinator allocates it to a
  node and, apart from a handoff, nothing ever stopped it again.  Since entity
  ids spread over the hash space, a long-running node accumulated one idle,
  empty shard actor per `numShards` — 64 of them with the default.  A shard
  that has stood empty for `shardPassivationIdleMs` is now stopped too.  The
  region keeps ownership, so the shard stays routable and the next message
  re-creates it with no coordinator round trip; only an *empty* shard is ever
  stopped, so no entity state is at stake, and messages arriving mid-stop are
  buffered and replayed exactly as they are for an entity.
- **`shardPassivationIdleMs` / `withShardPassivationIdleMs()` /
  `actor-ts.sharding.shard-passivation-idle`** (#892).  Unset it follows
  `passivationIdleMs` — a shard stands empty precisely because its entities
  went idle — and `0` keeps empty shards resident while entities still
  passivate.  It is deliberately absent from `reference.conf`: a shipped value
  is exactly what "unset" would have to be distinguishable from.

### Changed

- **Spawning an actor class is the standard form across the whole repo**
  (#547).  `spawn(() => new MyActor())` was the shape every call site had
  copied from the `Props` era; the ~500 zero-argument closures in `src/`,
  `tests/`, `examples/`, `benchmarks/` and the docs are now
  `spawn(MyActor)`.  The sweep covers every slot that takes an
  `ActorClassOrFactory` — `spawn` / `spawnAnonymous`, `withEntityActor` /
  `withActor` / `withSingletonActor`, the `entityActor` / `singletonActor` /
  `actor` / `child` fields, and the `Router.*` routee position.  No API
  change: the closure form still works, and is still the way to pass
  constructor arguments (`() => new Worker(database)`).

- **BREAKING — idle entities passivate by default, after 5 minutes** (#892).
  `passivation-idle` shipped as `0ms`, so nothing ever passivated until an
  operator went looking for the key, and entity sets only grew.  The reference
  value and the built-in fallback are now `5m`.
  **Migration:** an entity that keeps state in memory and does not rebuild it
  in `preStart` now loses that state after five minutes idle — persistent
  entities recover, plain ones do not.  Set `passivation-idle = 0ms`, or
  `withPassivationIdleMs(0)` per type, to restore the previous always-resident
  behaviour.  Note that under `rememberEntities` a passivation is also a
  *forget*, so a remembered fleet left on the default drains over time; decide
  explicitly which of the two you want.  `ShardedDaemonProcess` opts out on
  its own — its daemons are meant to run continuously.
- **BREAKING — anonymous actors are named `$anonymous-<n>-<random>`, not `$1` /
  `$2`** (#895).  `spawnAnonymous`, `spawnTypedAnonymous` and
  `context.spawn(behavior)` without a name drew from a bare per-parent counter,
  which is both opaque (a DevTools row reading `$1` gives no hint the name is
  framework-generated) and guessable — `/user/$1` is the first anonymous actor
  of every run, and an actor path is an address anything that can render one can
  send to.  The name now carries a per-parent counter *and* twelve random hex
  characters from `crypto.getRandomValues`; the counter is kept so spawn order
  stays legible in a log line and in the actor tree.  Same reasoning that moved
  `ask`'s reply refs off a counter in #120.  Note this is the *path* segment —
  `Actor.displayName()` above is the cosmetic label and is unaffected.
  **Migration:** nothing you name yourself changes — only the value the
  framework picks when you don't.  Code that hard-codes an anonymous path
  (`actorSelection('/user/$1')`) or parses `$<n>` out of a name must spawn with
  `spawn(actor, name)` and a name of its own.
- **BREAKING — unnamed reliable-delivery controllers are
  `consumer-<n>-<random>` / `producer-<n>-<random>`** (#897).  The fallback name
  came from a module-global counter, so `/system/delivery/consumer-1` was the
  first one of every run — a derivable address for an actor that is reachable by
  path — and two `ActorSystem`s in one process drew from the same sequence.
  Same shape as the anonymous-actor names above: counter first so spawn order
  stays legible, random half to close the guessability.
  **Migration:** passing an explicit `name` to `ReliableDelivery.consumer()` /
  `.producer()` is unchanged.  Code addressing a generated controller by path
  must pass a name of its own.
- **BREAKING — actor names starting with `$` are reserved for the framework**
  (#900).  `spawn(actor, name)` and `spawnTyped(behavior, name)` now reject a
  name beginning with `$`, the prefix `spawnAnonymous` generates
  (`$anonymous-<n>-<random>`).  Until now anyone could claim it, so a
  hand-picked `'$anonymous-1-…'` could collide with — or stand in for — a name
  the framework was entitled to hand out, with spawn order deciding which won.
  A `$` anywhere other than the first character is unaffected (`'order$42'`
  still spawns).
  **Migration:** rename any actor whose name starts with `$`, or let the
  framework name it with `spawnAnonymous`.  Note the rule sits on the *spawn
  call*, not on `ActorPath`: paths are also rebuilt from cluster-wire strings,
  and rejecting `$` there would break every remote reference to an anonymous
  actor — so receiving, resolving and rendering such a path all still work.

### Fixed

- **Two nodes that dial each other at the same moment no longer stay split
  forever** (#697).  `openOutbound` registers a connection in `byPeer` *before*
  the handshake, with `peer` still unset, and the hello-hijack guard compared
  identity alone — so in a crossing dial each node held an un-acked outbound
  under the other's key and rejected the other's perfectly legitimate `hello`.
  Neither dial then received its `hello-ack`, `peer` stayed `null`, and
  `onClose` deleted the `byPeer` entry only *if* `peer` was set: the slot was
  never reclaimed, the address never re-dialled, and every frame for that peer
  accumulated silently in the handshake buffer.  The pair was partitioned for
  the lifetime of the process — reachable in the real-network suite, where two
  nodes logged one hijack rejection naming each other in the same millisecond
  and cluster-wide receptionist and pub-sub state then converged at 4 of 5 on
  exactly those two.
  Cleanup is now keyed on the *dialled* address rather than on `peer`, so a
  dead dial always gives its slot back and the next send re-dials; a 5 s
  handshake deadline reclaims a dial that connects but never acks (the
  accepts-TCP-but-never-speaks case, which had no recovery path at all); the
  handshake buffer is capped at 1 000 frames, dropping oldest; and a crossing
  dial is settled by address order, so exactly one of the two survives instead
  of both standing down.  An **established** peer connection is still never
  displaced — only a node's own unfinished dial gives way — so the hijack
  defence the guard exists for is unchanged, and it now has a test saying so.
- **`rememberEntities` no longer forgets every entity when a shard rebalances**
  (#632).  `ShardRegion.onHandOff` announced an `EntityStopped` to the
  coordinator for *every* entity of the departing shard.  The coordinator
  applied and persisted those as `stopped`, which deleted the shard's whole
  entry from its registry — so when `onHandOffComplete` reallocated the shard
  and went to ship the remembered set to the new owner, there was nothing left
  to ship.  The new owner started empty, only the entity named by the next
  message ever came back, and the coordinator went on listing the rest with
  `started` events that would never see a `stopped`.  A rebalance is the
  ordinary path, so this was `rememberEntities` failing at precisely the thing
  it exists for; it survived because the only coverage was a cold restart,
  which reloads the registry from the journal and never exercises a live
  handoff.
  A stopping entity and a moving entity look identical on the wire, so the fix
  is on both sides: the departing region no longer reports the move as a stop
  (the same way an unexpected shard death already reported none, #894), and the
  coordinator ignores an `EntityStopped` for a shard that is mid-rebalance —
  which also covers an entity that passivates on its own inside the handoff
  window, newly likely now that passivation is on by default.  Note this is
  distinct from an ordinary passivation, which under `rememberEntities` is
  still deliberately a forget.
- **Filesystem object storage stopped recognising its own temp files** (#909).
  The `Math.random()` removal below (#898) changed the atomic-write temp path
  from `<key>.tmp.<pid>.<ts>.<rand>` to `<key>.tmp.<pid>.<random>` without
  updating the pattern `list()` uses to skip them — three all-digit groups
  against a two-group name whose second half is hexadecimal, so it could not
  match at all.  A temp file only survives if the process died between the
  write and the rename, which means it holds a *partial* body; `list()` began
  reporting those as ordinary objects, so any prefix scan — a sweep, a
  migration, a durable-state enumeration — saw a key that was never committed.
  Caught only after release-time review because the test wrote the old shape by
  hand: that literal still matched the stale pattern, so the assertion passed
  while the behaviour it guards was broken.  The fixture is now built from the
  same `randomId` the writer uses, leftovers in the pre-#898 shape are still
  skipped so an upgrade does not start surfacing them, and there is a test that
  an ordinary key which merely looks temp-ish is not swallowed.
- **Messages buffered during a handoff are no longer stranded** (#893).
  `completeHandOff` cleared the region's cached shard home without ever
  replaying the buffer, and the coordinator announces a new placement only to
  the new owner and to regions with an outstanding query — so the region that
  had just handed the shard off waited for an unrelated later message to
  trigger a lookup.  On a shard that went quiet after the rebalance, that
  never came.  The region now re-asks for the home whenever its buffer is
  non-empty.
- **A shard ref for a remote shard no longer drops messages while that shard is
  passivated** (#901).  `shardRefFor()` and `ShardInfo.ref` handed out a ref
  addressed at the shard's path on its owning node.  That was safe while an
  allocated shard always had a running actor; since #892 it does not, and in
  the gap nothing resolved the path, so the receiving node dropped the message
  into the envelope catch-all.  Remote shard traffic now goes to the owning
  region — always up — which materialises the shard before forwarding, the
  same shape entity traffic has always had.  The ref keeps the shard's path as
  its identity, so logging, comparison and `ref.path` are unchanged.
- **Remembered entities return after an unexpected shard death** (#894).  When
  a shard actor died outside a handoff, ownership stayed put — which is what
  lets the next message re-create the shard — but that also meant neither
  `onRegister` nor `tryAllocate` ever ran again, and those were the only paths
  that shipped the remembered registry.  The shard came back empty, only the
  entity named by the next message returned, and the coordinator kept listing
  the rest with `started` events that would never see a `stopped`.  The region
  now asks the coordinator to re-send what it remembers.
- **`preRestart` never stopped children, whatever its documentation said**
  (#899).  `Actor.preRestart`'s JSDoc, the `onRecreate` call site and the
  supervision page all promised the default stops the actor's children.  It only
  ever called `postStop()` — children belong to the cell, which outlives the
  instance being replaced.  No behaviour changed here; the documentation now
  matches, and the consequence it was hiding is spelled out: because
  `postRestart` re-runs `preStart` with the previous incarnation's children
  still in place, an actor that spawns a **named** child in `preStart` fails its
  first restart with `Child name '<name>' is not unique`.  Spawn anonymously, or
  stop the children yourself in an overridden `preRestart`.  Both the survival
  and the collision now have tests.
- **The sharding-failover churn test no longer measures the scheduler**
  (#902).  `tests/multi-node/sharding-failover.test.ts` → "burst of asks
  during repeated coordinator state churn" drove asks for a fixed 1.5 s and
  then asserted on how many it had managed (`replies > 0`, `replies +
  failures > 20`) — a **count** bounded by a **wall clock**.  Instrumenting
  the loop in a full-suite run showed the ask costing p50 0 ms and max 4 ms
  while `Bun.sleep(5)` cost 15–16 ms, one full Windows timer quantum (#477):
  the sample count was ~100 % timer granularity, leaving `> 20` a mere 4.6×
  over a floor that says nothing about sharding.  One stalled event loop then
  reds the build two ways — the window yields under 21 iterations, or the
  first ask hits its own 4 s timeout and, 4 s being longer than the 1.5 s
  window, the loop exits with `replies` still 0.  The burst is now bounded by
  a fixed count, and the graceful leave is keyed to the driver's progress
  rather than to a sleep — which also fixes an interleaving that was
  machine-dependent, landing the leave after ~13 asks on an idle machine but
  after the first one on a stalled machine.  Ruled out along the way: the
  #892 passivation defaults cannot fire here (both sweeps share one timer
  whose first tick is at 300 s, against a 30 s test timeout), and graceful
  leave does not in fact race in-flight asks at the wire — a probe firing the
  leave at t=0 saw 0 failures across ~1 400 asks.  Test-only change; no
  runtime behaviour changed.

### Security

- **BREAKING — the cluster TLS listener actually requests a client certificate
  now** (#565).  `requestCert` hard-defaulted to `false` in both the Node and
  the Bun adapter, and `requestClientCert` was never set to `true` anywhere in
  `src/`, `examples/` or `docs/`.  On a server, `rejectUnauthorized` does
  nothing unless `requestCert` is on — so the mTLS recipe the *Cluster
  security* page documents, `{cert, key, ca, rejectUnauthorized: true}`,
  produced server-authenticated TLS only.  Since the `hello` handshake carries
  no credential of its own, that left the peer certificate — the cluster's only
  admission control — unrequested: anyone who could reach the remoting port
  completed the handshake with no certificate at all and then claimed whatever
  node identity they liked.  This is also the mitigation the #896 note below
  leans on, so until now that note promised more than the transport delivered.
  `requestClientCert` now **defaults to `ca !== undefined`** — a trust bundle
  on a cluster listener has no other purpose — and the option object both
  adapters hand to the runtime is built in one shared place, since the defect
  survived review by being spelled out identically twice.
  Two configurations are now refused at bind time rather than started in a
  weaker state than they read as: `requestClientCert: true` with no `ca`, and
  **mutual TLS on Deno**, where `Deno.listenTls` cannot request a client
  certificate and the dialer sends none, so peers would be unauthenticated in
  both directions.
  **Migration:** a Node or Bun cluster already passing `ca` starts demanding
  peer certificates — which is what its configuration always claimed — so every
  node must present one signed by that CA.  Set `requestClientCert: false` to
  keep one-way TLS.  A Deno cluster configured with `ca` no longer binds; run
  it on Node.js or Bun for mTLS, or opt out explicitly.
- **A `ClusterClient`'s own wire identity no longer comes from `Math.random()`**
  (#565 sweep).  A client without an explicit `clientIdentity` names itself
  `50_000 + Math.floor(Math.random() * 15_000)`, and that port goes straight
  into the `NodeAddress` it announces on the wire and keys the cluster's
  `byPeer` map — so it is an address, not a coin flip, and a peer that can
  predict it can address, impersonate or pre-claim the client's slot.
  `Math.random()` is not a CSPRNG and its state is recoverable from a handful
  of observed outputs; the comment above the line claimed hrtime-derived
  randomness, which the code did not do.  It is now drawn with
  `crypto.getRandomValues` across the whole IANA ephemeral range — the old
  15 000-slot window also made an accidental collision likely at a few dozen
  clients per process, which was a correctness problem on its own.  The last
  of the generated-identifier findings this release sweeps up (#896, #897,
  #898, #895).
- **Quorum correlation ids in `DistributedData` are no longer guessable**
  (#896).  `nextPendingId()` returned `p<Date.now()>-<counter>`.  That value
  travels on the wire and the peer echoes it back on its acknowledgment, so an
  id that can be guessed is an id whose acknowledgment can be forged —
  satisfying a quorum write or read that no peer actually confirmed.  A
  timestamp is observable and the counter starts at 1 in every process, which
  made guessing arithmetic rather than search.  It is now sixteen random hex
  characters.  (The counter was also module-global rather than per-system, so
  two systems in one process shared a sequence.)  Reachable only by something
  that can already send cluster wire messages, which mTLS on the transport
  excludes — see *Cluster security* — so this is defence in depth, not an open
  door on a hardened cluster.
- **Filesystem object-storage temp paths no longer come from `Math.random()`**
  (#898).  The atomic-write temp file was named
  `<key>.tmp.<pid>.<Date.now()>.<Math.random()>`; the clock is observable and
  `Math.random()` is not a CSPRNG, so a local process sharing the directory
  could predict the path and pre-create it or plant a symlink there.  The
  suffix is now drawn from `crypto.getRandomValues`.

### Documentation

- **`fundamentals/spawning` no longer contradicts itself about constructor
  arguments** (EN + DE, #907).  The page declared `Worker` with two required
  constructor arguments, showed `system.spawn(Worker, 'worker-1')` as the form
  that is *rejected* — and then used that identical line fifty lines later as
  the correct naming example, with three further samples calling
  `new Worker(database)` one-armed against the two-argument class.  A reader
  copying the naming example got exactly the error quoted above it.  `Worker`
  now takes the one dependency every other sample on the page passes it, and
  the sections that are not about arity use the zero-argument `Greeter`.
- **The docs API-drift guard covers the `Props` removal** (#907).
  `docs/scripts/check-api-drift.mjs` runs in CI and its own header says to add
  a pattern whenever an API is renamed or removed — the largest removal the
  project has made added none, which is how a broken call shape survived in the
  docs long enough to be filed.  It now rejects `Props.create`, `Props.empty`,
  `spawn(props`, `entityProps`, `singletonProps`, `childProps`, `routeeProps`,
  `typedProps`, `behaviorFor`, `asInternal(`, `BackoffSupervisor.props` and
  `ClusterRouter.props`, with a per-pattern allowlist so the Akka migration
  pages keep Akka's own spelling in their `scala` / `csharp` fences.
- **`fundamentals/props` is now `fundamentals/spawning`** (EN + DE, #547) —
  rewritten around what the reader is doing rather than around a type.  The
  old slug redirects.

- **The docs lead with the actor class at every spawn site** (EN + DE, #547)
  — the samples follow the code trees onto `spawn(MyActor)`, and the prose
  that described them followed.  `quickstart` and `fundamentals/actor` were
  the sharpest mismatch: both called the argument "the factory" directly
  above a sample passing a class, and `actor.mdx` carried a dangling "`...`
  wraps the factory + supervisor strategy" sentence where `Props.create(…)`
  used to be named.

## [0.12.2] — 2026-08-04

### Fixed

- **BREAKING — persistence stores no longer silently corrupt rich payload
  types** (#888).  Every journal, snapshot store and durable-state store wrote
  payloads with bare `JSON.stringify`, so a persisted `Set`/`Map` recovered as
  `{}`, a `Date` as a string, a `Uint8Array` as an index-keyed object, and a
  `bigint` threw — and because the write path folds the original object, the
  corruption only surfaced on the next recovery.  Payloads now use the tagged
  JSON tree format `JsonSerializer` already used (`__date__`, `__bytes__`,
  `__map__`, `__set__`, `__bigint__`, plus a new `__literal__` escape so user
  data shaped like a tag round-trips as data), on every backend.
  **Migration:** none for readers — rows written by older versions decode
  unchanged.  Rows written from this version on carry tag objects where plain
  JSON would corrupt the value, so *older* framework versions (and
  non-actor-ts JSON consumers) reading *new* rows see the tag shape instead of
  a bare value.  `JsonSerializer` also now honours `toJSON()`, reports
  circular references as a `SerializationError` naming the key path instead of
  overflowing the stack, and only interprets a tag when it is an object's sole
  own key.

### Changed

- **The in-memory journal / snapshot store / durable-state store round-trip
  payloads through the same codec as the real backends** (#888).  Dev/prod
  parity: an event that cannot be stored fails in the test suite instead of on
  the first production recovery, and mutating an object after `persist` no
  longer aliases into the store.  Like the real stores, they still return and
  publish the caller's original objects.

### Added

- **Full type fidelity for stored payloads and `JsonSerializer`** (#889).
  `NaN` / `Infinity` / `-Infinity` / `-0`, `undefined` in value positions
  (array slots, `Set` members, `Map` entries — object properties still drop,
  matching `JSON.stringify`), `RegExp` (source + flags), `URL`, `Error`
  (name + message + cause, incl. subclass constructors and
  `AggregateError.errors` — deliberately no stack, which would leak
  filesystem paths into long-lived rows) and every typed array / `DataView` /
  `ArrayBuffer` now round-trip through every store and the JSON serializer.
  `Number`/`String`/`Boolean` wrapper objects unwrap like `JSON.stringify`;
  `Promise`, `WeakMap` and `WeakSet` throw a `SerializationError` at persist
  time instead of being silently stored as `{}`.
- **Per-store `serializer` option** (#888, the persistence half of #450).
  Every journal / snapshot store / durable-state store options builder — and
  every `Register<X>Plugins` bundle — takes `withSerializer(serializer)` to
  route a custom `Serializer` into stored rows via a self-describing
  `__serialized__` framing.  Default-format rows and framed rows coexist in
  one stream; reading a framed row without (or with a mismatching) serializer
  fails with an actionable `SerializationError`.  Registry auto-binding and
  the cluster wire remain tracked in #450.

## [0.12.1] — 2026-08-03

### Changed

- **BREAKING — `ReplicatedEventSourcedActor` no longer takes a `Cluster`, and
  `replicaId` now has a default** (#833).  Both existed only because the actor
  could not reach its own cluster; now that it can, they are boilerplate every
  subclass was copying:

  ```ts
  // before
  class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
    readonly persistenceId = 'counter-1';
    readonly replicaId: string;
    constructor(cluster: Cluster) {
      super(cluster);
      this.replicaId = cluster.selfAddress.toString();
    }
  }
  new Counter(cluster);

  // after
  class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
    readonly persistenceId = 'counter-1';
  }
  new Counter();
  ```

  **Migration:** drop the `cluster` constructor argument and the `super(cluster)`
  it fed (a subclass with no other dependencies can drop its constructor
  entirely).  `replicaId` defaults to `this.cluster.selfAddress.toString()`,
  which is what every in-repo subclass set it to by hand.

  A **custom** `replicaId` becomes a getter — as a field it now collides with
  the base-class accessor (`TS2610`):

  ```ts
  override get replicaId(): string { return process.env.REPLICA_ID!; }
  ```

  Override it when the id must survive a re-address (a fixed region name, say);
  two replicas that ever share an id dedupe each other's events away, so the
  node-address default is the safe one.  The actor must now run on a system
  that joined a cluster — it did before too, it just took the cluster by hand.

### Added

- **`actor-ts.sharding.max-entities` — the per-node entity cap is configurable**
  (#835).  `maxEntities` LRU-passivates the coldest entity when a node is at
  capacity; it was the one passivation trigger with no HOCON form, which left
  the time bound (`passivation-idle`) tunable per environment and the memory
  bound code-only.  An entity count is exactly the value that differs between a
  laptop and a 64 GB production node:

  ```hocon
  actor-ts.sharding {
    passivation-idle = 2 minutes
    max-entities     = 50000        # 0 = no cap (the default)
  }
  ```

  Same layering as the rest of the block — an explicit `withMaxEntities(…)`
  still wins — and the reference value is `0`, so nothing changes for anyone
  who does not set it.

- **An actor can reach its own `Cluster`** (#833).  `this.context` and
  `this.system` were always there; the `Cluster` was the one runtime object
  that had to be threaded in by hand — through a constructor argument, an
  options field, or a captured closure — and a framework-constructed actor (a
  sharded entity, a singleton) has no call site to thread it through at all.

  ```ts
  class CartEntity extends Actor<CartMessage> {
    override preStart(): void {
      // No constructor argument, no closure, no options field.
      this.log.info(`cart ${this.entityId} on ${this.cluster.selfAddress}`);
    }
  }
  ```

  Three accessors, all additive:

  - `system.cluster` — `Option<Cluster>`, filled in by `Cluster.join`.
  - `this.context.cluster` — the same `Option`, for an actor that must also
    run unclustered.
  - `this.cluster` — unwrapped, throwing when the system never joined one, on
    the same "this code already knows" trade-off as `this.entityId`.  The
    error names `Cluster.join` and the `Option` form rather than just the
    symptom.

  `cluster.sharding` / `cluster.singleton` come along with it, so an actor can
  start a region or a singleton from the inside.  All three read through to
  the system on every access: an actor that outlived the join sees the
  cluster, and a system that rejoined after `leave()` resolves to the new
  instance rather than the dead one.  It stays an `Option` deliberately —
  a cluster binds a transport and starts gossip/heartbeat/failure-detection
  timers, so a local-only system must never grow one on demand.

  Registration is a new `ClusterExtension` (`clusterOf(system)`, mirroring
  `metricsOf` / `tracerOf`) that `Cluster.join` is the sole writer of.  Core
  keeps its runtime independence from the cluster layer the same way
  `EntityContext` does: type-only import of `Cluster`, value import of just
  the extension id.

- **A sharded entity can read its own `entityId`** (#832).  The id an entity
  was routed by used to stop at the `Shard` that spawned it — the entity could
  only get it back by slicing the `entity-` prefix off its actor path, which is
  boilerplate at every call site and, worse, lossy: actor names have a
  restricted alphabet, so `Shard` folds everything outside `[A-Za-z0-9_-]` to
  `_` (#568) and `user:42` and `user/42` both read back as `user_42`.

  ```ts
  class CartEntity extends PersistentActor<CartCommand, CartEvent, CartState> {
    // one journal stream per entity, from the id sharding actually routed
    override get persistenceId(): string { return `cart-${this.entityId}`; }
  }
  ```

  Three accessors, all additive:

  - `this.entityId` — the value `extractEntityId` returned, verbatim.
  - `this.entity` — that plus `typeName` and `shardId` (`EntityContext`).
  - `this.context.entity` — the `Option` form, `None` for a non-entity actor;
    the two getters throw there instead.

  Available from `preStart` onwards — early enough for a `PersistentActor` to
  build its `persistenceId` before recovery — and stable across a restart.  It
  is a getter, not a field: the context is attached after construction, so a
  field initializer would still run too early.  The identity sits on the entity
  and nowhere else; an entity's own children get `None`.

  `Props.withEntity({ entityId, typeName, shardId })` is the same door
  `ClusterSharding` uses, left public so an entity can be unit-tested without a
  cluster around it.  `ShardedDaemonProcess` no longer regex-parses its own
  actor name to find its daemon index, and the chat example's two
  `PersistentActor`s drop their path-stripping getters — the direct-message
  channel's `persistenceId` is now built from the real `|`-separated pair id
  rather than the sanitized one.

### Documentation

- **A new page publishes the complete `reference.conf`** — every setting the
  framework ships, verbatim, so "what can I configure?" has one exhaustive
  answer instead of a curated example.  The Configuration page keeps
  explaining what each key does and links across.

  The copy is pinned to the source: a test compares the page's HOCON block to
  `REFERENCE_CONF` and fails on any drift, in both languages.  A published
  default that no longer matches the shipped one is the same lie as a
  documented key nothing reads, which is what the rest of this release is
  about.

### Fixed

- **A guard against the next dead config key** (closes #653).
  `tests/unit/config/NoDeadConfigKeys.test.ts` asserts, for every leaf in
  `REFERENCE_CONF`, that it is reachable from `ConfigKeys` *and* referenced
  from somewhere under `src/`.  A key added to the reference config without a
  reader now fails CI with a message naming the key.

  Knowingly-unimplemented keys go in `KNOWN_DEAD_KEYS` with the issue that
  will remove them — the list has exactly one entry (`remote.tls.enabled`,
  #591), and the guard also checks that each excused key still *exists*, so
  an exception cannot outlive its key.

  The check proves a reference rather than a correct read: a key mentioned in
  dead code would still pass.  That ceiling is deliberate — the defect worth
  catching is "declared and never wired up", and modelling config flow
  through the options mergers would be a lot of machinery for the rest.

  `PersistenceExtension` moved its two raw path literals onto
  `ConfigKeys.persistence.*` along the way; it was the last reader in `src/`
  still spelling paths by hand.

- **`actor-ts.system.name`, `actor-ts.worker-cluster.*` and
  `actor-ts.coordinated-shutdown.*` are actually read** (part of #653) — the
  last of the inert blocks.

  `ActorSystem.create()` now takes an **optional** name: omit it and the
  system is named from `actor-ts.system.name`, falling back to `"default"` as
  before.  `create('billing')` still wins.

  `CoordinatedShutdown` picks up all three of its keys.
  `default-phase-timeout` seeds the 12 canonical phases (it was hardcoded to
  `5_000`, now `DEFAULT_PHASE_TIMEOUT_MS` in `util/Constants.ts`).
  `terminate-actor-system = false` drops the built-in terminator task while
  leaving the phase and any user tasks in it intact — for a host process that
  owns the system's lifetime.  **`exit-jvm` is renamed to `exit-process`** —
  it is a JVM-ism in a TypeScript framework, and it now does something: with
  it on, `process.exit(0)` runs once the pipeline completes, which is how you
  stop a lingering handle from making a finished shutdown look like a hang.

  **The `worker` block is now `worker-cluster`, and `count` is `workers`** —
  named after `WorkerClusterOptions`, whose fields they fill in, and in
  lockstep with them.  `WorkerCluster.spawn` is a static with no `ActorSystem`
  in scope, so it loads the config chain itself (the same one
  `ActorSystem.create` uses).  An unknown `restart-policy` is now rejected by
  `WorkerClusterOptionsValidator` instead of falling through the internal
  `match` and silently meaning "never restart" — that check was missing for
  code-supplied values too.

- **`actor-ts.http.backend` and `actor-ts.http.shutdown-grace-period` are
  actually read** (part of #653).  `newServerAt(...).bind()` hardcoded
  `new FastifyBackend()` and the auto-registered shutdown task called
  `unbind()` with no grace period at all — so the documented 5 s drain window
  was, in practice, zero.

  ```hocon
  actor-ts.http {
    backend = "hono"
    shutdown-grace-period = 10s
  }
  ```

  `useBackend(...)` still wins; the config only decides what `bind()` picks
  when the builder was given nothing.  An unrecognised name now fails the
  `bind()` with a `ConfigError` naming the key and the accepted values,
  instead of silently falling back.  Express and Hono are imported
  dynamically, so naming neither keeps both out of your bundle.

  The reference comment advertised **`fastify | bun | express`** — a `bun`
  backend that has never existed, and no mention of the Hono backend that
  does.  Corrected to `fastify | express | hono`, and `backend = "bun"` now
  fails loudly rather than being ignored.

  **`shutdown-grace-period`'s published default moves `5s` → `0ms`**, the same
  correction as `max-frame-bytes`: `unbind()` has always been called with no
  grace period, so `0` — force as soon as the server closes — is what every
  deployment has actually been running.  Making the documented `5s` live
  turned out to cost real time rather than none: where a backend's `close()`
  cannot settle (Express with a live WebSocket on Bun), the window is not an
  upper bound that resolves early but a deadline that is always reached, so
  every such shutdown would have gained five seconds.  Raise it deliberately
  if you want in-flight requests to finish.

- **The `actor-ts.cluster.*` and `actor-ts.remote.*` config blocks are actually
  read** (part of #653; closes #754).  Same defect as the sharding block: the
  keys shipped in `reference.conf`, the Configuration page documented them, and
  `Cluster.join` took every value from `ClusterOptions` alone.  `Cluster.join`
  now layers them underneath, so **explicit options > HOCON > built-in
  defaults** holds here too.

  The bind address comes with it, which is what the docs have shown all along:

  ```hocon
  actor-ts.remote.tcp {
    host = "0.0.0.0"
    port = ${?ACTOR_TS_PORT}   # env-var substitution — now actually applied
  }
  ```

  One consequence worth knowing: `host` / `port` are validated on the *merged*
  settings, and the reference config supplies both, so a `Cluster.join` that
  omits them no longer throws `OptionsError` — it binds `0.0.0.0:2552`.  That is
  the point of the feature, but it turns a startup error into a running node,
  so pin the address in config if you were relying on the throw.

  `failureDetector` merges **per threshold**, not per object: setting only
  `downAfterMs` in code keeps `heartbeat-interval` and `unreachable-after` from
  the file.  A shallow merge would have silently reset the two the caller never
  mentioned.

  **`remote.max-frame-size` → `remote.max-frame-bytes`, and its documented
  default was wrong.**  The key is renamed to match the field it feeds
  (`ClusterOptions.maxFrameBytes`, new, with `withMaxFrameBytes(…)`), and the
  reference value moves `1M` → `16M`.  The `1M` in the docs was never the
  effective cap — nothing read the key, so every cluster has always run at
  `DEFAULT_MAX_FRAME_BYTES` (16 MiB).  Publishing `16M` states what the
  framework actually does; the alternative, keeping `1M` now that it is live,
  would have tightened every existing cluster's wire cap 16× on upgrade and
  broken anyone sending large envelopes.  **If you sized your deployment
  against the documented 1 MiB, set `max-frame-bytes = 1M` explicitly — it now
  works.**  The cap applies to the transport the cluster builds for itself; an
  injected `withTransport(…)` keeps the cap it was constructed with.

  **Two dead keys removed rather than wired:**

  - `cluster.leader-election = "lowest-address"` — the leader is always the
    lowest-addressed up-member and there is no second strategy, so the key
    documented a choice the framework does not offer.
  - `remote.transport = "tcp"` — a custom transport is an object passed to
    `withTransport(…)`, never a string; the in-memory transport is a test
    detail. `ConfigKeys.transport` (`'actor-ts.transport'`) went with it — it
    matched no documented path and was referenced nowhere.

  `remote.tcp.hostname` is now `remote.tcp.host`, matching `ClusterOptions.host`
  and the `withHost(…)` that sets it.  All four renamed/removed keys were inert,
  so no working configuration changes meaning — but a config file that named
  them was never doing anything anyway.

  `remote.tls.enabled` stays dead **on purpose** (#591): it is now flagged as
  such in the docs and named in the dead-key guard's exception list, rather than
  being quietly wired to a TLS implementation that does not exist yet.

- **The `actor-ts.sharding.*` config block is actually read** (#834, part of
  #653).  `reference.conf` shipped all five keys and the Configuration page
  documented them with their defaults, but nothing in `src/` ever looked at
  them: every sharding setting came from `ShardingOptions` alone.  An operator
  who wrote

  ```hocon
  actor-ts.sharding.passivation-idle = 2 minutes
  ```

  got no passivation whatsoever — entities stayed resident forever, with no
  warning, because the value was never read rather than rejected.
  `examples/config/application.conf` sets exactly this key, which made it look
  like a working example.

  `ClusterSharding.start` now layers the block under the caller's options, so
  the precedence the rest of the framework documents — **explicit options >
  HOCON > built-in defaults** — finally holds for sharding too, per field:

  ```ts
  // actor-ts.sharding: number-of-shards = 128, passivation-idle = 2 minutes

  const shardingOptions = StartShardingOptions.create<CartCommand>()
    .withTypeName('cart')
    .withEntityProps(Props.create(() => new CartEntity()))
    .withExtractEntityId((command) => command.entityId)
    .withNumShards(256);

  cluster.sharding.start(shardingOptions);
  // numShards 256 (explicit), passivationIdleMs 120_000 (config file)
  ```

  All five keys land: `number-of-shards`, `remember-entities` and
  `passivation-idle` reach the region, `rebalance-interval` and
  `hand-off-timeout` the per-type coordinator — `start` is the only call that
  feeds both, which is why the merge lives there and not in `ShardRegion`.
  The keys are now reachable from `ConfigKeys.sharding`, and an explicit
  `undefined` counts as "not set" and falls through to the file instead of
  shadowing it.

  **No behaviour change without a config file:** the reference values are
  identical to the built-in fallbacks (64 / 2s / 10s / false / 0ms), and a
  regression test pins them together so wiring the block cannot drift into
  changing defaults.

  Internally, `mergeOptions` / `stripUndefined` moved from
  `io/broker/BrokerOptions.ts` to `util/OptionsMerge.ts` — the precedence rule
  is project-wide, and sharding is its second caller.  Not a public export;
  no import path in the published API changes.

  The other dead blocks — `cluster.*`, `remote.*`, `http.backend`, `worker.*`,
  `coordinated-shutdown.*` — remain open under #653.

## [0.12.0] — 2026-08-01

### Added

- **`SingletonKey` and `ShardKey` — typed, class-declared identities** (#523).
  A singleton's name and its message type used to be two unlinked facts: the
  `typeName` string went one way, the `<T>` generic another, and
  `get<T>(typeName)` re-asserted the type with no checking at all.  Both keys
  tie them together the way `ServiceKey` already did for the Receptionist, and
  both are meant to be declared on the actor itself:

  ```ts
  class UserRepository extends PersistentActor<UserRepositoryCommand, Event, State> {
    static readonly singleton = SingletonKey.of<UserRepositoryCommand>('user-repository');
    constructor(private readonly users: ActorRef<UserCommand>) { super(); }
  }
  class UserActor extends PersistentActor<UserCommand, Event, State> {
    static readonly shard = ShardKey.of<UserCommand>('user', (command) => command.userId);
  }

  const users = cluster.sharding.start(UserActor);
  const repository = cluster.singleton.start(UserRepository, () => new UserRepository(users));
  ```

  A static is the carrier because TypeScript's `implements` constrains only
  the **instance** side of a class — there is no `static implements`, and
  `abstract static` is a compile error — so a `SingletonActor` marker
  interface would be structurally empty and check nothing.  It is deliberately
  not shipped.  A static also composes with any base class, which matters
  because these actors are usually `PersistentActor`s and TypeScript has
  single inheritance.  `ShardKey` carries the `extractEntityId` alongside the
  name (identity is the name alone, so a lookup-only node can omit the
  extractor); an extractor in options still overrides it.  The sharding half
  is purely additive — every existing calling shape keeps working.
- **`ClusterSingleton.ref(key)` — a singleton ref without hosting it** (#523),
  the counterpart to `ClusterSharding.startProxy` that the singleton API never
  had.  Works on a node that never calls `start`.  `ref` and `start` return
  the same memoised ref per key, and the local manager is resolved per
  delivery — so a node that calls `ref` first and `start` later keeps the same
  ref, which simply begins delivering locally instead of over the wire.  A
  leader that never called `start` hosts nothing, so its ref dead-letters with
  a single latched warning rather than buffering: unlike "no leader elected
  yet", that state does not heal on its own.
- **`cluster.singleton`** (#523) — the facade mirroring `cluster.sharding`,
  plus `ClusterSingleton.get(system, cluster)` for callers holding the two
  separately, and `stop(key)` / `managerFor(key)` / `isStarted(key)`.
- **`WorkerClusterOptions.withBackend()` and the same option on
  `ParallelMultiNodeSpecOptions`** (#520) — spawn workers through a given
  `WorkerBackend` instead of the one `getWorkerBackend()` detects.  For a
  runtime the detection does not know, and for driving fake workers in a test
  without mocking a module.  `WorkerBackend` is exported from the package root
  now that it is part of a public options shape.  See *Fixed* for why the seam
  had to exist.
- **Shard introspection: `ClusterSharding.shards()`, `shardRefFor()`, and the
  `StartEntity` / `GetShardStats` shard commands** (#151).  The sharding
  protocol had no query message of any kind — `ShardCoordinator` handled seven
  variants, none of them a `Get*` — so "which shards exist, and where?" had no
  answer short of the `/cluster/shards` management endpoint, which reads a
  DistributedData snapshot and only works if you opted into a
  `coordinatorStateStore`.  The multi-node tests went as far as reaching into
  the coordinator's private fields.  `shards(typeName)` now answers
  cluster-wide with a `ShardInfo` per placed shard: shard id, hosting node,
  region path, live entity count, whether it is local, **and a usable `ref`**.
  The coordinator owns the shard map but not the entity counts — only the
  hosting region knows those — so it fans `GetShardRegionStats` out to the
  registered regions and joins the answers against `shardHome`; a region that
  misses the deadline contributes `0` rather than failing the call.  Refs are
  materialised on the *asking* node, so the wire payload stays plain data and
  no ref has to survive serialisation.  `shardRefFor(typeName, shardId)` hands
  back one shard's ref and allocates the shard if it had no home yet, exactly
  as a first message for it would have.  Because a shard is a real actor now,
  that ref is the real thing — the local actor, or a `RemoteActorRef` at
  `/user/sharding-<type>/shard-<n>` — so `tell` works from anywhere; `ask` on
  it works when the shard is local, and cross-node queries pass their own
  actor's `self` as `GetShardStats.replyTo` (a one-shot ask ref is not
  addressable from another node, which is why the sharding protocol correlates
  replies by path in the first place).
- **`ClusterSharding.entityRefFor(typeName, entityId)`** (#512) — a
  location-transparent handle to a single entity, the counterpart to the region
  ref that sharding has handed out until now.  With only a region ref, every
  message has to embed its own entity id so `extractEntityId` can dig it back
  out; the identity of the entity is implicit and there is nothing you can pass
  to another component that means "this one entity".  `entityRefFor` returns an
  ordinary `ActorRef`, so `tell` and `ask` work as usual, and it wraps each
  message in an id-addressed envelope that the region routes without consulting
  `extractEntityId` at all — the message type no longer has to know how it is
  routed.  Synchronous, because the shard is `hash(entityId) % numShards` and
  needs no lookup; location-transparent, because it routes through the local
  region, which already knows how to buffer for an unplaced shard and how to
  forward across nodes.  A proxy region is enough to hand one out.
- **BREAKING — a shard is a real actor now: `Region → Shard → Entity`** (#511).
  A shard used to be nothing but a number key in `ShardRegion`'s maps, with the
  entities spawned as direct children of the *region*.  That left "give me an
  `ActorRef` for shard 7" with no referent at all, made handoff a
  fire-and-forget loop that reported `HandOffComplete` *before* the entities had
  actually stopped, and hid the shard dimension from the actor tree entirely.
  Entities are now grandchildren of the region:
  `/user/sharding-<type>/shard-<n>/entity-<id>` — **migration:** anything that
  resolved an entity by path has to insert the `shard-<n>` segment (the shard id
  is `hashShardId(entityId, numShards)`); `ActorPath.parent` of an entity is now
  its shard.  The new `Shard` actor owns the entity lifecycle only — spawn,
  watch, stop, and the buffer that holds traffic for an entity on its way out.
  Routing, buffering, coordinator registration and the ask-correlation machinery
  stay in the region, and so does the passivation *policy*: both the idle sweep
  and the `maxEntities` LRU are decided there and executed by the owning shard
  through a `PassivateEntity` command.  Keeping the policy one level up is what
  lets `maxEntities` go on meaning "per node" instead of quietly becoming "per
  shard" — a knob that would otherwise have changed meaning without changing
  name.  Handoff is now simply "stop the shard": the runtime terminates the
  entities underneath and only then delivers `Terminated`, so `HandOffComplete`
  finally means what it says.  Shards are created eagerly when the coordinator
  assigns one, not lazily on the first message, so an allocated-but-empty shard
  still has a live ref.  The cost was accepted deliberately and is not small:
  every message to a local entity now takes one extra node-local hop, and
  `benchmarks/cluster/sharded-roundtrip.ts` measures it as **~40k → ~29k ask/s
  on one node (−28 %, +9 µs per ask)** and **~42k → ~25k on two nodes (−41 %,
  +16 µs)** — medians of three runs each, on the same machine.  If you are
  routing hot-path traffic through a region and were relying on the old
  numbers, this is the change that moved them.
- **CI gate for the benchmarks: `typecheck:bench` + `bench:smoke`** (#506).
  Nothing looked at `benchmarks/` at all — `bun run typecheck` uses the build
  tsconfig, which deliberately excludes them, and `test.yml` does not even
  trigger on `benchmarks/**` — so a `src/` change that orphaned a benchmark was
  invisible from the benchmark side of the diff.  Two checks, in a new
  `benchmarks` workflow that also triggers on `src/**`:
  `bun run typecheck:bench` compiles `src` + `benchmarks` against the new
  `tsconfig.bench.json` (deliberately narrower than `tsconfig.dev.json`, which
  also pulls in `tests/` and `examples/` — a tight scope is fast and, unlike the
  dev config, green, so it can actually gate), and `bun run bench:smoke` runs
  every suite for real.  The new `ACTOR_TS_BENCH_SMOKE=1` collapses each case to
  one unwarmed iteration, so the full suite finishes in ~30 s; the numbers it
  prints are noise, the point is that each suite still executes.  The typecheck is
  the stricter of the two for a missing export — that is a compile error even when
  the imported binding is never called, whereas Bun silently elides an unused
  named import at runtime.  `run-all.ts` gains `--exclude=<group>`, and the
  workflow excludes `worker` for the same reason the worker-thread multi-node
  suites are quarantined on hosted runners (Bun there cannot respawn functional
  worker threads after the first).
- **`--devtools-host` for the examples** (#492) — the shared `--devtools` wiring
  bound `127.0.0.1` and only let you move the port, which is unreachable when the
  browser is not on the machine running the example (a container, a VM, a WSL or
  remote dev box).  `--devtools-host=<host>` / `DEVTOOLS_HOST` now sets the
  interface.  A non-loopback host there implies `allowRemote`, so DevTools binds
  and logs its "reachable without auth" warning rather than refusing on a rule
  written for applications; the free-port probe binds the same interface it is
  asking about, and a wildcard bind (`0.0.0.0`, `::`) is reported as a loopback
  URL because `http://0.0.0.0:9333` is not an address a browser can open.
- **Package-health CI: publint, arethetypeswrong and knip** (#416).  Three
  failure modes the test suite structurally cannot see, because they are
  properties of the published tarball rather than of the code: a broken `exports`
  map or a `files` list missing the built output (publint); declarations that
  resolve for the author but not for a consumer under their module resolution
  (attw); and a module reachable from no entry point, or an import with no
  manifest entry behind it — which works locally and breaks on a fresh install
  (knip).  All three pass today, so this locks in the current state rather than
  fixing a defect.
  Two configuration notes, since both were judgement calls.  attw runs with
  `--profile esm-only`: this package ships no CJS, so the "ESM (dynamic import
  only)" note for a CJS consumer describes the design and has no fix short of
  shipping CJS.  And knip is unusable here unconfigured — it reports ~341
  "unused files" and several hundred duplicate exports, because its defaults
  assume an *application*, where anything unreachable from one entry is dead and
  two names for one value is a mistake.  Neither holds for a library whose whole
  surface is its exports, and one of them is a documented convention: AGENTS.md
  *requires* every options family to export `XOptions` as both a type union and a
  value alias for the builder, in ~60 files.  `knip.jsonc` therefore turns off the
  rules that fight the project and keeps the ones that catch real problems, with
  the reasoning recorded against each.

- **`"sideEffects": false`** (#415) — nothing in this package does work at import
  time, so a consumer's bundler may drop whatever it does not reference.  Backed
  by a test rather than asserted: it bundles a narrow import and measures what
  survives.  `import { Actor }` comes out at **~1.5 KB** against **~2.3 MB** for
  the whole barrel, and the embedded DevTools UI — the largest single artefact in
  the tree — is absent.  A companion test proves that canary is a real one by
  showing the UI *does* appear when the DevTools entry point is imported;
  without it the assertion would keep passing even if tree-shaking broke.

- **`ActorPath.toString()` is memoized** (#412).  Every field is `readonly` and
  the parent chain is fixed at construction, so the rendering cannot change once
  computed — and it is called far more often than it looks: `equals` renders
  *both* sides, ref comparison goes through `equals`, and dead-letter routing,
  the receptionist and the DevTools taps all key on the string.  A deep path was
  re-walking its ancestors and re-joining an array on every one of those.
  Computed lazily rather than in the constructor, since a path is created on every
  spawn, including for actors whose path is never rendered.

- **`SqliteDurableStateStore`** (#392) — the last gap in the backend matrix.
  SQLite shipped a journal and a snapshot store but no durable state, so it was
  the only family whose three-component set was incomplete;
  `LibSqlDurableStateStore` covered the remote case and said so in its own
  JSDoc.  The schema is the SQLite dialect's, identical to libSQL/Turso and
  Cloudflare D1, so a database moves between a local file and either without a
  migration.
  The enabling piece is a new **`SqliteClient`** — a `SqlPool` adapter over the
  local driver.  Local SQLite was the one family without one, because
  `SqliteJournal` predates the relational base layer and drives `SqliteDb`
  directly while every other backend has an `XClient.ts`.  Two things made it
  more than a wrapper.  The driver is **synchronous and split** — `.all()`
  returns rows, `.run()` returns `changes`, and asking for the wrong one throws
  on `better-sqlite3` — so statements are classified before they run.  And its
  transactions are **real**, which means they need serializing: one `SqliteDb`
  is one connection, so without a queue a second `withTransaction` could issue
  its `BEGIN` while the first was still awaiting, collapsing the two into one
  transaction that commits early.
  Because it talks to a file rather than over HTTP, `withTransaction` is a
  genuine `BEGIN IMMEDIATE … COMMIT`.  `SqlPool` specifies isolation as
  adapter-defined so the HTTP-fronted stores can offer *less*; this one offers
  more than the contract requires.  `IMMEDIATE` rather than the default
  deferred, so a read-then-write sequence cannot fail to upgrade its lock
  partway through.  A remote URL is refused at construction with a pointer to
  `LibSqlDurableStateStore`, since the local driver cannot open one and
  silently creating a *file* by that name is the confusing outcome.
  It is also the first durable-state harness in the shared contract suite to run
  against a **real SQL engine** rather than a fake — an in-memory database needs
  no container.
  Follow-ons filed rather than left implicit: **#491** (collapse `SqliteJournal`
  onto `RelationalJournal`, now possible) and **#490** (the Cassandra-LWT half of
  #392).

- **A by-tag projection accepts a full `TagFilter`** (#393).  The query layer has
  supported `all` / `any` / `not` since it was written, but a projection was the
  one consumer still limited to a single tag string — so "every order that is not
  cancelled" needed a hand-rolled projection instead of a filter.
  `ByTagProjectionOptions.withTag` now takes either.  A bare string keeps working
  *and keeps its exact cursor*: `OffsetStore` is keyed by string, so the new
  `tagFilterCursorKey` maps a plain string to itself — any other mapping would
  have orphaned every persisted cursor and silently replayed each deployed
  projection from the beginning.  Object filters get a canonical key with each
  operator's tags sorted, so two filters that mean the same thing share one
  cursor however they were written.

- **`close?()` on `DurableStateStore`** (#393).  `Journal` and `SnapshotStore`
  have carried a teardown hook since they were written; durable state was the one
  contract of the three without it, even though its implementations hold the same
  kind of resource — a connection pool, an HTTP client, a file handle.  The
  remaining #393 items are tracked as **#493**.

- **Cloudflare D1 persistence backend** (#438) — `D1Journal`, `D1SnapshotStore`
  and `D1DurableStateStore`, completing the umbrella's five backends.  Spoken over
  D1's REST API with the framework's own `HttpClient`, so it adds **no dependency
  at all** — D1 has no Node SDK, which for once makes the SDK-free path the only
  path.  The SQL is `sqliteDialect`'s, so the schema is identical to the local
  SQLite and libSQL backends and a database can move between all three without a
  migration; the whole backend is a client plus three constructors.
  `withTransaction` provides no isolation because the HTTP API has no `BEGIN` and
  no parameterized batch — which `SqlPool` always documented as adapter-defined,
  and which the journal survives because concurrency rests on the primary key
  rejecting a racing writer.  The cost is documented: a multi-event append can
  persist a prefix if the connection drops midway.
  **Verification stops at the fake**, deliberately: D1 has no emulator that fits a
  container suite (locally it exists only inside `wrangler`/Miniflare), so there is
  no live suite and no CI row, and the docs say so plainly.
- **DynamoDB persistence backend** (#398) — `DynamoDbJournal`,
  `DynamoDbSnapshotStore` and `DynamoDbDurableStateStore` over
  `@aws-sdk/client-dynamodb` (a new optional peer, the same SDK family already
  used for S3).  Its optimistic concurrency is the **strongest** of any backend:
  the append is one `TransactWriteItems` where every put carries
  `attribute_not_exists`, so it is atomic across all items and a losing writer
  cannot leave a partial append behind — no equivalent of MongoDB's prefix
  caveat.  DynamoDB caps a transaction at 100 items, and an append beyond that is
  refused with a clear error rather than silently chunked, which would break that
  atomicity.  The compaction high-water mark lives in the same table at the
  reserved sort key 0, raised with a conditional update that expresses `GREATEST`
  as a condition.  Reads, deletes and `persistenceIds` page through
  `LastEvaluatedKey`; there is no indexed tag query yet, so `currentEventsByTag`
  falls back to the journal scan as it does on Postgres.
- **`MsSql`/`Mongo`/`DynamoDb` option validators** now reject an endpoint that is
  not an `http(s)` URL.  Worth noting because `new URL('localhost:8000')`
  *succeeds* — it reads `localhost:` as the scheme — so a bare `host:port` used to
  pass validation and fail later at connect time.
- **MongoDB persistence backend** (#397) — `MongoJournal`,
  `MongoSnapshotStore`, `MongoDurableStateStore` and `MongoQuery`, the first
  document-store backend and the first with an indexed tag query outside the
  SQL/Cassandra families (a multikey index over the `tags` array).  Optimistic
  concurrency uses the same two-layer scheme as the relational backends, with a
  unique compound index on `(persistenceId, sequenceNr)` and server error 11000
  standing in for a primary key and SQLSTATE 23505.  It needs **no
  transactions** — appends are contiguous from the head, so a losing writer fails
  on its first document and writes nothing — which keeps it working on a
  standalone `mongod` rather than requiring a replica set.  Payloads are stored as
  JSON text so a document with dotted or `$`-prefixed keys round-trips exactly.
  **Pin the driver to `mongodb@^6`**: version 7's bundled `bson` calls
  `v8.startupSnapshot.isBuildingSnapshot()` at module scope, which Bun does not
  implement, so importing it throws before any framework code runs.
- **`LazyStore`** — the store lifecycle (lazy connection, memoized init, one-shot
  schema preparation, ownership-aware teardown) is now shared by the relational
  and MongoDB families instead of living inside `RelationalStore`.
- **CockroachDB and YugabyteDB certified on the Postgres stores** (#401).  Both
  speak the PostgreSQL wire protocol, so they need no new backend — but "should
  work" is not the same as verified.  Two live suites now run the full
  persistence contract against them via the unmodified `PostgresJournal` /
  `PostgresSnapshotStore` / `PostgresDurableStateStore`, plus a docs page
  recording what is certified and what is not.  Notably CockroachDB's
  SERIALIZABLE isolation can reject a contended append with a retry error
  (SQLSTATE 40001) rather than a duplicate key, which currently surfaces as
  `JournalError`; that is documented rather than silently papered over.
- **Contract scenario for racing appends** — the persistence contract now
  asserts that concurrent `append`s at the same `expectedSeq` leave exactly one
  winner, no lost or duplicated events, and a `JournalConcurrencyError` for every
  loser.  This is the scenario that reaches the duplicate-key backstop at all,
  which nothing previously covered.  It also surfaced a genuine limitation in
  `CassandraJournal`, whose append is a read-then-write with no conditional write
  behind it — see the capability gate on its harness.
- **Microsoft SQL Server persistence backend** (#399) — `MsSqlJournal`,
  `MsSqlSnapshotStore` and `MsSqlDurableStateStore` on the relational base, via
  the `mssql`/tedious driver (a new optional peer dependency).  T-SQL needed four
  genuine dialect additions: `IF OBJECT_ID(…) IS NULL`-guarded DDL (there is no
  `CREATE TABLE IF NOT EXISTS`), `MERGE … WITH (HOLDLOCK)` upserts (the hint
  matters — without it two concurrent merges can both take the `NOT MATCHED`
  branch), `OFFSET/FETCH` row limiting, and named `@pN` parameters, which the
  pool adapter maps from the ordered array every other driver takes.  Requires
  SQL Server 2016+: the tags table's four-column key needs 1036 index bytes, so
  its primary key is nonclustered.  The driver is pure JavaScript and verified to
  import and build a pool on Bun, Node **and Deno 2** — the 2021 tedious
  crypto-shim issue that made Deno support an open question is fixed.
- **`SqlDialect.rowLimit(count)`** — row limiting moved into the dialect, since
  T-SQL has no `LIMIT` at all.  Unchanged for the `LIMIT`-based dialects.
- **libSQL / Turso persistence backend** (#400) — `LibSqlJournal`,
  `LibSqlSnapshotStore` and `LibSqlDurableStateStore`, SQLite reached over
  HTTP or WebSocket via `@libsql/client` (a new optional peer dependency,
  imported through its `/web` entry point so nothing native loads at runtime).
  The statements match the local SQLite backend's, so a database can move
  between a local file and Turso without a migration, and it is the first
  durable-state store in the SQLite family.  Remote URLs only — a `file:` or
  `:memory:` URL is rejected at construction with a pointer to `SqliteJournal`,
  because the HTTP driver cannot open one either.  Registration works like
  Postgres': `registerLibSqlPlugins` plus the plugin ids
  `actor-ts.persistence.{journal,snapshot-store,durable-state}.libsql`.
- **SQLite persistence now runs on Deno** (#400).  `getSqliteDriver()` used to
  throw there, because both drivers need a native binding — so `SqliteJournal`,
  `SqliteSnapshotStore` and `SqliteQuery` were unavailable and the docs pointed
  Deno users at the in-memory or Cassandra journal.  The new `NodeSqliteDriver`
  wraps the built-in `node:sqlite` (Deno >= 2.2, Node >= 22.13, recent Bun), so
  every supported runtime now has a SQLite driver that needs no install.  On
  Node, `better-sqlite3` is still preferred when present — existing deployments
  keep the driver they run — and `node:sqlite` is the fallback, which makes the
  peer dependency genuinely optional there.  A new `06-sqlite-journal` smoke
  case verifies append / read / concurrency on Bun, Node and Deno.
- **Relational persistence base layer** (#389) — `RelationalJournal`,
  `RelationalSnapshotStore`, `RelationalDurableStateStore` and the `SqlDialect`
  / `SqlPool` contracts are now exported.  A new SQL backend is a dialect
  (placeholder syntax, conflict clauses, duplicate-key classification, DDL)
  plus a pool adapter, instead of a third hand-written copy of three stores;
  `PostgresJournal` shrank from 280 lines to 31 on top of it.  `withTransaction`
  is deliberately specified as *adapter-defined* isolation, so an HTTP-fronted
  store that can only offer an atomic batch (libSQL, Cloudflare D1) still
  implements the journal correctly — the duplicate-key backstop, not the
  transaction, is what makes optimistic concurrency sound under a racing
  writer.  The Postgres dialect classifies conflicts by SQLSTATE rather than
  message text, which is what lets CockroachDB and YugabyteDB reuse it.

- **DevTools — embeddable web UI for a running system** (`actor-ts/devtools`,
  new `"./devtools"` subpath export).  `DevTools.attach(system, options)` binds
  a small server whose dashboard shows the system at a glance and links into
  one panel per tool; `DevTools.mount(system)` returns the routes for an
  existing server instead.  This first drop is the foundation — the versioned
  tap protocol, the WebSocket hub and the UI shell with its dashboard.  The
  panels themselves (actor tree + cluster, tracing, explain plan, time travel,
  profiler) follow, and the UI already lists them, marking each unavailable
  with a reason until it lands.  #445
  - **Security:** binds `127.0.0.1` unauthenticated by default, and
    `DevToolsOptions` *refuses* a routable bind unless `auth`, `ipAllowlist`
    or an explicit `allowRemote: true` is present — DevTools reads live actor
    state, so exposing it cannot be the result of a typo.  Auth and the IP
    allowlist wrap the UI, the JSON endpoints and the WebSocket upgrade alike.
    Individual panels can be switched off via `withPanels({ … })`.
  - Creating the extension does nothing: no port, no taps, no instrumentation
    until `attach()`, and each panel's collection runs only while a browser is
    subscribed to it.
  - The UI is vanilla TypeScript bundled at build time and embedded in the
    package — no UI framework in the dependency tree, no CDN loads, no
    filesystem access at runtime.
  - **Every example is wired for it**, opt-in via `--devtools` (see
    `examples/devtools.ts`).  An argument rather than only `DEVTOOLS=1`,
    because `VAR=value command` is a parser error in PowerShell — the flag
    works in every shell.  Short-lived example scripts park just before
    shutdown so there is time to open a browser; multi-system examples give
    each system its own port counting up from `--devtools-port`.  Without the
    flag their timing and output are unchanged.  The chat and voice backends
    pass their `Cluster` through, so the cluster panel is live there.
  - A DevTools attachment now ends with the system it debugs:
    `system.terminate()` releases the port even though it does not run
    `CoordinatedShutdown`.  Previously a terminated system left the server
    bound, keeping the process alive.
  - **Actor and cluster panels**, plus an overview with live figures.  The
    actor panel shows the live supervision tree with mailbox depths,
    filtering and restart highlighting; the cluster panel shows topology,
    members, shard distribution and membership history (pass
    `withCluster(cluster)` — a system cannot hand out its own).  Both
    sampling streams idle until a panel subscribes.  #204
  - A cluster member that leaves is **kept in the panel for an hour**,
    struck through and red, with how long ago it was last seen.  The
    node that drops out is the one worth looking at, and it used to
    disappear at that exact moment; the record is held on the server so
    a page reload does not erase it.
  - The **actors panel** keeps up with a live system.  Cell states used
    to freeze at whatever they were when the actor started, because
    lifecycle events announce births, deaths and restarts and nothing
    else — an actor that later suspended went on claiming to be a
    healthy `running` for the rest of the session.  The tap now
    re-inspects on its sampling interval and sends the new
    `actor-changed` delta for the cells that moved.  A **stopped actor
    stays on screen for 30 seconds**, greyed out and red, before it is
    swept: the actor worth looking at is usually the one that just died,
    and removing its row on the spot meant you never saw it.
  - **The UI says when nothing is answering.**  Every panel keeps drawing
    the last thing it heard — the final reading before a node died is
    usually the one worth having — which meant a dead cluster looked
    exactly like a healthy one, with only an eight-pixel badge to say
    otherwise.  A dialog now interrupts and names it, counting how long
    nothing has answered; the panel dims so frozen figures do not read as
    live ones.  It closes itself the moment something answers, and can be
    dismissed to read the last figures anyway.
  - The panel reads as one thing rather than three.  Corners are square
    throughout — rounded boxes made a developer tool look like a landing
    page — the per-node columns line up with their headings, uptimes
    under a minute lose their decimal, and the actor tree no longer
    scrolls inside its own box: the page scrolls, so the bottom of the
    tree is reachable without hunting for the right scrollbar.
  - Two places disagreed about how many nodes a cluster has, so one that
    had lost a node showed three rows and "2 / 2 up".  The cluster panel
    and the overview now read the same retained membership, and the
    topology graph colours a node by what it is now rather than by the
    status it had when it left.  The chosen timespan survives a reload.
  - **The overview's charts have a timespan** — one minute to
    twenty-four hours, five by default — and the series is recorded on
    the server rather than accumulated in the browser.  A panel opened an
    hour into a run shows that hour instead of filling an empty graph,
    and a reload does not lose it.  Stored in tiers so a day is neither
    unsendable nor unreadable: one second for fifteen minutes, fifteen
    seconds for four hours, two minutes for a day, with the query
    answered from the finest tier that reaches back far enough.  Levels
    keep each interval's peak so a spike survives summarising; counters
    keep its last reading so the rate maths stays correct.
  - **The actors panel lists every node**, each under its own heading —
    which is how a singleton hosted on one node, or work piling up on
    one of several, becomes visible at all.  Paths repeat across a
    cluster (every node runs the same system name), so trees are kept
    apart by address.  Remote nodes report whole trees each round and the
    client diffs them, so an actor that dies on a peer gets the same
    thirty-second tombstone a local one does.
  - **The overview covers the whole cluster.**  Every clustered node with
    DevTools attached runs an agent that answers for itself; the node
    serving the UI polls them on its sampling tick and reports both the
    total and a **Per node** breakdown.  The totals are the sum of the
    breakdown rather than a second count, so the two cannot drift apart.
    Polling is fire-and-forget — a slow node delays its own row, not the
    dashboard — and a node that stops answering keeps its last reading,
    marked *not answering*, until an hour has passed.
  - The **overview** is three sections — *Common* (identity, uptime,
    runtime, cluster), *Numbers* and *Charts* — and no longer duplicates
    the nav rail as a grid of tool cards.  Alongside the actor figures it
    reads the framework's own instrumentation for **messages per second,
    processed messages, mailbox drops and handler p99**, and derives
    **stashed messages** and **suspended actors** from the tree walk it
    already does.  Trends are split across three charts so a level and a
    rate never share a y-axis.  To make those counters real, DevTools
    enables the metrics registry at attach if the application had not,
    and restores the noop on detach; a registry you enabled yourself is
    left alone.
  - **Tracing panel** — the route a message took, and where its time
    went.  The panel opens on a full-width list: one row per trace with
    `sender → actor → actor`, the message's name, its payload as JSON
    and the duration; opening a row shows the flame graph or waterfall
    for that trace.  Spans carry microsecond timings, self time and
    per-span attributes.  Recording runs from the moment DevTools
    attaches rather than on a button press, so the messages worth
    looking at — the ones that already went past — are there when the
    panel opens.  The last 100 are kept by default and a selector takes
    that to 10 000 (`tracing.buffer`, ceiling `withSpanBufferCapacity`).
    DevTools' own actors are excluded so the hub publishing spans cannot
    feed its own output back in.
    Attaching DevTools no longer costs you your tracer: if one is already
    installed it is wrapped in the new `TeeTracer` so an OTel exporter and
    the local panel both see every span, and detaching restores the
    original.  #217
  - **Explain-plan panel** — the last messages one actor handled, with
    type, sender, mailbox wait, handling time and outcome (clean,
    stashed, threw).  Switched on per actor from the browser rather than
    by a code change and a restart, and switched back off when you leave
    the panel or detach.  #218
  - **Time-travel panel** — read a persistence journal in the browser and
    reconstruct an event-sourced actor's state at any sequence number,
    with a field-level diff of what each event changed.  Strictly
    read-only.  A fold comes either from a running `PersistentActor`
    (borrowed automatically) or from `DevToolsOptions.replayFolds`; where
    neither exists the event log still works and the panel says why the
    state cannot be derived.  Ships as a panel only — no CLI.  #201
  - **Profiler panel** — an aggregated flame graph of where the system
    spends its time, grouped by actor path and message type, plus the
    heaviest handlers as a table.  Wallclock mode uses the framework's
    own per-message timings (the ones behind
    `actor_message_handler_seconds`) and exports speedscope JSON; CPU
    mode hands back a V8 `.cpuprofile` for Chrome DevTools where
    `node:inspector` exists, and says so plainly where it does not — via
    the new `profiler.capabilities` request, so the mode is greyed out
    with its reason before you press Start.  It used to fail at Start
    with the runtime's own error, because importing `node:inspector`
    *succeeds* on Bun (it even exports `Session`) and only constructing
    a session throws.  One session at a time, auto-stoppable, and the
    hook is removed when the session ends or DevTools detaches.  #226
    With this the DevTools suite (#445) has all five panels.
- **`ActorSystem.startedAtMs`** — wall-clock time the system was created,
  stamped first in the constructor.  `Date.now() - system.startedAtMs` is
  the system's uptime, and unlike a monitoring tool's own clock it does
  not restart when that tool attaches, detaches or reconnects.
- **`CoordinatedShutdown.removeTask(phase, name)`** — unregister a task,
  so a component that registers on acquiring a resource can register
  again after releasing it.  Without it, `bind()` → `unbind()` →
  `bind()` on the same address was impossible: the HTTP layer's task is
  named `http-unbind-<host>:<port>` and outlived the server it belonged
  to, so the second bind collided with a task for a server that no
  longer existed.  `unbind()` now removes it.
- **`Props.asInternal()`** — marks an actor as belonging to tooling
  rather than to the application, inherited by its children.  Whole-system
  instrumentation skips it, which is what keeps a debugger out of its own
  output: DevTools' hub publishes the spans it just recorded, so tracing
  it fed every batch back in as the payload of the next one.  Application
  actors should not be marked — hiding real work from a profiler is how a
  performance problem stays invisible.  A marked actor opens no span at
  all, root or child: its probes receive event-stream publishes *during*
  an application message, so excluding only roots left them showing up in
  the middle of that message's route.
- **`TracingExtension.captureMessagePayloads(enabled)` /
  `isCapturingMessagePayloads()`** — attach the message itself, as JSON,
  to each `actor.receive` span.  A separate switch from
  `recordRootSpans` because the costs differ: one decides whether to open
  a span, this one decides whether to `JSON.stringify` a user object
  while doing so.  Bounded in depth and length, cycle-safe, and never
  allowed to throw into the dispatch it describes.
- **`TracingExtension.recordRootSpans(enabled)` /
  `isRecordingRootSpans()`** — trace **every** message, not only the ones
  that already belong to a trace.  The framework is propagate-only by
  design: an actor opens a span when the message arrived with a trace
  context or one was active at the call site, so a plain `ref.tell(…)`
  from outside any span records nothing.  Correct for production, and
  the reason a tracing UI could show an empty screen on a busy system.
  Off by default, refuses without a tracer installed, and cleared by
  `disable()`.  Costs one boolean read per message when off.
- **`MetricsExtension.disable()`** — back to the noop registry, mirroring
  `TracingExtension.disable()`, so a tool that switched metrics on for its
  own use can leave the system as it found it.
- **`replayState()`** (`actor-ts` → `src/persistence/Replay.ts`) — the
  journal fold behind `PersistentActor` recovery, now callable on its own
  against a journal and snapshot store with no `ActorSystem` involved.
  A `toSequenceNr` bound replays to a point in the past, using the newest
  snapshot before it.  Snapshot-integrity failures throw the new
  `SnapshotIntegrityError` (an `Error` subclass, messages unchanged).
- **`ActorContext.enableExplainPlan()` / `disableExplainPlan()` /
  `explainPlan()`** — the same per-actor recorder from code, for when
  you already know which actor you care about.  Opt-in per actor: an
  actor with no plan costs one null check on the dispatch path, and
  envelope timestamping is switched on only for actors being recorded.
  A stashed message keeps its original timestamp on replay, so its
  mailbox wait spans the whole stash residency.
- **`TeeTracer`** — a `Tracer` that forwards to another and reports every
  completed span to an observer.  The tracing extension holds exactly one
  tracer, so watching spans previously meant replacing whatever was
  installed; teeing removes the either/or.
- **`RecordingTracer` can be bounded and records monotonic timings.**
  `maxRecorded` caps the in-memory buffer (oldest evicted; `0` keeps none
  while still calling `onSpanEnd`) — an unbounded recorder left enabled on
  a busy system grew without limit.  `RecordedSpan` additionally carries
  `startHighResolutionMs`/`endHighResolutionMs`, because wall-clock
  milliseconds cannot resolve actor message handling.
- **Actor lifecycle events on the `EventStream`** — `ActorStarted`,
  `ActorStopped` and `ActorRestarted`, sharing an `ActorLifecycleEvent`
  base so `subscribe(ref, ActorLifecycleEvent)` takes the whole family.
  Previously the stream carried dead letters, cluster and broker events
  but nothing about actors coming and going, so tracking the tree meant
  polling it.  #204
- **`EventStream` channels may be abstract classes.**  Matching is by
  `instanceof`, so an abstract base is a valid channel — and the most
  useful one, since it subscribes to a whole event family at once.
- **`PersistenceExtension.configure({ journal?, snapshotStore? })`** — a thin
  convenience over `setJournal` / `setSnapshotStore` for tests and simple,
  single-backend apps that wire persistence directly in code.  (The docs
  already documented this call; it is now real.)
- **`CassandraJournalOptions.withLightweightTransactions(boolean)`** (#475) —
  opt out of the LWT-serialized append path (see *Security*) and get the
  single-round-trip write back.  Default `true`.  Only safe when a single
  writer per persistence id is genuinely guaranteed; with it off, a losing
  concurrent append silently discards its event.
- **`CassandraJournalOptions.withSerialConsistency(number)`** (#475) — the
  consistency governing the LWT claim's Paxos phase, applied to the
  conditional statement only.  Unset, the driver uses cluster-wide `SERIAL`,
  which needs a quorum across *every* datacenter — so on a multi-DC keyspace
  each append would pay a cross-DC round-trip, undoing the local-DC write path
  `consistency: LOCAL_QUORUM` exists to provide.  Set `localSerial` (9) there.
- **`RetryOptions.sleep`** (#477) — override how `retry` awaits the delay
  between attempts.  Defaults to `setTimeout`; pass a `ManualScheduler`-backed
  sleep to run the backoff on virtual time, so a test can assert the schedule
  exactly and instantly instead of measuring real gaps.  Same escape hatch as
  `BackoffPolicy`'s `random`.

### Changed

- **BREAKING — `ClusterSingleton.start()` returns an `ActorRef`; `SingletonHandle`
  is gone** (#523).  Addressing a singleton took three concepts and a hop —
  `system.extension(ClusterSingletonId).start(cluster, options).proxy` — so
  every singleton grew a hand-written `getOrCreate(cluster)` wrapper whose only
  job was to hide that line.  Sharding has had `cluster.sharding` and returned
  a plain `ActorRef` all along; singleton was the outlier.

  Migration:

  | Before | After |
  | --- | --- |
  | `system.extension(ClusterSingletonId).start(cluster, options)` | `cluster.singleton.start(options)` |
  | `handle.proxy.tell(m)` | `singletonRef.tell(m)` |
  | `handle.stop()` | `cluster.singleton.stop(key)` |
  | `handle.manager` | `cluster.singleton.managerFor(key)` |
  | `.get<T>(name).forEach(h => h.proxy.tell(m))` | `cluster.singleton.ref<T>(name).tell(m)` |

  `withTypeName` / `withProps` are unchanged, so builder call sites do not move.
  One behaviour change to know about: `stop()` on the returned ref is now a
  warning no-op.  It used to mean "stop forwarding" and was reachable only
  through `SingletonHandle.stop()`; now that the proxy *is* the returned
  `ActorRef`, `ref.stop()` is the natural thing to write, and `ActorRef.stop()`
  means "PoisonPill the target" everywhere else — it would have killed whatever
  the leader was hosting.  Use `cluster.singleton.stop(key)`.
- **BREAKING — framework actors moved from `/user` to grouped `/system`
  paths** (#509).  `ActorSystem` has always built a `/system` guardian and
  then never used it: the field was assigned in the constructor and read
  nowhere, `spawn` hardwired the user guardian, and so every actor the
  framework spawns for itself — the DevTools hub, shard regions and
  coordinators, the singleton manager, the pub-sub mediator, the
  receptionist, DistributedData, reliable-delivery controllers,
  projections — sat flat under `/user` among the application's own actors.
  DevTools documented the empty `/system` branch as intended behaviour.
  They now live under `/system`, one group per subsystem, and drop the name
  prefix that only existed to keep a dozen unrelated actors from colliding
  as flat siblings:

  | Before | After |
  | --- | --- |
  | `/user/devtools-hub` | `/system/devtools/hub` |
  | `/user/devtools-actor-tree` | `/system/devtools/actor-tree` |
  | `/user/devtools-stats` | `/system/devtools/stats` |
  | `/user/devtools-stats-dead-letters` | `/system/devtools/stats-dead-letters` |
  | `/user/receptionist` | `/system/cluster/receptionist` |
  | `/user/pubsub-mediator` | `/system/cluster/pubsub/mediator` |
  | `/user/distributed-data` | `/system/cluster/crdt/data` |
  | `/user/sharding-<typeName>` | `/system/cluster/sharding/region-<typeName>` |
  | `/user/sharding-coordinator-<typeName>` | `/system/cluster/sharding/coordinator-<typeName>` |
  | `/user/singleton-manager-<typeName>` | `/system/cluster/singleton/manager-<typeName>` |
  | `/user/reliable-consumer-<n>` / `-producer-<n>` | `/system/delivery/consumer-<n>` / `producer-<n>` |
  | `/user/projection-<name>…` | `/system/persistence/projection/<name>…` |

  **Migration.**  These paths travel on the wire and are embedded in the
  ShardCoordinator's persisted DistributedData state, so a mixed-version
  cluster will not interoperate and a coordinator recovering pre-upgrade
  state will not match its regions: restart the cluster cold, or discard
  the persisted coordinator state.  Application code is unaffected unless
  it matched on a framework path by string — `/user` now contains only
  what the application spawned, which is the point.  There is no public
  API for spawning into `/system`; the seam is internal.
  Group levels are actors (empty supervisors holding the grouping and a
  supervision policy) and are created on first use, so a system that never
  starts clustering or DevTools keeps the same three-cell tree it had
  before.  Groups restart their children by default — the behaviour these
  actors had under `/user` — with DevTools the deliberate exception: a
  probe that failed on what it observed would fail again on the restart.
  DevTools' `internal` mark moved from its two spawn sites to the
  `/system/devtools` group, since `ActorCell` inherits the flag; no other
  group is marked, as that would silently strip tracing from cluster
  internals.
  Seven places used to build these paths as hand-written `/user/…`
  literals, three of which doubled as `Cluster._registerEnvelopeHandler`
  keys.  They now derive from one internal module, and each registration
  site asserts that the actor really landed where the helper says. That
  drift was worth a guard: it did not throw, it *mis-delivered* —
  `dispatchEnvelope` misses the per-path handler, falls back to resolving
  the path itself, and tells the raw envelope body, so a singleton manager
  would receive an unwrapped payload instead of a `singleton-deliver`.

- **BREAKING (examples) — `examples/cluster/counter-node.ts` discriminates on
  `kind`** (#494).  Its `Command` union tagged entities with `op: 'increment' |
  'get'`, the only place in the repo that used a third spelling for a
  discriminant.  Migration: send `{ id, kind: 'increment' }` instead of
  `{ id, op: 'increment' }`.  `examples/pubsub/event-bus-across-nodes.ts`
  likewise renames `DomainEvent.type` to `kind`.

- **Example frontends dispatch server frames with `match`** (#494) — all eight
  chat/voice browser apps (React, Next, SvelteKit, Angular) and the four
  no-build `static/{plain,lit}` pages switched on the WebSocket frame's `kind`
  instead of matching on it, and the four React/Next reducers tagged their
  action unions with `type:` rather than the project-wide `kind:`.  Both are
  fixed; `ts-pattern` joins the eight app manifests and is imported from
  esm.sh on the CDN pages.  `examples/chat/static/plain/index.html` becomes a
  `<script type="module">` so it can import at all — it has no inline event
  handlers, so nothing depended on the old global scope.  The committed
  `static/**` bundles are regenerated.

- **Docs no longer recommend `if`-chains over `match`** (#494) — the pattern
  matching page carried a "When to prefer plain `if`" section whose rule of
  thumb was *use `match` from 4+ variants*, and the FAQ, design-decisions and
  event-dispatcher pages each repeated some form of "a plain `if/else` ladder
  works fine".  That is the opposite of the convention the codebase actually
  follows, so roughly 150 doc samples had grown up around the advice.  The
  section is gone and the three echoes are rewritten: every dispatch on an
  incoming message, event or command uses `match` with each arm delegating to
  an `onXxx` handler; matches on internal state or that compute a value keep
  their bodies inline.  The README's event-sourcing snippet, which dispatched
  on `cmd.kind` with a ternary forty lines below the section teaching the
  opposite, is fixed to match.
  The samples themselves follow in a second pass: ~150 `if`-chains, one
  `switch` and several ternaries across 33 EN/DE page pairs now use `match`,
  with class-actor hooks delegating to `onXxx` handlers and inline
  object-literal unions replaced by named variant types.
- **One declaration form per job: `interface` for contracts and heritage,
  `type` for data** (#503, #508).  The codebase used to mix the two with no
  stated rule.  It now has one: a declaration is an `interface` when it
  prescribes function heads — any method, call or construct signature — or
  when it `extends` another shape; everything else is a `type`, including
  plain data shapes, unions, and mapped and conditional types.  A
  function-typed *property* (`onLost?: () => void`) is not a function head.
  Across `src/`, the test suites, examples, benchmarks, the DevTools UI and
  the documentation's code samples that comes to 423 interfaces and 1690 type
  aliases.  In practice: the contracts you implement — `Journal`,
  `SnapshotStore`, `Lease`, `Transport`, `Serializer`, `Cache`, `Tracer`,
  `Span`, `DowningProvider`, `AllocationStrategy` — are interfaces, as are
  the option shapes that extend a backend connection; the records they carry
  are aliases.
  Nothing in the published type surface changes shape, and no signature
  moved.  The one consequence for consumers is that a name declared as a
  `type` can no longer be extended by declaration merging
  (`declare module 'actor-ts' { interface X { … } }`) — write an intersection
  in your own code instead.  That was already true of nothing in this repo:
  there is not a single `declare module` or `declare global` in the tree.
  One shape declares a function head and stays a `type` on purpose:
  `NativeWorker` in the web-worker backend intersects the DOM `Worker` with
  deliberately narrower listener signatures, which an intersection accepts as
  overloads and `extends` rejects as incompatible.  It carries a comment
  saying so.  The rule itself is written down in AGENTS.md.

- **Messages are named by their `kind`, not `Object`.** Every tool that
  lists what an actor handled — the profiler's heaviest handlers, the
  explain plan, the tracing panel — took the message's `constructor.name`,
  which answers `Object` for a plain object literal.  Since the house
  convention is a `kind`-discriminated union of object literals, that was
  the answer for nearly every message.  A tagged literal now reads as its
  discriminant (`place-order`), a tagged class as `Class.kind`, and
  classes and primitives are unchanged.

- **BREAKING — abbreviations spelled out across all identifiers.**  Type,
  class, file, method, field, generic-type-parameter and local names now use
  full words — `Command`/`Message`/`Acknowledgment`/`NegativeAcknowledgment`/
  `Terminate`/`Increment`/`DirectMessage`/`Request`/`Response`/`Function`/
  `Context`/`Connection`/… (no more `Cmd`/`Msg`/`Ack`/`Nak`/`Nack`/`Term`/`Inc`/
  `Dm`/`Req`/`Res`/`Fn`/`Ctx`/`Conn`).  Public-API surface is affected: generic
  parameters (`PersistentActor<Command, Event, State>`),
  `Scheduler.scheduleOnceFunction`/`scheduleAtFixedRateFunction` (were `…Fn`),
  exported types (`HealthCheckFunction`, …), and config fields
  (`maxMessages`/`maxAcknowledgmentPending`/`autoAcknowledge`).  The tagged-union
  discriminant field is now always `kind` (never `type`) and its string values
  are spelled out (`kind: 'increment'`, not `'inc'`).
  *Migration:* rename usages accordingly; messages must use `kind` with the
  spelled-out literal.  Names mirroring external APIs (nats.js, prom-client,
  amqplib, DOM) and domain acronyms (PubSub, K8s, AMQP, MQTT, SQL) are unchanged.
- **BREAKING — runtime floors raised: Node ≥ 24, Bun ≥ 1.3.**  Node 20
  reached end-of-life in April 2026 (no more security fixes); Node 24 is
  the oldest active LTS line (supported to April 2028) and the first
  floor on which everything the framework relies on — WebSocket client,
  zstd, WebCrypto, fetch — is native.  The Bun floor moves from the
  two-year-old, never-CI-tested 1.1 claim to 1.3, which CI now actually
  exercises (the multi-runtime smoke matrix runs Bun on `latest` *and*
  pinned 1.3.0; integration Docker images are pinned to
  `oven/bun:1.3-debian`).  Deno stays ≥ 2.0.
  *Migration:* upgrade to Node ≥ 24 / Bun ≥ 1.3.
- **BREAKING — `WebsocketClientActor` always uses the native
  `WebSocket`.**  The dynamic `ws` fallback for
  Node < 22 is gone, and with it the `headers` client option
  (`withHeaders` builder + the `headers` HOCON key under
  `actor-ts.io.broker.websocket`) — only the `ws` path could send
  custom handshake headers, so on native runtimes the option was
  already silently ignored.  `ws` remains an optional peer dependency
  for server-side upgrades on the Express backend.
  *Migration:* pass credentials via query parameter or subprotocol,
  exactly as browser clients must.
- **BREAKING — `typescript` peerDependency is now
  `^5.6.0 || ^6.0.0 || ^7.0.0`** — it finally admits TypeScript 7 (the
  native compiler the repo itself builds with since 6.0.3 → 7.0.2) and
  raises the floor from the never-verified 5.0 to 5.6, the single
  minimum now stated everywhere (README badge, FAQ, peer range).
- `@types/node` is pinned to the support floor (24) instead of the
  newest major, so framework code can't accidentally use Node-26-only
  APIs; the publish workflow drops its `npm@11` upgrade step (Node 24
  bundles npm ≥ 11.5.1, the trusted-publishing minimum).

- **TypeScript 7 — the native compiler** (#361).  The `typescript`
  devDependency moved from 6.0.3 to **7.0.2**, Microsoft's ground-up native
  (Go) port of the compiler that replaces the JavaScript-based `tsc`.  The
  npm package now ships a platform-specific native binary
  (`@typescript/typescript-win32-x64` etc.).  For this repo the switch was
  drop-in: no source or `tsconfig` changes were needed, `bun run typecheck`
  is clean and the full test suite passes.  The payoff is speed — a full
  `tsc --noEmit` over the repo dropped from **~6.5 s (6.0.3) to ~1.0 s
  (7.0.2)** on the same machine.  TypeScript is a devDependency only, so
  nothing changes for consumers of the published package.
- **`@fastify/static` 9.3.0 → 10.1.0** (#362) — devDependency used by the
  Fastify HTTP backend examples/tests; no code changes required.
- **CI: `actions/setup-node` 6 → 7** (#363) in the docs, multi-runtime, and
  publish workflows.
- **`better-sqlite3` support widened to v13** (#376).  The optional
  `better-sqlite3` peer dependency now accepts `^12.9.0 || ^13.0.0` (was
  `^12.9.0`), and the dev/test toolchain tracks 13.0.1.  better-sqlite3 13
  migrated to Node-API, which replaces its `prebuild-install` native-binding
  dependency tree with `node-addon-api` and improves prebuilt-binary
  portability across Node versions.  The `BetterSqliteDriver` surface
  (`open`/`exec`/`prepare`/`run`/`get`/`all`/`transaction`/`close`) is
  unchanged, so no consumer migration is required.

### Removed

- **BREAKING — dead persistence options removed** (#381).  Three
  declared-but-never-implemented knobs are gone (pre-1.0 hard cut):
  `LiveQueryOptions.batchSize` and `LiveQueryOptions.clock` (no query
  implementation ever batched or read an injected clock); the object-storage
  plugin's `durableStatePluginId` option + `withDurableStatePluginId` builder
  method (the plugin only ever registered the snapshot store by id, never the
  durable-state store); and the HOCON key `actor-ts.persistence.recovery.mode`
  (defined in the reference config + documented, but read by no code).
  *Migration:* remove any use of these — they were no-ops.  (The Cassandra
  `consistency` option is **not** removed — it is now honoured; see Fixed.)
- **Docs toolchain: Astro 7 + Starlight 0.41** (#474).  The upgrade #473 had to
  defer: `@astrojs/starlight@0.41.4` peers `astro: "^7.0.2"`, so the coordinated
  bump (`astro` `^6.4.8` → `^7.1.3`, `@astrojs/starlight` `^0.39.3` → `^0.41.4`)
  is now viable.  Astro 7 also makes `@astrojs/markdown-satteri` the default
  Markdown pipeline and demotes the remark/rehype one to the optional peer
  `@astrojs/markdown-remark`, which deprecates `markdown.rehypePlugins`; the
  Mermaid SSR wiring in `docs/astro.config.mjs` therefore moves to
  `markdown.processor: unified({ rehypePlugins: [...] })` and `docs` takes an
  explicit `@astrojs/markdown-remark` dependency (pinned to `7.2.1`, Astro's
  exact peer).  Site-only — no runtime or public-API impact.

### Fixed

- **A role-restricted singleton is hosted by a node that carries the role**
  (#524).  `wantHosted()` required the node to be the cluster leader **and** to
  carry the configured role, so `withRole('worker')` on a cluster whose elected
  leader lacked `worker` left the singleton hosted **nowhere**: the leader's
  manager declined on the role, every other manager declined on not being the
  leader, and messages died at the leader with a `log.warn`.  Host election is
  now "the first up-member carrying the role", falling back to the leader when
  no role is set — one shared `singletonHost()` used by the manager *and* the
  proxy, because the manager drops anything addressed to it that it is not
  hosting, so any drift between the two is silent message loss.

  A role now also rides along on `SingletonKey.of<T>(typeName, role?)`, the way
  `ShardKey` carries its `extractEntityId`: it is not part of the identity
  (`equals` ignores it) and a `role` in `StartSingletonOptions` still wins, but
  a node that only calls `ref()` has no options object to read — it has the key
  and nothing else — so without this its proxy would resolve a different host
  than the managers.  Declaring it on the class makes both sides agree by
  construction.  The existing role test never caught any of this: its
  role-carrying node was also the lowest-addressed one, and so the leader
  anyway.
- **`ask()` across nodes gets its reply instead of timing out** (#517).  The
  one-shot reply ref `ask` synthesises was built as a *root* path
  (`new ActorPath(name, null, systemName)`), and `ActorPath` renders a root
  without its own name — so the ref came out as `actor-ts://<system>/`, the
  `askResp-…` name gone.  Locally that is invisible, because the ref is passed
  around as an object and never looked up by path.  Across the wire the path is
  the whole address: the reply went back addressed to the bare system root,
  `parsePathSegments` yielded `[]`, the receiving node's path guard rejected it,
  and the ask timed out having *already been answered*.  The docs recommend
  `ask` for exactly this case (`cluster/refs-across-nodes`), and none of the
  existing cross-node tests covered it — they all pass a spawned actor as
  `replyTo`, which has a real path.

  Two halves to the fix.  The ref now lives at `/temp/askResp-<id>`, which keeps
  the name in the rendering **and** makes the path unique per call — a detail
  that matters more than the name: with every ask rendering to the same string,
  two in flight at once would have shared one registration and the second would
  have evicted the first.  And because an ask ref is not an actor and so cannot
  be resolved through the actor tree, `Cluster` registers it as a per-path
  envelope handler — done at *encode* time, the point where the ref is known to
  be leaving the node, so a purely local ask stays off the map entirely, and
  torn down when the ask settles by reply or timeout, so the map does not grow
  by one entry per call.  `/temp` is documented in `fundamentals/actor-paths`
  as the fourth top-level path.
- **A stopped singleton can be started again** (#523).  The extension's
  registry was written on start and never emptied, so `stop()` left a dead
  entry behind — and because `start()` is get-or-create, every later start on
  that node short-circuited to it and returned a proxy that had already stopped
  forwarding.  Silent, total, and undebuggable, with no way back short of
  tearing down the `ActorSystem`.  The registry is now pruned from the
  manager's own `postStop`, so supervision and system shutdown are covered too,
  not just the explicit path.  Restarting in the same turn still cannot work —
  the actor name stays taken until termination settles — but it now says so
  instead of surfacing `Child name 'manager-x' is not unique under …`.
- **Required singleton and sharding options are enforced** (#523).
  `OptionsValidator`'s check helpers are no-ops on `undefined` by design, and
  required-ness was never asserted for these two, so
  `{ typeName: 'x' }` with no `props` (singleton) or no `entityProps` /
  `extractEntityId` (sharding) validated cleanly and failed much later — the
  singleton inside `Props.create`, the region deep in `settingsToConfig` or on
  its first message, neither naming the missing field.  A proxy region stays
  exempt: it routes but never hosts.  An empty `role` on a singleton is
  rejected too — it silently matched no node, so the singleton was hosted
  nowhere.
- **The DevTools UI freshness check compares a source fingerprint, not bytes**
  (#521).  The gate added for #484 failed on its first run and kept `build` red:
  it rebuilt the bundle and diffed the result, which presumes the emitted bytes
  are a function of the sources alone.  They are not.  `gzipSync` stamps the
  compiling platform's OS code into byte 9 of every member — `0x0a` on Windows,
  `0x03` on Linux — so *every* asset differs between a Windows dev box and an
  ubuntu runner no matter what changed; from Windows the gate could never pass.
  On top of that `bun-version: latest` moves `Bun.build`'s minifier under the
  check (1.3.1 → 1.3.14 changed two shared chunks, which cascaded into renaming
  all seven panel chunks), and the asset array inherited `result.outputs`' order
  unsorted, which the same upgrade reshuffled.  The generated header now carries
  a `source-hash` over what the bundle is built *from* — the UI sources, the
  build script, and `package.json`'s `dependencies`, since `ts-pattern` is
  bundled in — and `bun run check:ui` recomputes and compares it without
  building anything.  That catches the thing worth catching, a change under
  `devtools-ui/` with no `bun run build:ui`, on any OS and any Bun.  It
  deliberately does not catch bundler drift: a newer Bun emitting smaller output
  for unchanged sources is not staleness, and treating it as such is what made
  the previous gate fire on bundles that were perfectly current.  The step also
  moved ahead of `bun run build` — that script *is* `build:ui && tsc`, so any
  check after it inspects a file the job just regenerated.
- **A module mock in the worker tests no longer hands a fake backend to the
  rest of the suite** (#520).  `tests/unit/worker/WorkerCluster.test.ts`
  installed its in-memory `FakeWorkerBackend` with `mock.module`, which in Bun
  is process-global and permanent — `bun test` runs every file in one process,
  and nothing took the mock back.  Whenever the runner visited
  `tests/unit/worker/` before `tests/unit/runtime/`, the four
  `getWorkerBackend` tests asserted against the leaked fake and failed; the
  mock also replaced `resetWorkerBackendCache` with a no-op, so their own cache
  reset silently did nothing.  That is what had `tests` and `multi-runtime` red
  on `develop` since 2026-07-27 while the same suite stayed green on Windows,
  where the file order differs — the defect was latent since #315, not a
  regression.  `WorkerCluster` and `ParallelMultiNodeSpec` now take the backend
  as an option (below), so the test injects its fake and mocks nothing.  No
  first-party module is mocked anywhere in the suite any more, which is what
  makes the leak impossible rather than merely fixed.
- **A `PersistentFSM` state-timeout that fires during recovery is dropped
  instead of crashing the FSM** (#519).  `onReceive` intercepts the internal
  `__fsm_state_timeout__` self-tell *before* delegating to the base class, so
  that branch bypassed the `_recovering` guard every ordinary command goes
  through — and `PersistentActor`'s state is unassigned until replay succeeds,
  making the dereference in `fireTimeoutTransition` a `TypeError` rather than a
  stash.  Supervision turned that into a restart, so the symptom was an FSM
  restarting for no visible reason.  Dropping the fire is also right on its own
  terms: `onRecoveryComplete` arms a fresh timer for the recovered state, so a
  pre-restart fire has nothing left to say.  Found while fixing #516, whose fix
  closed the then-reachable path from outside; this closes it at the site.
- **The embedded DevTools UI bundle is byte-reproducible, and CI verifies it**
  (#484).  Two places promised a freshness check for
  `src/devtools/generated/uiAssets.ts` — the generated file's own header and
  `.gitattributes` — and neither was true.  No workflow compared the committed
  bundle against a rebuild, and `build.yml`'s path filters listed neither
  `devtools-ui/**` nor `scripts/**`, so a UI-only change did not even trigger
  the build job.  The module is committed deliberately, so a fresh clone can
  typecheck, test and smoke without running the UI build; that is exactly what
  made a stale one invisible, since it stays valid TypeScript either way.
  The gate presupposes a byte-reproducible rebuild, and that did not hold:
  Bun's `[hash]` in a chunk file name is not a pure function of the chunk's
  bytes, it also varies with the path the module resolved through.  Bundling
  inside a git worktree — whose `node_modules` sits several directories above
  the project root — emitted byte-identical chunks under different names than
  a plain checkout did, so the committed bundle read as stale for anyone whose
  layout differed from whoever last regenerated it.  Nothing caught it: same
  file size, same asset bodies, only the names moved.  Chunk names are now
  derived from the bytes the bundle actually ships — the same reasoning that
  already makes the ETags content-derived rather than mtime-derived — so the
  names no longer depend on the layout they were built in.  `build.yml` gained
  the missing path filters, a `--frozen-lockfile` install (the bundled
  dependencies have to be the ones the lockfile pins for the check to mean
  anything), and a freshness step.  That step first shipped as a
  rebuild-and-diff, which turned out to be unpassable for reasons beyond the
  chunk names; see #521 below for what replaced it.
- **`/user` is drained before `/system` starts stopping** (#509).
  `terminate()` enqueued one `terminate` on the root cell, and a cell stops
  every child at once — so both guardians came down concurrently, while
  `fundamentals/actor-system.mdx` had always promised "stop `/user`
  recursively … then stop `/system`".  Harmless while every actor lived
  under `/user`; not harmless once the framework's own actors moved to
  `/system`, because the application talks to the framework and not the
  other way round.  A user actor's `postStop` — unsubscribing from the
  pub-sub mediator, handing a shard back, writing a last event — needs that
  framework actor still alive, and racing the guardians turned those into
  dead letters non-deterministically: the failure mode that reproduces on a
  loaded CI box and not on the machine you debug on.  The root cell now
  stops its children in sequence, each fully drained before the next is
  asked; ordinary actors keep the concurrent fan-out, since siblings are
  peers and nothing about being a child implies an order.
- **`Props.withSupervisorStrategy()` actually supervises now** (#509).  It was a
  no-op: `ActorCell.onFailure` resolved the strategy as
  `this.actor?.supervisorStrategy() ?? defaultStrategy` and never read
  `props.config.supervisorStrategy`, so the setter built a new `Props` whose
  strategy field nothing consumed.  The API is not obscure — `fundamentals/props.mdx`
  documents it with its own section in both languages, and the routing and
  supervision pages use it in samples — so every caller following the docs got
  the guardian's default instead of the policy they asked for, silently.
  Resolution order is now the failing child's Props, then the parent actor's
  `supervisorStrategy()`, then `defaultStrategy`.
  The repo described the semantics two contradictory ways, so this also settles
  which one is real: the strategy on an actor's `Props` says how **that actor**
  is supervised (`props.mdx`), not how it supervises its own children (the note
  in `benchmarks/single-node/supervisor-restart.ts`, now corrected).  That is
  why the parent reads it — a child never gets to answer for its own failure —
  and it is the reading that adds something, since the parent-side one is
  already covered by `override supervisorStrategy()`.
  Two consequences of expressing a per-child override through parent-side
  machinery are deliberate, and now documented at the call site: an
  `all-for-one` strategy in a child's `Props` still widens to every sibling, and
  the restart budget in `registerRestart` stays per-parent, so siblings share one
  allowance.
- **A stopped or restarted actor's stash goes to dead letters instead of
  vanishing** (#518).  `finalizeTermination` drained the mailbox to dead letters,
  but the stash is a separate buffer on the cell and was never drained; `Restart`
  cleared it outright (`this._stashBuffer = []`).  That is the worst shape a lost
  message can take — a stashed message arrived *earlier* than everything still
  queued, so it is the one a sender is most likely blocked on, and "I told an
  actor and nothing happened, anywhere" cannot be diagnosed from the outside.
  Both paths now route the buffer through `DeadLetter`, the stop path draining
  the stash ahead of the mailbox so the dead-letter stream keeps arrival order.
  The stash still cannot survive a restart — the new instance has none of the
  state that made those messages un-handleable — but the loss is now visible.
  Found while fixing #516, where the stash is provably empty and this was
  therefore out of scope.
- **`ShardMapChanged` is actually published now** (#513).  The event was
  declared, exported, unit-tested for its shape, and consumed in two places —
  the DevTools shard panel (`ClusterTap`) and
  `examples/cluster/counter-node.ts`, which logs `shard map v<n>: n1=6, n2=5,
  …`.  Nothing ever constructed it.  `ShardCoordinator` mutated `shardHome` in
  four places and published nothing, so the panel stayed empty forever and the
  example's listener never fired; both looked wired up until you ran them.  The
  coordinator now broadcasts a `ShardMapUpdate` on every allocation change and
  each region turns it into a local `ShardMapChanged` — via the region, because
  the coordinator only runs on the leader and an event that fires on one node
  out of N is no use to a per-node panel.  Broadcasts are coalesced (allocation
  changes arrive one shard at a time, and a fresh cluster places every shard at
  once), so `version` counts broadcasts rather than individual assignments.
  `ShardMapChanged` also gained an optional fourth constructor argument
  `regions`, which lets `ClusterTap` drop the hard-coded `regions: []` it had
  been rendering; existing three-argument construction is unaffected.
- **A `RemoteActorRef` renders the path it actually points at, and no longer
  compares equal to every other remote ref** (#515).  The path was built as
  `new ActorPath(lastSegment, null, systemName)` — a *root*, and `ActorPath`
  renders a root as `actor-ts://<system>/` without its name, so the name was
  discarded on the spot.  Every remote ref therefore stringified to the same
  address-less value, and because `ActorRef.equals` compares `path.toString()`,
  any two remote refs compared equal regardless of node or path.  The real
  target only survived in `RemoteActorRef.toString()`, which is overridden.
  Two silent consequences went with it: `Receptionist.onRegister` /
  `onDeregister` and `DistributedPubSubMediator.onSubscribe` /
  `onUnsubscribe` / `onUnsubscribeAll` key their local maps on
  `ref.path.toString()`, so every remote registrant or subscriber collapsed
  onto the single key `actor-ts://<system>/` and a second one silently
  overwrote the first; and `ShardRegion`'s passivation and termination lookups,
  which match a candidate against entity refs by `equals`, could never match a
  remote candidate.  The path is now built segment by segment — the shape
  `ClusterSingletonProxy` already used — so it round-trips back to
  `targetPath`.  **Still open:** `ActorPath` carries a system name but no
  host/port, and every member of a cluster shares one system name, so `equals`
  distinguishes paths but not *nodes*; refs to the same path on two members
  remain equal.  `toString()` stays the node-qualified rendering.  Found while
  adding `ClusterSharding.shardRefFor()` (#151).  `parsePathSegments` moved
  from `cluster/RefCodec.ts` to `ActorPath.ts` (internal, not exported from the
  package): it is the inverse of `ActorPath`'s own rendering, and `RefCodec`
  constructs `RemoteActorRef`s, so importing it from there would have closed a
  module cycle.
- **A `PersistentActor` whose `onRecoveryFailure` does not rethrow now stops
  instead of black-holing every command** (#516).  The hook is public and
  overridable, and its default — rethrow, so `preStart` rejects and `ActorCell`
  routes an `ActorInitializationError` to supervision — was the only path anyone
  had tested.  An override that merely *records* the error let `preStart` resolve
  normally, so the cell counted the actor as started while `_recovering` was
  still `true` and `_state` had never been assigned: every command hit
  `onReceive`, was stashed, and vanished.  At command #1025 the hard-coded
  1024-entry stash overflowed, throwing `StashOverflowError` from inside the
  handler — a supervision restart 1024 messages away from the actual cause, whose
  recovery then failed and was swallowed again.  `onRecoveryFailure` is now
  documented as what it is: a *notification*, not a decision.  Rethrow (the
  default) and supervision decides; return, and the actor stops via
  `context.stopSelf()`.  Because the cell drains system messages ahead of every
  user message — with `onCreate` itself running inside that loop — nothing can
  reach `onReceive` without a state, and the stash is provably still empty, so
  commands already queued become dead letters instead of disappearing.
  `PersistentFSM` inherits the fix, which also closes its unguarded `this.state`
  read in `fireTimeoutTransition` — reachable when a state-timeout fire was
  already in the mailbox.  Recovery-failure semantics are now documented on
  `persistent-actor`, `persistent-fsm`, `migrating-adapter` and the FAQ's "Why
  isn't my actor receiving messages?" aside (EN + DE), which previously blamed
  slow recovery for exactly this symptom.
- **A throwing `onRecoveryComplete` is no longer misreported as a recovery
  failure** (#516).  It ran inside the same `try` as the replay, so a bug in the
  user's post-recovery hook was handed to `onRecoveryFailure` — blaming the
  journal for state that had recovered perfectly — and skipped the `unstashAll()`
  that follows it.  Post-recovery user code now runs outside the guard, so it
  reaches supervision as an ordinary actor failure, and the drain moved into a
  `finally`.  `recover()` is reduced to pure replay with no user callbacks.  Its
  old comment claimed commands were "already stashed by the ActorCell" during
  recovery; they are not — nothing can be handled before `preStart` resolves, so
  they wait in the mailbox and that drain is a no-op on every normal path.
- **`bun run lint:package` is reproducible, and `lint:knip` exits 0 again**
  (#507).  The three package-health scripts invoked their tools through `bunx`,
  which — contrary to the first guess — does honour the manifest range and
  resolved the pinned `knip@6.29.0` rather than `latest`; the real problem is
  what `bunx` does when the tool is *absent* from `node_modules`: it silently
  fetches it from the registry and runs anyway, so the check appeared to pass
  judgement on a tree that was never installed.  With `publint` and
  `@arethetypeswrong/cli` missing, knip could not map the `bunx publint` /
  `bunx attw` script invocations back to their manifest entries and reported both
  devDependencies as unused — exit 1 locally while CI, which runs `bun install`
  first, stayed green.  All three scripts now call the installed binary directly
  (`node_modules/.bin` is on `PATH` inside a script), so a missing install fails
  loudly instead of being papered over.  `lint:knip` additionally switches to
  knip's Bun-native `knip-bun` binary: with a *complete* install the Node one
  exhausts its heap on this repo's module graph (`Zone Allocation failed`,
  exit 134).  The `bun run build` prefix moves out of `lint:publint` /
  `lint:types-exports` into `lint:package`, so the build happens once, and
  `package-health.yml` now runs those scripts instead of repeating the
  invocations — the flags live in exactly one place, and a local
  `bun run lint:package` checks what CI checks.  No `ignoreDependencies` entries
  were added: once the binaries resolve, knip attributes them correctly, and an
  unnecessary ignore would hide a real finding later.  Also drops the three
  redundant `entry` patterns from `knip.jsonc` — knip derives `src/index.ts`,
  `src/testkit/index.ts` and `src/devtools/index.ts` from the `exports` map
  itself, which it had been reporting as configuration hints.
- **The whole benchmark suite starts again** (#506).  `bun run bench` was dead:
  ten suites imported the free `ask` helper from the barrel, and that export was
  removed when `ref.ask(…)` became the only ask form.  The removal's adoption
  sweep covered tests, examples and docs but not `benchmarks/`, so every affected
  file died at import with `SyntaxError: Export named 'ask' not found`.  Migrated
  to the method form — `ask<TRequest, TResponse>(ref, message, timeout)` becomes
  `ref.ask<TResponse>(message, timeout)`, the request generic dropping out because
  the ref already carries it.  Three unrelated benchmark type errors that a
  benchmarks-only compile surfaced are fixed in the same pass: a factory typed as
  the *abstract* `typeof PersistentActor<…>` (so it was not newable), a pair of
  mutually-recursive route type annotations, and a `declare const self` colliding
  with the DOM lib.  Also removes a dangling `ask` import from `tests/actor.test.ts`
  — unused, so Bun elided it and the suite stayed green.
- **`bun run bench` reports failures in its exit code** (#506).  The driver
  printed a red `[exit=N]` line for a failed suite and then exited **0**, which is
  how ten broken benchmarks stayed invisible.  It now exits non-zero, listing what
  failed; every suite still runs, so one break does not mask the rest.
- **Broker subscriptions survive a reconnect, and a dropped connection is torn
  down before the next one is built** (#504).  Two compounding defects in
  `BrokerActor` and its subclasses, both of which failed *silently* — the actor
  reported `BrokerConnected` and then received nothing.

  `handleConnectionLost` scheduled a reconnect without ever calling
  `disconnectImplementation`, so it ran **only** from `postStop` and every
  reconnect re-entered `connectImplementation` on top of the previous attempt's
  state.  For `NatsActor` that was fatal rather than merely leaky: its live-handle
  map still held the dead connection's subscriptions, and its
  `if (subs.has(subject)) return` guard therefore skipped re-subscribing — after
  one reconnect **not even the configured `subscriptions` were re-established**.
  `KafkaActor` overwrote its producer and consumer without disconnecting them
  (leaking both on every cycle, and on any connect that failed after
  `producer.connect()` succeeded), `JetStreamActor` abandoned its push
  subscription and pending acks, and `RedisStreamsActor` left the previous
  `XREADGROUP` loop running against the old client alongside the new one.
  `postStop` had the mirror-image bug: it gated on `_state !== 'disconnected'`,
  which is exactly the state a *dropped-but-open* connection sits in, so stopping
  a mid-reconnect actor skipped teardown entirely.  `disconnectImplementation` is
  now called before every re-connect attempt and whenever transport state is
  open at stop, and is documented as idempotent.

  Separately, only *configured* subscriptions were ever restored.  A subscription
  added at runtime (`{ kind: 'subscribe', … }` on `NatsActor` / `KafkaActor`) was
  recorded nowhere, so it vanished on the first drop; and one sent while the actor
  was disconnected was dropped on the floor outright.  `BrokerActor` now owns a
  **desired-subscription set** — `rememberSubscription` / `forgetSubscription`
  plus the `initialSubscriptions` / `applySubscription` / `revokeSubscription`
  hooks — which is connection-independent, seeded from the options exactly once
  (so a runtime `unsubscribe` is not resurrected by the next reconnect), and
  replayed by `applyDesiredSubscriptions()` on every connect.  A subscribe that
  arrives during an outage now lands on the next connect instead of being lost,
  re-subscribing a live subject swaps its target, and a subscription that cannot
  be established is logged as a warning instead of leaving the actor connected
  and deaf.  `MqttActor` already implemented this contract with its own richer
  registry (QoS, multiple targets, deathwatch) and is unchanged.  `NatsActor`
  additionally gains the `createNatsConnection()` test seam its two siblings
  already had — it previously had **no unit test at all**, which is how this went
  unnoticed — and its `onReceive` moves to a `ts-pattern` match over named
  variant types (part of #496).

- **A `TypedActor`'s `terminated` signal is actually delivered** (#448).
  `Signal` declared `{ kind: 'terminated'; ref }`, the docs tabulated it
  alongside `post-stop` and `pre-restart`, and `context.watch`'s own JSDoc
  promised *"you'll receive a Signal when it terminates"* — but that kind was
  **constructed nowhere in the codebase**, so `onSignal` was never called for
  it.  The `Terminated` the runtime enqueues went to the *receive* handler
  instead, typed as `T`, where a handler written against the documented
  protocol had no reason to look for it.  A watched actor's death was therefore
  invisible to every `receiveWithSignal` behavior.  It is now routed to
  `onSignal`, and — unlike `post-stop` and `pre-restart`, where the actor is
  going away regardless — the returned behavior is honoured, so answering
  `Behaviors.stopped` to a child's death stops the parent as the docs promise.
  Gated on a registered `onSignal`, so code that watched an actor and inspected
  the `Terminated` in its receive handler is unaffected.  The path had **no test
  coverage at all** (`receiveWithSignal` appeared in no test), which is how it
  stayed broken; it now has four.

- **A router prunes a routee that has stopped** (#449).  `Router` watched every
  routee it spawned and then ignored the notification, so a dead routee stayed
  in the pool and the strategy kept choosing it: under round-robin **1/N of all
  traffic** went silently to dead letters, and every `Broadcast` lost one
  message.  Nothing surfaced it — the router reported no error and the pool
  still looked the right size.

- **A router rejects a pool size that cannot work** (#455).  `size <= 0` (and a
  fractional or non-finite size) produced a router whose spawn loop never ran:
  an empty pool, every strategy returning nothing, and 100% of messages dropped
  to dead letters with no error anywhere.  All four factories now throw
  `OptionsError` at construction, where the stack still points at the call.
  *Behaviour change:* previously silent, now a throw.

- **`FailureDetector` thresholds: the documentation now matches the code, and a
  contradictory pair is rejected** (#452).  `downAfterMs` was documented as
  *"additional time after which an unreachable peer is declared down"*, and the
  validator's own comment said the two thresholds were therefore "not ordered
  against each other".  `decide` never worked that way: it compares both against
  the time since the last heartbeat and tests `down` **first**.  So with
  `downAfterMs <= unreachableAfterMs` the `unreachable` branch became dead code
  — a peer went straight from healthy to down, skipping the state whose whole
  purpose is to let a transient network blip recover — and nothing rejected the
  configuration.  The JSDoc now describes the absolute measurement (which is
  what the defaults, the docs' ~2.5× ratio guidance and `tombstoneMinRetentionMs
  = 6 × downAfterMs` all already assumed), and `FailureDetectorOptionsValidator`
  fails such a pair with both values in the message.  *Behaviour change:* a
  config that was silently degraded now throws `OptionsError` at construction.

- **A bounded mailbox now honours its bound while the actor is suspended**
  (#407).  The `drop-head` overflow policy called `dequeueUser`, which refuses
  while the mailbox is suspended — so the arm removed nothing, appended the
  incoming message anyway, and still counted a drop.  The queue therefore grew
  **past capacity without limit**, and `actor_mailbox_dropped_total` reported
  evictions that never happened.  Suspension is not an obscure state: it is the
  supervision window, entered whenever an actor throws and waits for its
  parent's decision while messages keep arriving — so the bound went missing at
  the moment it was most needed, and since v0.10.0 made the bounded mailbox the
  **default** (10 000 / `drop-head`), this was the default path.  Overflow now
  evicts through a suspension-independent `removeOldest`, and the counter and
  `onDrop` callback only fire when a message was really removed.

- **Stopping a `ProducerController` no longer leaves in-flight callers hanging
  forever** (#451).  `postStop` settled the *queued* sends — every waiting
  caller got `Error('producer stopped')` — but for in-flight sends it cancelled
  the resend timer and dropped the confirmation callback on the floor.  So a
  caller whose message had already gone out to the consumer and was awaiting an
  acknowledgment was never called back at all: not with success, not with
  failure. Since a confirmation callback exists precisely to guarantee an
  eventual answer, that is the one outcome it must never produce.  Both
  collections are now drained the same way.  Note the window makes this the
  *common* case rather than the rare one: with the default `windowSize` of 16,
  the first 16 unacknowledged sends are all in-flight, and only the 17th
  onwards would have been settled correctly.

- **The DevTools uptime counter stops when nothing answers.**  Every
  other figure on the overview stands still of its own accord once the
  samples stop, because it is a number somebody sent us — uptime was the
  exception, interpolated locally between samples and so still counting
  up minutes after the system it measures had died.  It now freezes at
  the last reading, and the first sample after a reconnect corrects it.
- **DevTools no longer stops a clustered example from starting.** Three
  nodes started from three terminals are three processes, each claiming
  port 9333, and the second and third died outright: *"voice backend
  failed to start: Is port 9333 in use?"*.  A debugger that cannot bind
  is not a reason for the program under debug to die.  The examples now
  take the first free port in the range — `9333`, `9334`, `9335` with no
  flags — and, if that fails too, log a warning and run without DevTools.
  Four separate faults were in the way, each hidden behind the last: the
  example gave up on the first conflict; a failed `attach()` left the
  extension half-attached so a retry hit *"task devtools-detach already
  registered"*; `unbind()` left its own shutdown task behind so the same
  port could never be re-bound; and DevTools' actors kept their names
  until an asynchronous termination settled, so re-attaching hit *"Child
  name 'devtools-hub' is not unique"*.  `attach()` now rolls back
  cleanly, and `attach` → `detach` → `attach` on one system works.

- **Relational journals: a contention-aborted append reports
  `JournalConcurrencyError`, not an opaque `JournalError`** (#479).  The
  optimistic-concurrency backstop assumed a losing writer always gets far
  enough to violate the events primary key.  Against a live MariaDB it does
  not: InnoDB aborts the loser with errno 1020 (`ER_CHECKREAD`, *"Record has
  changed since last read"*) **before** the key is checked, so the race fell
  through to the generic wrapper and callers could no longer tell a retryable
  race from a storage failure.  Found by running the #390 contract's
  "concurrent appends leave exactly one winner" scenario against the live
  MariaDB suite, where it was the only failure; the data was never at risk
  (exactly one event stored, head advanced once) — only the error type was
  wrong.  `SqlDialect` gains `isSerializationConflictError`, implemented per
  dialect (MariaDB 1020/1213/1205, Postgres `40001`/`40P01`, MSSQL 1205/1222,
  SQLite none — it serializes writers with a lock rather than picking a
  victim).  Crucially the bases translate only after re-reading and finding
  the head (or revision) actually moved: a lock-wait timeout against an
  unrelated long transaction stays the storage failure it is, instead of
  becoming a retry loop against a head that will never change.
  `RelationalDurableStateStore.upsert` had the identical hole and is fixed
  the same way.
- **The YugabyteDB certification suite actually runs now** (#401).  Its
  healthcheck probed `127.0.0.1:5433`, but `yugabyted` binds every service to
  the node's advertise address, so loopback never listens.  The container went
  `unhealthy` after a clean startup, compose refused to start the runner on the
  unmet `service_healthy` condition, and the whole thing read as a slow image
  rather than a suite that silently never executed.  It probes the container's
  own address now — and passes all 28 contract scenarios, which makes
  YugabyteDB's ✓ row in the docs true for the first time.  With that, every one
  of the eight database suites has run green against a real server: Postgres,
  MariaDB, libSQL, MSSQL, MongoDB, DynamoDB, CockroachDB, YugabyteDB.
- **Persistence: the InMemory reference stores now match the cross-backend
  contract** (#390).  `InMemoryJournal.append` ran the optimistic-concurrency
  check even for an empty event batch, so `append(pid, [], staleSeq)` threw
  where the SQLite, Cassandra, Postgres and MariaDB journals all return `[]`
  early — nothing is written, so there is nothing to conflict over.  And
  `InMemoryDurableStateStore.upsert` accepted a negative or fractional
  `expectedRevision`, reporting it as a `DurableStateConcurrencyError` (which
  invites an endless retry) instead of the `JournalError` the relational and
  object-storage stores raise for a bogus argument.  Both divergences surfaced
  while specifying the new parameterized persistence contract, which now runs
  one shared scenario set against every `Journal` / `SnapshotStore` /
  `DurableStateStore` implementation — and, via the live-database adapter,
  extends the Postgres and MariaDB Docker suites with the cases they lacked.
  That adapter also fixes those suites, which had been failing since the
  journal high-water mark landed: they reset each scenario with
  `delete(pid, MAX_SAFE_INTEGER)`, which now *sets* the mark to that value, so
  the following `append(pid, …, 0)` correctly reported a conflict.
- **Three wall-clock test assertions no longer flake the coverage gate**
  (#477).  `bun run test:coverage:gate` failed intermittently — not on the
  coverage floor (line coverage sits around 94 %) but because `bun test`
  exited non-zero.  The cause was not clock granularity but the **timer**:
  Bun's event loop decides a deadline is due on the platform's tick boundary,
  so a `setTimeout` whose delay sits just under a tick multiple fires a full
  quantum **early** — a 30 ms timer measured as low as 18.7 ms on
  Bun 1.3.1 / Windows 11 (15.625 ms quantum) and as high as 201 ms under load.
  `after`'s and `assertDoesNotCompleteWithin`'s `>= 25` bounds on a 30 ms
  delay had no margin against that and now assert a quantum below nominal via
  the new `tests/util/TimerTolerance.ts` (which records the measurements), plus
  a deterministic check that the factory is not invoked synchronously.  `retry`'s
  backoff test is off the wall clock entirely — it drives the new
  `RetryOptions.sleep` seam with `ManualScheduler`, asserting attempts at
  virtual 0/20/50 ms and thereby proving the third delay is capped at 30 ms
  rather than 40 ms, which the old `gap2 < 40` bound could not do reliably at
  any tolerance.  Test-only change beyond the `sleep` addition; no runtime
  behaviour changed.
- **Docs site builds from a fresh install again** (#473).  `docs/package.json`
  and `docs/bun.lock` had drifted apart across three dependency bumps — the
  lockfile's workspace header still recorded the pre-bump ranges, so
  `bun install --frozen-lockfile` failed outright ("lockfile had changes, but
  lockfile is frozen").  Worse, PR #472 raised `astro` to `^7.1.3` while
  `@astrojs/starlight@0.39.3` and its transitive `@astrojs/mdx@5.0.4` both
  declare `peerDependencies: { astro: "^6.0.0" }`; a clean install resolved
  astro 7 and `astro build` died on `Package subpath './jsx/rehype.js' is not
  defined by "exports"`.  The `astro` range is back at `^6.4.8` (the other
  bumps are peer-compatible and stay) and `docs/bun.lock` is regenerated, so
  package.json and lockfile agree.  (Astro 7 lands separately, together with the
  Starlight release that peer-supports it — see Changed → #474.)
  Both CI docs workflows now install with
  `--frozen-lockfile`, and `docs-checks` — which runs on every `docs/**` change
  — gained a lockfile-sync job, so this drift fails on the PR instead of
  silently at release time.

- **Dead-letter delivery no longer recurses into a stack overflow.**  An
  actor subscribed to the `DeadLetter` channel that stopped without
  unsubscribing made every subsequent dead letter bounce between the
  event stream and the dead-letter office until the stack blew.  A dead
  letter wrapping another dead letter is now dropped — that nesting is
  the loop signature, and there is nowhere further to send an
  undeliverable dead letter.

- **Persistence: uniform `JournalError` wrapping + consistent missing-dependency
  hints** (#383).  Driver errors from the read-side journal methods
  (`highestSeq`, `delete`, `persistenceIds`, and Cassandra's `read`) now surface
  as `JournalError` across all backends, matching what `append`/`read` already
  did — callers can catch one error type regardless of backend.  The
  Cassandra driver is now lazy-imported through the shared `lazyImportModule`
  helper (was a hand-rolled `try/catch` with a `bun add` hint), so its
  missing-dependency message matches Postgres/MariaDB.  Fixed the doubled verb
  in the Postgres/MariaDB hint ("…backends require **requires** the 'pg'
  package") by dropping the trailing word from the `context` string.
- **Persistence examples repaired** (#382).  `examples/persistence/scylla-ledger.ts`
  and `benchmarks/persistence/recovery.ts` overrode `snapshotPolicy` as a
  property (`override readonly snapshotPolicy = everyNEvents(...)`) while the
  base declares it as a method, which threw `snapshotPolicy is not a function`
  on the first persist — both now override the method.  `examples/persistence/
  cassandra-plugin-hello.ts` imported `FakeCassandraClient` from a stale
  pre-test-split path and used the removed free `ask(...)` function; it now
  imports from `tests/integration/in-process/persistence/` and calls
  `ref.ask(...)`.
- **Persistence (Cassandra): single-flight `start()`, a live `consistency`
  option, and an accurate batch comment** (#380).  `CassandraJournal.start()`
  and `CassandraSnapshotStore.start()` set `started` only at the very end, so
  two concurrent first calls both ran `connect()` + DDL; they now share a
  single in-flight start (a failed start clears the guard so a later call
  retries).  The `consistency` option (exposed as `withConsistency`) was
  declared but never sent — every read, write, and batch now passes the
  configured CQL consistency level.  The `append` comment that claimed a logged
  batch "only if same partition" (while the code always passed `logged: false`)
  is corrected to describe the actual unlogged-batch-per-partition behaviour and
  why it is safe under the single-writer contract.
- **Persistence: `highestSeq` no longer rewinds to 0 after a full delete**
  (#379).  When `delete(pid, toSeq)` removed every event for a persistenceId,
  the in-memory, SQLite, Postgres and MariaDB journals recomputed the highest
  sequence number as `MAX(sequence_nr)` over the now-empty stream and returned
  0 — so a recovered `PersistentActor` (snapshot at seq N, `deleteHistory(N)`,
  then `persist`) sent `expectedSeq = N` against an `actualSeq` of 0 and hit a
  spurious `JournalConcurrencyError`; worse, sequence numbers could be reused.
  Each backend now keeps a monotonic high-water mark — an in-memory map for
  `InMemoryJournal`, a small additive `<events>_meta(persistence_id,
  deleted_to)` table (auto-created, `IF NOT EXISTS`) for the SQL backends — so
  the counter never rewinds, matching Cassandra (which already tracked it in
  its metadata table) and Akka semantics.  A parameterized contract test
  covers full- and partial-delete-then-append across all four backends.
- **Persistence: closing one store no longer tears down a shared connection
  pool / backend** (#378).  The Postgres and MariaDB journal, snapshot-store,
  and durable-state-store `close()` methods used to call `pool.end()`
  unconditionally — so when a single pool was injected and shared across all
  three stores (the arrangement `registerPostgresPlugins` recommends), closing
  one store ended the pool out from under the others.  Each store now tracks an
  `ownsPool` flag and only ends a pool it built itself; an injected pool is left
  to the caller.  The object-storage plugin had the mirror-image bug — both the
  snapshot and durable-state stores closed the *same* shared backend — so the
  stores gained an `ownsBackend` option (default true for standalone use; the
  plugin sets it false) and `registerObjectStoragePlugins` now returns a
  `close()` handle that closes the shared backend exactly once.
- **Persistence: a misconfigured journal / snapshot-store plug-in now fails
  fast instead of silently falling back to in-memory** (#377).  When
  `actor-ts.persistence.journal.plugin` (or the snapshot-store key) names a
  plug-in id that has no registered factory — e.g. the config is set but the
  matching `registerXxxPlugins(...)` call was forgotten or ordered after the
  first `PersistentActor` spawn — `PersistenceExtension` used to hand back the
  in-memory implementation with no warning, so events were written to a
  volatile store and lost on restart.  It now throws
  `Unknown journal plugin '<id>': …` (and the snapshot-store equivalent).  The
  zero-config default is unchanged: with no plugin key set, the in-memory
  reference implementation is still used.
- **Public-API exports completed.**  Several documented/exported symbols
  were unreachable from the package root: the CRDT map types (`LWWMap`,
  `ORMap`, `GCounterMap`, `MVRegister`), the `LeaseMajority` downing
  strategy (+options), `eventDispatcher`, `CachedSnapshotStore` (+options),
  `reEncryptObjectStorage` / `InMemoryReEncryptProgressStore`, and the
  `MasterKeyRing` types.  They are now re-exported from `actor-ts`, and the
  TestKit multi-node helpers (`MultiNodeSpec`, `ParallelMultiNodeSpec`,
  `MockCluster`, `SnapshotMigrationTest`) are reachable via a new
  `actor-ts/testkit` subpath — the in-repo examples no longer need deep
  relative imports.
- Corrected stale JSDoc on public symbols surfaced by the docs audit
  (`CoordinatedShutdown` `recover` flag, `JsonLogger` `source` field,
  `DeathPactError`, `TestProbe.receiveN`/`fishForMessage` parameter names,
  HTTP backend references, `PersistentActor` reply example,
  `NatsActor`/`JetStreamActor` out-of-scope notes).

### Security

- **The cluster-singleton proxy buffer is bounded** (#526).
  `ClusterSingletonProxy` held every message sent before the cluster had a host,
  with no cap and no overflow policy.  That wait is normally a gossip round —
  which is why buffering is the right answer — but nothing bounds how long it
  can last: unreachable seeds, or a partition in which this node sees nobody,
  keep the cluster there for the length of the outage while the application
  keeps sending.  Unbounded, that is a memory leak that ends the process.
  A new `bufferSize` (`StartSingletonOptions.withBufferSize`, default `1_000`)
  drops the newest message to dead letters past the cap, with a latched
  warning and a `droppedCount` for metrics — dropping the *newest* because the
  buffer exists to preserve send order and evicting from the front would hand
  the singleton a torn prefix of it.  Every other buffered path in the
  framework (mailboxes, WebSocket frames) was already bounded; this one was
  the gap.
- **`ClusterSingletonManagerOptions` is validated** (#526).  The one options
  family in the cluster layer with real constraints and no validator.  The new
  `ClusterSingletonManagerOptionsValidator` asserts the required `cluster` /
  `typeName` / `singletonProps` and checks `typeName` / `role` non-empty and
  `acquireRetryIntervalMs` positive, running once in the manager's
  constructor.  Narrow by construction — the extension is normally the only
  thing that builds these, and it validates `StartSingletonOptions` first — so
  this closes the door for a caller constructing the manager directly, who
  previously got a `Cannot read properties of undefined` from inside
  `preStart` instead of an `OptionsError`.
- **A rejected CAS no longer wedges an object-storage durable-state entry**
  (#117).  When the backend refused a `put` on a stale `If-Match`, the store
  threw the concurrency error but **kept the rejected etag cached** — and that
  cache is what the next `If-Match` is built from.  So every retry re-sent the
  etag the backend had just rejected and failed identically, and worse, the
  up-front revision check answered from the same stale cache, reporting a
  revision that was no longer the truth.  The entry stayed stuck until
  something happened to call `load` or `delete`.  The etag is now dropped on
  rejection, which routes the retry into the refresh-and-recover path that
  already existed for a cache wiped by a restart.

- **The re-encryption sweep validates keys it gets from `list()`** (#123).  Keys
  come from the bucket, not from the framework, and the sweep derives its HKDF
  salt from the key — then **rewrites the body**.  A key that yielded no usable
  persistence id (empty, or one carrying control characters) therefore did not
  merely fail to decrypt: it would re-encrypt data under a salt the owning store
  never reproduces, leaving it permanently undecryptable.  Such keys are now
  skipped before being fetched and reported in the new
  `ReEncryptResult.skippedMalformedKey` — a non-zero count is worth
  investigating, because nothing the framework writes produces one.  The
  key-shape rules are the shared `makeKeyValidator` ones, so the sweep cannot
  drift from the storage backends.

- **`safeStringify` for error paths** (#146).  `ClusterClient.handleReply` built
  its rejection message with a bare `JSON.stringify` on a body received from the
  cluster.  Worth stating precisely, because the issue title overstates it:
  wire bodies arrive as parsed JSON and so **cannot** be circular, and
  `JSON.stringify` throws rather than hangs.  The real defects were that
  `handleReply` was not wrapped, so any throw escaped into the socket decoder
  loop and abandoned **every remaining frame in the same batch** — leaving those
  asks to time out — and that the guarantee rested on the frame codec staying
  JSON-only.  A new `src/util/SafeStringify.ts` renders cycles, `BigInt`,
  functions, symbols and throwing getters without ever throwing, and caps its
  output so a large body cannot become a large message; the reply handler is now
  wrapped so one bad frame cannot take its batch with it.

- **A TCP socket's nested framing caps are validated** (#372).
  `TcpSocketOptionsValidator` checked `host` and `port` but never looked inside
  `framing`, where both inbound size limits live — and those are DoS caps: a
  frame past the cap drops the connection instead of buffering without bound.
  The failure mode is worse than a merely wrong number.  Both are applied as
  `length > cap`, and *every* comparison against `NaN` is `false`, so a
  non-numeric value read from HOCON did not clamp anything — it **removed the
  cap** and restored the unbounded buffering the limit exists to prevent.  Zero
  or negative failed the other way, dropping every connection immediately.
  `framing.maxLineLen` and `framing.maxFrameLen` must now be positive integers;
  unset still falls through to the defaults (1 MiB / 16 MiB).  The rule is
  spelled out with `fail` because the typed check helpers only reach top-level
  fields.

- **`ask` reply refs get unpredictable names** (#119).  The one-shot reply ref
  was named from a module-global `++askCounter`, which is predictable — anything
  able to address a ref by path could aim a forged reply at an in-flight ask —
  *and* shared across every `ActorSystem` in the process, so the Nth ask in two
  independent systems drew the same name.  Over a long run the counter also
  wrapped into collisions with names still in flight.  Names are now
  `askResp-` plus 12 hex characters from `crypto.randomUUID`, the same primitive
  `ClusterClient` moved to for its ask ids (#120).

- **Numeric gossip and heartbeat fields are checked for plausibility**
  (#113, #115).  Two peer-supplied numbers were used without a look:
  - **`removedAt` on a tombstone** (#113) decides whether the entry ages out, and
    the comparison failed **open**: at `Infinity` or `NaN`,
    `Date.now() - removedAt` is `-Infinity` or `NaN`, neither of which is
    `>= ttl`, so the tombstone looked fresh on *every* merge and never expired.
    A far-future value did the same through a negative age.  Since a tombstone
    suppresses its address, one forged frame kept a node from ever rejoining —
    the same shape as the `version` DoS fixed earlier, whose guard sat directly
    above this code.  `removedAt` now gets that same finite-and-not-far-future
    check.
  - **`seq` and `ts` on a heartbeat** (#115) were unvalidated, and `seq` was
    echoed straight back in the acknowledgment.  Nothing consumes either field
    today (`onHeartbeatAcknowledgment` is a no-op, `ts` is unread), so this is a
    boundary guard rather than a live exploit — recorded plainly because the
    honest reason to fix it is that a `NaN` reaching future RTT or clock-skew
    tracking would be silent nonsense.  An implausible frame is now dropped;
    that is safe because `handleWire` has already recorded liveness from the
    socket-level address, so refusing the frame cannot make a live peer look
    unreachable.

- **Actor names are validated, closing a path-forging and a log-injection hole**
  (#126, #134).  `ActorPath` accepted any string, and a path is rendered by
  joining segments with `/` and taken apart again by splitting on it
  (`RefCodec.parsePathSegments`) — so `spawn(props, 'a/b')` did not merely look
  wrong, it changed the path *structure*, producing something indistinguishable
  from a child `b` of an actor `a`.  That collides with, or impersonates, a
  different actor, and it crosses the cluster wire, where the remote side
  re-splits the string.  `.` and `..` carried the same risk through traversal
  meaning.  Separately, a name containing a newline let a caller forge log lines,
  since paths are written to logs and trace spans.
  A name is now rejected if it contains `/`, `\` or a control character, if it is
  `.` or `..`, or if it is empty below a parent — empty stays legal for a root,
  which `deadLetters`, `nobody` and the test probe rely on.  Everything else
  still works, including spaces, interior dots and non-ASCII
  (`'Order.Placed'`, `'entity#3'`, `'日本語'`).
  *Behaviour change:* previously silent corruption, now a throw at spawn time.
  The docs used to tell readers to *"validate segments yourself"*; that guidance
  is replaced by the rule the framework now enforces.

- **The default 500 response no longer echoes the thrown message** (#356).  All
  three backends put `message: err.message` in the body of an unhandled error,
  and a thrown `Error`'s text routinely carries filesystem paths, SQL fragments,
  connection strings or driver internals — none of which is a client's business.
  `defaultErrorResponse` in `Route.ts` was always correct and says so in its
  JSDoc (*"deliberately does NOT echo the thrown message"*); the backends simply
  did not route through it, so the WebSocket-reject and `fallback()` paths were
  safe while every ordinary route was not.  The generic 500 is now
  `{ error: 'Internal Server Error' }` on Fastify, Express and Hono alike.
  An `HttpError`'s own message is still returned — it is authored by the
  application *for* the client — and `withErrorHandler` remains the way to
  surface or log the detail. There was no test either way; there are now three
  per backend.

- **HOCON config parsing can no longer reach the object prototype** (#406).
  A key path is expanded segment by segment onto a plain object, and
  `object[key] = value` invokes the inherited `__proto__` *setter* rather than
  creating an own property — so `__proto__.polluted = true` in any config
  source descended into `Object.prototype` and polluted **every object in the
  process**, while the parsed config still came back as `{}`.  That silence is
  what made it dangerous: nothing in the result hinted at what had happened.
  Three further vectors went with it — a single-segment `"__proto__" { … }`
  replaced the config object's own prototype, `${__proto__}` spliced the
  prototype object into a resolved value, and `deepMerge` carried an *own*
  `__proto__` property (which `JSON.parse` produces and `Object.entries`
  reports) through into the merged result, `{ ...base }` included.
  `__proto__`, `constructor` and `prototype` are now refused as config keys and
  as substitution paths, with a source position like any other parse error, and
  the exported `deepMerge` / `stripUndefined` / substitution walk filter them as
  defence in depth for objects that arrive from plain JavaScript rather than
  from HOCON.  The guard is exact-match, so `_proto_`, `constructorName` and
  `prototypes` keep working.  Note the earlier `__proto__` fix (#9) hardened the
  **JSON serializer** — the config parser was a separate, unguarded path.
  Verified by 11 unit tests plus a cross-runtime smoke case, since how a plain
  assignment meets the prototype setter is engine behaviour rather than library
  behaviour.

- **Cassandra journal: concurrent appends no longer silently lose events**
  (#475).  `CassandraJournal.append` did a plain read-modify-write — read the
  head from `metadata`, compare it to `expectedSeq`, then `INSERT` the events.
  A CQL `INSERT` is an *upsert*, so two writers that both read head `N` both
  passed the check and both wrote `sequence_nr = N+1`: the second overwrote the
  first, and **both callers were told their event was persisted**.  Six racing
  appends produced six successes, one surviving event, and no
  `JournalConcurrencyError`.  The relational backends never had this — their
  events primary key rejects the loser and the duplicate-key error is
  translated back into `JournalConcurrencyError` — so Cassandra was the only
  backend where a system-of-record write could vanish without a trace.
  Appends now claim their sequence range with a **lightweight transaction** on
  the `metadata` row (`IF NOT EXISTS` for a fresh stream, `IF max_sequence_nr =
  ?` thereafter) *before* any event is written, so exactly one writer wins and
  every loser gets a `JournalConcurrencyError` carrying the real head.
  *Behaviour change:* an append now costs one Paxos round-trip — roughly 3–4×
  the latency of a plain quorum write, per `append` rather than per event.
  Cross-pid throughput is unaffected (each claim contends only on its own
  `metadata` partition).  Claiming before writing also inverts the crash
  window: a failed event batch triggers a compensating release of the claim,
  but a process death between the committed claim and the events leaves a gap
  (head ahead of stored events) instead of the previous orphan-events case.
  Both are documented in `docs/.../persistence/journals/cassandra.mdx`.
  `withLightweightTransactions(false)` restores the old single-round-trip
  path — and the old race with it.
- **Persistence: event tags are validated at the journal boundary** (#136).
  Tags (from `PersistentActor.tagsFor`, often derived from user input) are
  always bound as query parameters, so SQL/CQL injection was never reachable —
  but they were otherwise unchecked.  A shared `assertValidTags` now runs in
  every journal's `append` and rejects a comma (which would split into extra
  tags out of SQLite's CSV `tags` column and corrupt a peer event's tag list),
  control characters / newlines (log-injection family), and enforces per-tag
  length (255) and per-event count (64) caps against index/row-size blow-ups.
  Also, `CassandraSnapshotStore` now validates its keyspace + table
  identifiers through `assertSafeIdentifier` (the journal already did), closing
  the last raw-interpolation gap in the Cassandra backend.

### Documentation

- **`Cluster.leader()` and `KeepOldest` say what they actually do** (#525).
  Both were documented — in JSDoc, in `cluster/overview`, in
  `cluster/downing-strategies` — as picking the **oldest** member.  Neither
  does: `upMembers()` sorts by address and both take `[0]`, so the winner is
  the **lowest-addressed** member.  Address order and join order are unrelated,
  so a node that joined a minute ago outranks one that has been up for a week
  whenever its address sorts lower.

  The semantics stay — the one property leadership needs is that every node
  names the same one, and address order delivers that without a monotonic join
  sequence on the wire — and the descriptions are corrected instead, with the
  rule stated once, canonically, under *The leader* in `cluster/overview`
  (EN + DE).  `KeepOldest` is the sharper end of this: a split-brain resolver
  is chosen *for* its tiebreak, and that page actively recommended relying on
  "a long-running 'stable' node (a coordinator pod) that's almost always the
  oldest" — which address ordering does not deliver.  It now says to pin the
  address of the node that should survive.  A test pins the contract: a
  later-joining, lower-addressed node takes leadership immediately, which the
  existing leader test could not catch (its lowest-addressed node was also the
  seed, so the two orderings agreed).
- **Persistence doc snippets reconciled with the real API** (EN + DE, #384).
  `projections.mdx` / `persistence-query.mdx` / `push-based-query.mdx` used
  `new SqliteQuery({ path })` (the constructor takes a `SqliteJournal`
  instance) and a nonexistent `SqliteOffsetStore`; they now construct a
  `SqliteJournal` and use `InMemoryOffsetStore` / `DurableStateOffsetStore`.
  `operations/upgrades/rolling-migration.md` used the renamed
  `MigrationChain.start(...).next(...)` (now `MigrationChain.for(...).add(...)`).
  The new `PersistenceExtension.configure` method makes the previously-documented
  `.configure(...)` call real; the docs-audit pass instead migrated the journal /
  snapshot-store pages to the builder-first `ActorSystemOptions.withPersistence(...)`
  at system creation (both are valid ways to wire persistence).  A new
  `docs/scripts/check-api-drift.mjs` guard (`npm run check:api-drift` in
  `docs/`), wired into a `docs-checks` CI workflow that runs on every docs
  change, fails on any reappearance of a removed/renamed API name (#385).
- **Large docs↔source audit pass** (EN + DE) — corrected default values
  (gossip interval 500 → 1000 ms, bounded-mailbox default), reworded stale
  caution boxes, rewrote drifted pages (conflict-resolver, key-rotation,
  single-writer-lease, push-based-query) to the real APIs, and added a
  dedicated NATS JetStream guide page.

## [0.11.0] — 2026-07-15

### Changed — Naming conventions: no abbreviations, unified vocabulary

Repo-wide naming sweep for consistency.  Pre-1.0, so these are hard
renames with no deprecation shims.  All are mechanical — same behavior,
new names.

- **BREAKING — WebSocket → `Websocket` (single-cap), no `Ws` abbreviation.**
  Every identifier and file/dir uses the `Websocket` spelling:
  `WebSocketServerActor`/`WebSocketClientActor` → `WebsocketServerActor`/
  `WebsocketClientActor`; the `Ws*` supporting types (`WsConnection`,
  `WsCodec`, `WsFrame`, `WsServerMessage`, …) → `Websocket*`; `wsSend()` →
  `websocketSend()`; `DEFAULT_WS_MAX_FRAME_BYTES` →
  `DEFAULT_WEBSOCKET_MAX_FRAME_BYTES`; the module moved
  `src/http/ws/` → `src/http/websocket/`.  The `websocket()` routing
  directive, the global `WebSocket`, the `ws` package's `WebSocketServer`,
  and the `Sec-WebSocket-Protocol` header are unchanged.
  *Migration:* replace `Ws`/`WebSocket` identifier prefixes with
  `Websocket`; `wsSend` → `websocketSend`.
- **BREAKING — abbreviations spelled out** in type/member names: `*Cmd` →
  `*Command`, `*Msg` → `*Message`, `*Ack` → `*Acknowledgment`, `ByPid*` →
  `ByPersistenceId*`, `*Impl` → `*Implementation`, `*Ctor` → `*Constructor`.
  Wire/discriminator string literals are unchanged.
  *Migration:* e.g. `MqttCmd` → `MqttCommand`, `EnvelopeMsg` →
  `EnvelopeMessage`, `SubscribeAck` → `SubscribeAcknowledgment`.
- **BREAKING — testkit assertions spelled out too:** `TestProbe.expectMsg()`
  → `expectMessage()`, `TestProbe.expectMsgType()` → `expectMessageType()` —
  the last `Msg` holdouts, now consistent with `expectNoMessage()`.
  *Migration:* rename the calls; signatures and behavior are unchanged.
- **BREAKING — one config vocabulary: `Options`, never `Settings`.**
  Remaining `*Settings` types → `*OptionsType` (`CircuitBreakerSettings`,
  `TlsTransportSettings`, `Bounded/PriorityMailboxSettings`,
  `ManagementRoutesSettings`, `ConsumerControllerSettings`,
  `KeepMajoritySettings`, the testkit specs); `BrokerSettings.ts` folded
  into `BrokerOptions.ts` (`BrokerSettingsError` → `BrokerOptionsError`);
  the `BrokerActor` glue `readSettingsFromConfig`/`requiredSettings`/
  `builtInDefaults`/`settings` → `readOptionsFromConfig`/`requiredOptions`/
  `builtInDefaultOptions`/`options`; `default{FailureDetector,PhiAccrual}Settings`
  → `default*Options`.  New dedicated `ConsumerControllerOptions` +
  `KeepMajorityOptions` files with builders.
- **BREAKING — Command vs Signal unified on `kind`.**  MQTT and WebSocket
  internal mailbox signals are now `kind`-tagged plain objects (dispatched
  by `kind`, like the typed-actor `Signal`), not `instanceof`-dispatched
  classes; the bad-payload hook is `onInvalidMessage` everywhere (MQTT's
  `onDecodeError` is gone); `WebSocketAcceptSignal` → `WebsocketAcceptCommand`
  and `WebsocketClientSend` is a command, both lifted out of the `*Signal`
  unions.
  *Migration:* override `onInvalidMessage` instead of `onDecodeError`;
  construct outbound sends via `websocketSend(msg)` (unchanged).
### Added — Options validation

- **`OptionsValidator` + `OptionsError`** (#274) — a declarative-but-code
  validator layer for the `XOptions` pattern.  Each options file with
  constrained fields exports an `XOptionsValidator` (`extends
  OptionsValidator<XOptionsType>`, brokers via `BrokerOptionsValidator`) whose
  `rules(s)` uses typo-checked, no-op-on-`undefined` helpers (`port`,
  `positiveNumber`, `positiveInt`, `nonNegativeInt`, `oneOf`, `nonEmptyString`,
  `url`, …) plus `fail(field, reason, value)` for cross-field rules.  Validation
  runs **once at consume time on the merged settings**, so builder, plain-object,
  and HOCON inputs are all checked and cross-field rules see the final values —
  broker actors via the `optionsValidator()` hook (in `preStart`, after the
  required-field check), non-broker consumers via one
  `new XOptionsValidator().validate(settings)` call in their constructor.
- **Validators shipped for**: every broker (MQTT, Kafka, AMQP, Redis Streams,
  NATS, JetStream, SSE, TCP, UDP, gRPC client) and the WebSocket client; the
  cluster core (`Cluster`, `ClusterBootstrap`, `FailureDetector`, `PhiAccrual`,
  `ClusterClient`, `ClusterClientReceptionist`, `StaticQuorum`, `KeepReferee`,
  `LeaseMajority`, `ClusterRouter`), sharding (`Sharding`, `StartSharding`,
  `ShardedDaemonProcess`) and singleton (`StartSingleton`); discovery
  (`AutoDiscovery`, `ConfigSeedProvider`, `DnsSeedProvider`,
  `KubernetesApiSeedProvider`, `Receptionist`) and gossip intervals
  (`DistributedPubSub`, `DistributedData`); leases (`Lease`, `KubernetesLease`);
  caches (`RedisCache`, `MemcachedCache`, `CachedSnapshotStore`); the
  `CassandraJournal` and S3 / filesystem object-storage backends; the
  Express/Hono HTTP backends; `WorkerCluster`; delivery `ProducerController`;
  and `TestProbe`.  Options whose fields carry no real constraint
  (all-boolean/string/callback, or degrade-gracefully knobs like snapshot
  `keepN` where `<= 0` means "keep all") intentionally get no validator.

### Changed — Options validation

- **BREAKING** (#274) — invalid **option values** now throw `OptionsError` at
  construction / actor start instead of a bare `Error` (or, previously, going
  unchecked on the builder/plain-object path).  Notably MQTT `protocolVersion`
  outside `{4, 5}` now throws `OptionsError` on **all** input paths (previously
  only the HOCON path threw, as a bare `Error`).  *Migration:* catch
  `OptionsError` (exported from the package root) where you previously matched
  the ad-hoc `Error` message.  Missing **required** broker settings still throw
  `BrokerOptionsError`; malformed HOCON still throws `ConfigError`.
- **BREAKING — `InMemoryCache` joins the `XOptions` family.** It now takes an
  `InMemoryCacheOptions` builder (or plain object) with `withMaxEntries` /
  `withCleanupMs`, validates via `InMemoryCacheOptionsValidator` (out-of-range
  values throw `OptionsError` instead of a bare `Error`, and `cleanupMs` — a
  negative / `NaN` sweep interval — is now checked too), and reads its defaults
  from HOCON `actor-ts.cache.in-memory.{maxEntries, cleanupMs}` via the
  `CacheExtension` (previously the bounds were unreachable through the
  extension).  The internal `InMemoryCacheSettings` interface is **removed** —
  use `InMemoryCacheOptionsType` (both `InMemoryCacheOptions` and the type are
  now exported from the package root).  *Migration:* a plain
  `{ maxEntries, cleanupMs }` object still works unchanged; only the type name
  changed.
- **WebSocket route / policy options are now validated.** The resolved
  per-connection policy (`maxFrameBytes`, `maxBufferedBytes`, `maxConnections`,
  and the `onOversizeFrame` / `onInvalidMessage` / `onBackpressure` enums) is
  checked on every path — route options, HOCON `actor-ts.http.websocket`, and
  defaults — via `WebsocketPolicyOptionsValidator`, and `allowedOrigins` via
  `WebsocketRouteOptionsValidator`.  Bad values throw `OptionsError` (the enum
  guard previously threw a bare `Error`, and only on the HOCON path; the
  numeric knobs — e.g. `maxConnections: 0`, which silently admitted nobody —
  were unchecked).  The reference config now ships an `actor-ts.http.websocket`
  section documenting the defaults.
- **The object-storage decompression cap is now a store option.** The 512 MiB
  decompression-bomb guard (#3) was pinned to its default because the stores
  called `decodeBody` without a cap.  `withMaxDecompressedBytes` is now on
  `ObjectStorageSnapshotStoreOptions`, `ObjectStorageDurableStateStoreOptions`,
  and `ObjectStoragePluginOptions` (validated at construction — a non-positive
  / non-integer cap throws `OptionsError`, `Infinity` opts out), and both
  stores forward it into `decodeBody`.  Raise it to restore a legitimately
  large snapshot / state blob, or lower it for a tighter bound.
- **HTTP middleware + directives now validate their options.** Added
  `OptionsValidator`s for `TimeoutOptions` (`ms`), `HstsOptions` (`maxAge` plus
  the preload cross-field), `CorsOptions` (`maxAge` plus credentials-vs-`*`),
  `CsrfOptions` (present-secret length, cookie `sameSite` / `maxAgeSeconds`),
  and `StaticFilesOptions` (`maxFileSize`, `dotfiles` / `symlinks` enums); the
  ad-hoc bare-`Error` validity checks in the consumers now throw `OptionsError`
  (required-field guards stay as-is).  `rateLimit` and `idempotent` also gained
  the real `RateLimitOptions` / `IdempotencyOptions` fluent builders they were
  already documented to have, each with a validator (`windowMs`/`max`,
  `ttlMs`/`missingHeader`); the plain-object call form is unchanged.
- **`CircuitBreaker` and `BoundedMailbox` now validate their options too** —
  the last exported options types with real numeric constraints join the
  validator family.  `CircuitBreakerOptionsValidator` checks `maxFailures`
  (integer >= 1), `resetTimeoutMs` (finite >= 0), and the previously-unchecked
  `callTimeoutMs` (> 0 — omit it to disable the per-call timeout; `0`, which
  previously meant "no timeout" silently, now throws), and requires
  `maxFailures`/`resetTimeoutMs` at runtime (a builder without them previously
  produced a breaker that silently never opened).
  `BoundedMailboxOptionsValidator` checks `capacity` (integer >= 1, and now
  required — previously a missing `capacity` made the "bounded" mailbox
  silently unbounded) and the previously-unchecked `overflow` enum.  The old
  ad-hoc bare-`Error` guards now throw `OptionsError`.

### Added — HTTP hardening

- **Scoped error handling + fallback routes** (#352) — `handleErrors(handler,
  child)` catches exceptions from a subtree (akka-http `ExceptionHandler`
  style; sees the original error, returns a response or `null` to decline);
  `fallback(handler)` answers any unmatched request via each backend's
  not-found hook; `ServerBuilder.withErrorHandler(...)` is the server-wide
  last resort.  Precedence, uniform across Fastify/Express/Hono: innermost
  `handleErrors` → `withErrorHandler` → framework default.
- **HTML response utilities** (#352) — `escapeHtml`, an auto-escaping `html`
  tagged template with a `SafeHtml` brand, `rawHtml` escape hatch, and
  `completeHtml` (`text/html` + `nosniff`).
- **Security-middleware suite** (#353) — `cors` (a route directive that the
  compiler expands into per-pattern preflight `OPTIONS` routes),
  `strictTransportSecurity` / `hsts`, `contentSecurityPolicy`,
  `csrfProtection` + `requireSameOrigin`, `securityHeaders`, `requestId`,
  `BasicAuth`, and `requestTimeout` — each with an `XOptions` builder.  Plus
  public `parseCookies` / `serializeCookie` helpers.
- **Static file serving** (#354) — `getFromFile`, `getFromDirectory`, and
  `getFromBrowseableDirectory`: MIME detection, index resolution, conditional
  requests (weak ETag + `Last-Modified` → 304), single `Range` (206/416),
  HEAD, trailing-slash redirects, and XSS-safe directory listings.
- **MIME-type registry** (#354) — `contentTypeFor(pathOrExt, overrides?)` and
  `DEFAULT_MIME_TYPES`.
- **Streaming response bodies** (#354) — `HttpResponse.body` now accepts a web
  `ReadableStream<Uint8Array>`, written natively by all three backends.

### Changed — HTTP hardening

- **`Middleware` `next()` accepts an optional request override** (#353) —
  `next(req?)` lets a middleware enrich what the handler sees (request-id,
  CSRF token).  Backward compatible.
- **HonoBackend now answers `HEAD` on `GET` routes** (#354), matching
  Fastify/Express; a route pattern ending in `/*` exposes the remainder as
  `req.params['*']` on every backend.
- **BREAKING:** the `Route` / `CompiledEndpoint` unions gain `fallback` and
  `cors` variants — an exhaustive `match` over `Route` must handle them
  (#352, #353).
- **BREAKING:** `ServerBuilder` gains a required `withErrorHandler` method —
  structural third-party implementers must add it (#352).
- **BREAKING:** `HttpError`'s constructor gains an optional 4th `headers`
  parameter (after `extra`); `BearerTokenAuth` 401s now expose the challenge
  on `err.headers['www-authenticate']`, no longer `err.extra.wwwAuthenticate`
  (#352).

### Security

- **CORS, CSRF, and security-header middleware** (#353) — origin allowlisting
  with correct preflight handling, an HMAC-signed double-submit CSRF token
  (plus an Origin/Referer check), and HSTS / CSP / COOP / CORP / nosniff /
  frame-options; secret comparisons are constant-time.
- **`WWW-Authenticate` reaches the wire** (#353) — `BearerTokenAuth` (and the
  new `BasicAuth`) 401s emit a real challenge header instead of burying it in
  the body.
- **Hardened path-traversal defence for static files** (#354) — the URL
  remainder is fully decoded before validation, every segment is rejected if
  it is `..`, empty, NUL, a backslash, or a `:` (drive/ADS) segment, absolute
  forms are refused, the joined path is confined to the root, symlink escapes
  are refused, and dotfiles are denied — every rejection a uniform 404.

- **WS-1 (HIGH) — WebSocket upgrade crash hardened**.
  A malformed percent-escape in the upgrade path (e.g. `GET /room/%ZZ` against a
  `websocket('/room/:id', …)` route) made `decodeURIComponent` throw inside the
  Express backend's fire-and-forget upgrade handler, surfacing as an *unhandled
  rejection* — process-fatal under Node's default and reachable **pre-auth** by
  an unauthenticated client.  `matchWebsocketPattern` now treats a malformed escape as
  a non-match (→ 404), and the Express upgrade handler attaches its socket
  error-guard before any async work and wraps the handler in a last-resort
  `.catch` that closes the socket.  Fastify/Hono were not affected.
- **WS-2 (HIGH) — Cross-Site WebSocket Hijacking (CSWSH) defence**.  No upgrade handler validated the `Origin` header, so a
  malicious web page could open an authenticated WebSocket riding a victim
  browser's ambient cookie/IP auth.  New **`allowedOrigins`** option on
  `websocket()` routes (`.withAllowedOrigins([...])` on the builder): an upgrade
  whose `Origin` is present but not listed is rejected with 403 before the
  handshake on all three backends; a missing `Origin` (non-browser client) is
  allowed.  Bearer-token auth was already resistant (browsers can't set
  `Authorization` on a WS handshake).
- **HTTP-1 (MEDIUM-HIGH) — Hono body-size cap enforced before buffering**.  The Hono backend read the whole request body via
  `arrayBuffer()` and only then compared it against `maxBodyBytes`, so the cap
  was cosmetic — the real ceiling was the runtime's native default (128 MiB on
  Bun, effectively unbounded on Node via `@hono/node-server`).  It now rejects
  an oversized `Content-Length` with 413 *before* buffering; the post-buffer
  check remains a backstop for chunked bodies that omit Content-Length.
  Express (streaming cap) and Fastify (framework default) were unaffected.
- **HTTP-2 (MEDIUM-HIGH) — `InMemoryCache` is now bounded (LRU)**.  The default in-process cache was an unbounded `Map`
  with lazy expiry only, so a flood of distinct attacker-chosen keys
  (`Idempotency-Key`; rate-limit keys — idempotency additionally stores the
  full response body for 24 h) grew it without limit → RAM exhaustion.  It now
  accepts `{ maxEntries?, cleanupMs? }` (defaults `10_000` / `60_000`): a new
  key beyond the cap evicts the least-recently-used entry, and a background
  sweep reclaims expired entries.  *Behaviour change:* the default
  is now bounded — pass `maxEntries: Infinity` for the previous unbounded
  behaviour (documented OOM risk).  Options / validation / HOCON plumbing for
  these fields landed as the `InMemoryCacheOptions` follow-up (see *Changed —
  Options validation*).
- **WS-6 (LOW) — CRLF stripped from raw upgrade-reject headers**.  `writeRawHttpResponse` (the Express pre-handshake
  reject path) wrote app-supplied header names/values verbatim onto the raw
  socket, so an `authorize` guard echoing attacker-influenced data into a
  header could split the response.  CR/LF are now stripped from header names
  and values.
- **#9 (hardening) — JSON deserialization ignores the `__proto__` setter**
 .  `JsonSerializer` and the cluster ref decoder
  now define a decoded `"__proto__"` key as an own data property instead of
  assigning through the prototype setter, so a hostile payload can't change
  the decoded object's prototype.
- **BRK-1 / BRK-2 (MEDIUM) — inbound buffer caps for TCP `lines` + SSE**.  A hostile / MITM'd upstream could stream bytes with no
  frame delimiter, growing the inbound buffer without bound.  The TCP `lines`
  framer now rejects an un-terminated remainder that already exceeds
  `maxLineLen` (matching the existing terminated-line check), and the SSE
  client caps its pending event buffer at 1 MiB — both drop the connection
  instead of buffering forever.  (`length-prefixed` TCP framing was already
  bounded.)
- **#6 (LOW) — consistent SQL/CQL identifier validation**.  Postgres/MariaDB already validated table identifiers,
  but SQLite (journal + snapshot store) and Cassandra (keyspace + table names,
  interpolated into CQL) did not.  A shared `assertSafeIdentifier`
  (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is now applied across all four, so a
  config-sourced identifier can't inject SQL/CQL.  Data values were, and
  remain, bound parameters.
- **HTTP-3 (docs) — rate-limit examples key on the socket peer, not
  `x-forwarded-for`**.  The shipped `rateLimit`
  examples taught keying on the client-settable `x-forwarded-for` header, which
  an attacker rotates per request to bypass the limit (and which collapses all
  header-less clients into one shared bucket).  The JSDoc and the bilingual
  docs now use `req.remoteAddress` and state the trusted-proxy caveat.  No
  behaviour change — `key` was always caller-supplied.
- **#3 (MEDIUM) — decompression-bomb cap on stored bodies**.  Reading a snapshot / durable-state / object body
  decompressed it with no output bound, so a tampered or hostile compressed
  blob (a few KB expanding to many GB) could OOM the process on recovery.
  `decodeBody` now caps the decompressed size at **512 MiB** by default
  (`DecodeOptions.maxOutputBytes`; `Infinity` opts out): gzip enforces it at
  allocation time via zlib's `maxOutputLength`, and every path asserts the
  decoded size as a portable backstop.
- **HTTP-4 (MEDIUM) — idempotency responses can be scoped per caller**.  The idempotency cache keyed only on the
  `Idempotency-Key` header plus a method/path/body fingerprint, so two callers
  reusing the same key for the same request shape shared one cached response —
  a cross-user disclosure when the response is identity-specific (e.g. carries
  `Set-Cookie` or the first caller's data).  New opt-in `identity: (req) =>
  string` folds the authenticated principal into the cache key so responses are
  partitioned per caller.  (Same-key-different-body poisoning was already
  rejected with 422.)
- **WS-4 (MEDIUM) — WebSocket backpressure works on the Hono backend**.  The Hono socket adapter didn't implement
  `bufferedAmount`, so the connection actor's `maxBufferedBytes` /
  `onBackpressure` guard was a no-op on Hono — a slow / idle-reading client
  could grow the outbound send buffer without bound (OOM).  The adapter now
  surfaces the send-buffer depth from the native socket (Bun
  `getBufferedAmount()`, Node/Deno numeric `.bufferedAmount`).
- **WS-3 (MEDIUM) — cap the WebSocket transport frame size (Express + Fastify)**
 .  The `ws`-backed backends left the transport at the
  `ws` default `maxPayload` (100 MiB), so an oversized frame was buffered in
  full before the app-level `maxFrameBytes` (1 MiB default) rejected it —
  allocation-amplification DoS.  Both now pass `maxPayload:
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES` (1 MiB), so an oversized frame is rejected at the
  protocol level.  *Caveat, since narrowed:* on these backends a route that
  raised `maxFrameBytes` above the default was still capped at the default by
  the transport.  #373 replaced that constant with `transportFrameCapOf` — the
  widest cap any of the server's routes resolved to — and #586 gave the Hono
  backend a runner-level cap it had lacked entirely.  Both are **server-level,
  not per-route**: #373's per-route half was considered and declined, because
  `@fastify/websocket` registers once per instance and Bun's `maxPayloadLength`
  belongs to the whole `Bun.serve`, so two of the three backends cannot express
  one.  And two transports enforce no cap at all — Hono-on-Deno, whose
  `Deno.upgradeWebSocket` has no payload option, and Bun with Express or
  Fastify, where `ws` resolves to Bun's built-in shim, which stores `maxPayload`
  and enforces nothing.  On those two the connection actor's own `maxFrameBytes`
  check is the guarantee, and it closes 1009.  The `[0.17.0]` entries for
  #373 and #586 are the accurate account.
- **WS-5 (MEDIUM, partial) — per-route WebSocket connection admission cap**
 .  New opt-in `maxConnections` on `websocket()`
  routes (`.withMaxConnections(n)`, or `actor-ts.http.websocket.maxConnections`
  in HOCON): a new upgrade beyond the cap is closed with 1013 in the shared
  wiring layer before an actor is wired for it, and the live count decrements
  when a connection closes.  Default: unlimited (behaviour unchanged).  The
  other WS-5 sub-parts — a handshake/idle timeout and hub-mailbox bounding —
  remain tracked follow-ups.

### Documentation

- Moved the Server-WebSocket page from the IO section into the HTTP section
  (#351).
- Reconciled stale API-reference pages with the shipped code (#360): rewrote the
  persistence adapter & migration pages and the OTel **tracing** adapter page to
  the function-based APIs, rewrote the management & health-check and cache &
  durable-data pages to their real APIs, and removed the page for the
  never-shipped OTel *metrics* adapter.
- Repointed stale `*Settings` type names in prose to the `*OptionsType`
  vocabulary (#349).
- Fixed broken code samples that declared a `const` inside a call's object
  literal (#359).

## [0.10.0] — 2026-07-08

### Added — Typed WebSocket & MQTT

- **Typed WebSocket routing** (#1) — a `websocket(path, actorRef)` directive
  in the HTTP routing DSL binds a `WebSocketServerActor<TOut, TIn>`.  The
  hub receives codec-decoded messages (JSON by default; `rawCodec()` for
  binary), replies to the sending connection with `this.reply(...)` or
  fans out with `this.broadcast(...)`, and gets `onClientConnected` /
  `onClientDisconnected` / `onInvalidMessage` hooks.  The framework spawns
  an internal session actor per connection and solves the first-frame
  race by construction (listeners attach synchronously at upgrade; the
  mailbox is the buffer).  Works on all three HTTP backends — Fastify
  (`@fastify/websocket`), Express (`ws` upgrade handling), and Hono
  (per-runtime: Bun/Node/Deno).  `withMiddleware(...)` runs at upgrade
  time, so `BearerTokenAuth` / `IpAllowlist` gate the handshake.
- **`WebSocketClientActor<TOut, TIn>`** (#1) — the typed client half, built
  on `BrokerActor`: reconnect-with-backoff, outbound buffering across
  reconnects, circuit breaker, and HOCON settings.  Other actors push a
  typed send with `ref.tell(wsSend(msg))`.
- **`actor-ts.http.websocket` HOCON block** — server-side WebSocket
  defaults (`maxFrameBytes`, `onOversizeFrame`, `onInvalidMessage`,
  `maxBufferedBytes`, `onBackpressure`); route options override HOCON,
  which overrides built-in defaults.
- **Subclass-first, typed `MqttActor<T, TSelf>`** (#345) — the MQTT
  counterpart to `WebSocketClientActor`.  Extend it, declare
  subscriptions in the constructor with `this.subscribe(topic, { qos })`,
  handle inbound traffic in `onMessage(msg)`, and publish with
  `this.publish(topic, payload)`.  Lifecycle events (inbound / connected /
  disconnected) run on the actor thread via the mailbox.  Hooks:
  `onMessage`, `onConnected`, `onDisconnected`, `onDecodeError`,
  `onSelfMessage`.  Still externally controllable via
  `ref.tell({ kind: 'publish' | 'subscribe' | 'unsubscribe', … })`.
- **`MqttOptions` fluent builder** (#345) — `MqttOptions.create()
  .withBrokerUrl(…).withClientId(…).withQos(…)…`; feeds the same
  three-layer settings merge (constructor > HOCON
  `actor-ts.io.broker.mqtt` > built-in defaults).  (As of #346/#348 this is
  the primary way to construct; a plain `MqttOptionsType` object works too —
  see the options note under *Changed*.)
- **Typed MQTT payloads** (#345) — inbound `MqttMessage<T>` carries a
  lazily-decoding `MqttPayload<T>` (`.bytes` / `.text()` / `.entity<U=T>()`,
  successes cached).  A pluggable `MqttCodec<T>` seam (default
  `mqttJsonCodec()`) decodes `entity()` and encodes non-string publishes;
  `publish(topic, { … })` encodes an entity, `publish(topic, string |
  Uint8Array)` sends raw bytes.  Decode failures surface via
  `onDecodeError`.  `MqttClientLike` / `MqttModuleLike` are exported as
  test seams for the `mqttModule()` override.

### Changed — Options overhaul & MQTT

- **Fluent options, framework-wide** (#346, #348) — every configurable
  constructor and factory takes a fluent options builder **or** a plain
  settings object, interchangeably: `new MqttActor(MqttOptions.create()
  .withClientId('x'))` behaves identically to `new MqttActor({ clientId:
  'x' })`.  A builder *is* its settings — `OptionsBuilder` stores each field
  as an own property, so a builder instance reads and spreads exactly like a
  plain settings object (no separate resolve step; consumers just read the
  argument).  Each configurable type exposes **three names from one
  `XOptions.ts` file**: `XOptionsType` (the plain object), `XOptionsBuilder`
  (the fluent builder, `XOptions.create().withField(…)`), and `XOptions` — the
  **union** of the two that every consumer signature accepts (`options:
  XOptions`), plus a value alias so `XOptions.create()` keeps working.  There
  is no separate "Settings" concept (the former `XSettings` interface is now
  `XOptionsType`, co-located in `XOptions.ts`).  HOCON resolution is
  unchanged — the builder / plain object only supplies the
  highest-precedence explicit layer, and unset fields still fall through
  to config then defaults.  Naming lockstep with no divergence: builder
  method `withX` ⇔ settings field `x` ⇔ HOCON leaf `x`.  Affected
  (non-exhaustive): `ActorSystem.create(name, ActorSystemOptions
  .create()…)`; `TestKit.create` / `new TestProbe` (`TestKitOptions` /
  `TestProbeOptions`); every broker actor (`MqttOptions`, `KafkaOptions`,
  `AmqpOptions`, `NatsOptions`, `JetStreamOptions`, `RedisStreamsOptions`,
  `SseOptions`, `TcpSocketOptions`, `UdpSocketOptions`, `GrpcClientOptions`,
  `GrpcServerOptions`); HTTP/WS (`WebSocketClientOptions`,
  `WebSocketRouteOptions`, `ExpressBackendOptions`, `HonoBackendOptions`);
  cache (`RedisCacheOptions`, `MemcachedCacheOptions`); persistence
  journals / snapshot stores / durable-state stores / object-storage
  backends / projections / plugin registrations; cluster / sharding /
  singleton / client / pub-sub / router / downing / failure detectors;
  leases, seed providers + discovery, observability adapters
  (`OtelAdapterOptions`, `PromClientAdapterOptions`), `WorkerClusterOptions`,
  `DistributedDataOptions`, and `ProducerControllerOptions`.  Migration:
  `new X({ a, b })` still works, or use `new X(XOptions.create()
  .withA(a).withB(b))`; the positional "context" args that were never
  settings (a system name, a `Cluster`, a sharding entity + type name)
  stay positional.  **BREAKING** (pre-1.0 hard cut): the builder class
  `XOptions` is renamed `XOptionsBuilder` and the settings interface
  `XSettings` is renamed `XOptionsType`; `XOptions` is now the accepted-input
  union.  Everyday call sites — `XOptions.create()…` and plain objects — are
  unaffected; only code that referenced the old `XSettings` type name or the
  builder *class* by name needs updating.
- **BREAKING: renamed settings fields + HOCON keys** (#348) — to keep the
  builder-method ⇔ settings-field ⇔ HOCON-leaf names in lockstep, six
  fields were renamed: MQTT `defaultQos` → `qos` (`withQos`) and
  `keepAliveSec` → `keepAlive` (`withKeepAlive`); JetStream `ackTimeoutMs`
  → `ackTimeout`; ClusterClient `log` → `logger`; DistributedData
  `gossipIntervalMs` → `gossipInterval`; ProducerController
  `resendTimeoutMs` → `resendTimeout`.  Update any plain settings objects
  and HOCON keys using the old names.
- **BREAKING: `MqttActor` is now abstract** (#345) — you subclass it and
  override `onMessage` instead of spawning it directly and driving it only
  with `tell`.  Migration: `class MyClient extends MqttActor<T> { … }` and
  spawn the subclass.  A pure external-router setup needs a trivial
  subclass with an empty `onMessage`.
- **BREAKING: `MqttMessage.payload` is a `MqttPayload<T>` wrapper**, no
  longer a raw `Uint8Array` (#345).  Migration: `msg.payload` →
  `msg.payload.bytes`; `new TextDecoder().decode(msg.payload)` →
  `msg.payload.text()`; JSON reads → `msg.payload.entity()`.
- **BREAKING: `MqttOptionsType.subscriptions` and the `MqttSubscription`
  type are removed** (#345) — they were never HOCON-expressible (targets
  are actor refs).  Migration: move `subscriptions: [{ topic, target }]`
  into the subclass constructor as `this.subscribe(topic, { target })`, or
  send `ref.tell({ kind: 'subscribe', topic, target })`.
- **BREAKING: `subscribe`/`unsubscribe` command `target` semantics**
  (#345) — a `subscribe` command with no `target` now delivers to the
  actor's own `onMessage` (previously `target` was required).  An
  `unsubscribe` command with no `target` now removes only the *foreign*
  targets and leaves the actor's own subscription intact (previously it
  dropped the whole topic).

### Fixed — MQTT

- **MQTT runtime subscriptions are re-applied after a reconnect** (#345) —
  previously only the (now-removed) `settings.subscriptions` were
  re-subscribed on reconnect, so subscriptions added at runtime silently
  stopped receiving after a drop.  The unified registry is now re-applied
  on every (re)connect.
- **MQTT `subscribe` while disconnected reaches the broker on connect**
  (#345) — previously it updated only the local routing map and never
  issued the broker SUBSCRIBE.
- **MQTT terminated fan-out targets are cleaned up** (#345) — subscriber
  refs are deathwatched; when one stops it is pruned from the registry and
  a broker UNSUBSCRIBE fires once the pattern has no consumers left.

### Removed — legacy frame-level WebSocket API

- **BREAKING: the legacy frame-level WebSocket API** — `WebSocketActor`
  (client), `ServerWebSocketActor` (server bridge), and the
  `serverWebSocketActorOf` / `bunWebSocketHandlers` adapters are gone.
  They worked at the raw text/binary frame level and needed ~150 lines of
  backend-specific boilerplate to stand up a server.  Replace a
  `WebSocketActor` with `WebSocketClientActor`, and a hand-rolled server
  plugin with a `websocket(path, ref)` route + `WebSocketServerActor`.
  The client HOCON key `actor-ts.io.broker.websocket` is unchanged.

### Security

- **WebSocket DoS hardening carried into the new stack** (#1) — inbound
  frames are size-capped (`maxFrameBytes`, default 1 MiB) *before* the
  codec decodes them; oversize frames close 1009 (or drop) and
  undecodable frames close 1003 (or drop / hook) per policy.  Slow-consumer
  backpressure closes/drops past `maxBufferedBytes`.

- **DurableState revision tampering** (#116) — `ObjectStorageDurableStateStore.load()`
  previously trusted the `revision` value inside the body JSON, so an
  attacker with write access to the underlying bucket could roll back
  state past CAS checks.  Two-track integrity fix: encrypted bodies use
  AES-GCM with `revision` as AAD (already wired); unencrypted bodies
  gain an opt-in HMAC-SHA256 over `{ revision, etag }` with per-pid
  HKDF-derived subkeys.  Set `integrity: { mode: 'hmac-sha256', integrityKey }`
  on the store + `requireIntegrity: true` to refuse legacy un-tagged
  bodies on the read path.
- **ClusterClient ask-ID predictability** (#120) — `nextAskId()` used
  `Date.now() + counter`, predictable enough that a MitM on the
  TCP socket could pre-compute likely IDs and inject forged
  `cluster-client-reply` frames.  Switched to `crypto.randomUUID()`
  (122 bits of entropy per call).
- **Master-key rotation sweep race** (#109) — `reEncryptObjectStorage()`
  had no durable progress token, so a crash forced the resumed run
  to re-list and re-GET every object from scratch (a 24-hour sweep =
  a 24-hour wasted re-walk).  Worse: if the operator dropped a
  retired key from the keyring too soon, the sweep would only
  notice mid-corpus, leaving the bucket half-rewritten.  Added two
  opt-in options: `progress: ReEncryptProgressStore` for durable
  resume tokens (file/Redis/object-storage-backed) and
  `verifyKeyringCompleteness: boolean` (default `true`) for a
  pre-sweep sample that refuses to start when a body's key version
  is absent from `active`/`retired`.
- **LeaseMajority split-brain** (#142) — a slow `lease.acquire()`
  that the local defence-in-depth timeout had given up on could
  later resolve `true` and write `decision=surviveSet`, letting
  both sides of an equal partition claim victory.  Three layered
  fixes: (1) monotonic `acquireEpoch` so a late result with a
  stale epoch is dropped; (2) fire-and-forget `lease.release()`
  on abandon to undo any wire-side success after the local
  give-up, with fail-safe-on-rejection (refuse to claim majority
  on the same view); (3) optional fencing tokens — `Lease.acquireWithToken?():
  Promise<{ token: string } | null>` with `KubernetesLease`
  returning `<resourceVersion>/<leaseTransitions>` and
  `InMemoryLease` a monotonic per-name version stamp.

### Added — Persistence, HTTP & observability

- **PostgreSQL persistence backend** (#323) — `PostgresJournal`,
  `PostgresSnapshotStore`, and `PostgresDurableStateStore` (the first
  SQL-backed durable-state store) on top of the `pg` driver, registered
  via `registerPostgresPlugins(ext, …)` which selects the journal +
  snapshot store by config plugin ID and returns the durable-state-store
  handle (the object-storage-plugin pattern — `PersistenceExtension` has
  no durable-state registry).  Optimistic concurrency (per-pid
  `SELECT MAX(seq)` inside a transaction plus a primary-key
  unique-violation `23505` backstop; revision CAS via
  `ON CONFLICT`/`UPDATE … WHERE revision`), an indexed tags join table,
  and auto-created schema (`autoCreateTables`, default on).  `pg` is an
  optional peer-dependency, lazy-imported; the backend defines its own
  minimal client shapes so the framework stays dependency-free.  Ships
  with an in-process fake-pool unit suite and a live `postgres:latest`
  Docker suite wired into the integration-brokers CI matrix.
- **MariaDB persistence backend** (#324) — sibling of #323 for
  MariaDB / MySQL via the official `mariadb` connector: `MariaDbJournal`,
  `MariaDbSnapshotStore`, `MariaDbDurableStateStore`, and
  `registerMariaDbPlugins`.  A separate implementation with the MariaDB
  dialect (`?` placeholders, `INSERT IGNORE` for the tag dedup,
  `ON DUPLICATE KEY UPDATE` snapshot upsert, a derived-table-wrapped
  `keepN` prune, `ER_DUP_ENTRY`/1062 concurrency backstop, and
  `LONGTEXT`/`VARCHAR(255)`/`BIGINT` columns).  Optional `mariadb`
  peer-dep; in-process fake-pool suite + live `mariadb:latest` Docker
  suite in CI.
- **Configurable compression level** (#322) — `CompressionConfig` gains
  an optional `level` (gzip 0–9, zstd 1–22) threaded through the codec to
  the object-storage snapshot + durable-state stores.  Out-of-range values
  are clamped; the level is encoder-only and is NOT written to the wire
  (the ATS1 manifest records only the algorithm), so changing it needs no
  migration — old bodies keep decoding, new bodies use the new level, and
  the two mix freely in one bucket.
- **Real-network multi-node integration tests** (#313) — new
  `tests/integration/` subtree with a Docker-compose setup that
  brings up 5 cluster-node containers + 1 controller container
  on a shared bridge network and runs partition / heal /
  membership-convergence scenarios over a real TCP stack.  All
  fault injection happens inside each container's network
  namespace via `iptables` + `tc netem`, so no host privileged
  mode is required — just `NET_ADMIN` on each cluster-node
  container.  Two npm scripts ship: `bun run test:integration`
  (build + up + auto-exit on the controller's status) and
  `bun run test:integration:teardown`.  The same command works
  locally on Docker Desktop and in
  `.github/workflows/integration.yml`; the workflow is
  triggered by pushes to `main`, manual dispatch, and a nightly
  schedule.  Fifteen scenarios covering the cluster's load-bearing
  primitives:
  - **01** — membership convergence (smoke test)
  - **02** — 2:3 split-brain with partition + heal verification
  - **03** — Receptionist gossip-convergence over a shared
    `ServiceKey` across all 5 nodes, with partition + heal
  - **04** — DistributedData `LWWRegister` quorum reads/writes
    during a 50ms `tc-netem` egress latency storm — proves
    `majority`-consistency operations survive a real network
    slowdown
  - **05** — Cluster Singleton failover after the host node
    `cluster.leave()`s; new leader's manager spawns the
    singleton, proxies from every remaining node converge
  - **06** — Cluster Sharding rebalance: 30 entities warmed up,
    victim node leaves, 8 ex-victim entities relocate to
    surviving regions via the coordinator's HandOff path
  - **07** — Concurrent `GCounter` increments from all 5 nodes
    converge to the exact expected total (proves CRDT merge +
    `ddata-gossip` wire path under write pressure)
  - **08** — Receptionist `Subscribe` continuous-listing
    notifications fire on register / deregister, observable
    from every cluster node within gossip-propagation latency
  - **09** — External `ClusterClient` (NOT a cluster member)
    makes 100 sequential asks against `/user/echo`; exercises
    the #120 `randomUUID` ask-id path end-to-end
  - **10** — Management HTTP auth end-to-end: 401 without
    token, 200 with valid token, 404 with valid token + fake
    address, /health stays anonymous (probe contract)
  - **11** — `PersistentActor` event-sourcing + snapshot +
    replay: 5 increments → snapshot at seq=3 → kill → respawn
    triggers `recover()` → snapshot-load + replay restores
    state.  Two-kill cycle verifies determinism.
  - **12** — `DistributedPubSub` topic fan-out: 15 events
    published from two different nodes, all 5 subscribers
    receive both bursts in order
  - **13** — `CoordinatedShutdown` pipeline progresses through
    early (`BeforeServiceUnbind`) + late
    (`BeforeActorSystemTerminate`) phases on a victim node;
    markers POST'd to a peer observer verify both fired in
    chronological order
  - **14** — Bounded mailbox + `actor_mailbox_dropped_total`
    metric: bombard a slow actor with 15 000 messages, verify
    ~5 000 drops are counted in the Prometheus output with
    correct `{class, path, reason}` labels
  - **15** — `DnsSeedProvider` against docker's embedded DNS:
    resolves every peer hostname, validates IPv4 shape and
    `<systemName>@<host>:<port>` stamping
- **Backend `remoteAddress` wiring** (#312 follow-up) — the
  Fastify, Express, and Hono backends now populate
  `HttpRequest.remoteAddress` from the socket peer
  (`req.ip` / `req.socket.remoteAddress` on Fastify+Express;
  best-effort across `c.req.raw` / `c.env.requestIP` on Hono).
  `IpAllowlist` works end-to-end on real socket peers — the
  pre-existing `getClientIp` override is no longer required for
  default deployments behind direct connections.
- **HTTP route middleware framework** (#312) — new
  `withMiddleware(mw, route)` builder + `Middleware` type
  `(req, next) => Promise<HttpResponse> | HttpResponse`.  Middlewares
  compose outside-in; nested wraps run in declaration order.  The
  HTTP cache primitives (`rateLimit`, `idempotent`, `cached`) are
  unchanged, but new orthogonal concerns (auth, allowlists, custom
  logging, request tracing) can hang off the same hook.
- **`BearerTokenAuth({ tokens })`** (#312) — built-in middleware
  that 401s every request lacking a `Authorization: Bearer <token>`
  header from the configured (rotatable) shared-secret list.
  Constant-time comparison so an attacker probing tokens can't
  distinguish "first character wrong" from "last character wrong"
  by timing.  Rejection includes `WWW-Authenticate: Bearer realm=...`.
- **`IpAllowlist({ allow })`** (#312) — built-in middleware for
  CIDR-based network-level isolation.  Parses IPv4 + IPv6 CIDRs
  (including IPv4-mapped IPv6 like `::ffff:10.0.0.1` so a dual-
  stack socket peer matches an IPv4 CIDR).  Fail-secure: no
  resolvable client IP means 403.  Trust-source is explicit:
  default reads `req.remoteAddress` (the socket peer); operators
  behind a trusted proxy must opt-in to header trust via the
  `getClientIp` extractor.
- **`HttpRequest.remoteAddress?: string`** (#312) — optional new
  field on the request shape.  Backends should populate from the
  underlying socket where available.  Consumers that need to
  trust `x-forwarded-for` must do so explicitly (see
  `IpAllowlist`'s `getClientIp`).
- **`managementRoutes`** gains `auth`, `ipAllowlist`, and
  `authProtectHealth` settings (#312).  By default the auth
  middleware wraps the privileged subtree (`/cluster/*`,
  `/metrics`) but leaves `/health` and `/ready` anonymous —
  standard Kubernetes liveness/readiness probes can't easily
  attach an Authorization header.  Set `authProtectHealth: true`
  when the deployment can present credentials on probes.  The
  IP-allowlist wraps EVERYTHING (network-level isolation
  precedes any application policy).
- **`JsonLogger`** (#311) — structured-logging logger that emits one
  `\n`-delimited JSON object per record to `process.stdout` (or an
  injected `JsonLogSink`).  Every record carries `ts` (ISO-8601),
  `level`, optional `source`, `msg`, the merged static + dynamic
  MDC, and positional `...args` under an `args` array.  Errors
  serialise as `{ name, message, stack }`; circular refs,
  `BigInt`, and functions are sanitised so a log call never throws.
  Drop-in for log-aggregation pipelines (Loki, ELK, Datadog,
  CloudWatch, etc.) via the standard stdout-pipe path.
- **`otelLogger({ api })`** (#311) — bridge to
  `@opentelemetry/api-logs` for OTLP-Logs pipelines.  Optional peer
  dep (structural-typed on the OTel surface, like `otelTracer`).
  Maps severity to OTel's standard severity-number range, attaches
  the actor's path on `source`, merges static + dynamic MDC into
  `attributes`, and the SDK auto-links the active span's
  `traceId`/`spanId` when tracing is enabled in the same process.

### Changed — Bounded mailbox default

- **Bounded mailbox is now the default** (#310) — every actor spawned
  without an explicit `Props.withMailbox(...)` gets a
  `BoundedMailbox` with `capacity = 10_000` and `overflow = 'drop-head'`.
  The pre-#310 unbounded shape was a classic Akka-anti-pattern in
  disguise: a runaway producer could absorb the JVM, ahem, the V8
  heap, until OOM.  10 000 is high enough that a well-tuned actor
  never hits it on a normal traffic spike; if it does, the actor's
  throughput is mismatched and the bound makes that operationally
  visible.  Drops are emitted as the `actor_mailbox_dropped_total`
  Counter (labels `class`, `path`, `reason`).  Opt back into unbounded
  per-actor via `Props.withMailbox(() => new Mailbox())`; keep the
  bounded shape but change the capacity via `Props.withMailboxCapacity(n)`.

### Fixed — Compression

- **zstd compression on runtimes without native zstd** (#321) — the
  compression codec wired the `fzstd` peer-dependency as a compressor, but
  `fzstd` is decompression-only (it has no `compress`), so
  `compression: { algorithm: 'zstd' }` threw `fzstd.compress is not a
  function` on any runtime without native zstd (i.e. not Bun and not
  Node ≥22.15) — and the eager peer-dep probe passed anyway.  zstd
  resolution is now split by direction: compress is native-only with a
  clear "needs Bun / Node ≥22.15" error, decompress keeps the `fzstd`
  fallback so a non-native runtime can still READ zstd bodies written
  elsewhere, and `probeCompressionAvailability('zstd')` now checks the
  compress path so the misconfig surfaces at plugin-init, not on first
  persist.
- **Object-storage compression docs were inaccurate** — the docs
  described `gzip` / `brotli` / `deflate` with a `level` field and
  `Content-Encoding`-header-driven decode, none of which matched the
  implementation.  Corrected across EN + DE to the real `none` / `gzip` /
  `zstd` set, the ATS1-manifest-driven decode, the now-real `level`
  option, and the per-direction zstd runtime support.

## [0.9.1] — 2026-05-15

Docs-only patch release covering the first round of post-v0.9.0
publish feedback.

### Fixed

- README logo no longer 404s on the npmjs.com package page —
  switched from relative `./docs/public/logo.png` to an absolute
  `raw.githubusercontent.com/pathosDev/actor-ts/main/...` URL.
  Relative paths inside raw `<img>` tags aren't rewritten by
  npm's README renderer, only Markdown image syntax is.
- README license badge link similarly switched to an absolute
  `github.com/.../LICENSE` URL.
- README "## License" section text — said "MIT" left over from
  the original metadata-only declaration; corrected to
  "Apache 2.0" matching the v0.9.0 relicense.
- Sub-package READMEs (`benchmarks/`, `examples/chat/`,
  `examples/voice/`) referenced a non-existent `assets/logo.svg`
  path (the `assets/` folder never existed in this layout).
  Switched to the same absolute
  `raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.svg`
  URL the root README now uses — consistent across every README
  and robust under any rendering target (GitHub, npm, mirrored
  forks).

## [0.9.0] — 2026-05-14

The "public-launch readiness" release.  Six workstreams accumulated
since v0.8.0 (142 commits total): the docs site goes live at
`actor-ts.dev` with 199+ pages and full German translation; a wave
of API shortcuts collapses the clustered-actor setup from 15–30
lines to a single `Cluster.bootstrap({ name })`; eight latent
security weaknesses get patched; a code-quality sprint closes 17
audit-catalog issues; the chat sample grows DMs / typing /
read-receipts / production-grade auth.

### Added — Quality-of-life API shortcuts

- `Cluster.bootstrap({ name })` — one-call setup that builds the
  `ActorSystem`, joins the cluster, starts the Receptionist, and
  wires `SIGTERM` / `SIGINT` shutdown.  Discovery defaults to an
  env-driven chain (`CLUSTER_SEEDS` → Kubernetes API → DNS) via
  the new `autoDiscovery()` builder so the same code runs
  single-node in dev and joins an existing cluster in production
  without a config change.
- `cluster.sharding` getter on `Cluster` — replaces the
  `ClusterSharding.get(system, cluster)` ceremony.  The static
  form still works for callers that need to reference the class
  from outside a `Cluster` handle.
- `ClusterSharding.start('cart', CartActor, { extractEntityId })`
  — class-shorthand overload that wraps the entity in
  `Props.create(() => new CartActor())` internally.  Factory form
  also accepted (`() => new CartActor(deps)`); full-form
  `start({ typeName, entityProps, ... })` stays valid.
- `ref.ask<TRes>(msg, timeoutMs?)` — method form of the ask
  pattern.  Auto-injects `replyTo: ref` on the message so
  recipients can read either `this.sender` or `msg.replyTo`
  without callers supplying it.  `OmitReplyTo<TMsg>` distributes
  across unions so the call site never has to satisfy the
  `replyTo` field.
- `system.spawnTyped(behavior, name)` +
  `system.spawnTypedAnonymous(behavior)` — method form symmetric
  to `spawn` / `spawnAnonymous`.  Same pair on `ActorContext` for
  typed-child creation from untyped parents.
- `system.http(port, { host?, backend? })` — Fastify-default HTTP
  shortcut.  Returns the same `ServerBuilder` as the explicit
  `system.extension(HttpExtensionId).newServerAt(...)` chain.
- `ActorSystem.create('app', { persistence: { journal,
  snapshotStore } })` — wire real persistence backends at creation
  time.  Either slot is independent; the in-memory default stays
  in place for the omitted slot.

### Removed — replaced by method forms

- Free function `ask(ref, msg, timeoutMs?)` — use
  `ref.ask<TRes>(msg, timeoutMs?)`.  Pre-1.0, no compat shim.
- Free functions `spawnTyped(system, behavior, name?)` and
  `spawnTypedChild(ctx, behavior, name?)` — use
  `system.spawnTyped(...)` / `ctx.spawnTyped(...)` (with
  anonymous variants).  Internal `Ask.ts` and
  `internal/PromiseActorRef.ts` modules deleted; ask impl
  inlined into `ActorRef.ts`.

### Security

Eight latent weaknesses patched.  All defenses are at the
deserialisation / boundary layer with regression tests pinning
both the attack vector and the legitimate path.

- **Wire-frame size cap** — `cluster/protocol` rejects frames
  claiming gigabyte+ lengths before allocation; defeats a
  4-GiB-claim memory-exhaustion DoS.  Configurable; `Infinity`
  cap remains the escape hatch.
- **Path-traversal block in `FilesystemObjectStorageBackend`** —
  keys containing `..` or absolute-path patterns rejected at the
  boundary instead of being resolved through to disk.
- **Memcached protocol injection** — `MemcachedCache` keys
  validated against the 250-byte / printable-ASCII rule before
  being placed on the wire; defeats injection via attacker-
  controlled keys.
- **Gossip-version cap against permanent-down exploit** —
  versions more than 24 h above the local wall-clock are
  rejected on the spot; previously a malicious peer could send
  `version: MAX_SAFE_INTEGER` to pin a healed node as `down`
  forever.
- **Snapshot-seq validation on recovery** — `PersistentActor`
  rejects snapshots whose `seqNr` is non-monotonic with the
  journal; defeats tampered-snapshot replay.
- **WebSocket inbound frame size cap** — `WebSocketActor`
  rejects oversized inbound frames before assembly; defeats
  memory-exhaustion DoS via fragmented frames.
- **Duplicate-identity hello rejection** — `cluster/transport`
  refuses a second hello frame claiming an already-connected
  identity; defeats peer-hijack where an attacker rebinds to a
  victim's `from` address.  Legitimate reconnect (after clean
  close) unaffected.
- **Idempotency-key cache binding** — `http/cache/idempotency`
  ties each cached response to the request fingerprint (method
  + path + body hash) so a poisoned key can't replay one
  response across different requests.

### Documentation

- **Public website at [actor-ts.dev](https://actor-ts.dev)** —
  Astro Starlight site under `docs/`, 199+ pages across the
  12-Part IA, full Quickstart + fundamentals + per-subsystem
  deep-dives + migration guides + API reference (TypeDoc).
- **Full German translation** — every page mirrored under
  `/de/`.  Seven additional UI locales (fr, es, ja, ko, pt-BR,
  ru, zh-CN) staged with sidebar labels translated; full content
  translations tracked as #300–#306.
- **Mermaid diagrams throughout** — replaces ASCII art across
  all subsystem pages (cluster, sharding, distributed-data,
  persistence, observability, operations, testing, IO, delivery).
- **Landing-page polish** — animated particle-network hero,
  prose-driven "What is actor-ts" cards, See-it-in-action status
  grid, custom-domain redirect, mobile-responsive splash.
- **Issue templates** — `.github/ISSUE_TEMPLATE/` gains
  `security_report.yml`; bug template gets a security-flag
  checkbox.
- `decodeCrdt` (`src/crdt/DistributedData.ts`) annotated as the
  codebase's reference shape for discriminator-union dispatch,
  with explicit notes on what makes the existing
  `const _exhaustive: never = json` pattern safe and when to
  prefer it vs `match().exhaustive()` (#231).

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

### Chat sample feature sweep

Five "Chat sample: …" follow-up issues resolved across five
commits.  Four shipped as features, one closed-not-implement, one
sub-feature spun off as its own focused issue.

- **User-created rooms at runtime** (#98) — new
  `ChatRoomDirectoryActor` wraps a cluster-wide `DistributedData`
  ORSet of room names.  `DEFAULT_ROOMS` becomes the idempotent seed
  list; the actor fans out `RoomsChanged` / `RoomAdded` /
  `RoomRemoved` events to per-session subscribers.  Protocol gains
  `create-room` (client → server) plus `room-added` / `room-removed`
  (server → client).  Six frontends grow a "+ new room" input.
- **Private direct messages** (#100) — DMs ride on existing
  protocol frames as virtual `@<username>` "rooms".  Server
  distinguishes by the leading `@` and routes through a sharded
  `DmChannelActor` keyed on the canonical pair-id
  (`canonicalPairId('alice', 'bob') === 'alice|bob'` regardless of
  ordering).  Each user subscribes once at login to their inbox
  topic `chat.dm.user.<self>` — single subscription covers every
  DM conversation.  Six frontends: click any user in the Online
  panel to open a DM.
- **Typing indicators** (#103 slice 1) — `{ type: 'typing', room }`
  fan-outs via the room's existing PubSub topic as an ephemeral
  `TypingBroadcast`; server filters self-echoes; clients debounce
  outbound at 1/2 s and auto-clear stale indicators after 3 s.
- **Read receipts** (#103 slice 2) — per-room
  `read-up-to.<room>` `DistributedData` LWWMap mapping username →
  highest acked message timestamp.  New `ReadReceiptsActor` enforces
  a monotonic guard at the boundary (LWW's wall-clock tiebreak
  doesn't know read pointers can't go backwards).  Frontends render
  ✓ / ✓✓ on own messages.
- **Emoji passthrough** (#103 slice 1, doc-only) — server is
  text-agnostic; any frontend can wire an `emoji-mart` /
  `<emoji-picker-element>` / native picker on top without server
  changes.  Documented in the chat README; no code shipped.
- **Production-realistic auth** (#99, Option A) — passwords stored
  as `<salt>:<hash>` scrypt records (`crypto.scryptSync`,
  N=16384/r=8/p=1, constant-time verify via
  `crypto.timingSafeEqual`).  Session tokens become HMAC-SHA256-
  signed JWT-style strings; `lookupToken` self-validates without a
  DD read.  DD-LWWMap shrinks to a revocation-only set
  (`chat.session-revocations`).  Server secret comes from
  `CHAT_TOKEN_SECRET` env (warned-and-fallback otherwise).
- **#104 (mobile frontends)** — closed-not-implement.  Six web
  frontends already cover the "protocol works anywhere" story;
  adding React Native + Flutter is two more app-frameworks to
  maintain for marginal sample-value gain.  Rationale in the issue
  closing comment.
- **#292 (file uploads)** — spun off as its own focused issue
  because object-storage wiring is qualitatively different from
  the other UI-polish items.  Not blocking the rest of the sweep.

Chat-sample smoke-test grows from passes 1–2 to **passes 1–7**,
covering: login + send + history (1–2), user-created rooms (3),
direct messages (4), typing indicators (5), read receipts including
a monotonic-guard probe (6), and auth hardening — wrong password,
valid resume, revoked-token resume rejection, tampered-token resume
rejection (7).

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
  terminal.  Refuses to down `selfAddress` — that's `leave()`'s
  job (#56).

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
  one `protocol.ts` over the wire (#94, #95, #96, #97).
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
