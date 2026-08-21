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
| actor-ts (bun) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-java (jvm) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka.net (dotnet) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| akka-scala (jvm) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| nact (bun) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| orleans (dotnet) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-java (jvm) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| pekko-scala (jvm) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |
| xstate (bun) | 2026-08-21 | 0.16.0 | `7a4a42fc` | 12th Gen Intel(R) Core(TM) i9-12900K | 10 | 94.0 GiB | linux 6.12.99-production+truenas (x64) |

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
| actor-ts [^1] | bun 1.4.0 | 326,256 actor/s | ± 7.5 % | 3.08 µs | 171.64 µs | 2.52 ms | +7.3 MB |
| nact [^2] | bun 1.4.0 | 908,219 actor/s | ± 8.6 % | 1.11 µs | 75.31 µs | 1.21 ms | +6.9 MB |
| xstate [^3] | bun 1.4.0 | 250,671 actor/s | ± 5.8 % | 4.00 µs | 281.50 µs | 1.74 ms | +12.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 104,445 actor/s | ± 7.0 % | 9.62 µs | 917.61 µs | 2.68 ms | — |
| akka.net [^5] | dotnet 10.0.11 | 84,732 actor/s | ± 2.2 % | 11.81 µs | 1.21 ms | 1.61 ms | — |
| akka-scala [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 97,748 actor/s | ± 5.1 % | 10.26 µs | 974.20 µs | 2.95 ms | — |
| orleans [^6] | dotnet 10.0.11 | 29,797 actor/s | ± 3.6 % | 33.61 µs | 3.16 ms | 8.21 ms | — |
| pekko-java [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 104,056 actor/s | ± 4.9 % | 9.63 µs | 913.98 µs | 2.44 ms | — |
| pekko-scala [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 92,236 actor/s | ± 4.9 % | 10.87 µs | 1.02 ms | 2.99 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 13,654,593 msg/s | ± 7.8 % | 74 ns | 60.81 µs | 439.77 µs | −1.5 MB |
| nact | bun 1.4.0 | 1,192,666 msg/s | ± 3.5 % | 840 ns | 791.85 µs | 1.38 ms | −4.6 MB |
| xstate [^8] | bun 1.4.0 | 823,217 msg/s | ± 9.1 % | 1.22 µs | 1.20 ms | 2.22 ms | −1.9 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 7,031,789 msg/s | ± 16.4 % | 146 ns | 139.11 µs | 495.06 µs | — |
| akka.net | dotnet 10.0.11 | 5,926,112 msg/s | ± 4.5 % | 169 ns | 167.65 µs | 194.20 µs | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 5,057,621 msg/s | ± 25.4 % | 211 ns | 202.35 µs | 478.73 µs | — |
| orleans [^10] | dotnet 10.0.11 | 682,992 msg/s | ± 8.8 % | 1.47 µs | 1.39 ms | 3.34 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 6,706,810 msg/s | ± 16.0 % | 154 ns | 147.50 µs | 555.48 µs | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 4,329,235 msg/s | ± 22.1 % | 241 ns | 230.07 µs | 474.34 µs | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 15,860,952 msg/s | ± 5.7 % | 63 ns | 534.11 µs | 1.11 ms | +2.3 MB |
| nact | bun 1.4.0 | 1,157,520 msg/s | ± 2.1 % | 864 ns | 8.59 ms | 9.94 ms | +0.5 MB |
| xstate [^8] | bun 1.4.0 | 881,974 msg/s | ± 8.6 % | 1.14 µs | 11.42 ms | 13.54 ms | +0.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,186,143 msg/s | ± 7.4 % | 109 ns | 1.09 ms | 1.58 ms | — |
| akka.net | dotnet 10.0.11 | 6,390,694 msg/s | ± 2.9 % | 157 ns | 1.56 ms | 1.68 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 8,953,818 msg/s | ± 9.7 % | 113 ns | 1.11 ms | 1.93 ms | — |
| orleans [^10] | dotnet 10.0.11 | 798,042 msg/s | ± 34.5 % | 1.35 µs | 13.68 ms | 19.01 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,512,235 msg/s | ± 9.4 % | 106 ns | 1.06 ms | 1.55 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 9,593,688 msg/s | ± 12.7 % | 106 ns | 1.04 ms | 1.75 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 809,498 ask/s | ± 9.0 % | 1.25 µs | 826 ns | 3.03 µs | +1.2 MB |
| nact | bun 1.4.0 | 484,981 ask/s | ± 5.8 % | 2.07 µs | 1.85 µs | 3.84 µs | +0.2 MB |
| xstate [^11] | bun 1.4.0 | 425,836 ask/s | ± 7.5 % | 2.36 µs | 1.81 µs | 5.44 µs | +1.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 251,694 ask/s | ± 8.6 % | 4.01 µs | 3.60 µs | 7.96 µs | — |
| akka.net | dotnet 10.0.11 | 306,154 ask/s | ± 4.4 % | 3.27 µs | 3.20 µs | 4.10 µs | — |
| akka-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 261,382 ask/s | ± 7.9 % | 3.85 µs | 3.53 µs | 8.76 µs | — |
| orleans | dotnet 10.0.11 | 188,171 ask/s | ± 23.8 % | 5.59 µs | 5.49 µs | 6.82 µs | — |
| pekko-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 256,891 ask/s | ± 7.8 % | 3.92 µs | 3.53 µs | 7.73 µs | — |
| pekko-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 264,148 ask/s | ± 9.4 % | 3.82 µs | 3.48 µs | 8.94 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.4.0 | 2,265,381 exchange/s | ± 7.9 % | 444 ns | 4.44 ms | 4.99 ms | −2.8 MB |
| nact | bun 1.4.0 | 585,031 exchange/s | ± 3.5 % | 1.71 µs | 16.98 ms | 19.17 ms | −0.2 MB |
| xstate | bun 1.4.0 | 480,162 exchange/s | ± 6.1 % | 2.09 µs | 20.88 ms | 24.39 ms | +2.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,993,830 exchange/s | ± 2.6 % | 502 ns | 5.01 ms | 5.36 ms | — |
| akka.net | dotnet 10.0.11 | 497,639 exchange/s | ± 7.4 % | 2.02 µs | 19.75 ms | 29.52 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,960,035 exchange/s | ± 3.0 % | 511 ns | 5.12 ms | 5.43 ms | — |
| orleans [^14] | dotnet 10.0.11 | 362,617 exchange/s | ± 9.8 % | 2.79 µs | 26.52 ms | 38.87 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,993,457 exchange/s | ± 2.6 % | 502 ns | 5.01 ms | 5.36 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,002,318 exchange/s | ± 2.1 % | 500 ns | 5.00 ms | 5.27 ms | — |

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
