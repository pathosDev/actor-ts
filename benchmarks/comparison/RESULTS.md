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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka.net (dotnet) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| orleans (dotnet) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `78969bc1` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

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
| actor-ts [^1] | bun 1.3.1 | 41,020 actor/s | ± 7.2 % | 24.51 µs | 1.85 ms | 10.61 ms | +17.3 MB |
| nact [^2] | bun 1.3.1 | 176,074 actor/s | ± 7.9 % | 5.71 µs | 442.12 µs | 5.08 ms | +25.9 MB |
| xstate [^3] | bun 1.3.1 | 51,164 actor/s | ± 20.0 % | 20.58 µs | 1.60 ms | 10.96 ms | +27.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^4] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 26,119 actor/s | ± 11.6 % | 38.90 µs | 3.80 ms | 6.61 ms | — |
| akka.net [^5] | dotnet 10.0.9 | 30,645 actor/s | ± 9.3 % | 32.93 µs | 3.14 ms | 7.34 ms | — |
| orleans [^6] | dotnet 10.0.9 | 4,830 actor/s | ± 7.3 % | 208.19 µs | 20.91 ms | 34.77 ms | — |
| pekko [^7] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,240 actor/s | ± 12.7 % | 41.95 µs | 4.12 ms | 7.79 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 780,032 msg/s | ± 10.2 % | 1.30 µs | 1.07 ms | 5.38 ms | −6.9 MB |
| nact | bun 1.3.1 | 366,249 msg/s | ± 3.2 % | 2.73 µs | 2.58 ms | 5.62 ms | −0.3 MB |
| xstate [^8] | bun 1.3.1 | 156,540 msg/s | ± 11.6 % | 6.48 µs | 5.65 ms | 26.13 ms | −36.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,204,703 msg/s | ± 10.9 % | 460 ns | 439.33 µs | 993.05 µs | — |
| akka.net | dotnet 10.0.9 | 1,245,002 msg/s | ± 16.7 % | 833 ns | 806.01 µs | 1.14 ms | — |
| orleans [^9] | dotnet 10.0.9 | 321,004 msg/s | ± 11.5 % | 3.15 µs | 3.07 ms | 7.26 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,665,097 msg/s | ± 43.3 % | 702 ns | 679.55 µs | 1.34 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 889,758 msg/s | ± 8.1 % | 1.13 µs | 10.53 ms | 16.15 ms | −2.4 MB |
| nact | bun 1.3.1 | 379,096 msg/s | ± 6.0 % | 2.65 µs | 25.59 ms | 33.48 ms | −1.1 MB |
| xstate [^8] | bun 1.3.1 | 168,014 msg/s | ± 16.8 % | 6.22 µs | 61.40 ms | 94.33 ms | −9.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,965,204 msg/s | ± 7.5 % | 339 ns | 3.40 ms | 4.23 ms | — |
| akka.net | dotnet 10.0.9 | 1,127,158 msg/s | ± 17.2 % | 916 ns | 9.19 ms | 12.55 ms | — |
| orleans [^9] | dotnet 10.0.9 | 603,010 msg/s | ± 21.2 % | 1.71 µs | 17.00 ms | 21.13 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,126,715 msg/s | ± 14.7 % | 326 ns | 3.29 ms | 4.34 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 92,496 ask/s | ± 12.9 % | 11.03 µs | 8.52 µs | 34.99 µs | +8.8 MB |
| nact | bun 1.3.1 | 104,008 ask/s | ± 12.2 % | 9.76 µs | 7.27 µs | 31.88 µs | +6.8 MB |
| xstate [^10] | bun 1.3.1 | 62,001 ask/s | ± 18.0 % | 16.82 µs | 12.11 µs | 59.90 µs | +5.9 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^11] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 23,552 ask/s | ± 14.0 % | 43.44 µs | 39.46 µs | 101.38 µs | — |
| akka.net | dotnet 10.0.9 | 105,391 ask/s | ± 23.1 % | 10.01 µs | 8.18 µs | 29.99 µs | — |
| orleans | dotnet 10.0.9 | 124,451 ask/s | ± 15.1 % | 8.21 µs | 6.91 µs | 23.06 µs | — |
| pekko [^11] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 22,780 ask/s | ± 21.6 % | 46.65 µs | 43.39 µs | 110.65 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 123,436 exchange/s | ± 6.7 % | 8.14 µs | 81.44 ms | 91.78 ms | −16.8 MB |
| nact | bun 1.3.1 | 182,160 exchange/s | ± 4.7 % | 5.50 µs | 54.65 ms | 65.63 ms | −15.4 MB |
| xstate | bun 1.3.1 | 88,314 exchange/s | ± 9.5 % | 11.44 µs | 114.71 ms | 140.89 ms | −16.1 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 466,399 exchange/s | ± 28.4 % | 2.37 µs | 23.48 ms | 30.11 ms | — |
| akka.net | dotnet 10.0.9 | 403,468 exchange/s | ± 13.0 % | 2.52 µs | 22.05 ms | 40.43 ms | — |
| orleans [^12] | dotnet 10.0.9 | 173,076 exchange/s | ± 7.5 % | 5.81 µs | 58.34 ms | 67.18 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 468,331 exchange/s | ± 31.8 % | 2.44 µs | 24.51 ms | 28.99 ms | — |

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
