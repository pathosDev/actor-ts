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
│   ├── wait-for-port.ts          # TCP/HTTP readiness probe
│   └── scenario.ts               # tiny scenario runner + waitFor
├── README.md                     # ← this file
├── s3/                           # B.2 — MinIO (Closes #20, refs #297)
├── mqtt/                         # B.3 — Mosquitto (Closes #21)
├── kafka/                        # B.4 — Redpanda (Closes #22)
├── amqp/                         # B.5 — RabbitMQ (Closes #23)
├── nats/                         # B.6 — NATS (Closes #24)
├── redis-streams/                # B.7 — Redis (refs #296)
├── grpc/                         # B.8 — gRPC (Closes #296)
└── k8s/                          # B.9 — kind (Closes #298)
```

Every suite directory follows the same shape:

```
<broker>/
├── docker-compose.<broker>.yml   # broker service + runner service
├── runner.ts                     # imports scenarios/*, calls runScenarios()
└── scenarios/
    ├── 01-…ts
    └── 02-…ts
```

## Run locally

You need Docker (Desktop on macOS/Windows, Engine on Linux).
Nothing else.  Per-suite:

```bash
bun run test:integration:s3        # MinIO + S3ObjectStorageBackend
bun run test:integration:mqtt      # Mosquitto + MqttActor
bun run test:integration:kafka     # Redpanda + KafkaActor
bun run test:integration:amqp      # RabbitMQ + AmqpActor
bun run test:integration:nats      # NATS + NatsActor
bun run test:integration:redis     # Redis + RedisStreamsActor
bun run test:integration:grpc      # gRPC echo + GrpcActor
bun run test:integration:k8s       # kind + KubernetesApiSeedProvider
```

All of them:

```bash
bun run test:integration:brokers
```

Tear down (volumes, networks):

```bash
bun run test:integration:brokers:teardown
```

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
   shown above.
3. Add the npm script to `package.json` — copy an existing one,
   swap the compose-file name.
4. (Optional) Add the suite to the CI matrix in
   `.github/workflows/integration-brokers.yml`.
5. The scenario uses `waitForPort(host, port)` from `lib/wait-for-port.ts`
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
