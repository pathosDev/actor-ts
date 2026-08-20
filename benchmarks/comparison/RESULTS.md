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
| actor-ts (bun) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-java (jvm) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka.net (dotnet) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-scala (jvm) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| nact (bun) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| orleans (dotnet) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-java (jvm) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-scala (jvm) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| xstate (bun) | 2026-08-20 | 0.16.0 | `2d94f69c` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |

## Arms

`rounds` is how many interleaved measurements each published row averages.
A single round is not a measurement on a machine that is not otherwise
idle — see the spread column in the tables below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.14 | 100 |
| akka-java | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| akka.net | 1.5.70 | C# | Apache-2.0 | dotnet 10.0.11 | 100 |
| akka-scala | 2.8.8 | Scala 3 | BUSL-1.1 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.3.14 | 100 |
| orleans | 10.2.2 | C# | MIT | dotnet 10.0.11 | 100 |
| pekko-java | 1.6.0 | Java | Apache-2.0 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| pekko-scala | 1.6.0 | Scala 3 | Apache-2.0 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 100 |
| xstate | 5.32.5 | TypeScript | MIT | bun 1.3.14 | 100 |

## spawn

Create a batch of actors and take them through their full lifecycle — spawn, confirmed start, stop, confirmed stop.

### batch=100

100 measured iterations of 100 actor(s) each — 10,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.3.14 | 354,652 actor/s | ± 9.3 % | 2.85 µs | 225.42 µs | 2.27 ms | +30.2 MB |
| nact [^2] | bun 1.3.14 | 697,751 actor/s | ± 7.7 % | 1.44 µs | 105.30 µs | 1.28 ms | +16.9 MB |
| xstate [^3] | bun 1.3.14 | 331,593 actor/s | ± 7.5 % | 3.04 µs | 267.95 µs | 1.28 ms | +15.7 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 104,889 actor/s | ± 4.9 % | 9.56 µs | 915.63 µs | 2.22 ms | — |
| akka.net [^5] | dotnet 10.0.11 | 84,681 actor/s | ± 1.9 % | 11.81 µs | 1.21 ms | 1.62 ms | — |
| akka-scala [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 97,341 actor/s | ± 5.5 % | 10.31 µs | 983.43 µs | 2.96 ms | — |
| orleans [^6] | dotnet 10.0.11 | 30,009 actor/s | ± 4.0 % | 33.38 µs | 3.15 ms | 8.08 ms | — |
| pekko-java [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 102,488 actor/s | ± 5.2 % | 9.79 µs | 925.76 µs | 2.43 ms | — |
| pekko-scala [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 90,311 actor/s | ± 4.7 % | 11.10 µs | 1.04 ms | 3.35 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.14 | 13,818,694 msg/s | ± 15.0 % | 74 ns | 64.01 µs | 375.69 µs | +1.7 MB |
| nact | bun 1.3.14 | 1,592,934 msg/s | ± 2.2 % | 628 ns | 598.73 µs | 1.14 ms | +0.9 MB |
| xstate [^8] | bun 1.3.14 | 877,649 msg/s | ± 2.8 % | 1.14 µs | 1.00 ms | 5.37 ms | +7.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 7,228,924 msg/s | ± 12.2 % | 141 ns | 136.56 µs | 298.13 µs | — |
| akka.net | dotnet 10.0.11 | 5,962,087 msg/s | ± 4.6 % | 168 ns | 166.89 µs | 195.34 µs | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 5,368,883 msg/s | ± 26.1 % | 199 ns | 189.67 µs | 516.28 µs | — |
| orleans [^10] | dotnet 10.0.11 | 694,965 msg/s | ± 9.6 % | 1.45 µs | 1.36 ms | 3.35 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 6,764,171 msg/s | ± 16.3 % | 153 ns | 148.06 µs | 369.05 µs | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 4,338,533 msg/s | ± 23.6 % | 242 ns | 230.59 µs | 487.54 µs | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.14 | 19,051,980 msg/s | ± 6.2 % | 53 ns | 492.38 µs | 1.15 ms | +0.9 MB |
| nact | bun 1.3.14 | 1,635,109 msg/s | ± 1.6 % | 612 ns | 5.88 ms | 7.50 ms | +8.5 MB |
| xstate [^8] | bun 1.3.14 | 961,417 msg/s | ± 2.5 % | 1.04 µs | 10.35 ms | 11.61 ms | −48.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,175,118 msg/s | ± 6.9 % | 110 ns | 1.09 ms | 1.59 ms | — |
| akka.net | dotnet 10.0.11 | 6,373,521 msg/s | ± 3.2 % | 157 ns | 1.57 ms | 1.71 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,033,841 msg/s | ± 8.0 % | 111 ns | 1.10 ms | 1.98 ms | — |
| orleans [^10] | dotnet 10.0.11 | 792,039 msg/s | ± 29.7 % | 1.35 µs | 13.41 ms | 18.88 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,357,505 msg/s | ± 7.0 % | 107 ns | 1.07 ms | 1.61 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,366,847 msg/s | ± 14.9 % | 109 ns | 1.07 ms | 1.85 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.14 | 916,865 ask/s | ± 9.4 % | 1.10 µs | 871 ns | 2.83 µs | +0.9 MB |
| nact | bun 1.3.14 | 590,004 ask/s | ± 7.0 % | 1.70 µs | 1.48 µs | 3.21 µs | +0.8 MB |
| xstate [^11] | bun 1.3.14 | 404,790 ask/s | ± 5.7 % | 2.48 µs | 2.15 µs | 5.67 µs | +1.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 250,713 ask/s | ± 9.1 % | 4.03 µs | 3.66 µs | 7.97 µs | — |
| akka.net | dotnet 10.0.11 | 307,016 ask/s | ± 3.9 % | 3.26 µs | 3.19 µs | 4.05 µs | — |
| akka-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 261,959 ask/s | ± 10.5 % | 3.87 µs | 3.54 µs | 8.51 µs | — |
| orleans | dotnet 10.0.11 | 186,826 ask/s | ± 21.3 % | 5.58 µs | 5.47 µs | 6.86 µs | — |
| pekko-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 252,994 ask/s | ± 8.5 % | 3.99 µs | 3.60 µs | 7.96 µs | — |
| pekko-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 263,510 ask/s | ± 10.2 % | 3.83 µs | 3.49 µs | 8.70 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.14 | 2,824,859 exchange/s | ± 2.9 % | 354 ns | 3.58 ms | 4.09 ms | −0.3 MB |
| nact | bun 1.3.14 | 811,064 exchange/s | ± 1.7 % | 1.23 µs | 12.29 ms | 13.21 ms | −18.3 MB |
| xstate | bun 1.3.14 | 507,713 exchange/s | ± 1.3 % | 1.97 µs | 19.73 ms | 21.49 ms | −22.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,985,620 exchange/s | ± 2.5 % | 504 ns | 5.01 ms | 5.42 ms | — |
| akka.net | dotnet 10.0.11 | 498,937 exchange/s | ± 7.6 % | 2.02 µs | 19.97 ms | 28.96 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,943,486 exchange/s | ± 3.5 % | 515 ns | 5.19 ms | 5.51 ms | — |
| orleans [^14] | dotnet 10.0.11 | 356,936 exchange/s | ± 11.4 % | 2.84 µs | 27.65 ms | 37.61 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,986,446 exchange/s | ± 2.7 % | 504 ns | 5.03 ms | 5.43 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,992,523 exchange/s | ± 2.1 % | 502 ns | 5.03 ms | 5.32 ms | — |

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
