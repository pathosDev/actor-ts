<p align="center">
  <img src="./assets/logo.svg" alt="actor-ts" width="560"/>
</p>

<p align="center">
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml"><img alt="tests workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml/badge.svg?branch=main"/></a>
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml"><img alt="build workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml/badge.svg?branch=main"/></a>
  <a href="#"><img alt="tests" src="https://img.shields.io/badge/tests-1079%20passing-22c55e?style=flat-square&logo=bun"/></a>
  <a href="#"><img alt="coverage" src="https://img.shields.io/badge/coverage-~86%25-22c55e?style=flat-square"/></a>
  <a href="#"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.4+-3178c6?style=flat-square&logo=typescript&logoColor=white"/></a>
  <a href="#"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.1-f7bf88?style=flat-square&logo=bun&logoColor=white"/></a>
  <a href="#"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white"/></a>
  <a href="#"><img alt="deno" src="https://img.shields.io/badge/deno-%3E%3D2.0-000000?style=flat-square&logo=deno&logoColor=white"/></a>
  <a href="#"><img alt="license" src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square"/></a>
  <a href="#"><img alt="status" src="https://img.shields.io/badge/status-experimental-f59e0b?style=flat-square"/></a>
</p>

---

> ⚠️ **Disclaimer — please read before using.**
> This is a **complex, AI-assisted hobby project** — a from-scratch port of
> the actor-model stack (actors, supervision, cluster, sharding, persistence,
> HTTP) to TypeScript, running on Bun, Node.js, and Deno.  Large parts were
> written with AI pair-programming and **have not been battle-tested in
> production**.  Test coverage is good (~1079 tests, ~86 % line) but the
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
  `/cluster/*`)
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

- Nothing.  This is an experimental hobby project (~1079 tests, ~86 % line coverage).

### What's solid in tests, but not production-tested

- Actor core, supervision, mailboxes, typed Behaviors, TestKit
- Cluster gossip + membership + sharding (single + multi-node test scenarios)
- Persistence (in-memory + SQLite); CassandraSnapshotStore tested against a fake CQL client only
- HTTP DSL + Fastify backend
- Caching (InMemoryCache); RedisCache tested against a mock client
- Schema-migration round-trips
- Object-storage with FilesystemBackend; S3Backend tested against a fake SDK + optional MinIO

### What's there but skipped in CI

- S3 / MinIO live-integration tests (env-var-gated, ~9 tests)
- Phase 2 broker actors (Kafka / AMQP / gRPC) — peer deps not installed by default

### What's NOT here

- Production-grade observability (no OpenTelemetry / Prometheus exporters yet)
- A schema registry (only manual migration via `MigrationChain` / `defaultsAdapter`)
- Multi-process `FilesystemObjectStorageBackend`
- gRPC reflection / health-service auto-registration
- A documentation site (README is the source of truth)
- Backwards-compatibility guarantees of any kind — pre-1.0

See [`ROADMAP.md`](./ROADMAP.md) for what's coming next and what's
explicitly out of scope.

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

## Caching (Redis / Memcached / in-memory)

A single `Cache` abstraction backs everything: HTTP middleware (response
cache, rate-limit, idempotency-keys), an optional `CachedSnapshotStore`
decorator for hot sharded-actor recall, and arbitrary user code.  Three
implementations ship — `InMemoryCache` (default, single-process),
`RedisCache` (via `ioredis`, optional peer-dep), `MemcachedCache` (via
`memjs`, optional peer-dep).

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

### Catalogue

| Phase | Actor | Use-case | Peer-dep |
| --- | --- | --- | --- |
| 1 | `TcpSocketActor` | raw TCP, line/length-prefixed/byte framing | — |
| 1 | `UdpSocketActor` | raw UDP datagrams | — |
| 1 | `MqttActor` | IoT, light pub/sub | `mqtt` |
| 1 | `WebSocketActor` | real-time browser clients, market feeds | `ws` (Node) / native (Bun/Deno) |
| 2 | `KafkaActor` | event streaming, log compaction | `kafkajs` |
| 2 | `AmqpActor` | RabbitMQ enterprise messaging | `amqplib` |
| 2 | `GrpcClientActor` / `GrpcServerActor` | RPC + bidi-stream | `@grpc/grpc-js` + `@grpc/proto-loader` |
| 3 | `NatsActor` | cloud-native NATS-Core pub/sub | `nats` |
| 3 | `RedisStreamsActor` | lightweight event streams (XADD/XREADGROUP) | `ioredis` |
| 3 | `SseActor` | Server-Sent Events client (push-only) | — |

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
| `examples/cache/redis-rest-service.ts`             | response cache + rate-limit + idempotency |
| `examples/io/mqtt-temperature.ts`                  | MQTT broker actor with topic fan-out    |
| `examples/io/websocket-feed.ts`                    | WebSocket actor + Bun.serve server      |
| `examples/io/grpc-sensor.ts`                       | gRPC client + server actors             |
| `examples/pubsub/chat-mediator.ts`                 | topic-based pub-sub                     |
| `examples/http/rest-service.ts`                    | REST CRUD on a sharded entity (Fastify) |
| `examples/http/express-backend.ts`                 | same, swapping in the Express backend   |
| `examples/patterns/circuit-breaker-ask.ts`         | circuit-breaker protecting `ask`        |
| `examples/fsm/traffic-light.ts`                    | named-state FSM                         |

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
itself** (~1079 tests under `tests/`) uses `bun:test` and therefore runs
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
examples/       — 60+ runnable examples
benchmarks/     — 20+ micro-benchmarks (single-node, cluster, worker, http, memory, persistence)
tests/unit/     — most of the ~1079 tests live here
tests/smoke/    — cross-runtime smoke scripts (bun / node / deno)
```

## Status

Feature-complete for a single-process / small-cluster app.  The big
roadmap items still open:

- CRDTs / Replicated Event Sourcing
- Projections / Persistence Query
- Multi-Node-Spec test harness
- Real K8s Lease (currently a stub)
- Production hardening of the sharding rebalance path (daemon failover)

See [CHANGELOG.md](./CHANGELOG.md) for what landed in the latest release.

## License

[MIT](./LICENSE) — do whatever you want, at your own risk (see the disclaimer
at the top).
