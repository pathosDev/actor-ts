<p align="center">
  <img src="https://raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.png" alt="actor-ts" width="560"/>
</p>

<p align="center">
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml"><img alt="build workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml/badge.svg?branch=main"/></a>
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml"><img alt="tests workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml/badge.svg?branch=main"/></a>
  <a href="#"><img alt="tests" src="https://img.shields.io/badge/tests-7784%20of%207784-22c55e?style=flat-square&logo=bun"/></a>
  <a href="#"><img alt="coverage" src="https://img.shields.io/badge/coverage-~93%25-22c55e?style=flat-square"/></a>
</p>

<p align="center">
  <a href="#"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.6+-3178c6?style=flat-square&logo=typescript&logoColor=white"/></a>
  <a href="#"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.3-f7bf88?style=flat-square&logo=bun&logoColor=white"/></a>
  <a href="#"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white"/></a>
  <a href="#"><img alt="deno" src="https://img.shields.io/badge/deno-%3E%3D2.0-000000?style=flat-square&logo=deno&logoColor=white"/></a>
</p>

<p align="center">
  <a href="https://github.com/pathosDev/actor-ts/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache_2.0-8b5cf6?style=flat-square"/></a>
  <a href="#"><img alt="status" src="https://img.shields.io/badge/status-experimental-f59e0b?style=flat-square"/></a>
</p>

---

> ⚠️ **Disclaimer — please read before using.**
> This is a **complex, AI-assisted hobby project** — a from-scratch port of
> the actor-model stack (actors, supervision, cluster, sharding, persistence,
> HTTP) to TypeScript, running on Bun, Node.js, and Deno.  Large parts were
> written with AI pair-programming and **have not been battle-tested in
> production**.  Test coverage is good (~7784 tests, ~93 % line) but the
> surface area is enormous.  **Do not deploy this to anything that matters
> yet.**  Use it to learn, to prototype, to benchmark ideas — not to handle
> real money, users, or data.
>
> Those figures are measured on GitHub's hosted runners, where **three
> multi-node suites are skipped** — Bun there cannot respawn functional
> worker threads after the first worker test, so `ACTOR_TS_SKIP_FLAKY_MNS=1`
> removes `LeaseMajority`, `ParallelPubSub` and the `ParallelMultiNodeSpec`
> self-tests from the run.  They execute on a local `bun test` and in Docker,
> and a nightly job re-runs them with the flag off; see
> [Diagnosing test flakes](https://actor-ts.dev/testing/diagnosing-flakes/).

---

## What is this?

`actor-ts` is a **batteries-included actor-model runtime** for TypeScript —
messages, mailboxes, supervisors, location-transparent refs, the whole
Erlang-style actor toolkit — running natively on **Bun**, **Node.js**, and
**Deno**.

A short tour of what's in the box:

- **Actors** — single-threaded per-mailbox processing, lifecycle hooks, stash,
  timers, become/unbecome, supervision (restart / resume / stop / escalate).
- **Cluster** — gossip membership, φ-accrual failure detection, split-brain
  resolvers, weakly-up, multiple transports (TCP, MessageChannel, in-memory).
- **Cluster sharding + singleton + pub-sub + reliable delivery + receptionist**
  — production patterns from the actor-model tradition.
- **Distributed Data** — nine CRDTs (counters, registers, sets, maps) with
  durable-storage backend, quorum reads/writes, automatic gossip.
- **Persistence** — `PersistentActor`, `DurableState`, snapshots, projections
  (with a per-projection handler-failure strategy: retry with backoff, skip to
  dead letters, or stop), persistence-query, replicated event sourcing.  Journals for in-memory,
  SQLite (built-in driver on every runtime — `bun:sqlite`, `node:sqlite`, or
  `better-sqlite3`), libSQL / Turso, PostgreSQL, MariaDB,
  Microsoft SQL Server, MongoDB, DynamoDB, Cloudflare D1,
  Cassandra / ScyllaDB.
- **Object storage** — S3 / MinIO / R2 / filesystem with optional gzip/zstd
  compression and client-side AES-256-GCM encryption (per-tenant subkeys via
  HKDF).
- **HTTP** — directive-style routing DSL with Fastify default, Express + Hono
  backends, response caching, rate-limiting, idempotency-key dedup.  Typed
  **WebSocket** routes: `websocket(path, actorRef)` binds a
  `WebsocketServerActor` (typed messages, `reply` / `broadcast`,
  connect/disconnect hooks); `WebsocketClientActor` is the reconnecting
  client half.  Scoped error handling (`handleErrors`) + `fallback` routes;
  a security-middleware suite (CORS, CSRF, HSTS, CSP, security headers,
  Basic auth, request-id, timeout); HTML-escaping helpers; and
  backend-agnostic **static file serving** (`getFromFile` /
  `getFromDirectory` — MIME detection, conditional requests, Range,
  directory browsing).
- **Message brokers** — single `BrokerActor` base with Kafka, MQTT, AMQP,
  NATS, Redis-Streams, gRPC, SSE, raw TCP/UDP and IMAP/SMTP email
  integrations.
  Reconnect-with-backoff, outbound buffer, subscriber fan-out are baked in.
- **Caching** — pluggable Cache with in-memory, Redis, Memcached backends.
- **Typed options + fail-fast validation** — one fluent `XOptions` builder per
  configurable thing (or a plain object), with values validated once on the
  merged settings (builder / object / HOCON alike) — a bad port, timeout, or
  URL throws an `OptionsError` at startup, not deep in a later code path.
- **Utility primitives + helpers** — `Option<T>`, `Try<T>`, `Either<L, R>` and
  `Lazy<T>` for Scala-style ergonomics; `BidirectionalMap<K, V>`, a `Map` that
  also answers `value → key` and keeps the inverse in step for you, and
  `BidirectionalMultiMap<L, R>`, which does the same for a many-to-many
  relation and leaves nothing behind when a participant drops out (both,
  unlike an ordinary class, survive a snapshot as real instances — no
  adapter); plus
  the small helpers the framework itself runs on: `randomString` / `randomHex`
  / `randomId` (crypto entropy, no modulo bias, exact length) and `randomUuid`
  (a v4 UUID, for when the identifier has to be globally unique too) — all four
  take an optional `exists` predicate and redraw while it says the candidate is
  taken, so "keep going until one is free" is the call itself rather than a
  `do`/`while` around it;
  `safeStringify`
  (a `JSON.stringify` for log and error paths that cannot throw),
  `lazyImportModule` (import an optional peer dependency, or fail with a
  message naming the install command).
- **Dead letters** — every undeliverable message is published on the event
  stream naming the actor it failed to reach.  Opt in to
  `system.deadLetterQueue` and they are also *kept*: a bounded ring, or a
  journal-backed one that survives a restart, filterable by recipient and
  time and replayable by id — with a replay cap so a poison message cannot
  be retried into an ever-growing queue.
- **Observability** — Prometheus exporter, OTel tracing, management
  HTTP endpoints (`/health`, `/ready`, `/cluster/members`, `/sharding/regions`),
  out-of-the-box stock metrics.
- **Multi-sink logging** — one record to several destinations at once, each
  with its own minimum level, with bounded queues, batched delivery and a
  flush on shutdown.  Console (text or NDJSON), rotating log files, and
  ten platforms: OTLP (which alone reaches Loki, Datadog, SigNoz, Axiom,
  Honeycomb, New Relic and any OTel collector), Graylog/GELF, Sentry,
  Parseable, Loki, Seq, Splunk HEC and RFC 5424 syslog.  No dependencies —
  Sentry is a passthrough to your own SDK.  A `transform` hook redacts
  once, before fan-out.
- **DevTools** — `DevTools.attach(system)` opens an embedded web UI: live
  actor tree and mailbox depths, cluster topology and shard distribution,
  a span flame graph, a per-actor explain plan, time travel over a
  persistence journal, and a profiler.  Vanilla TypeScript bundled into the
  package — no UI framework, no CDN.  Loopback-only and unauthenticated by
  default, and it refuses a routable bind without a gate.
- **TestKit** — `TestProbe`, `ManualScheduler`, `MultiNodeSpec` for
  deterministic tests including cluster scenarios.

Everything works under any of the three runtimes — runtime-specific backends
(TCP sockets, worker threads, SQLite, HTTP serve) live behind small
abstractions in [`src/runtime/`](./src/runtime/) and auto-detect at startup.

---

## Quick start

```bash
bun add actor-ts                                  # Bun
npm install actor-ts                              # Node
# Deno: no install — import via `npm:actor-ts`
```

```ts
import { Actor, ActorSystem } from 'actor-ts';

class Greeter extends Actor<string> {
  override onReceive(name: string): void {
    console.log(`hello, ${name}!`);
  }
}

const system = ActorSystem.create('hello');
const ref    = system.spawn(Greeter, 'greeter');

ref.tell('world');

await system.terminate();
```

The same file runs unchanged under `bun run`, `node` and `deno run`.

---

## A few more patterns

A flavour of what idiomatic `actor-ts` code looks like — pick the
snippet that matches what you're reaching for.

### Typed messages + pattern matching

Discriminated-union messages plus `match().exhaustive()` from
[`ts-pattern`](https://github.com/gvergnaud/ts-pattern) give you a
compile-time check that every variant is handled. Add a new variant
to `Command` without a matching `with(...)` arm and TypeScript fails the
build.

```ts
import { Actor, ActorSystem, type ActorRef } from 'actor-ts';
import { match } from 'ts-pattern';

type IncrementCommand = { kind: 'increment' };
type DecrementCommand = { kind: 'decrement' };
type GetCommand = { kind: 'get'; replyTo: ActorRef<number> };
type Command = IncrementCommand | DecrementCommand | GetCommand;

class Counter extends Actor<Command> {
  private count = 0;
  override onReceive(cmd: Command): void {
    match(cmd)
      .with({ kind: 'increment' }, () => this.onIncrement())
      .with({ kind: 'decrement' }, () => this.onDecrement())
      .with({ kind: 'get' }, m => this.onGet(m))
      .exhaustive();
  }

  private onIncrement(): void { this.count++; }
  private onDecrement(): void { this.count--; }
  private onGet(m: GetCommand): void { m.replyTo.tell(this.count); }
}
```

### Ask pattern — request / response

`tell` is fire-and-forget; `ref.ask<Reply>(msg)` awaits a typed
reply with a configurable timeout.  The framework spawns a
one-shot reply actor, wires it as both `replyTo` and
`context.sender`, and resolves the promise when the target replies.

```ts
import { ActorSystem } from 'actor-ts';

const system  = ActorSystem.create('demo');
const counter = system.spawnAnonymous(Counter);

counter.tell({ kind: 'increment' });
counter.tell({ kind: 'increment' });

const value = await counter.ask<number>({ kind: 'get' }, 5_000);
console.log(value);  // 2
```

### Event-sourced actor

State is rebuilt from a journal on every restart — no in-place
mutation, no "did this write commit?" question. Same `Counter` API
the rest of the app sees, every mutation durable.

```ts
import { ActorSystem } from 'actor-ts';
import { PersistentActor } from 'actor-ts/persistence';
import { match } from 'ts-pattern';

type IncrementCommand = { kind: 'increment' };
type DecrementCommand = { kind: 'decrement' };
type Command = IncrementCommand | DecrementCommand;

type IncrementedEvent = { kind: 'incremented' };
type DecrementedEvent = { kind: 'decremented' };
type Event = IncrementedEvent | DecrementedEvent;

type State = { count: number };

class Counter extends PersistentActor<Command, Event, State> {
  readonly persistenceId = 'counter-1';
  initialState(): State { return { count: 0 }; }

  // A fold that computes a value — arms stay inline.
  onEvent(s: State, e: Event): State {
    return match(e)
      .with({ kind: 'incremented' }, () => ({ count: s.count + 1 }))
      .with({ kind: 'decremented' }, () => ({ count: s.count - 1 }))
      .exhaustive();
  }

  // A command dispatch — every arm delegates to an `onXxx` handler.
  onCommand(_state: State, cmd: Command): void {
    match(cmd)
      .with({ kind: 'increment' }, () => this.onIncrement())
      .with({ kind: 'decrement' }, () => this.onDecrement())
      .exhaustive();
  }

  private onIncrement(): void { this.persist({ kind: 'incremented' }); }
  private onDecrement(): void { this.persist({ kind: 'decremented' }); }
}
```

### Cluster sharding — N instances behind one ref

Same actor code; the framework routes per-entity messages to the
correct node in the cluster and migrates entities when nodes come
and go. The `ShardRegion` ref you get back behaves like any other
`ActorRef` to callers.

```ts
import { Cluster } from 'actor-ts/cluster';

// One-call bootstrap — system + cluster + receptionist + SIGTERM
// wiring in one line.  Discovery defaults to an env-driven chain
// (CLUSTER_SEEDS → K8s API → DNS); local dev with no env produces
// a single-node cluster, which is exactly what you want.
const { system, cluster } = await Cluster.bootstrap({ name: 'app' });

// `CartActor` declares its own identity, so neither the type name nor
// the entity-id extractor is repeated here:
//   static readonly shard = ShardKey.of<CartCommand>('cart', (c) => c.entityId);
const cartRegion = cluster.sharding.start(CartActor);

cartRegion.tell({ entityId: 'user-42', kind: 'add', sku: 'book-1' });

// A handle on one entity, wherever it lives — no routing key needed
// in the message, because the handle names its entity.
const cart = cluster.sharding.entityRefFor(CartActor, 'user-42');
cart.tell({ kind: 'add', sku: 'book-2' });

// And the shards themselves are addressable: where they live, how
// full they are, and a live ref to each.
for (const shard of await cluster.sharding.shards('cart')) {
  console.log(shard.shardId, `${shard.node}`, shard.entityCount);
}

// Inside the entity, its own id — the value `extractEntityId` returned,
// not the sanitized form in the actor path.  Usually spent on a
// per-entity journal stream.  The cluster it runs in is right there
// too, so nothing has to be threaded through the constructor:
class CartActor extends PersistentActor<CartCommand, CartEvent, CartState> {
  override get persistenceId(): string { return `cart-${this.entityId}`; }

  // Names itself once, instead of every message repeating the id.
  override displayName(): string { return `Cart(${this.entityId})`; }

  override preStart(): void {
    this.log.info(`starting on ${this.cluster.selfAddress}`);
    // → [...] INFO  actor-ts://shop/.../entity-user-42 - Cart(user-42) - starting on ...
  }
}
```

`this.cluster` throws on a system that never joined one; ask
`this.context.cluster` (an `Option<Cluster>`, matching `system.cluster`)
when the actor has to work either way.

`displayName()` is a label, not an address: it joins the log line and
the DevTools tree beside the path, never in place of it, so metrics,
tracing and every wire identifier stay on the path. It defaults to the
path, so an actor that doesn't override it logs exactly as before.

### Cluster singleton — exactly one instance, cluster-wide

One node hosts it; the rest hold a forwarding ref. Failover moves it
without callers changing anything.

```ts
class JobScheduler extends Actor<JobCommand> {
  static readonly singleton = SingletonKey.of<JobCommand>('job-scheduler');
  override onReceive(command: JobCommand): void { /* ... */ }
}

// On every node that may host it — get-or-create, so calling this
// from several modules is safe.
const scheduler = cluster.singleton.start(JobScheduler);
scheduler.tell({ kind: 'schedule', jobId: '42' });

// On a node that should only talk to it, never host it:
cluster.singleton.ref(JobScheduler).tell({ kind: 'schedule', jobId: '43' });
```

---

## Documentation

> 📚 **[actor-ts.dev](https://actor-ts.dev/)** —
> full documentation site with concept guides, runnable examples, and an
> auto-generated API reference.

The docs site is the canonical entry point.  Highlights:

- **[Quickstart](https://actor-ts.dev/intro/quickstart/)** —
  hello-actor in five minutes.
- **[Why actors?](https://actor-ts.dev/intro/why-actors/)** —
  what the actor model gives you that Promise/Worker code doesn't.
- **[Migrating from Akka / Pekko / Orleans](https://actor-ts.dev/migration/overview/)** —
  for people coming from another actor framework.
- **[DevTools](https://actor-ts.dev/observability/devtools/overview/)** —
  attach the embedded UI to a running system and look inside it.
- **[API reference](https://actor-ts.dev/api/)** —
  every public class, function, type generated from JSDoc.

---

## Examples

Two end-to-end sample apps that exercise the framework comprehensively, each
with six interchangeable frontends (Plain HTML, Lit, Angular, React, Next.js,
SvelteKit) talking the same WebSocket protocol to a clustered backend:

- **[`examples/chat/`](./examples/chat/)** — multi-room chat with sharding,
  persistence, DMs, typing indicators, read receipts, production-realistic
  auth.  Demonstrates `ClusterSharding`, `DistributedPubSub`, `PersistentActor`,
  `DistributedData` (ORSet, LWWMap), `ClusterSingleton`, failover.
- **[`examples/voice/`](./examples/voice/)** — voice rooms with PCM-encoded
  audio streaming over WebSocket.  Same cluster infrastructure, different
  protocol shape.

Run either with `bun examples/chat/backend/main.ts --port 2551` (then
`--seeds localhost:2551` on additional terminals), open
`http://localhost:8080`, pick a frontend, and poke.

---

## Benchmarks

How does it compare to the other options?  Measured, rather than asserted —
same machine, same harness, same workload, ten interleaved rounds, and every
row verified against work the system actually completed rather than work it
was asked for.

Each figure is the **mean of those ten rounds**, with the spread they varied
by — a gap smaller than the spread beside it is not a difference.

Per operation, Bun 1.3.1, AMD Ryzen 9 7940HX:

| scenario                       | actor-ts          | nact 7.6.2      | XState 5.32.5   |
| ------------------------------ | ----------------- | --------------- | --------------- |
| tell throughput (batch 10k)    | **4.55M/s** ±8 %  | 389k/s ±3 %     | 183k/s ±9 %     |
| ask round-trip (p50)           | **3.5 µs**        | 6.7 µs          | 13.5 µs *       |
| ping-pong (10k exchanges)      | **504k/s** ±6 %   | 166k/s ±10 %    | 83k/s ±13 %     |
| spawn → started → stopped      | 75k/s ±10 %       | **192k/s** ±7 % | 61k/s ±4 %      |

<sub>\* XState has no request/response primitive — that row is `send` plus a
snapshot wait, which is the idiomatic equivalent but not a native ask.</sub>

actor-ts leads the JavaScript field on everything except spawning.  It stays
behind there for a structural reason rather than a fixable one: nact
constructs an actor synchronously inside `spawn()` and registers it in two
maps, while this benchmark waits for a confirmed `preStart`, a `stop()` and a
confirmed `postStop` — a supervision-aware lifecycle that notifies the parent
on the way out.  The row measures what an actor system does, and doing it
costs more than not doing it.

There is deliberately no "no framework" column.  One used to sit here, showing
direct method calls as a floor; it was removed because a number two orders of
magnitude above everything else is read as "these frameworks are wasteful"
rather than as "a direct call does none of this work", and because it was the
least stable figure in the suite.

### And against the JVM and .NET

Kept in its own table on purpose: these are other virtual machines, measured by
a harness that mirrors the JavaScript one rather than being it.

Each JVM framework appears twice: through its **Java** API and through its
**Scala 3** API, at the identical pinned version.  Reading down a column pair
gives the licence question; reading across a pair gives the language binding.

| scenario                    | actor-ts (Bun)   | Akka 2.8.8 (Java) | Akka (Scala 3)  | Pekko 1.6.0 (Java) | Pekko (Scala 3) | Akka.NET 1.5.70 | Orleans 10.2.2 |
| --------------------------- | ---------------- | ----------------- | --------------- | ------------------ | --------------- | --------------- | -------------- |
| tell throughput (batch 1k)  | **2.90M/s** ±6 % | 2.11M/s ±27 %     | 1.31M/s ±37 %   | 1.71M/s ±28 %      | 1.10M/s ±45 %   | 1.38M/s ±9 %    | 288k/s ±19 %   |
| tell throughput (batch 10k) | **4.55M/s** ±8 % | 3.14M/s ±9 %      | 2.80M/s ±16 %   | 3.04M/s ±13 %      | 2.84M/s ±47 %   | 1.36M/s ±18 %   | 576k/s ±26 %   |
| ping-pong (10k exchanges)   | 504k/s ±6 %      | 404k/s ±40 %      | 369k/s ±42 %    | 343k/s ±27 %       | 603k/s ±82 %    | 415k/s ±21 %    | 157k/s ±7 %    |
| spawn → started → stopped   | **75k/s** ±10 %  | 28k/s ±10 %       | 26k/s ±6 %      | 27k/s ±14 %        | 28k/s ±13 %     | 34k/s ±6 %      | 5k/s ±13 % ‡   |
| ask round-trip (p50)        | **3.5 µs**       | 34.9 µs †         | 37.4 µs †       | 32.8 µs †          | 32.4 µs †       | 7.2 µs          | 7.7 µs         |
| licence                     | MIT              | BUSL-1.1          | BUSL-1.1        | Apache-2.0         | Apache-2.0      | Apache-2.0      | MIT            |

<sub>† Every arm drives the system from an external caller.  On an event loop
that is a microtask and in .NET an `await`; on the JVM, from a non-actor
thread, it is a thread parking on a future — which is why the two .NET arms
land far better on this row than the JVM ones.<br/>
‡ Orleans has no caller-visible create or stop; grains activate on first call,
so that row is activation latency rather than a comparable lifecycle.</sub>

This table used to say "expect roughly a third of the JVM's throughput", and
that is no longer where the numbers land — most of the gap was a scheduling
hop and an async state machine on the receive path rather than anything
inherent to the runtime.  On bulk messaging actor-ts is now ahead of every JVM
arm; on the alternating volley the JVM spreads are wide enough (±27 % to ±82 %)
that only the ordering against Orleans and XState is safe to read at all.

**Two things the JVM columns say that a single column could not.**

*The licence pair.*  Akka and Pekko are the same lineage either side of a
licence change, and at the same binding they agree to within their spreads on
every row.  **Staying on an OSI-approved licence costs nothing in throughput.**

*The binding pair.*  Each framework is measured through its Java API and
through its Scala 3 API at the identical version, so the gap between them is
the language binding and nothing else.  On four of the five rows there is no
gap worth the name.  On one there is: at a batch of 1 000 the Scala arms run
**36–38 % behind their Java siblings** — both pairs, independently, and large
enough to survive their spreads (t = 3.4 and 2.8).  That is the cost of the
idiomatic functional style, where an actor advances its state by returning a
new behavior per message rather than mutating a field.  The effect shrinks to
7–11 % at a batch of 10 000, which is consistent with the JIT eliminating the
allocation once it has enough profile to work with — that part is a plausible
mechanism rather than something this benchmark measured.

The same actor model appears on three runtimes, which is what makes the
runtime's own contribution visible rather than inferred.

The spreads are the other half of the story, and they grew: the JVM arms now
launch a fresh process per run rather than measuring inside their build tool's
already-warm one, which is how every other arm has always been measured and is
the fairer shape — but a cold JVM is a noisier one, and the volley row in
particular moves by a third to four fifths between rounds.  Treat those four
columns as an order of magnitude, not a ranking.  Elsewhere: a 20 % gap is a
difference, a 10 % gap is a tie.

These are **ratios, not absolutes**, on one machine.  Read the columns, treat
the last digit as fiction, and note that a 10 % gap here is inside the
run-to-run noise.  A benchmark measures the workload it contains: these are
local, in-process, single-node message paths, which is the part of an actor
system a microbenchmark can measure honestly.  Nothing here says anything
about clustering, persistence, or a real network.

**[Full tables, methodology and caveats](./benchmarks/comparison/RESULTS.md)** —
including what is deliberately *not* measured yet (clustering, persistence)
and why.  Reproduce with `bun run bench:compare -- --rounds=10`.

---
## Roadmap & status

See [`ROADMAP.md`](./ROADMAP.md) for what's done and what's planned.  The
[`CHANGELOG.md`](./CHANGELOG.md) tracks per-version changes — pre-1.0 minor
bumps are potentially breaking; check the changelog before upgrading.

Issues and feature requests live on
[GitHub](https://github.com/pathosDev/actor-ts/issues).  A vulnerability
goes through [`SECURITY.md`](./SECURITY.md) instead, which names the
private reporting channel, the supported versions, and what is in and out
of scope.

---

## Star History

<a href="https://www.star-history.com/?repos=pathosDev%2Factor-ts&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pathosDev/actor-ts&type=date&theme=dark&legend=top-left&sealed_token=jnLXrF3L8eXXufEpEqvJAJTvVh3Yozo3qjSycX9PSzadtcBeaNoG0k6wCBSK-PQI4rbivEhZGTqBaxdDUeVxAVsKC09rEN5CSn545vlFeRTKgb6DsPw6IpxFVafwOh805ncB1xOqGYFOkysOP_OJsMF1gUCECRRLqMoHokzQhVQ0BhxkI8yFTYoiwdjZ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pathosDev/actor-ts&type=date&legend=top-left&sealed_token=jnLXrF3L8eXXufEpEqvJAJTvVh3Yozo3qjSycX9PSzadtcBeaNoG0k6wCBSK-PQI4rbivEhZGTqBaxdDUeVxAVsKC09rEN5CSn545vlFeRTKgb6DsPw6IpxFVafwOh805ncB1xOqGYFOkysOP_OJsMF1gUCECRRLqMoHokzQhVQ0BhxkI8yFTYoiwdjZ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pathosDev/actor-ts&type=date&legend=top-left&sealed_token=jnLXrF3L8eXXufEpEqvJAJTvVh3Yozo3qjSycX9PSzadtcBeaNoG0k6wCBSK-PQI4rbivEhZGTqBaxdDUeVxAVsKC09rEN5CSn545vlFeRTKgb6DsPw6IpxFVafwOh805ncB1xOqGYFOkysOP_OJsMF1gUCECRRLqMoHokzQhVQ0BhxkI8yFTYoiwdjZ" />
 </picture>
</a>

---

## License

[Apache 2.0](./LICENSE).
