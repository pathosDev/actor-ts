<p align="center">
  <img src="./assets/logo.svg" alt="actor-ts" width="560"/>
</p>

<p align="center">
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml"><img alt="build workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml/badge.svg?branch=main"/></a>
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml"><img alt="tests workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml/badge.svg?branch=main"/></a>
  <a href="#"><img alt="tests" src="https://img.shields.io/badge/tests-1666%20of%201666-22c55e?style=flat-square&logo=bun"/></a>
  <a href="#"><img alt="coverage" src="https://img.shields.io/badge/coverage-~85%25-22c55e?style=flat-square"/></a>
</p>

<p align="center">
  <a href="#"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.4+-3178c6?style=flat-square&logo=typescript&logoColor=white"/></a>
  <a href="#"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.1-f7bf88?style=flat-square&logo=bun&logoColor=white"/></a>
  <a href="#"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white"/></a>
  <a href="#"><img alt="deno" src="https://img.shields.io/badge/deno-%3E%3D2.0-000000?style=flat-square&logo=deno&logoColor=white"/></a>
</p>

<p align="center">
  <a href="#"><img alt="license" src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square"/></a>
  <a href="#"><img alt="status" src="https://img.shields.io/badge/status-experimental-f59e0b?style=flat-square"/></a>
</p>

---

> ⚠️ **Disclaimer — please read before using.**
> This is a **complex, AI-assisted hobby project** — a from-scratch port of
> the actor-model stack (actors, supervision, cluster, sharding, persistence,
> HTTP) to TypeScript, running on Bun, Node.js, and Deno.  Large parts were
> written with AI pair-programming and **have not been battle-tested in
> production**.  Test coverage is good (~1666 tests, ~85 % line) but the
> surface area is enormous.  **Do not deploy this to anything that matters
> yet.**  Use it to learn, to prototype, to benchmark ideas — not to handle
> real money, users, or data.

---

## What is this?

`actor-ts` is a **batteries-included actor-model runtime** for TypeScript.  It
gives you the same mental model you'd get in Erlang or Scala/Akka — messages,
mailboxes, supervisors, location-transparent refs — on the modern TypeScript
type system, running natively on **Bun**, **Node.js 20+**, and **Deno 2+**.

Runtime-specific backends (TCP sockets, Web Workers, SQLite, Bun.serve /
@hono/node-server / Deno.serve) live behind small abstractions in
[`src/runtime/`](./src/runtime/) and are auto-detected at startup — you write
the same application code regardless of where it runs.

Inside one process:

- **actors** with single-threaded per-mailbox processing, lifecycle hooks,
  stash, timers, become/unbecome
- **supervision** (one-for-one / all-for-one, restart / resume / stop / escalate)
- **ask** + **pipeTo** + **after** + **retry** + **circuit breaker** patterns
- **typed `Behaviors` DSL** as a functional facade over the OO API
- **routers** (round-robin / random / broadcast) with pool semantics
- **bounded + priority mailboxes**, FSM DSL
- **TestKit** with `TestProbe` + `ManualScheduler` for deterministic tests

Across a cluster:

- **gossip-based membership** with leader election, roles, seed retries,
  weakly-up transitions
- **failure detection** — simple time-threshold + full **φ-accrual** detector
- **cluster sharding** — coordinator, hand-off, passivation, remember-entities,
  hash + least-shard allocation
- **distributed pub-sub**, **cluster singleton**, **sharded daemon process**,
  **receptionist** (service-key discovery), **reliable delivery** (at-least-once)
- **split-brain resolvers** (keep-majority / keep-oldest / static-quorum /
  keep-referee)
- **pluggable transports** — TCP, in-memory, worker-threads (`MessageChannelTransport`)
  for multi-core scaling
- **seed providers** — config / DNS / Kubernetes API / aggregate

Plus the things an actual web-service needs:

- **HTTP** — directives-style routing DSL, Fastify default + optional Express
  and Hono backends, pluggable via a tiny `HttpServerBackend` interface.
  Hono auto-picks the right serve primitive per runtime (`Bun.serve`,
  `@hono/node-server`, `Deno.serve`).
- **Event Sourcing + Durable State** — `PersistentActor`, snapshots, in-memory
  / SQLite / Cassandra / ScyllaDB journals.  SQLite uses `bun:sqlite` on Bun
  and `better-sqlite3` on Node via a single `SqliteDriver` abstraction.
- **Object-storage persistence** — snapshots and DurableState in S3 / MinIO /
  R2 / a local directory, with optional gzip or zstd compression and
  client-side AES-256-GCM encryption (per-tenant subkeys via HKDF).
- **Caching** — pluggable `Cache` abstraction with in-memory, Redis, and
  Memcached backends.  Wires HTTP response caching, rate-limiting, and
  idempotency-key dedup; an optional `CachedSnapshotStore` decorator
  speeds up sharded-actor cold-starts.
- **Message-broker actors** — single `BrokerActor` base + 9 concrete
  actors: `TcpSocketActor`, `UdpSocketActor`, `MqttActor`,
  `WebSocketActor`, `KafkaActor`, `AmqpActor`, `GrpcClientActor` /
  `GrpcServerActor`, `NatsActor`, `RedisStreamsActor`, `SseActor`.
  Reconnect-with-backoff, outbound buffer, subscriber fan-out, and
  per-actor settings (Aktor + HOCON + defaults) are baked into the base.
- **HOCON configuration** with ENV substitution and code overrides
- **coordinated shutdown** (12-phase, SIGTERM-aware, K8s-PreStop-friendly)
- **Kubernetes** leases + management HTTP endpoints (`/health`, `/ready`,
  `/cluster/members`, `/cluster/leader`, `/cluster/shards`, opt-in
  `/cluster/leave`, `/cluster/down`, `/metrics`)
- **serialization** — pluggable, JSON + CBOR built-in

And the language-level niceties you expect in 2026:

- `Option<T>` (`Some<T>` / `None`) with the full Scala-style API —
  `map` / `flatMap` / `filter` / `filterNot` / `exists` / `forall` / `contains` /
  `fold` / `orElse` / `forEach` / `toArray` / `getOrElse` / `toNullable`
- pattern matching via [`ts-pattern`](https://github.com/gvergnaud/ts-pattern) —
  `match(msg).with({ kind: 'ping' }, …).exhaustive()` everywhere it replaces
  a `switch`

---

## Integrations

External services and libraries the framework can plug into.  Each row
is a **peer dependency** — install only what you actually use; nothing
is pulled in until the relevant plugin runs.

| Category | Integrations | Package(s) |
| --- | --- | --- |
| **HTTP server** | Fastify *(default)*, Express, Hono | `fastify`, `express`, `hono` (+ `@hono/node-server` on Node) |
| **Event journal / snapshots** | SQLite, Cassandra / ScyllaDB | `better-sqlite3` (Node), `cassandra-driver` |
| **Object storage** | AWS S3, MinIO, Cloudflare R2, Backblaze B2 | `@aws-sdk/client-s3` |
| **Cache** | Redis, Memcached | `ioredis`, `memjs` |
| **Message brokers** | MQTT, WebSocket, Kafka, AMQP / RabbitMQ, gRPC, NATS | `mqtt`, `ws`, `kafkajs`, `amqplib`, `@grpc/grpc-js` + `@grpc/proto-loader`, `nats` |
| **Discovery** | Kubernetes API | `@kubernetes/client-node` |
| **Compression** (object-storage) | zstd (when no native runtime support) | `fzstd` |

Built-in alternatives ship for every category — in-memory caches and
journals, filesystem object-storage, DNS / config discovery, gzip
compression, AES-256-GCM encryption via WebCrypto, JSON / CBOR
serialization — so you can prototype without any peer-dep at all.

Any of the integrations can be swapped for a hand-rolled client by
passing one to the relevant constructor (`RedisCache({ client })`,
`S3ObjectStorageBackend({ client })`, …) — useful for tests, custom
middleware, or in-house clients.

---

## What's in here / What isn't

### What's actually battle-ready

- Nothing.  This is an experimental hobby project (~1666 tests, ~85 % line coverage).

### What's solid in tests, but not production-tested

- Actor core, supervision, mailboxes, typed Behaviors, TestKit
- Cluster gossip + membership + sharding (single + multi-node test scenarios)
- Cluster-aware router (role filter + consistent hashing)
- Persistence (in-memory + SQLite); CassandraSnapshotStore tested against a fake CQL client only
- HTTP DSL + Fastify backend
- Caching (InMemoryCache); RedisCache tested against a mock client
- Schema-migration round-trips, in-process schema registry, master-key rotation
- Object-storage with FilesystemBackend; S3Backend tested against a fake SDK + optional MinIO
- Observability: structured logging / MDC propagation, Prometheus exposition, OpenTelemetry-style tracing across actor + cluster hops
- Persistent FSM, BackoffSupervisor, CRDT family (G/PN counters, G/OR sets, LWW/MV registers, OR/LWW maps, GCounterMap)
- Server-side WebSocket via Bun.serve / Fastify-websocket adapters
- Kafka manual-commit (exactly-once-with-processing) + NATS JetStream durable streams (push + pull consumer)

### What's there but skipped in CI

- S3 / MinIO live-integration tests (env-var-gated, ~9 tests)
- Phase 2 broker actors (Kafka / AMQP / gRPC) — peer deps not installed by default

### What's NOT here

- gRPC reflection / health-service auto-registration
- A documentation site (README is the source of truth)
- Indexed `eventsByTag` for `CassandraJournal` — InMemory + SQLite use
  a tag side-table; Cassandra currently falls back to a client-side
  journal scan.  Side-table is tracked under #44.
- Backwards-compatibility guarantees of any kind — pre-1.0

See [`ROADMAP.md`](./ROADMAP.md) for what's coming next and what's
explicitly out of scope, and [`CHANGELOG.md`](./CHANGELOG.md) for
what landed in the most recent release.

Spotted a bug or want to suggest a feature?  Open an issue via the
[issue tracker](https://github.com/pathosDev/actor-ts/issues/new/choose)
— the templates pre-fill the right labels and prompt for the
context the project needs to act.  This is a personal hobby
project; **pull requests are not accepted**, but well-shaped
issues are how features get prioritised.

---

## Quick start

Install with the package manager for your runtime — pick **one**:

**Bun**

```bash
bun add actor-ts
```

**Node.js 20+**

```bash
npm install actor-ts
# optional — only if you use the Hono HTTP backend or SQLite persistence:
npm install @hono/node-server better-sqlite3
```

**Deno 2+** — no install step; import from npm directly:

```ts
import { Actor, ActorSystem, Props } from 'npm:actor-ts';
```

Run with `--allow-net` (for TCP transport) and `--allow-read` (for
reading TLS certs from disk) as needed.

```ts
import { Actor, ActorSystem, Props } from 'actor-ts';

class Greeter extends Actor<string> {
  override onReceive(name: string): void {
    console.log(`hello, ${name}!`);
  }
}

const system = ActorSystem.create('hello');
const ref    = system.actorOf(Props.create(() => new Greeter()), 'greeter');

ref.tell('world');

await new Promise(r => setTimeout(r, 20));
await system.terminate();
```

The same file runs unchanged under `bun run`, `node` and `deno run`.

## Ask pattern & Option

```ts
import { Actor, ActorSystem, Props, ask } from 'actor-ts';

type Cmd = { kind: 'add'; n: number } | { kind: 'get' };

class Counter extends Actor<Cmd> {
  private total = 0;
  override onReceive(cmd: Cmd): void {
    if (cmd.kind === 'add') this.total += cmd.n;
    else this.sender.forEach(s => s.tell(this.total));   // Option<ActorRef>
  }
}

const system = ActorSystem.create('counter');
const ref    = system.actorOf(Props.create(() => new Counter()));

ref.tell({ kind: 'add', n: 3 });
ref.tell({ kind: 'add', n: 4 });
const total = await ask<Cmd, number>(ref, { kind: 'get' }, 500);
console.log(total); // 7
```

## Pattern matching

```ts
import { match, P } from 'ts-pattern';

override onReceive(cmd: Cmd): void {
  match(cmd)
    .with({ kind: 'add' }, (c) => { this.total += c.n; })
    .with({ kind: 'get' }, () => this.sender.forEach(s => s.tell(this.total)))
    .exhaustive();
}
```

## Cluster

```ts
import { ActorSystem, Cluster } from 'actor-ts';

const sys     = ActorSystem.create('chat');
const cluster = await Cluster.join(sys, {
  host: '0.0.0.0',
  port: 2552,
  seeds: ['chat@node-a:2552', 'chat@node-b:2552'],
});

cluster.subscribe(evt => console.log('cluster →', evt));
console.log('leader is', cluster.leader().fold(() => '<none>', m => m.address.toString()));
```

`MemberRemoved` fires on two paths.  A **definitive removal**
(graceful `leave`, downing-provider force-down) keeps the address
in the local map as a **tombstone** with a `removedAt` timestamp so
late-arriving gossip can't resurrect it; the tombstone is reclaimed
after `tombstoneTtlMs` (default 24 h).  An **FD-driven removal**
(failure-detector cascade) deletes the entry outright so a healed
partition can re-discover the peer.  Public APIs (`getMembers`,
`upMembers`, `reachableMembers`) already filter `removed` entries,
so most code stays unaffected — only direct iteration of the raw
membership view needs to skip them explicitly.

### Outside-in: `ClusterClient`

A small handle for processes that are NOT cluster members but need
to talk to actors on one — REST frontends, batch jobs, operator
scripts.  Opens a single persistent TCP connection to one of the
listed contact-points and exchanges framed wire-messages with the
`ClusterClientReceptionist` extension running on the cluster side.

```ts
// On every cluster node that should accept client traffic:
sys.extension(ClusterClientReceptionistId).start(cluster);

// From an external process (or a separate ActorSystem):
const client = new ClusterClient({
  contactPoints: ['chat@node-a:2552', 'chat@node-b:2552'],
});

await client.send('user/notifications', { kind: 'flush' });
const reply = await client.ask<{ status: 'ok' }>('user/orders/123',
  { kind: 'getStatus' }, 2_000);
await client.close();
```

Failover: the client tries the contact-points in order; on dial
failure it falls through to the next.  Ask rejects with a clear
error if every contact-point is unreachable, the target path
doesn't exist on the receiving node, or the cluster-side ask
times out.  ActorRef payloads aren't yet rewritten — keep messages
data-only (plain objects + primitives).

### Distributed data — quorum writes / reads

`DistributedData` gossips a key-value store of CRDTs across the
cluster.  The classic `update(key, factory, fn)` and `get(key)` are
fire-and-forget — eventually consistent.  When you need a stronger
guarantee, switch to the async variants with a `WriteConsistency` /
`ReadConsistency` target:

```ts
const dd = sys.extension(DistributedDataId).start(cluster);

// Wait for ⌊N/2⌋+1 replicas (incl. self) to apply before returning.
await dd.updateAsync<GCounter>('hits', GCounter.empty,
  (c) => c.increment(dd.selfReplicaId(), 1),
  { consistency: 'majority' });

// Pull the freshest view by polling a majority of replicas; the
// merged value is also applied locally so the next sync `get` sees it.
const total = await dd.getAsync<GCounter>('hits',
  { consistency: 'majority', timeoutMs: 2_000 });
```

`'local'` is the legacy fire-and-forget behaviour; `'all'` waits
for every up-member; `{ from: K }` clamps to `[1, N]`.  Self always
counts as the first ack, so single-node clusters resolve instantly.
A timeout rejects writes (the local apply still stands — gossip
continues) and resolves reads with the best-available merge.

## Event sourcing

```ts
import { PersistentActor, SqliteJournal, everyNEvents } from 'actor-ts';

class Account extends PersistentActor<Cmd, Event, State> {
  readonly persistenceId = 'acc-alice';
  initialState(): State { return { balance: 0 }; }
  snapshotPolicy = everyNEvents<State, Event>(50);

  onEvent(s: State, e: Event): State {
    return e.kind === 'deposited'
      ? { balance: s.balance + e.amount }
      : { balance: s.balance - e.amount };
  }

  async onCommand(s: State, cmd: Cmd): Promise<void> { /* …persist… */ }
}
```

Swap `SqliteJournal` for `CassandraJournal` (ScyllaDB works too — same CQL
protocol) for multi-node deployments.

The read-side `PersistenceQuery` walks the journal for projections.
`eventsByTag` accepts either a bare tag string or a `TagFilter` object
that combines `all` (intersect), `any` (union), and `not` (exclusion):

```ts
import { SqliteQuery, offsetStart } from 'actor-ts';

const query = new SqliteQuery(journal);

// Single tag — back-compat shorthand for { all: ['type:Order'] }.
for await (const te of query.eventsByTag('type:Order', offsetStart)) { /* … */ }

// Intersect: orders for tenant t1 that aren't archived.
const liveOrders = await query.currentEventsByTag(
  { all: ['type:Order', 'tenant:t1'], not: ['archived'] },
  offsetStart,
);

// Union: any tenant in a set.
const t1OrT2 = await query.currentEventsByTag(
  { any: ['tenant:t1', 'tenant:t2'] },
  offsetStart,
);
```

`InMemoryQuery` and `SqliteQuery` push the filter into the storage
layer (the SQLite path JOINs the indexed tags side-table, with `IN (…)`
for `any` and JS-refines the rest); `CassandraQuery` currently falls
back to a client-side journal scan for any tag query — an indexed
`events_by_tag` side-table for Cassandra is in flight (#44).

## Object-storage persistence (S3 / MinIO / R2 / filesystem)

Snapshots and Durable State can also live in any S3-compatible bucket
— useful when state blobs grow large and you want to take pressure off
the SQL database.  One factory call wires both stores against a shared
backend:

```ts
import {
  ActorSystem,
  PersistenceExtensionId,
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  registerObjectStoragePlugins,
  compressionByPrefix,
  encryptionByPrefix,
} from 'actor-ts';

const sys = ActorSystem.create('app', {
  config: { 'actor-ts': { persistence: {
    'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
  } } },
});

const { durableStateStore } = registerObjectStoragePlugins(
  sys.extension(PersistenceExtensionId),
  {
    backend: { kind: 's3', bucket: 'my-app', region: 'eu-central-1' },
    prefix: 'env-prod/',
    keepN: 5,
    // Pick gzip/zstd/none per persistenceId.
    compression: compressionByPrefix({
      default:   { algorithm: 'gzip' },
      'large/':  { algorithm: 'zstd' },
    }),
    // Per-tenant client-side encryption — derive an HKDF subkey per pid
    // from the master, so a leaked subkey never crosses tenants.
    encryption: encryptionByPrefix({
      default:                 { mode: 'sse-s3' },
      'tenant-acme/':          { mode: 'client-aes256-gcm', masterKey: acmeKey },
      'tenant-bigcorp/':       { mode: 'client-aes256-gcm', masterKey: bigcorpKey },
    }),
  },
);
```

Backends ship for **filesystem** (tests / dev), **S3** (AWS, MinIO,
Cloudflare R2, Backblaze B2 — anything speaking the S3 API), or
**custom** (pass your own `ObjectStorageBackend`).  CAS via S3's
`If-Match` / `If-None-Match` headers makes Durable State race-safe
against concurrent writers.  See
[`examples/persistence/s3-snapshot-bank-account.ts`](examples/persistence/s3-snapshot-bank-account.ts)
for an end-to-end example that runs against a local directory by
default and against MinIO with `ACTOR_TS_S3=minio`.

Compression and encryption can also be set **per actor** — override
`compression()` / `encryption()` directly on `PersistentActor` /
`DurableStateActor` and the actor's choice wins over the plugin
default for both write and read paths.  Useful when only some actors
need the extra cost (e.g. PII actors get client-side AES while the
rest use SSE-S3):

```ts
class PiiActor extends PersistentActor<Cmd, Event, State> {
  override compression() { return { algorithm: 'zstd' as const }; }
  override encryption()  { return {
    mode: 'client-aes256-gcm' as const,
    masterKey: this.tenantKey(),
  }; }
  // ...
}
```

## Schema evolution (event & state migration)

Events and snapshots evolve over time — fields get added, renamed,
restructured.  `actor-ts` mirrors Akka's `EventAdapter` pattern: events
land in the journal as a versioned envelope `{ _v, _t, _e }`; on
recovery, an adapter up-casts older versions to the current shape.

For **purely additive** evolution (new field with a default), use
`defaultsAdapter` — no upcaster code:

```ts
import { defaultsAdapter, PersistentActor } from 'actor-ts';

class Account extends PersistentActor<Cmd, Event, State> {
  override eventAdapter() {
    return defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },   // v1 → v2 added `currency`
    });
  }
  // ...
}
```

For **non-additive** changes (rename, type change, split, merge), use
`MigrationChain` — each step is a typed pure function:

```ts
import { MigrationChain } from 'actor-ts';

const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
  .add({ fromVersion: 1, toVersion: 2,
         upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) })
  .add({ fromVersion: 2, toVersion: 3,
         upcast: (v: DepositedV2): DepositedV3 => ({
           kind: v.kind, cents: Math.round(v.amount * 100), currency: v.currency,
         }) });
```

Snapshots get a parallel `snapshotAdapter()`; `DurableStateActor`
provides `stateAdapter()`.  Strict on read: an adapter on a non-envelope
payload throws `MigrationError` so corrupt recovery is a loud error,
not a silent one.

Runnable examples:
[`examples/persistence/event-migration.ts`](examples/persistence/event-migration.ts)
(additive via `defaultsAdapter`),
[`examples/persistence/event-migration-chain.ts`](examples/persistence/event-migration-chain.ts)
(rename / type change via `MigrationChain`).

**Operating across a fleet?**  The walkthrough at
[`docs/operations/rolling-migration.md`](docs/operations/rolling-migration.md)
covers the canonical four-phase rolling deploy: code-first with
both schemas registered, reader rollout, writer flip via
`writeVersion`, optional historical backfill — plus the parallel
story for master-key rotation.

**Not sure which adapter to reach for?**  The decision flowchart
at [`docs/persistence/migration-recipes.md`](docs/persistence/migration-recipes.md)
maps each change shape (additive / restructuring / multi-service /
on-write-validation / pre-envelope retrofit) to the one tool that
fits, with a worked example for each.

## Caching (Redis / Memcached / in-memory)

A single `Cache` abstraction backs everything: HTTP middleware (response
cache, rate-limit, idempotency-keys), an optional `CachedSnapshotStore`
decorator for hot sharded-actor recall, and arbitrary user code.  Three
implementations ship — `InMemoryCache` (default, single-process),
`RedisCache` (via `ioredis`, optional peer-dep), `MemcachedCache` (via
`memjs`, optional peer-dep).  The seven primitives are `get` / `set` /
`incr` / `setIfAbsent` / `delete` plus bulk `mget` / `mset` for
batched round-trips on hot paths (Redis emits a single `MGET` / `MSET`;
Memcached falls back to parallel single-key calls; the in-memory
backend iterates the map).

```ts
import {
  ActorSystem,
  CacheExtensionId,
  RedisCache,
  cached, idempotent, rateLimit,
  // routes
  get, post, path, concat, complete, completeJson, Status,
} from 'actor-ts';

const sys = ActorSystem.create('app');
const cache = new RedisCache({ url: 'redis://localhost:6379' });
sys.extension(CacheExtensionId).setCache('default', cache);

const limit = rateLimit({ cache, windowMs: 60_000, max: 100, key: req => req.headers['x-real-ip'] ?? '' });
const cacheGet = cached({ cache, ttlMs: 30_000, key: req => `users:${req.params.id}` });
const dedup = idempotent({ cache, ttlMs: 24 * 60 * 60_000 });

const routes = path('users', concat(
  path(':id', get(limit(cacheGet(async req => completeJson(Status.OK, await loadUser(req.params.id!)))))),
  post(limit(dedup(async req => completeJson(Status.Created, await createUser(req))))),
));
```

For sharded persistence, wrap any existing `SnapshotStore` with the
read-through cache decorator — cuts cold-start storms after rebalancing
to a single round-trip in 99% of cases:

```ts
import { CachedSnapshotStore } from 'actor-ts';
const cached = new CachedSnapshotStore(cassandraStore, { cache, ttlMs: 5 * 60_000 });
sys.extension(PersistenceExtensionId).setSnapshotStore(cached);
```

End-to-end example:
[`examples/cache/redis-rest-service.ts`](examples/cache/redis-rest-service.ts)
runs offline by default and against Redis with `ACTOR_TS_CACHE=redis`.

## Observability — Prometheus + OpenTelemetry

Framework metrics and traces flow through tiny abstractions
(`MetricsRegistry`, `Tracer`) so any stack-specific client can plug
in.  Two thin adapters bridge to the de-facto standard Node libraries
without forcing them as hard dependencies:

```ts
import {
  ActorSystem,
  MetricsExtensionId,
  TracingExtensionId,
  promClientRegistry,
  otelTracer,
} from 'actor-ts';
import * as promClient from 'prom-client';
import * as otelApi from '@opentelemetry/api';

const sys = ActorSystem.create('app');

// 1. Metrics — share one prom-client Registry between framework and
//    app code, expose it at a single /metrics endpoint.
const promReg = new promClient.Registry();
sys.extension(MetricsExtensionId).setRegistry(
  promClientRegistry({ client: promClient, registry: promReg }),
);

// 2. Tracing — funnel framework spans into the real OpenTelemetry SDK
//    (Jaeger / Tempo / Honeycomb / Datadog via OTLP).  Cross-actor
//    propagation rides W3C `traceparent` automatically.
sys.extension(TracingExtensionId).setTracer(
  otelTracer({ api: otelApi, tracerName: 'my-app' }),
);
```

Both adapters are structurally typed against their peer dep — `import
* as promClient` / `import * as otelApi` is the only place the user
mentions the library, no `import 'prom-client'` inside `actor-ts`.
End-to-end recipes (including OTLP-HTTP exporter wiring):
[`examples/management/prom-client-shared.ts`](examples/management/prom-client-shared.ts)
and
[`examples/management/otel-jaeger.ts`](examples/management/otel-jaeger.ts).

## Message-broker actors (TCP / UDP / MQTT / WebSocket / Kafka / AMQP / gRPC / NATS / Redis-Streams / SSE)

Bridging external messaging systems into the actor system is a
recurring pattern; rather than hand-rolling lifecycle / reconnect /
backpressure for every protocol, all broker actors share a single
[`BrokerActor`](src/io/broker/BrokerActor.ts) base.  Subclasses need
only three protocol hooks (`connectImpl`, `disconnectImpl`,
`dispatchOutgoing`); the base owns:

- **Lifecycle state machine** (`disconnected → connecting → connected → disconnecting`)
- **Auto-reconnect** with exponential backoff (and optional `CircuitBreaker`)
- **Outbound buffer** that holds messages while disconnected and drains them in FIFO on reconnect
- **Subscriber fan-out** with auto-cleanup on `Terminated`
- **Lifecycle events** on the system EventStream (`BrokerConnected`,
  `BrokerDisconnected`, `BrokerReconnectAttempt`, …) — health probes
  and metrics observe one uniform stream

### Settings — Aktor *or* HOCON

Settings (URL, credentials, topics, …) follow a 3-layer precedence:

1. **Constructor argument** of the actor — per-instance overrides.
2. **HOCON config** under `actor-ts.io.broker.<name>.*` — system-wide defaults.
3. **Built-in defaults** of the actor class.

```ts
// 1. Per-instance, in code:
const mqtt = sys.actorOf(Props.create(() => new MqttActor({
  brokerUrl: 'mqtt://prod-broker:1883',
  clientId: 'temperature-demo',
  subscriptions: [{ topic: 'sensors/+/temp', target: aggregator }],
})));

// 2. System-wide, in HOCON (application.conf):
//    actor-ts.io.broker.mqtt {
//      brokerUrl   = "mqtt://prod-broker:1883"
//      credentials = { username = "iot", password = ${MQTT_PASSWORD} }
//      defaultQos  = 1
//    }
```

Constructor wins over HOCON; HOCON wins over built-in defaults.
Required fields missing from every layer raise a clear
`BrokerSettingsError` at startup, naming both the field and the HOCON
path that could supply it.

`MqttActor` defaults to MQTT 3.1.1 for back-compat.  Set
`protocolVersion: 5` to opt in to MQTT 5.0 — inbound `MqttMessage`s
then carry optional `userProperties` and `reasonCode`, and outbound
`MqttPublish`es accept a `userProperties` map that the actor
attaches to the PUBLISH packet's v5 properties block.  On v3.1.1
those fields are silently dropped (the wire format has no slot).

Runnable examples:
[`examples/io/mqtt-temperature.ts`](examples/io/mqtt-temperature.ts) (MQTT pub/sub),
[`examples/io/websocket-feed.ts`](examples/io/websocket-feed.ts) (WS server + client in one process),
[`examples/io/grpc-sensor.ts`](examples/io/grpc-sensor.ts) (gRPC unary + server-stream).

## More examples

Dozens of runnable examples live in [`examples/`](./examples/):

| Path                                               | What it shows                           |
| -------------------------------------------------- | --------------------------------------- |
| `examples/hello-world.ts`                          | minimum viable actor                    |
| `examples/bank-account.ts`                         | ask pattern + error replies             |
| `examples/supervision.ts`                          | restart / resume / stop directives      |
| `examples/typed/behaviors-supervise.ts`            | functional `Behaviors` DSL + supervise  |
| `examples/cluster/singleton-cron.ts`               | cluster singleton with failover         |
| `examples/cluster/sharded-daemon-fixed-workers.ts` | N fixed daemons spread over nodes       |
| `examples/persistence/bank-account.ts`             | event-sourced account on SQLite         |
| `examples/persistence/scylla-ledger.ts`            | same, on ScyllaDB                       |
| `examples/persistence/s3-snapshot-bank-account.ts` | snapshots in S3 / MinIO / filesystem    |
| `examples/persistence/event-migration.ts`          | additive schema evolution (defaults)    |
| `examples/persistence/event-migration-chain.ts`    | non-additive schema evolution (chain)   |
| `examples/persistence/migrate-legacy-events.ts`    | one-shot migration of pre-envelope events |
| `examples/persistence/schema-registry.ts`          | in-process Zod-style registry + upcasters |
| `examples/persistence/replicated-counter.ts`       | multi-master event-sourced actor (CRDT) |
| `examples/persistence/projection-bank-statement.ts`| read-side projection over the journal   |
| `examples/cache/redis-rest-service.ts`             | response cache + rate-limit + idempotency |
| `examples/io/mqtt-temperature.ts`                  | MQTT broker actor with topic fan-out    |
| `examples/io/websocket-feed.ts`                    | WebSocket actor + Bun.serve server      |
| `examples/io/websocket-server.ts`                  | server-side WS upgrade (Bun + Fastify)  |
| `examples/chat/`                                   | clustered chat app (3 nodes, sharded persistent rooms, multi-frontend) |
| `examples/voice/`                                  | distributed voice server (1:1 PTT, group, Teams-style rooms; Receptionist + PubSub + DD) |
| `examples/io/grpc-sensor.ts`                       | gRPC client + server actors             |
| `examples/io/kafka-exactly-once.ts`                | Kafka manual offset-commit              |
| `examples/io/jetstream-orders.ts`                  | NATS JetStream durable consumer         |
| `examples/management/prometheus-endpoint.ts`       | Prometheus `/metrics` over `Bun.serve`  |
| `examples/management/prom-client-shared.ts`        | bridge framework metrics into a `prom-client` registry the app already owns |
| `examples/management/otel-jaeger.ts`               | bridge framework tracing into the real `@opentelemetry/api` SDK + OTLP exporter |
| `examples/management/opentelemetry-tracing.ts`     | OTel-style spans across actor hops      |
| `examples/pubsub/chat-mediator.ts`                 | topic-based pub-sub                     |
| `examples/http/rest-service.ts`                    | REST CRUD on a sharded entity (Fastify) |
| `examples/http/express-backend.ts`                 | same, swapping in the Express backend   |
| `examples/patterns/circuit-breaker-ask.ts`         | circuit-breaker protecting `ask`        |
| `examples/patterns/backoff-supervisor.ts`          | restart-with-exponential-backoff supervisor |
| `examples/fsm/traffic-light.ts`                    | named-state FSM                         |
| `examples/fsm/order-workflow.ts`                   | persistent FSM (state-machine + event sourcing) |
| `examples/crdt/shopping-cart-orset.ts`             | OR-Set as a shopping cart               |

Run any of them with `bun run examples/<path>`.

## Benchmarks

Micro-benchmarks for throughput / latency / memory live in
[`benchmarks/`](./benchmarks/) — see the [benchmarks README](./benchmarks/README.md)
for the full list.

```bash
bun run bench                             # everything
bun run benchmarks/run-all.ts --group=single-node
bun run benchmarks/single-node/tell-throughput.ts
```

Groups: `single-node` · `cluster` · `memory` · `persistence` · `http`.

## Install / dev

```bash
bun install           # fetches dependencies
bun run typecheck     # tsc --noEmit  (src only, runtime-neutral)
bun run typecheck:dev # full workspace incl. tests + benchmarks
bun run build         # emit dist/ with declarations
```

## Testing

The framework's production code is runtime-neutral, but the **test suite
itself** (~1666 tests under `tests/`) uses `bun:test` and therefore runs
directly only on Bun.  Cross-runtime validation goes through two
separate channels:

**1. Full test suite — Bun only**

```bash
bun test
```

```bash
bun test --coverage
```

`bun:test` has no drop-in replacement on Node or Deno; migrating the
whole suite to a runtime-neutral runner (Vitest / `node:test` / Deno's
built-in) is a distinct, larger piece of work that hasn't been done
yet.

**2. Cross-runtime smoke — Bun, Node, Deno**

`tests/smoke/smoke.mjs` is a plain-ESM script (no test framework) that
exercises the three most fragile cross-runtime paths — module loading,
actor messaging, and InMemory cluster formation.  It runs identically
on all three runtimes.

```bash
bun run smoke:bun      # run straight from src/
```

```bash
bun run smoke:node     # builds dist/, then runs under Node 20+
```

```bash
bun run smoke:deno     # builds dist/, then runs under Deno 2+
```

```bash
bun run smoke          # all three in sequence (use before releasing)
```

**3. Individual benchmarks as runtime smoke**

Every file under `benchmarks/` is a standalone script.  After
`bun run build`, each can be run under any runtime — handy as an
end-to-end check that a specific subsystem (HTTP, sharding, persistence)
doesn't break when switching runtimes:

```bash
node benchmarks/single-node/tell-throughput.ts
```

```bash
deno run --allow-net --allow-read benchmarks/single-node/tell-throughput.ts
```

## Runtime compatibility

| Capability              | Bun               | Node.js 20+                      | Deno 2+                  |
| ----------------------- | ----------------- | -------------------------------- | ------------------------ |
| Core actor + supervision| ✅                | ✅                               | ✅                       |
| Cluster (InMemory)      | ✅                | ✅                               | ✅                       |
| Cluster (TCP + TLS)     | ✅ `Bun.listen`   | ✅ `node:net` / `node:tls`       | ✅ `Deno.listen(Tls)`    |
| Multi-core workers      | ✅ Web Worker     | ✅ `node:worker_threads`         | ✅ Web Worker            |
| HTTP — Fastify backend  | ✅                | ✅                               | ✅ (via Node-compat)     |
| HTTP — Express backend  | ✅ (optional peer)| ✅ (optional peer)               | ✅ (via Node-compat)     |
| HTTP — Hono backend     | ✅ `Bun.serve`    | ✅ `@hono/node-server` (optional)| ✅ `Deno.serve`          |
| SQLite persistence      | ✅ `bun:sqlite`   | ✅ `better-sqlite3` (optional)   | ⚠️ not yet — use InMem/Cassandra |
| Cassandra / ScyllaDB    | ✅                | ✅                               | ✅                       |

All runtime-specific code lives under [`src/runtime/`](./src/runtime/).
Adapters are loaded lazily via dynamic `import(…)`, so Node users don't
pay for `bun:sqlite`, Bun users don't pay for `better-sqlite3`, and so on.
Auto-detection via `globalThis.Bun` / `globalThis.Deno` — no user
configuration required.

## Project layout

```
src/
  Actor.ts, ActorRef.ts, ActorSystem.ts, ...   core
  cluster/                                     membership + sharding + pubsub + singleton + downing
  config/                                      HOCON parser + Config
  coordination/                                Lease interface (in-memory + K8s stub)
  delivery/                                    ReliableDelivery (at-least-once)
  discovery/                                   Receptionist + seed providers
  fsm/                                         FSM DSL
  http/                                        routing DSL + Fastify / Express / Hono backends
  internal/                                    ActorCell, mailbox, guardians
  mailbox/                                     BoundedMailbox, PriorityMailbox
  management/                                  /health, /ready, /cluster/*
  pattern/                                     pipeTo, after, retry, CircuitBreaker
  persistence/                                 PersistentActor, journals, snapshot stores
  runtime/                                     Bun / Node / Deno adapters (TCP, workers, HTTP, SQLite)
  serialization/                               JSON + CBOR, pluggable Serializer
  testkit/                                     TestProbe, ManualScheduler
  typed/                                       Behaviors DSL
  util/                                        Option<T>
  worker/                                      WorkerCluster (multi-core)
examples/       — 75+ runnable examples
benchmarks/     — 20+ micro-benchmarks (single-node, cluster, worker, http, memory, persistence)
tests/unit/     — most of the ~1666 tests live here
tests/smoke/    — cross-runtime smoke scripts (bun / node / deno)
```

## License

[MIT](./LICENSE) — do whatever you want, at your own risk (see the disclaimer
at the top).
