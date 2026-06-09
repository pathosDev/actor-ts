<p align="center">
  <img src="https://raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.png" alt="actor-ts" width="560"/>
</p>

<p align="center">
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml"><img alt="build workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/build.yml/badge.svg?branch=main"/></a>
  <a href="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml"><img alt="tests workflow" src="https://github.com/pathosDev/actor-ts/actions/workflows/test.yml/badge.svg?branch=main"/></a>
  <a href="#"><img alt="tests" src="https://img.shields.io/badge/tests-2120%20of%202125-ef4444?style=flat-square&logo=bun"/></a>
  <a href="#"><img alt="coverage" src="https://img.shields.io/badge/coverage-~86%25-22c55e?style=flat-square"/></a>
</p>

<p align="center">
  <a href="#"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.4+-3178c6?style=flat-square&logo=typescript&logoColor=white"/></a>
  <a href="#"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.1-f7bf88?style=flat-square&logo=bun&logoColor=white"/></a>
  <a href="#"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white"/></a>
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
> production**.  Test coverage is good (~2120 tests, ~86 % line) but the
> surface area is enormous.  **Do not deploy this to anything that matters
> yet.**  Use it to learn, to prototype, to benchmark ideas — not to handle
> real money, users, or data.

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
- **Distributed Data** — eight CRDTs (counters, registers, sets, maps) with
  durable-storage backend, quorum reads/writes, automatic gossip.
- **Persistence** — `PersistentActor`, `DurableState`, snapshots, projections,
  persistence-query, replicated event sourcing.  Journals for in-memory,
  SQLite (via Bun-SQLite + better-sqlite3), Cassandra / ScyllaDB.
- **Object storage** — S3 / MinIO / R2 / filesystem with optional gzip/zstd
  compression and client-side AES-256-GCM encryption (per-tenant subkeys via
  HKDF).
- **HTTP** — directive-style routing DSL with Fastify default, Express + Hono
  backends, response caching, rate-limiting, idempotency-key dedup.
- **Message brokers** — single `BrokerActor` base with Kafka, MQTT, AMQP,
  NATS, Redis-Streams, gRPC, WebSocket, SSE, raw TCP/UDP integrations.
  Reconnect-with-backoff, outbound buffer, subscriber fan-out are baked in.
- **Caching** — pluggable Cache with in-memory, Redis, Memcached backends.
- **Observability** — Prometheus exporter, OTel tracing + metrics, management
  HTTP endpoints (`/health`, `/ready`, `/cluster/members`, `/sharding/regions`),
  out-of-the-box stock metrics.
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
import { Actor, ActorSystem, Props } from 'actor-ts';

class Greeter extends Actor<string> {
  override onReceive(name: string): void {
    console.log(`hello, ${name}!`);
  }
}

const system = ActorSystem.create('hello');
const ref    = system.spawn(Props.create(() => new Greeter()), 'greeter');

ref.tell('world');

await new Promise(r => setTimeout(r, 20));
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
to `Cmd` without a matching `with(...)` arm and TypeScript fails the
build.

```ts
import { Actor, ActorSystem, Props, type ActorRef } from 'actor-ts';
import { match } from 'ts-pattern';

type Cmd =
  | { kind: 'inc' }
  | { kind: 'dec' }
  | { kind: 'get'; replyTo: ActorRef<number> };

class Counter extends Actor<Cmd> {
  private count = 0;
  override onReceive(cmd: Cmd): void {
    match(cmd)
      .with({ kind: 'inc' }, () => { this.count++; })
      .with({ kind: 'dec' }, () => { this.count--; })
      .with({ kind: 'get' }, m => m.replyTo.tell(this.count))
      .exhaustive();
  }
}
```

### Ask pattern — request / response

`tell` is fire-and-forget; `ref.ask<Reply>(msg)` awaits a typed
reply with a configurable timeout.  The framework spawns a
one-shot reply actor, wires it as both `replyTo` and
`context.sender`, and resolves the promise when the target replies.

```ts
import { ActorSystem, Props } from 'actor-ts';

const system  = ActorSystem.create('demo');
const counter = system.spawnAnonymous(Props.create(() => new Counter()));

counter.tell({ kind: 'inc' });
counter.tell({ kind: 'inc' });

const value = await counter.ask<number>({ kind: 'get' }, 5_000);
console.log(value);  // 2
```

### Event-sourced actor

State is rebuilt from a journal on every restart — no in-place
mutation, no "did this write commit?" question. Same `Counter` API
the rest of the app sees, every mutation durable.

```ts
import { PersistentActor, ActorSystem, Props } from 'actor-ts';

type Cmd   = { kind: 'inc' } | { kind: 'dec' };
type Event = { kind: 'incremented' } | { kind: 'decremented' };
interface State { count: number }

class Counter extends PersistentActor<Cmd, Event, State> {
  readonly persistenceId = 'counter-1';
  initialState(): State { return { count: 0 }; }
  onEvent(s: State, e: Event): State {
    return e.kind === 'incremented'
      ? { count: s.count + 1 }
      : { count: s.count - 1 };
  }
  onCommand(_state: State, cmd: Cmd): void {
    this.persist({
      kind: cmd.kind === 'inc' ? 'incremented' : 'decremented',
    });
  }
}
```

### Cluster sharding — N instances behind one ref

Same actor code; the framework routes per-entity messages to the
correct node in the cluster and migrates entities when nodes come
and go. The `ShardRegion` ref you get back behaves like any other
`ActorRef` to callers.

```ts
import { Cluster } from 'actor-ts';

// One-call bootstrap — system + cluster + receptionist + SIGTERM
// wiring in one line.  Discovery defaults to an env-driven chain
// (CLUSTER_SEEDS → K8s API → DNS); local dev with no env produces
// a single-node cluster, which is exactly what you want.
const { system, cluster } = await Cluster.bootstrap({ name: 'app' });

const cartRegion = cluster.sharding.start('cart', CartActor, {
  extractEntityId: (msg: CartCmd) => msg.entityId,
});

cartRegion.tell({ entityId: 'user-42', kind: 'add', sku: 'book-1' });
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

## Roadmap & status

See [`ROADMAP.md`](./ROADMAP.md) for what's done and what's planned.  The
[`CHANGELOG.md`](./CHANGELOG.md) tracks per-version changes — pre-1.0 minor
bumps are potentially breaking; check the changelog before upgrading.

Issues and feature requests live on
[GitHub](https://github.com/pathosDev/actor-ts/issues).

---

## Star History

<a href="https://www.star-history.com/?repos=pathosDev%2Factor-ts&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pathosDev/actor-ts&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pathosDev/actor-ts&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pathosDev/actor-ts&type=date&legend=top-left" />
 </picture>
</a>

---

## License

[Apache 2.0](./LICENSE).
