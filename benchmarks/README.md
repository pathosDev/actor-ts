<p align="center">
  <img src="https://raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.svg" alt="actor-ts" width="420"/>
</p>

<p align="center"><em>Micro-benchmarks for actor-ts on Bun, Node.js, and Deno — throughput, latency, memory, scaling.</em></p>

---

> ⚠️ **These numbers are comparative, not absolute.**  Single-machine,
> single-JIT measurements say nothing about a production cluster on real
> hardware with real networks.  Treat them as a lower bound on latency
> and an upper bound on throughput, and use them to detect regressions
> between commits, compare mailbox variants, compare transport / journal
> plug-ins, or compare the framework across runtimes — not as marketing
> material.
>
> The harness uses a runtime-neutral timer (`highResNow()` in
> [src/runtime/detect.ts](../src/runtime/detect.ts)) — `Bun.nanoseconds()`
> on Bun, `performance.now() × 1e6` elsewhere.  Most benchmark files work
> unchanged on every runtime; a few (`worker-count-scaling.ts` using Web
> Workers, `rest-comparison.ts` spinning up an HTTP listener) rely on
> features the corresponding runtime must support.

---

## What's in here?

Every benchmark is **self-contained** and runnable under `bun run`,
`node` (after `bun run build`), or `deno run --allow-net --allow-read`.
Suites under `lib/` provide a tiny measurement harness; the directory
layout groups benchmarks by subsystem.

```
benchmarks/
  lib/                # harness + stats helpers (not a benchmark)
  single-node/        # tell / ask / create / stash / pool / payload ...
  cluster/            # bootstrap, gossip, pub-sub, sharding, node-count
  worker/             # multi-core Bun Worker scaling (true parallelism)
  memory/             # ΔRSS / Δheap probes
  persistence/        # journal append, recovery, snapshot tradeoffs
  http/               # Fastify vs. Express vs. Hono (+ REST comparison)
  run-all.ts          # driver — spawns every file in a subprocess
```

Files whose name starts with `_` (e.g. `worker/_cpu-worker.ts`) are
helpers used BY benchmarks and are skipped by the discovery driver.

---

## Quick start

The full suite with subprocess isolation is `bun`-only (the driver
shells out with `bun run …`).  Individual files run on any of the three
runtimes.

**Bun — full suite or individual files**

```bash
bun run bench                                      # every suite
```

```bash
bun run benchmarks/run-all.ts --group=single-node  # one group
```

```bash
bun run benchmarks/single-node/tell-throughput.ts  # single file
```

```bash
bun run benchmarks/run-all.ts --list               # preview what would run
```

**Node.js 20+** — build `dist/` first, then run a file directly:

```bash
bun run build
node benchmarks/single-node/tell-throughput.ts
```

**Deno 2+** — same pattern, with permission flags as needed:

```bash
bun run build
deno run --allow-net --allow-read benchmarks/single-node/tell-throughput.ts
```

---

## Output format

Every benchmark renders one bordered table per group.  Columns:

```
┌── single-node · tell-throughput ──────────────────────────────────────────┐
│ case              │      throughput │    perOp │      p50 │     memory   │
├───────────────────┼─────────────────┼──────────┼──────────┼──────────────┤
│ batch=10k         │   4,210,593 ... │   237 ns │    2.3ms │    +1.80 MB  │
│ batch=100k        │     763,482 ... │  1.31 µs │ 130.5 ms │   +28.84 MB  │
└───────────────────┴─────────────────┴──────────┴──────────┴──────────────┘
```

(p99 column elided above for brevity; real output has it too.)

- **throughput** — total wall time / total ops.  Unit label reflects what
  the benchmark measures (`msg/s`, `ask/s`, `event/s`, `req/s`,
  `actor/s`, …).  Values ≥ 100 show as whole numbers with thousands
  separators; smaller values keep two decimals.  Tinted **green** in a
  real terminal — the headline metric.
- **perOp**      — average cost of one logical op.
- **p50 / p99**  — per-iteration latency distribution.  In batch
  benchmarks one iteration = one batch of `opsPerIteration` ops.
- **memory**     — process RSS change across the measurement window,
  with an explicit sign so `+1.80 MB` means "allocated", `-2.10 MB`
  means "shrank" (GC released more than was allocated).  Tinted yellow
  above 10 MB and red above 100 MB so leaky cases stand out.  Run with
  `bun --smol` for tighter baselines.

Memory-only benchmarks render a three-column `case / memory / heap`
variant of the same table.  The suite runner wraps each file in a
short `▸ group / file.ts` banner plus a final `✓ done` summary.
Colours honour `NO_COLOR=1` and are dropped automatically when stdout
is not a TTY (piping to a file works without ANSI noise).

---

## Groups

| Group         | What it measures |
| ------------- | ---------------- |
| `single-node` | tell / ask throughput, actor creation, supervisor restart cost, stash/unstash, priority-mailbox overhead, become/unbecome, router-pool scaling (1 / 2 / 4 / 8 / 16 routees), ask vs. payload size (64 B → 256 KB) |
| `cluster`     | single-node bootstrap, 3-node gossip convergence, pub-sub fan-out, sharded entity round-trip, **node-count scaling** (1 / 2 / 3 / 5 sharded nodes, one subprocess per size) |
| `worker`      | **Bun Worker count scaling** (1 / 2 / 4 / 8 / auto workers running a CPU-bound task) — true multi-core parallelism, unlike a router pool inside one ActorSystem |
| `memory`      | ΔRSS per idle actor, ΔRSS per queued message |
| `persistence` | journal append rate (InMemory / SQLite mem / SQLite file), recovery time at 100 and 10 000 events, **snapshot-frequency tradeoff** (write rate vs. recovery time for never / every 1000 / every 100 / every 10 events) |
| `http`        | Fastify, Express, and Hono route throughput (plain text + JSON) plus a side-by-side REST comparison |

---

## Day-to-day scaling questions

Several benchmarks are specifically aimed at the "how much does X help
me?" questions that come up when sizing an actor system:

| Question | Benchmark | Notes |
| -------- | --------- | ----- |
| **1 node vs. several nodes** | [`cluster/node-count-scaling.ts`](cluster/node-count-scaling.ts) | Same sharded ask workload against 1 / 2 / 3 / 5-node clusters (each size in its own subprocess) — shows the cost of cross-node shard forwarding. |
| **Single actor vs. Router pool** | [`single-node/router-pool.ts`](single-node/router-pool.ts) | Concurrency lift of a round-robin pool for I/O-bound workloads at 1 / 2 / 4 / 8 / 16 routees.  JS is single-threaded, so a pool gives in-flight concurrency, not CPU parallelism. |
| **1 worker vs. several workers (multi-core)** | [`worker/worker-count-scaling.ts`](worker/worker-count-scaling.ts) | Bun `Worker`s (one per OS thread) dispatching CPU-bound tasks round-robin.  Scales roughly linearly with cores.  The `auto` row mirrors `WorkerCluster.spawn({ workers: 'auto' })`. |
| **Message payload size** | [`single-node/payload-size.ts`](single-node/payload-size.ts) | Ask round-trip cost for 64 B up to 256 KB payloads (local in-process — `Uint8Array` references do not serialise). |
| **Snapshot frequency** | [`persistence/snapshot-frequency.ts`](persistence/snapshot-frequency.ts) | Write throughput **and** recovery time at four snapshot policies — the tradeoff between write-path cost and replay cost on one page. |
| **HTTP backend choice** | [`http/rest-comparison.ts`](http/rest-comparison.ts) | Fastify / Express / Hono side-by-side on the same routing DSL. |

---

## Writing a new benchmark

Drop a file anywhere under a group directory (e.g. `single-node/my-bench.ts`)
and the discovery driver picks it up.  Minimum shape:

```ts
import { Actor, ActorSystem, LogLevel, NoopLogger, Props } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

class Noop extends Actor<unknown> { override onReceive(): void {} }

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-my', { logger: new NoopLogger(), logLevel: LogLevel.Off });

  await runGroup('single-node · my-bench', [
    {
      name: 'spawn + stop',
      unit: 'actor',
      iterations: 5_000,
      run: () => { const ref = system.spawnAnonymous(Props.create(() => new Noop())); ref.stop(); },
    },
  ]);

  await system.terminate();
}

void main();
```

Helpers available from [`lib/harness.ts`](lib/harness.ts):

- `runGroup(title, specs[])` — the primary entry point.  Warms up, times
  every spec, renders the table.
- `memoryGroup(title)` — three-column `case / memory / heap` table for
  pure ΔRSS/Δheap probes (no timing).
- `runBenchmark(spec)` + `printResult(result)` — lower-level building
  blocks if you need to postprocess before printing.

Prefix a filename with `_` (e.g. `_cpu-worker.ts`) to have the driver
skip it — useful for bootstrap files consumed by actual benchmarks.
