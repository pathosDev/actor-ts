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
| actor-ts (bun) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka.net (dotnet) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| orleans (dotnet) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-19 | 0.16.0 | `6a15c3dd` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

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
| actor-ts [^1] | bun 1.3.1 | 78,712 actor/s | ± 8.8 % | 12.82 µs | 928.03 µs | 8.66 ms | +30.1 MB |
| nact [^2] | bun 1.3.1 | 195,576 actor/s | ± 12.8 % | 5.21 µs | 384.65 µs | 5.04 ms | +25.8 MB |
| xstate [^3] | bun 1.3.1 | 65,469 actor/s | ± 7.9 % | 15.39 µs | 1.14 ms | 8.11 ms | +29.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^4] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 26,380 actor/s | ± 6.9 % | 38.09 µs | 3.78 ms | 6.52 ms | — |
| akka.net [^5] | dotnet 10.0.9 | 32,348 actor/s | ± 27.2 % | 40.95 µs | 3.18 ms | 15.96 ms | — |
| orleans [^6] | dotnet 10.0.9 | 5,056 actor/s | ± 10.0 % | 199.40 µs | 19.27 ms | 36.39 ms | — |
| pekko [^7] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,819 actor/s | ± 12.4 % | 40.89 µs | 4.01 ms | 6.74 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 2,960,450 msg/s | ± 9.4 % | 341 ns | 295.40 µs | 721.53 µs | +2.2 MB |
| nact | bun 1.3.1 | 376,091 msg/s | ± 3.9 % | 2.66 µs | 2.51 ms | 5.30 ms | −0.2 MB |
| xstate [^8] | bun 1.3.1 | 192,955 msg/s | ± 5.1 % | 5.20 µs | 4.37 ms | 22.04 ms | −69.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,406,131 msg/s | ± 9.3 % | 419 ns | 408.02 µs | 731.16 µs | — |
| akka.net | dotnet 10.0.9 | 1,303,660 msg/s | ± 23.6 % | 845 ns | 802.54 µs | 1.53 ms | — |
| orleans [^9] | dotnet 10.0.9 | 259,161 msg/s | ± 11.4 % | 3.90 µs | 3.84 ms | 6.79 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,621,160 msg/s | ± 19.9 % | 646 ns | 614.44 µs | 1.39 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 4,499,776 msg/s | ± 10.7 % | 225 ns | 2.00 ms | 5.00 ms | +0.1 MB |
| nact | bun 1.3.1 | 404,331 msg/s | ± 3.9 % | 2.48 µs | 23.78 ms | 30.42 ms | −1.1 MB |
| xstate [^8] | bun 1.3.1 | 192,032 msg/s | ± 7.7 % | 5.24 µs | 50.30 ms | 71.87 ms | −29.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,116,353 msg/s | ± 6.3 % | 322 ns | 3.20 ms | 4.21 ms | — |
| akka.net | dotnet 10.0.9 | 1,311,193 msg/s | ± 35.5 % | 1.17 µs | 10.86 ms | 20.80 ms | — |
| orleans [^9] | dotnet 10.0.9 | 528,129 msg/s | ± 15.9 % | 1.94 µs | 19.34 ms | 25.99 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,325,517 msg/s | ± 15.3 % | 307 ns | 3.05 ms | 4.12 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 222,920 ask/s | ± 6.6 % | 4.51 µs | 3.56 µs | 10.42 µs | +3.2 MB |
| nact | bun 1.3.1 | 122,581 ask/s | ± 11.3 % | 8.30 µs | 6.58 µs | 25.86 µs | +9.9 MB |
| xstate [^10] | bun 1.3.1 | 56,200 ask/s | ± 15.1 % | 18.12 µs | 13.71 µs | 56.62 µs | +6.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^11] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 23,277 ask/s | ± 7.5 % | 43.19 µs | 38.94 µs | 94.39 µs | — |
| akka.net | dotnet 10.0.9 | 127,193 ask/s | ± 35.7 % | 18.25 µs | 6.78 µs | 180.93 µs | — |
| orleans | dotnet 10.0.9 | 113,537 ask/s | ± 17.8 % | 9.15 µs | 7.86 µs | 23.44 µs | — |
| pekko [^11] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 23,145 ask/s | ± 13.8 % | 43.98 µs | 40.82 µs | 93.21 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 521,325 exchange/s | ± 8.1 % | 1.93 µs | 19.44 ms | 24.18 ms | −24.1 MB |
| nact | bun 1.3.1 | 182,987 exchange/s | ± 7.3 % | 5.49 µs | 52.67 ms | 67.87 ms | −8.6 MB |
| xstate | bun 1.3.1 | 82,675 exchange/s | ± 12.0 % | 12.25 µs | 121.87 ms | 143.46 ms | −14.0 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 450,480 exchange/s | ± 24.3 % | 2.36 µs | 23.73 ms | 29.72 ms | — |
| akka.net | dotnet 10.0.9 | 432,842 exchange/s | ± 21.1 % | 2.44 µs | 21.85 ms | 37.22 ms | — |
| orleans [^12] | dotnet 10.0.9 | 164,438 exchange/s | ± 4.1 % | 6.09 µs | 60.63 ms | 71.58 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 452,457 exchange/s | ± 34.3 % | 2.43 µs | 24.66 ms | 32.31 ms | — |

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
