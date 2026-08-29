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
| actor-ts (bun) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-java (jvm) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka.net (dotnet) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-scala (jvm) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| nact (bun) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| orleans (dotnet) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-java (jvm) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-scala (jvm) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| xstate (bun) | 2026-08-29 | 0.17.0 | `7ac004f8` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |

## Arms

`rounds` is how many interleaved measurements each published row averages.
A single round is not a measurement on a machine that is not otherwise
idle — see the spread column in the tables below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.17.0 | TypeScript | MIT | bun 1.4.0 | 100 |
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

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.4.0 | 327,380 actor/s | ± 7.8 % | 3.07 µs | 170.41 µs | 2.48 ms | +7.3 MB |
| nact [^2] | bun 1.4.0 | 925,792 actor/s | ± 8.7 % | 1.09 µs | 73.00 µs | 1.15 ms | +6.3 MB |
| xstate [^3] | bun 1.4.0 | 251,669 actor/s | ± 5.8 % | 3.99 µs | 283.57 µs | 1.69 ms | +12.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| akka-java [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 109,377 actor/s | ± 4.9 % | 9.17 µs | 880.88 µs | 2.08 ms | — |
| akka.net [^5] | dotnet 10.0.11 | 84,479 actor/s | ± 1.8 % | 11.84 µs | 1.22 ms | 1.62 ms | — |
| akka-scala [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 101,305 actor/s | ± 4.9 % | 9.90 µs | 933.97 µs | 2.80 ms | — |
| orleans [^6] | dotnet 10.0.11 | 30,283 actor/s | ± 3.5 % | 33.06 µs | 3.11 ms | 8.15 ms | — |
| pekko-java [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 105,805 actor/s | ± 5.0 % | 9.48 µs | 902.34 µs | 2.31 ms | — |
| pekko-scala [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 95,894 actor/s | ± 4.6 % | 10.45 µs | 980.44 µs | 2.86 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 13,900,648 msg/s | ± 8.0 % | 72 ns | 60.83 µs | 441.44 µs | −1.5 MB |
| nact | bun 1.4.0 | 1,205,356 msg/s | ± 3.1 % | 830 ns | 783.28 µs | 1.37 ms | −3.5 MB |
| xstate [^8] | bun 1.4.0 | 837,584 msg/s | ± 10.4 % | 1.21 µs | 1.18 ms | 2.36 ms | −3.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 7,198,723 msg/s | ± 13.7 % | 142 ns | 135.54 µs | 481.39 µs | — |
| akka.net | dotnet 10.0.11 | 5,936,704 msg/s | ± 4.6 % | 169 ns | 167.37 µs | 196.39 µs | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 5,153,375 msg/s | ± 23.8 % | 206 ns | 194.32 µs | 492.92 µs | — |
| orleans [^10] | dotnet 10.0.11 | 693,942 msg/s | ± 8.3 % | 1.45 µs | 1.33 ms | 3.40 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 6,627,066 msg/s | ± 15.5 % | 155 ns | 148.72 µs | 421.21 µs | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 4,195,893 msg/s | ± 23.6 % | 251 ns | 241.31 µs | 531.92 µs | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 16,583,656 msg/s | ± 5.3 % | 60 ns | 528.83 µs | 1.04 ms | +0.9 MB |
| nact | bun 1.4.0 | 1,160,684 msg/s | ± 2.6 % | 862 ns | 8.54 ms | 9.98 ms | +0.6 MB |
| xstate [^8] | bun 1.4.0 | 868,879 msg/s | ± 8.9 % | 1.16 µs | 11.61 ms | 13.56 ms | +0.2 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,377,695 msg/s | ± 8.1 % | 107 ns | 1.07 ms | 1.59 ms | — |
| akka.net | dotnet 10.0.11 | 6,379,655 msg/s | ± 3.3 % | 157 ns | 1.56 ms | 1.72 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,392,564 msg/s | ± 13.0 % | 108 ns | 1.07 ms | 1.68 ms | — |
| orleans [^10] | dotnet 10.0.11 | 876,619 msg/s | ± 35.1 % | 1.26 µs | 12.53 ms | 17.88 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,842,395 msg/s | ± 7.3 % | 102 ns | 1.03 ms | 1.32 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,444,006 msg/s | ± 15.6 % | 108 ns | 1.07 ms | 1.78 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 817,189 ask/s | ± 7.4 % | 1.23 µs | 786 ns | 3.02 µs | +1.1 MB |
| nact | bun 1.4.0 | 487,023 ask/s | ± 6.4 % | 2.06 µs | 1.84 µs | 3.84 µs | +0.3 MB |
| xstate [^11] | bun 1.4.0 | 421,199 ask/s | ± 9.4 % | 2.40 µs | 1.88 µs | 5.53 µs | +1.1 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| akka-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 252,433 ask/s | ± 7.5 % | 3.99 µs | 3.58 µs | 8.04 µs | — |
| akka.net | dotnet 10.0.11 | 309,069 ask/s | ± 3.9 % | 3.24 µs | 3.17 µs | 4.06 µs | — |
| akka-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 264,659 ask/s | ± 8.1 % | 3.80 µs | 3.46 µs | 8.76 µs | — |
| orleans | dotnet 10.0.11 | 198,197 ask/s | ± 23.5 % | 5.30 µs | 5.19 µs | 6.54 µs | — |
| pekko-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 261,578 ask/s | ± 6.6 % | 3.84 µs | 3.47 µs | 7.76 µs | — |
| pekko-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 266,809 ask/s | ± 9.1 % | 3.78 µs | 3.48 µs | 8.90 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 2,262,927 exchange/s | ± 7.7 % | 445 ns | 4.43 ms | 5.08 ms | −3.5 MB |
| nact | bun 1.4.0 | 591,154 exchange/s | ± 3.7 % | 1.69 µs | 16.84 ms | 18.60 ms | −0.2 MB |
| xstate | bun 1.4.0 | 480,520 exchange/s | ± 6.0 % | 2.09 µs | 21.04 ms | 24.29 ms | +2.5 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | spread | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,040,048 exchange/s | ± 3.0 % | 491 ns | 4.92 ms | 5.25 ms | — |
| akka.net | dotnet 10.0.11 | 494,781 exchange/s | ± 7.4 % | 2.03 µs | 20.02 ms | 28.72 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,010,089 exchange/s | ± 2.7 % | 498 ns | 5.00 ms | 5.32 ms | — |
| orleans [^14] | dotnet 10.0.11 | 358,702 exchange/s | ± 14.0 % | 2.85 µs | 27.48 ms | 37.89 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,034,470 exchange/s | ± 3.2 % | 492 ns | 4.93 ms | 5.25 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,024,689 exchange/s | ± 2.9 % | 494 ns | 4.97 ms | 5.25 ms | — |

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
