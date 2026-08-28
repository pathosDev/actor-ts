# Broker live-integration suites

The `tests/unit/` suites cover the framework's broker adapters
(`S3ObjectStorageBackend`, `MqttActor`, `KafkaActor`, …) against
hand-rolled fakes — no real broker on the test runner.  That's the
right shape for fast feedback but it leaves three classes of bugs
uncovered:

- **Protocol-level corners** — quoting, escaping, header
  serialisation that differs between our spec-reading and what the
  real broker accepts.
- **Auth / connection bring-up** — credentials format, TLS, lazy
  reconnect after a transient drop.
- **Operational shape** — broker config that our code assumed
  exists but isn't on by default (Mosquitto's `allow_anonymous`,
  RabbitMQ's `definitions.json` import).

Each suite here brings up the corresponding broker in Docker and
runs scenarios against the live socket.  Same pattern as #313's
cluster integration setup; just one container per suite instead of
a 5-node mesh.

## Layout

```
tests/integration/brokers/
├── lib/
│   ├── WaitForPort.ts            # TCP/HTTP readiness probe
│   ├── Scenario.ts               # tiny scenario runner + waitFor
│   ├── PersistenceContract.ts    # shared journal/snapshot/durable-state contract
│   ├── PgWireRunner.ts           # runs the Postgres stores against a pg-wire server
│   └── persistence-contract/     # the contract's per-store scenario modules
├── package.json                  # test-only dep manifest, see below
├── README.md                     # ← this file
├── s3/                           # B.2 — MinIO (Closes #20, refs #297)
├── mqtt/                         # B.3 — Mosquitto (Closes #21)
├── kafka/                        # B.4 — Redpanda (Closes #22)
├── amqp/                         # B.5 — RabbitMQ (Closes #23)
├── nats/                         # B.6 — NATS (Closes #24)
├── redis-streams/                # B.7 — Redis (refs #296)
├── grpc/                         # B.8 — gRPC (Closes #296)
├── k8s/                          # B.9 — kind (Closes #298)
├── postgres/                     # PostgreSQL (Closes #323)
├── mariadb/                      # MariaDB (Closes #324)
├── libsql/                       # libSQL / sqld (refs #400)
├── mssql/                        # SQL Server 2022 (Closes #399)
├── cockroachdb/                  # CockroachDB — pg wire (Closes #401)
├── yugabytedb/                   # YugabyteDB — pg wire (Closes #401)
├── mongodb/                      # MongoDB (Closes #397)
├── cassandra/                    # Apache Cassandra (Closes #676, refs #1169)
├── dynamodb/                     # DynamoDB Local (Closes #398)
└── email/                        # GreenMail — SMTP + IMAP (refs #1133)
```

## Why a separate `tests/integration/brokers/package.json`?

The runner images don't install from the repo-root `package.json`.
They install from the dedicated `tests/integration/brokers/package.json`
that explicitly declares every adapter peer-dep — plus actor-ts's
own runtime deps (`fastify`, `ts-pattern`) — as regular
`dependencies`.

Same shape an end-user has in their own project: in a fresh
`bun init` directory, the user runs `bun add actor-ts` and then
`bun add @aws-sdk/client-s3` — both are plain `dependencies`,
not peer-deps.  The test image's `bun install` does exactly
that pattern, no `--production`, no peer-dep machinery.

This avoids two bun-specific traps that fire ONLY inside the
actor-ts repo:

1. `bun install --production` skips optional peer-deps entirely.
2. `bun add <pkg>` no-ops when `<pkg>` is already listed in the
   project's `peerDependencies` with `optional: true` — bun
   treats it as "already declared", silently does nothing.

End-users never hit either trap (their package.json doesn't have
our peerDependencies block).  We had to engineer around both
because the integration runners build INSIDE the actor-ts repo.
The test-package.json side-steps the question entirely by being
a fresh manifest with no peer-dep cross-reference.

When a new adapter peer-dep is added to actor-ts (or an existing
range bumps), the test-package.json needs the matching update.
Failure mode is loud: the test runner's first `import` of the
missing package throws "Cannot find module" before any scenario
even starts.

That loud failure only covers peers that HAVE a suite here, though —
a driver with no suite directory is declared in no manifest at all
and nothing says so.  `tests/unit/ci/OptionalPeerDeclarations.test.ts`
is the quiet half: it asserts every optional peer is declared either
in this manifest or in the root `devDependencies`, so the gap is a
failing test rather than a discovery years later (#676).  Which of the
two contexts a given peer belongs in is the rule in AGENTS.md,
*Runtime portability*.

The same guard asserts the reverse, which is what keeps this manifest a
real boundary rather than a convention: nothing in `src/` may name an
optional peer in an import specifier.  A driver that lives only here is
not on the build compile's module path at all, so the library reaches it
through `lazyImportModule(name)` and a hand-written structural type —
`NatsConnectionLike`, `CassandraDriver` — and those stubs stay
hand-written even for a peer that IS installed at the root, because they
are exported and an imported specifier would land in a published `.d.ts`
that a consumer who skipped the optional peer cannot resolve.  Drift in a
stub is caught here, against the live broker, rather than at compile time
in a tree that could not compile it (#676).

`cassandra-driver` is the case where "here" is not a preference but the
only available home, and it is worth knowing before someone tries to
"simplify" it back to a root devDependency.  Its 4.9.0 release hard-pins
`adm-zip: ~0.5.10`, and GHSA-xcpc-8h2w-3j85 (high) is fixed only in 0.6.0
— so a root entry pulls an unfixable high advisory into `bun.lock` and
turns `bun run lint:audit` red.  Because these packages are absent from
the root install by design, declaring it here puts the driver's whole
closure outside the lockfile `bun audit` reads: the gate stays green
because there is nothing there, not because anything was suppressed.  That
is what `cassandra/scenarios/01-driver-shape.ts` buys — the same shape
check `tests/unit/ci/OptionalPeerModuleShapes.test.ts` performs for the
root-manifest peers, in the one place the driver can be installed at all.

Every suite directory has the same three files:

```
<name>/
├── docker-compose.<name>.yml     # service under test + runner service
├── Dockerfile.runner             # runner image, installs from the manifest above
└── Runner.ts                     # entry point, exits 0 / 1
```

Three suites also carry a config file their image needs —
`mqtt/mosquitto.conf`, `amqp/rabbitmq.conf`, `grpc/echo.proto`.

What `Runner.ts` then executes comes in two shapes.

**Own scenarios.**  The nine broker suites — s3, mqtt, kafka, amqp,
nats, redis-streams, grpc, k8s, email — add a `scenarios/` directory,
and the runner imports it and calls `runScenarios()` from
`lib/Scenario.ts`:

```
<name>/
└── scenarios/
    ├── 01-…ts
    └── 02-…ts
```

`cassandra` is the tenth, and it is a persistence backend rather than a
broker — worth saying why it is on this side of the split rather than the
next.  `SqlPersistenceContext` requires three factories, and one of them is
`makeDurableStateStore`; there is no Cassandra durable-state store, so a
context built for the shared contract would have to fail or fake its third
factory and the durable-state scenarios would go red or assert nothing.  Its
four scenarios go at the seams `FakeCassandraClient` cannot reach instead:
the driver's own module shape (see below), the LWT append serializer against
real Paxos, the `events_by_tag` side table including compaction reaching it
(#654), and two stores agreeing on a storage identity over one keyspace
(#1358).

**Shared persistence contract.**  The eight persistence suites —
postgres, mariadb, libsql, mssql, cockroachdb, yugabytedb, mongodb,
dynamodb — have **no** `scenarios/` directory.  They supply three
factories (`makeJournal`, `makeSnapshotStore`, `makeDurableStateStore`)
and run `sqlPersistenceScenarios()` from `lib/PersistenceContract.ts`,
whose cases live in `lib/persistence-contract/` and are shared with the
fast `bun test` pass (#390).  So a backend earns its live coverage by
writing a harness rather than another copy of the tests, and a case
added for one backend is immediately checked against all of them.

The two Postgres-wire certifications are thinner still: `cockroachdb`
and `yugabytedb` hand a description and a port to `runPgWireSuite()`
from `lib/PgWireRunner.ts`, which drives the *unmodified* Postgres
stores against the other server — that is the whole point of those two
(#401).

## Run locally

You need Docker (Desktop on macOS/Windows, Engine on Linux).
Nothing else.  One suite, named by its directory here:

```bash
bun run test:integration:broker s3             # MinIO + S3ObjectStorageBackend
bun run test:integration:broker mqtt           # Mosquitto + MqttActor
bun run test:integration:broker kafka          # Redpanda + KafkaActor
bun run test:integration:broker amqp           # RabbitMQ + AmqpActor
bun run test:integration:broker nats           # NATS + NatsActor
bun run test:integration:broker redis-streams  # Redis + RedisStreamsActor
bun run test:integration:broker grpc           # gRPC echo + GrpcActor
bun run test:integration:broker k8s            # kind + KubernetesApiSeedProvider
bun run test:integration:broker postgres       # PostgreSQL + Postgres{Journal,SnapshotStore,DurableStateStore}
bun run test:integration:broker mariadb        # MariaDB + MariaDb{Journal,SnapshotStore,DurableStateStore}
bun run test:integration:broker libsql         # libSQL (sqld) + LibSql{Journal,SnapshotStore,DurableStateStore}
bun run test:integration:broker mssql          # SQL Server 2022 + MsSql{Journal,SnapshotStore,DurableStateStore}
bun run test:integration:broker cockroachdb    # CockroachDB + the Postgres stores over pg wire
bun run test:integration:broker yugabytedb     # YugabyteDB + the Postgres stores over pg wire
bun run test:integration:broker mongodb        # MongoDB + Mongo{Journal,SnapshotStore,DurableStateStore}
bun run test:integration:broker cassandra      # Cassandra + Cassandra{Journal,Query,SnapshotStore}
bun run test:integration:broker dynamodb       # DynamoDB Local + DynamoDb{Journal,SnapshotStore,DurableStateStore}
bun run test:integration:broker email          # GreenMail (SMTP + IMAP) + EmailBridgeActor
```

The list above is documentation, not configuration.  There used to be a
`package.json` script per line — 34 of them, all the same two `docker compose`
invocations with a different path — so the set of backends was maintained in
four places and missing one meant a suite that silently never ran (#559).
`scripts/integration-compose.mjs` discovers them instead: a suite is a
directory here holding `docker-compose.<dir>.yml`, so adding a backend means
adding a directory.  A wrong name prints the ones that exist.

Tear one down, or dump its logs:

```bash
bun run test:integration:broker:teardown kafka
bun scripts/integration-compose.mjs kafka --logs
```

All of them, and their teardown:

```bash
bun run test:integration:brokers
bun run test:integration:brokers:teardown
```

`up` stops at the first failing suite; teardown deliberately does not, so one
broken suite cannot strand every later suite's containers and volumes.

## CI

`.github/workflows/integration-brokers.yml` runs the broker suites
as a job matrix.  Skipped on PRs touching only docs / unit tests
(same `paths:` filter as `integration.yml`).

## Adding a new broker suite

1. Pick a docker-compose-ready image (`bitnami/<x>`, `eclipse-mosquitto`,
   `vectorized/redpanda`, …).  Prefer images with a `tini`-style
   PID 1 — they exit cleanly on `docker compose down` instead of
   leaking zombies.
2. Create `tests/integration/brokers/<name>/` with the three files
   shown above.  There is **no npm script to add** — `scripts/integration-compose.mjs`
   discovers the suite from the directory, which is the whole point of #559.
3. Add the adapter's peer-dep to `package.json` here, if it has one that no
   other suite already declares.
4. Add the suite to the CI matrix in
   `.github/workflows/integration-brokers.yml`.  Not optional:
   `tests/unit/ci/IntegrationBrokerSuites.test.ts` fails when the matrix and
   the tree disagree in either direction, so a missing leg is a red `bun test`
   rather than a suite that silently never runs.
5. The scenario uses `waitForPort(host, port)` from `lib/WaitForPort.ts`
   to guard against the "container started, broker not ready yet"
   race that's the single most common source of flake.

## Why not testcontainers/node?

The [testcontainers/node](https://github.com/testcontainers/testcontainers-node)
library wraps Docker programmatically and would shave some
boilerplate.  We didn't pick it because:

- **Bun compatibility is best-effort** (the library expects Node's
  `child_process` event ordering).
- The user requirement is "lokal lauffähig wie tests/integration"
  — docker-compose YAML is the universal shape every developer
  already has muscle memory for; pulling a Node-only library on
  top is friction.
- The compose files are short (~20 lines each) — the abstraction
  cost outweighs the boilerplate savings.

If we end up wanting per-test container lifecycle (each `it()`
gets a fresh broker), we can revisit; the current per-SUITE
lifecycle works fine for the scenario count we have.
