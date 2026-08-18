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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka.net (dotnet) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| orleans (dotnet) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| vanilla (bun) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `4cea6896` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

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
| orleans | 10.2.2. Commit Hash: a575888773a3b01b079c9c3720bb1553c3169997 | C# | MIT | dotnet 10.0.9 | 9 |
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
| actor-ts [^1] | bun 1.3.1 | 42,243 actor/s | 23.67 µs | 1.81 ms | 10.47 ms | +17.0 MB |
| nact [^2] | bun 1.3.1 | 162,538 actor/s | 6.15 µs | 397.00 µs | 5.40 ms | +26.5 MB |
| vanilla [^3] | bun 1.3.1 | 4,714,979 actor/s | 212 ns | 18.00 µs | 94.50 µs | +1.2 MB |
| xstate [^4] | bun 1.3.1 | 51,470 actor/s | 19.43 µs | 1.49 ms | 12.44 ms | +26.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^5] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,452 actor/s | 40.90 µs | 4.11 ms | 7.91 ms | — |
| akka.net [^6] | dotnet 10.0.9 | 31,712 actor/s | 31.53 µs | 2.99 ms | 8.68 ms | — |
| orleans [^7] | dotnet 10.0.9 | 4,844 actor/s | 206.45 µs | 21.12 ms | 33.51 ms | — |
| pekko [^8] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 22,918 actor/s | 43.63 µs | 4.14 ms | 7.38 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 813,537 msg/s | 1.23 µs | 1.01 ms | 3.87 ms | +1.1 MB |
| nact | bun 1.3.1 | 334,902 msg/s | 2.99 µs | 2.85 ms | 6.46 ms | −0.8 MB |
| vanilla [^9] | bun 1.3.1 | 207,296,849 msg/s | 5 ns | 3.40 µs | 31.90 µs | +0.3 MB |
| xstate [^10] | bun 1.3.1 | 158,319 msg/s | 6.32 µs | 5.61 ms | 25.81 ms | −38.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,079,927 msg/s | 481 ns | 469.40 µs | 958.70 µs | — |
| akka.net | dotnet 10.0.9 | 1,358,899 msg/s | 736 ns | 698.70 µs | 981.70 µs | — |
| orleans [^11] | dotnet 10.0.9 | 313,095 msg/s | 3.19 µs | 3.08 ms | 7.99 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,437,905 msg/s | 695 ns | 663.70 µs | 2.58 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 889,606 msg/s | 1.12 µs | 10.55 ms | 16.58 ms | −0.5 MB |
| nact | bun 1.3.1 | 372,270 msg/s | 2.69 µs | 26.55 ms | 32.26 ms | +0.6 MB |
| vanilla [^9] | bun 1.3.1 | 576,368,876 msg/s | 2 ns | 13.90 µs | 56.20 µs | +0.0 MB |
| xstate [^10] | bun 1.3.1 | 176,406 msg/s | 5.67 µs | 54.71 ms | 72.28 ms | −3.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,778,367 msg/s | 360 ns | 3.54 ms | 4.30 ms | — |
| akka.net | dotnet 10.0.9 | 1,245,977 msg/s | 803 ns | 8.10 ms | 9.31 ms | — |
| orleans [^11] | dotnet 10.0.9 | 591,360 msg/s | 1.69 µs | 16.97 ms | 19.90 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,926,521 msg/s | 342 ns | 3.38 ms | 5.99 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 95,641 ask/s | 10.46 µs | 8.10 µs | 31.50 µs | +8.0 MB |
| nact | bun 1.3.1 | 104,767 ask/s | 9.54 µs | 7.80 µs | 31.20 µs | +7.1 MB |
| vanilla [^12] | bun 1.3.1 | 548,480 ask/s | 1.82 µs | 900 ns | 13.30 µs | +6.7 MB |
| xstate [^13] | bun 1.3.1 | 62,683 ask/s | 15.95 µs | 11.00 µs | 65.20 µs | +5.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^14] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 21,390 ask/s | 46.75 µs | 43.70 µs | 120.30 µs | — |
| akka.net | dotnet 10.0.9 | 93,191 ask/s | 10.73 µs | 8.80 µs | 29.40 µs | — |
| orleans | dotnet 10.0.9 | 131,242 ask/s | 7.62 µs | 6.40 µs | 21.00 µs | — |
| pekko [^14] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 20,945 ask/s | 47.74 µs | 46.70 µs | 97.00 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 124,064 exchange/s | 8.06 µs | 78.93 ms | 97.91 ms | −20.7 MB |
| nact | bun 1.3.1 | 185,358 exchange/s | 5.39 µs | 53.09 ms | 60.76 ms | −9.5 MB |
| vanilla [^15] | bun 1.3.1 | 342,055,755 exchange/s | 3 ns | 26.70 µs | 43.20 µs | +0.1 MB |
| xstate | bun 1.3.1 | 86,856 exchange/s | 11.51 µs | 113.17 ms | 131.03 ms | −11.2 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 355,359 exchange/s | 2.81 µs | 28.51 ms | 30.45 ms | — |
| akka.net | dotnet 10.0.9 | 470,587 exchange/s | 2.13 µs | 21.46 ms | 23.24 ms | — |
| orleans [^16] | dotnet 10.0.9 | 162,216 exchange/s | 6.16 µs | 62.88 ms | 80.44 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 350,780 exchange/s | 2.85 µs | 29.52 ms | 32.80 ms | — |

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
