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
| actor-ts (bun) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka.net (dotnet) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| orleans (dotnet) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-19 | 0.16.0 | `81c863dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

## Arms

`rounds` is how many interleaved measurements each published row averages.
A single round is not a measurement on a machine that is not otherwise
idle — see the spread column in the tables below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.1 | 10 |
| akka | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 10 |
| akka.net | 1.5.70 | C# | Apache-2.0 | dotnet 10.0.9 | 10 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.3.1 | 10 |
| orleans | 10.2.2 | C# | MIT | dotnet 10.0.9 | 10 |
| pekko | 1.6.0 | Java | Apache-2.0 | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 10 |
| xstate | 5.32.5 | TypeScript | MIT | bun 1.3.1 | 10 |

## spawn

Create a batch of actors and take them through their full lifecycle — spawn, confirmed start, stop, confirmed stop.

### batch=100

100 measured iterations of 100 actor(s) each — 10,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.3.1 | 76,288 actor/s | ± 5.7 % | 13.15 µs | 971.34 µs | 7.83 ms | +31.6 MB |
| nact [^2] | bun 1.3.1 | 188,260 actor/s | ± 7.9 % | 5.35 µs | 406.48 µs | 4.91 ms | +26.0 MB |
| xstate [^3] | bun 1.3.1 | 52,691 actor/s | ± 10.3 % | 19.21 µs | 1.42 ms | 9.31 ms | +25.9 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^4] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 27,240 actor/s | ± 8.3 % | 36.95 µs | 3.71 ms | 6.18 ms | — |
| akka.net [^5] | dotnet 10.0.9 | 33,934 actor/s | ± 5.5 % | 29.56 µs | 2.84 ms | 6.15 ms | — |
| orleans [^6] | dotnet 10.0.9 | 5,136 actor/s | ± 10.6 % | 197.32 µs | 19.99 ms | 36.22 ms | — |
| pekko [^7] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 25,459 actor/s | ± 8.5 % | 39.56 µs | 3.87 ms | 6.71 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 2,998,133 msg/s | ± 9.2 % | 336 ns | 288.96 µs | 744.77 µs | +2.0 MB |
| nact | bun 1.3.1 | 366,062 msg/s | ± 2.2 % | 2.73 µs | 2.57 ms | 5.83 ms | +0.6 MB |
| xstate [^8] | bun 1.3.1 | 165,845 msg/s | ± 3.2 % | 6.04 µs | 5.32 ms | 24.11 ms | −32.9 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,261,520 msg/s | ± 8.8 % | 446 ns | 431.75 µs | 834.09 µs | — |
| akka.net | dotnet 10.0.9 | 1,392,567 msg/s | ± 7.1 % | 722 ns | 702.19 µs | 990.13 µs | — |
| orleans [^9] | dotnet 10.0.9 | 348,131 msg/s | ± 16.1 % | 2.94 µs | 2.89 ms | 6.02 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,469,291 msg/s | ± 22.1 % | 717 ns | 699.06 µs | 1.63 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 4,678,951 msg/s | ± 5.4 % | 214 ns | 1.90 ms | 5.05 ms | +0.1 MB |
| nact | bun 1.3.1 | 386,096 msg/s | ± 1.5 % | 2.59 µs | 25.07 ms | 31.84 ms | −0.2 MB |
| xstate [^8] | bun 1.3.1 | 179,433 msg/s | ± 5.2 % | 5.59 µs | 54.70 ms | 77.31 ms | −3.2 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,827,654 msg/s | ± 4.5 % | 354 ns | 3.54 ms | 4.42 ms | — |
| akka.net | dotnet 10.0.9 | 1,289,842 msg/s | ± 22.1 % | 812 ns | 8.07 ms | 12.33 ms | — |
| orleans [^9] | dotnet 10.0.9 | 723,352 msg/s | ± 17.6 % | 1.42 µs | 13.79 ms | 19.62 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,232,893 msg/s | ± 15.6 % | 317 ns | 3.23 ms | 3.97 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 214,641 ask/s | ± 5.2 % | 4.67 µs | 3.70 µs | 12.09 µs | +3.3 MB |
| nact | bun 1.3.1 | 105,427 ask/s | ± 10.9 % | 9.61 µs | 7.12 µs | 30.63 µs | +3.3 MB |
| xstate [^10] | bun 1.3.1 | 65,705 ask/s | ± 18.1 % | 16.09 µs | 11.74 µs | 55.91 µs | +4.5 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^11] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 23,570 ask/s | ± 9.8 % | 42.89 µs | 38.59 µs | 99.73 µs | — |
| akka.net | dotnet 10.0.9 | 107,602 ask/s | ± 23.1 % | 9.78 µs | 7.99 µs | 29.96 µs | — |
| orleans | dotnet 10.0.9 | 143,138 ask/s | ± 12.3 % | 7.10 µs | 6.02 µs | 20.13 µs | — |
| pekko [^11] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,867 ask/s | ± 8.1 % | 40.50 µs | 37.02 µs | 93.36 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 502,747 exchange/s | ± 5.2 % | 1.99 µs | 19.72 ms | 26.59 ms | −15.9 MB |
| nact | bun 1.3.1 | 191,429 exchange/s | ± 1.7 % | 5.23 µs | 52.31 ms | 56.23 ms | −13.0 MB |
| xstate | bun 1.3.1 | 92,574 exchange/s | ± 4.2 % | 10.82 µs | 107.32 ms | 123.18 ms | −17.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 459,114 exchange/s | ± 13.3 % | 2.22 µs | 22.55 ms | 28.68 ms | — |
| akka.net | dotnet 10.0.9 | 413,392 exchange/s | ± 13.4 % | 2.47 µs | 22.41 ms | 43.11 ms | — |
| orleans [^12] | dotnet 10.0.9 | 176,146 exchange/s | ± 3.1 % | 5.68 µs | 57.03 ms | 63.64 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 525,665 exchange/s | ± 8.7 % | 1.92 µs | 18.78 ms | 24.16 ms | — |

## Notes

[^1]: One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.
[^2]: nact creates actors synchronously — `initialStateFunc` has run for the whole batch when the spawn loop returns — so only the stops are awaited.
[^3]: XState starts and stops actors synchronously; confirmation is a snapshot status read.
[^4]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Akka Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^5]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination, driven through a coordinator actor so the counting matches the other cross-language arms.
[^6]: Orleans has no caller-visible create or stop: a grain activates on first call and deactivates on its own schedule. This row is first-call activation latency for a batch of fresh grain identities; deactivation is requested but not awaited, because nothing surfaces its completion to the caller.
[^7]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Pekko Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^8]: XState processes events synchronously on the caller's stack — this row does not measure a mailbox.
[^9]: [OneWay] is the nearest equivalent of a fire-and-forget send, but it is a one-way RPC rather than a mailbox enqueue.
[^10]: XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, which is the idiomatic equivalent but not a native ask.
[^11]: Driven from a non-actor thread, where Java has no non-blocking wait: each round trip parks and unparks a thread on a CompletableFuture. The .NET arms await instead and land ~5x higher on this row, so read it as the cost of asking from outside the actor system on this runtime, not as the framework's messaging speed — its tell throughput is the highest in the table.
[^12]: A driven chain of awaited grain calls rather than two mailboxes volleying — the closest deadlock-free analogue in a virtual-actor model.

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
