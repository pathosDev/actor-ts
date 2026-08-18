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
the noise here, and it is why each row below is the median of several
interleaved rounds rather than one run, and why a 10 % gap between two arms
should be read as "about the same".

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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka.net (dotnet) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| orleans (dotnet) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| vanilla (bun) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `f15accb9` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

## Arms

`rounds` is how many interleaved measurements each published row is the
median of.  A single round is not a measurement on a machine that is not
otherwise idle — see the spread note below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.1 | 9 |
| akka | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 9 |
| akka.net | 1.5.70 | C# | Apache-2.0 | dotnet 10.0.9 | 9 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.3.1 | 9 |
| orleans | 10.2.2 | C# | MIT | dotnet 10.0.9 | 9 |
| pekko | 1.6.0 | Java | Apache-2.0 | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 9 |
| vanilla | n/a | TypeScript | MIT | bun 1.3.1 | 9 |
| xstate | 5.32.5 | TypeScript | MIT | bun 1.3.1 | 9 |

## spawn

Create a batch of actors and take them through their full lifecycle — spawn, confirmed start, stop, confirmed stop.

### batch=100

100 measured iterations of 100 actor(s) each — 10,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.3.1 | 40,654 actor/s | 24.60 µs | 1.90 ms | 9.65 ms | +23.7 MB |
| nact [^2] | bun 1.3.1 | 180,081 actor/s | 5.55 µs | 416.70 µs | 4.79 ms | +23.8 MB |
| vanilla [^3] | bun 1.3.1 | 4,537,205 actor/s | 220 ns | 17.00 µs | 122.30 µs | +0.8 MB |
| xstate [^4] | bun 1.3.1 | 54,649 actor/s | 18.30 µs | 1.42 ms | 9.12 ms | +22.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^5] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,745 actor/s | 40.41 µs | 3.92 ms | 6.80 ms | — |
| akka.net [^6] | dotnet 10.0.9 | 31,897 actor/s | 31.35 µs | 2.99 ms | 8.89 ms | — |
| orleans [^7] | dotnet 10.0.9 | 4,909 actor/s | 203.70 µs | 20.01 ms | 35.54 ms | — |
| pekko [^8] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,185 actor/s | 41.35 µs | 4.14 ms | 6.21 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 806,727 msg/s | 1.24 µs | 1.06 ms | 3.99 ms | −1.5 MB |
| nact | bun 1.3.1 | 362,302 msg/s | 2.76 µs | 2.54 ms | 5.94 ms | −0.9 MB |
| vanilla [^9] | bun 1.3.1 | 209,687,566 msg/s | 5 ns | 3.40 µs | 18.70 µs | +0.3 MB |
| xstate [^10] | bun 1.3.1 | 161,215 msg/s | 6.20 µs | 5.46 ms | 24.98 ms | −36.9 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,171,855 msg/s | 460 ns | 446.00 µs | 960.80 µs | — |
| akka.net | dotnet 10.0.9 | 1,314,741 msg/s | 761 ns | 745.30 µs | 1.39 ms | — |
| orleans [^11] | dotnet 10.0.9 | 298,687 msg/s | 3.35 µs | 3.28 ms | 6.45 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,289,218 msg/s | 776 ns | 761.70 µs | 1.43 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 897,407 msg/s | 1.11 µs | 10.97 ms | 15.37 ms | −0.3 MB |
| nact | bun 1.3.1 | 373,470 msg/s | 2.68 µs | 26.70 ms | 32.34 ms | −1.6 MB |
| vanilla [^9] | bun 1.3.1 | 479,080,166 msg/s | 2 ns | 16.60 µs | 80.30 µs | +0.0 MB |
| xstate [^10] | bun 1.3.1 | 175,622 msg/s | 5.69 µs | 55.92 ms | 72.78 ms | −3.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,921,696 msg/s | 342 ns | 3.46 ms | 4.18 ms | — |
| akka.net | dotnet 10.0.9 | 1,334,329 msg/s | 749 ns | 7.03 ms | 16.03 ms | — |
| orleans [^11] | dotnet 10.0.9 | 599,756 msg/s | 1.67 µs | 16.57 ms | 19.65 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,025,108 msg/s | 331 ns | 3.26 ms | 4.40 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 86,633 ask/s | 11.54 µs | 9.20 µs | 37.20 µs | +7.4 MB |
| nact | bun 1.3.1 | 110,082 ask/s | 9.08 µs | 6.60 µs | 26.60 µs | +9.0 MB |
| vanilla [^12] | bun 1.3.1 | 564,583 ask/s | 1.77 µs | 900 ns | 14.40 µs | +5.2 MB |
| xstate [^13] | bun 1.3.1 | 67,540 ask/s | 14.81 µs | 10.40 µs | 52.00 µs | +7.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^14] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 22,881 ask/s | 43.70 µs | 40.50 µs | 113.80 µs | — |
| akka.net | dotnet 10.0.9 | 114,581 ask/s | 8.73 µs | 7.30 µs | 24.60 µs | — |
| orleans | dotnet 10.0.9 | 138,385 ask/s | 7.23 µs | 5.60 µs | 20.90 µs | — |
| pekko [^14] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 20,891 ask/s | 47.87 µs | 47.10 µs | 106.80 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 125,314 exchange/s | 7.98 µs | 79.37 ms | 89.22 ms | −13.2 MB |
| nact | bun 1.3.1 | 183,518 exchange/s | 5.45 µs | 53.78 ms | 62.79 ms | −12.3 MB |
| vanilla [^15] | bun 1.3.1 | 328,785,139 exchange/s | 3 ns | 27.00 µs | 67.50 µs | +2.9 MB |
| xstate | bun 1.3.1 | 84,742 exchange/s | 11.80 µs | 116.33 ms | 151.57 ms | −33.7 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 391,080 exchange/s | 2.56 µs | 25.36 ms | 29.18 ms | — |
| akka.net | dotnet 10.0.9 | 447,407 exchange/s | 2.24 µs | 20.60 ms | 29.32 ms | — |
| orleans [^16] | dotnet 10.0.9 | 167,717 exchange/s | 5.96 µs | 60.07 ms | 63.95 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 386,603 exchange/s | 2.59 µs | 25.94 ms | 33.54 ms | — |

## Notes

[^1]: One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.
[^2]: nact creates actors synchronously — `initialStateFunc` has run for the whole batch when the spawn loop returns — so only the stops are awaited.
[^3]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Construction and disposal are synchronous, so there is no start to wait for.
[^4]: XState starts and stops actors synchronously; confirmation is a snapshot status read.
[^5]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Akka Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^6]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination, driven through a coordinator actor so the counting matches the other cross-language arms.
[^7]: Orleans has no caller-visible create or stop: a grain activates on first call and deactivates on its own schedule. This row is first-call activation latency for a batch of fresh grain identities; deactivation is requested but not awaited, because nothing surfaces its completion to the caller.
[^8]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Pekko Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^9]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.
[^10]: XState processes events synchronously on the caller's stack — this row does not measure a mailbox.
[^11]: [OneWay] is the nearest equivalent of a fire-and-forget send, but it is a one-way RPC rather than a mailbox enqueue.
[^12]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  One awaited microtask is the floor for a request/response pair.
[^13]: XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, which is the idiomatic equivalent but not a native ask.
[^14]: Driven from a non-actor thread, where Java has no non-blocking wait: each round trip parks and unparks a thread on a CompletableFuture. The .NET arms await instead and land ~5x higher on this row, so read it as the cost of asking from outside the actor system on this runtime, not as the framework's messaging speed — its tell throughput is the highest in the table.
[^15]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Two objects calling each other in a loop — no scheduling between hops.
[^16]: A driven chain of awaited grain calls rather than two mailboxes volleying — the closest deadlock-free analogue in a virtual-actor model.

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
