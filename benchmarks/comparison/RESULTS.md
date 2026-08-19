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
| actor-ts (bun) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka-java (jvm) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka.net (dotnet) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka-scala (jvm) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| orleans (dotnet) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko-java (jvm) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko-scala (jvm) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-19 | 0.16.0 | `7ea93881` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

## Arms

`rounds` is how many interleaved measurements each published row averages.
A single round is not a measurement on a machine that is not otherwise
idle — see the spread column in the tables below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.1 | 10 |
| akka-java | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 10 |
| akka.net | 1.5.70 | C# | Apache-2.0 | dotnet 10.0.9 | 10 |
| akka-scala | 2.8.8 | Scala 3 | BUSL-1.1 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 10 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.3.1 | 10 |
| orleans | 10.2.2 | C# | MIT | dotnet 10.0.9 | 10 |
| pekko-java | 1.6.0 | Java | Apache-2.0 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 10 |
| pekko-scala | 1.6.0 | Scala 3 | Apache-2.0 | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 10 |
| xstate | 5.32.5 | TypeScript | MIT | bun 1.3.1 | 10 |

## spawn

Create a batch of actors and take them through their full lifecycle — spawn, confirmed start, stop, confirmed stop.

### batch=100

100 measured iterations of 100 actor(s) each — 10,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.3.1 | 75,350 actor/s | ± 9.6 % | 13.40 µs | 953.44 µs | 7.37 ms | +35.4 MB |
| nact [^2] | bun 1.3.1 | 191,984 actor/s | ± 7.2 % | 5.24 µs | 376.62 µs | 4.81 ms | +25.5 MB |
| xstate [^3] | bun 1.3.1 | 61,118 actor/s | ± 4.3 % | 16.39 µs | 1.18 ms | 9.21 ms | +28.1 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 27,626 actor/s | ± 9.9 % | 36.54 µs | 3.66 ms | 5.97 ms | — |
| akka.net [^5] | dotnet 10.0.9 | 33,949 actor/s | ± 6.3 % | 29.57 µs | 2.82 ms | 6.37 ms | — |
| akka-scala [^4] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 26,482 actor/s | ± 6.3 % | 37.92 µs | 3.77 ms | 5.96 ms | — |
| orleans [^6] | dotnet 10.0.9 | 4,804 actor/s | ± 13.2 % | 211.58 µs | 20.91 ms | 37.14 ms | — |
| pekko-java [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 26,507 actor/s | ± 13.8 % | 38.51 µs | 3.83 ms | 6.44 ms | — |
| pekko-scala [^7] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 27,504 actor/s | ± 13.2 % | 36.96 µs | 3.63 ms | 6.83 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 2,904,852 msg/s | ± 6.0 % | 345 ns | 287.69 µs | 810.26 µs | +2.0 MB |
| nact | bun 1.3.1 | 358,612 msg/s | ± 3.1 % | 2.79 µs | 2.63 ms | 5.58 ms | −0.1 MB |
| xstate [^8] | bun 1.3.1 | 184,966 msg/s | ± 3.6 % | 5.41 µs | 4.55 ms | 23.97 ms | −67.9 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,109,543 msg/s | ± 27.0 % | 533 ns | 514.16 µs | 974.06 µs | — |
| akka.net | dotnet 10.0.9 | 1,381,767 msg/s | ± 8.6 % | 729 ns | 714.15 µs | 1.12 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,306,151 msg/s | ± 36.9 % | 951 ns | 926.04 µs | 1.93 ms | — |
| orleans [^10] | dotnet 10.0.9 | 287,979 msg/s | ± 18.9 % | 3.59 µs | 3.57 ms | 6.63 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,713,142 msg/s | ± 28.2 % | 639 ns | 611.15 µs | 1.26 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 1,095,551 msg/s | ± 44.8 % | 1.14 µs | 1.11 ms | 2.08 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 4,551,474 msg/s | ± 8.0 % | 221 ns | 1.99 ms | 5.01 ms | +0.2 MB |
| nact | bun 1.3.1 | 389,040 msg/s | ± 2.6 % | 2.57 µs | 25.10 ms | 30.64 ms | −0.6 MB |
| xstate [^8] | bun 1.3.1 | 182,543 msg/s | ± 9.4 % | 5.53 µs | 54.10 ms | 73.15 ms | −14.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 3,141,988 msg/s | ± 8.8 % | 321 ns | 3.17 ms | 5.01 ms | — |
| akka.net | dotnet 10.0.9 | 1,355,147 msg/s | ± 17.8 % | 763 ns | 7.49 ms | 10.32 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,797,139 msg/s | ± 15.7 % | 366 ns | 3.52 ms | 6.81 ms | — |
| orleans [^10] | dotnet 10.0.9 | 575,964 msg/s | ± 25.7 % | 1.84 µs | 18.24 ms | 24.53 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 3,043,058 msg/s | ± 13.0 % | 334 ns | 3.33 ms | 5.30 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 2,839,750 msg/s | ± 46.8 % | 421 ns | 3.87 ms | 8.06 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 209,281 ask/s | ± 9.5 % | 4.82 µs | 3.55 µs | 15.88 µs | +3.2 MB |
| nact | bun 1.3.1 | 110,832 ask/s | ± 10.3 % | 9.12 µs | 6.72 µs | 29.14 µs | +3.6 MB |
| xstate [^11] | bun 1.3.1 | 57,786 ask/s | ± 17.4 % | 17.82 µs | 13.49 µs | 56.53 µs | +5.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 26,996 ask/s | ± 19.6 % | 38.83 µs | 34.94 µs | 93.86 µs | — |
| akka.net | dotnet 10.0.9 | 122,047 ask/s | ± 23.2 % | 8.61 µs | 7.21 µs | 24.59 µs | — |
| akka-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 26,549 ask/s | ± 20.7 % | 39.63 µs | 37.36 µs | 93.10 µs | — |
| orleans | dotnet 10.0.9 | 112,755 ask/s | ± 20.0 % | 9.19 µs | 7.65 µs | 22.86 µs | — |
| pekko-java [^12] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 27,986 ask/s | ± 16.5 % | 36.88 µs | 32.84 µs | 89.62 µs | — |
| pekko-scala [^13] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 35,570 ask/s | ± 51.9 % | 34.29 µs | 32.35 µs | 84.97 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 504,151 exchange/s | ± 5.5 % | 1.99 µs | 19.99 ms | 24.57 ms | −10.6 MB |
| nact | bun 1.3.1 | 165,517 exchange/s | ± 9.7 % | 6.10 µs | 61.33 ms | 77.50 ms | −14.6 MB |
| xstate | bun 1.3.1 | 83,337 exchange/s | ± 12.7 % | 12.17 µs | 121.98 ms | 140.66 ms | −14.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 403,650 exchange/s | ± 39.6 % | 2.84 µs | 29.33 ms | 36.98 ms | — |
| akka.net | dotnet 10.0.9 | 414,703 exchange/s | ± 21.4 % | 2.53 µs | 22.57 ms | 41.77 ms | — |
| akka-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 369,495 exchange/s | ± 42.0 % | 3.11 µs | 31.45 ms | 37.21 ms | — |
| orleans [^14] | dotnet 10.0.9 | 157,152 exchange/s | ± 6.6 % | 6.39 µs | 64.08 ms | 71.79 ms | — |
| pekko-java | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 342,670 exchange/s | ± 26.7 % | 3.15 µs | 32.52 ms | 41.46 ms | — |
| pekko-scala [^9] | jvm 21.0.10 (OpenJDK 64-Bit Server VM) | 602,526 exchange/s | ± 81.5 % | 2.81 µs | 29.32 ms | 33.60 ms | — |

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
