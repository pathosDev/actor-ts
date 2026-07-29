# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a pre-1.0 hobby project — every minor version is potentially
breaking.  See `ROADMAP.md` for what's coming, and `README.md` →
"What is this?" for current scope honesty.

## [Unreleased]

### Added

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
  protocol level.  *Caveat:* on these backends a route that raises
  `maxFrameBytes` above the default is currently still capped at the default by
  the transport; a per-route / configurable transport cap and the Hono
  runner-level cap are tracked follow-ups.
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
