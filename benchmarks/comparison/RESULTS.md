# Framework comparison — measured results

<!-- GENERATED FILE — do not edit by hand. -->

> Regenerate with `bun run bench:compare:report` after a measurement run
> (`bun run bench:compare`).  Hand edits are lost on the next run, and a
> hand-edited benchmark table is worth nothing anyway.

## How to read this

These are **ratios, not absolutes**.  Single-machine measurements say nothing
about a production deployment on real hardware with real networks, so compare
columns and treat the last digit of every figure as fiction.

How much fiction: across five consecutive rounds on an ordinary desktop, the
ask rate varied by 2 % on one arm, 15 % on another and 34 % on a third — while
the *ordering* of the three was identical in every round.  That is the shape of
the noise here, and it is why each row below is the mean of several
interleaved rounds rather than one run — and why every throughput figure
carries the spread of the rounds it averages.  Read a gap smaller than
that spread as "about the same".

Two rules govern what is in here, both from `README.md`:

- Every row is **completion-verified**: the arm reported what the system
  actually did, not what it was asked to do, and this file refuses to render
  a row where those disagree (#1027).
- Same-runtime and cross-language rows are **never in one table**.  Two
  JavaScript frameworks on one machine through one harness is a measurement;
  a framework on another virtual machine through a mirrored harness is a
  weaker claim, and mixing them into a single ranking would hide that.

## Environment

One row per arm, because they are not required to have been measured together —
and a row taken three months earlier on other hardware should be visible as
exactly that rather than averaged in silently.

| arm | measured | actor-ts | commit | CPU | cores | RAM | OS |
| --- | -------- | -------- | ------ | --- | ----- | --- | -- |
| actor-ts (bun) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-java (jvm) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka.net (dotnet) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-scala (jvm) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| nact (bun) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| orleans (dotnet) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-java (jvm) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-scala (jvm) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| xstate (bun) | 2026-08-21 | 0.16.0 | `3c04d81b` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |

## Arms

`rounds` is how many interleaved measurements each published row averages.
A single round is not a measurement on a machine that is not otherwise
idle — see the spread column in the tables below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.4.0 | 100 |
| akka-java | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| akka.net | 1.5.70 | C# | Apache-2.0 | dotnet 10.0.11 | 100 |
| akka-scala | 2.8.8 | Scala 3 | BUSL-1.1 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.4.0 | 100 |
| orleans | 10.2.2 | C# | MIT | dotnet 10.0.11 | 100 |
| pekko-java | 1.6.0 | Java | Apache-2.0 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| pekko-scala | 1.6.0 | Scala 3 | Apache-2.0 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| xstate | 5.32.5 | TypeScript | MIT | bun 1.4.0 | 100 |

## spawn

Create a batch of actors and take them through their full lifecycle — spawn, confirmed start, stop, confirmed stop.

### batch=100

100 measured iterations of 100 actor(s) each — 10,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.4.0 | 328,412 actor/s | ± 7.2 % | 3.06 µs | 170.18 µs | 2.45 ms | +7.3 MB |
| nact [^2] | bun 1.4.0 | 906,214 actor/s | ± 9.0 % | 1.11 µs | 75.42 µs | 1.21 ms | +7.0 MB |
| xstate [^3] | bun 1.4.0 | 253,075 actor/s | ± 5.4 % | 3.96 µs | 279.41 µs | 1.63 ms | +12.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 102,139 actor/s | ± 5.6 % | 9.82 µs | 935.68 µs | 2.59 ms | — |
| akka.net [^5] | dotnet 10.0.11 | 84,553 actor/s | ± 2.0 % | 11.83 µs | 1.21 ms | 1.62 ms | — |
| akka-scala [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 95,908 actor/s | ± 5.6 % | 10.46 µs | 1.00 ms | 3.10 ms | — |
| orleans [^6] | dotnet 10.0.11 | 29,881 actor/s | ± 4.2 % | 33.53 µs | 3.14 ms | 8.50 ms | — |
| pekko-java [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 101,140 actor/s | ± 5.0 % | 9.91 µs | 932.50 µs | 2.80 ms | — |
| pekko-scala [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 89,692 actor/s | ± 5.8 % | 11.19 µs | 1.05 ms | 3.66 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 13,693,613 msg/s | ± 6.9 % | 73 ns | 60.84 µs | 429.55 µs | −2.0 MB |
| nact | bun 1.4.0 | 1,192,327 msg/s | ± 3.4 % | 840 ns | 791.66 µs | 1.43 ms | −4.9 MB |
| xstate [^8] | bun 1.4.0 | 824,638 msg/s | ± 8.4 % | 1.22 µs | 1.19 ms | 2.52 ms | −2.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 7,093,389 msg/s | ± 15.3 % | 145 ns | 138.82 µs | 392.64 µs | — |
| akka.net | dotnet 10.0.11 | 5,883,236 msg/s | ± 4.4 % | 170 ns | 168.71 µs | 194.03 µs | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 5,346,739 msg/s | ± 26.8 % | 201 ns | 191.52 µs | 386.97 µs | — |
| orleans [^10] | dotnet 10.0.11 | 684,671 msg/s | ± 9.9 % | 1.47 µs | 1.38 ms | 3.29 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 6,543,468 msg/s | ± 16.3 % | 157 ns | 152.97 µs | 399.91 µs | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 4,270,070 msg/s | ± 23.8 % | 246 ns | 235.03 µs | 498.24 µs | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 15,842,356 msg/s | ± 6.4 % | 63 ns | 531.63 µs | 1.18 ms | +1.9 MB |
| nact | bun 1.4.0 | 1,150,641 msg/s | ± 2.5 % | 870 ns | 8.64 ms | 9.81 ms | +0.6 MB |
| xstate [^8] | bun 1.4.0 | 877,954 msg/s | ± 8.1 % | 1.15 µs | 11.47 ms | 13.61 ms | +0.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,217,546 msg/s | ± 8.3 % | 109 ns | 1.09 ms | 1.60 ms | — |
| akka.net | dotnet 10.0.11 | 6,349,884 msg/s | ± 2.5 % | 158 ns | 1.57 ms | 1.72 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,088,528 msg/s | ± 10.4 % | 111 ns | 1.09 ms | 1.88 ms | — |
| orleans [^10] | dotnet 10.0.11 | 784,538 msg/s | ± 35.9 % | 1.38 µs | 13.86 ms | 19.14 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,477,987 msg/s | ± 8.2 % | 106 ns | 1.06 ms | 1.65 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,336,361 msg/s | ± 11.8 % | 108 ns | 1.07 ms | 1.85 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 812,770 ask/s | ± 7.8 % | 1.24 µs | 805 ns | 3.05 µs | +1.1 MB |
| nact | bun 1.4.0 | 485,151 ask/s | ± 4.6 % | 2.07 µs | 1.83 µs | 3.83 µs | +0.6 MB |
| xstate [^11] | bun 1.4.0 | 419,975 ask/s | ± 9.8 % | 2.41 µs | 1.85 µs | 5.54 µs | +1.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 252,125 ask/s | ± 7.1 % | 3.99 µs | 3.65 µs | 7.86 µs | — |
| akka.net | dotnet 10.0.11 | 308,292 ask/s | ± 3.6 % | 3.25 µs | 3.18 µs | 4.04 µs | — |
| akka-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 262,290 ask/s | ± 8.6 % | 3.84 µs | 3.52 µs | 8.86 µs | — |
| orleans | dotnet 10.0.11 | 186,277 ask/s | ± 22.1 % | 5.61 µs | 5.48 µs | 7.13 µs | — |
| pekko-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 254,971 ask/s | ± 7.1 % | 3.94 µs | 3.59 µs | 8.00 µs | — |
| pekko-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 262,312 ask/s | ± 9.9 % | 3.86 µs | 3.53 µs | 8.78 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 2,245,419 exchange/s | ± 7.7 % | 448 ns | 4.47 ms | 5.20 ms | −2.0 MB |
| nact | bun 1.4.0 | 584,327 exchange/s | ± 3.1 % | 1.71 µs | 17.07 ms | 18.64 ms | −0.2 MB |
| xstate | bun 1.4.0 | 476,468 exchange/s | ± 5.5 % | 2.10 µs | 21.15 ms | 24.61 ms | +2.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,978,574 exchange/s | ± 2.4 % | 506 ns | 5.03 ms | 5.43 ms | — |
| akka.net | dotnet 10.0.11 | 491,109 exchange/s | ± 8.1 % | 2.05 µs | 20.41 ms | 28.94 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,948,162 exchange/s | ± 3.3 % | 514 ns | 5.16 ms | 5.43 ms | — |
| orleans [^14] | dotnet 10.0.11 | 358,711 exchange/s | ± 10.7 % | 2.83 µs | 27.13 ms | 38.88 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,974,409 exchange/s | ± 2.5 % | 507 ns | 5.04 ms | 5.49 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,990,669 exchange/s | ± 2.2 % | 503 ns | 5.02 ms | 5.32 ms | — |

## Notes

[^1]: One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.
[^2]: nact creates actors synchronously — `initialStateFunc` has run for the whole batch when the spawn loop returns — so only the stops are awaited.
[^3]: XState starts and stops actors synchronously; confirmation is a snapshot status read.
[^4]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Akka Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^5]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination, driven through a coordinator actor so the counting matches the other cross-language arms.
[^6]: Orleans has no caller-visible create or stop: a grain activates on first call and deactivates on its own schedule. This row is first-call activation latency for a batch of fresh grain identities; deactivation is requested but not awaited, because nothing surfaces its completion to the caller.
[^7]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Pekko Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^8]: XState processes events synchronously on the caller's stack — this row does not measure a mailbox.
[^9]: Idiomatic functional style: state advances by returning a new behavior per message, which is what the native-language API leads with — so each message carries a behavior allocation the mutable Java-API arm beside it does not.
[^10]: [OneWay] is the nearest equivalent of a fire-and-forget send, but it is a one-way RPC rather than a mailbox enqueue.
[^11]: XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, which is the idiomatic equivalent but not a native ask.
[^12]: Driven from a non-actor thread, where Java has no non-blocking wait: each round trip parks and unparks a thread on a CompletableFuture. The .NET arms await instead and land ~5x higher on this row, so read it as the cost of asking from outside the actor system on this runtime, not as the framework's messaging speed — its tell throughput is the highest in the table.
[^13]: Driven from a non-actor thread, where the JVM offers no non-blocking wait: each round trip parks and unparks a thread on an awaited Future. The .NET arms await instead and land ~5x higher on this row, so read it as the cost of asking from outside the actor system on this runtime, not as the framework's messaging speed.
[^14]: A driven chain of awaited grain calls rather than two mailboxes volleying — the closest deadlock-free analogue in a virtual-actor model.

## Known gaps

Stated because a comparison that only lists what it measured reads as a
comparison of everything:

- **No sharding or clustering row.** A known throughput regression is open
  against sharding (#529); publishing a sharded comparison now would bake it
  into the first number anyone sees.
- **No persistence row.** The persistence benchmarks cover in-memory and
  SQLite only (#1177), so the comparable arm would be a storage-engine
  comparison wearing a framework label.
- **No stored baselines and no regression gate.** Nothing here fails when a
  number moves between releases (#528).
- **The main benchmark suite still publishes no numbers**, and its cluster
  suites never leave the process (#1177).
