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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `62ea5d59` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-18 | 0.16.0 | `62ea5d59` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `62ea5d59` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-18 | 0.16.0 | `62ea5d59` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| vanilla (bun) | 2026-08-18 | 0.16.0 | `62ea5d59` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `62ea5d59` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

## Arms

`rounds` is how many interleaved measurements each published row is the
median of.  A single round is not a measurement on a machine that is not
otherwise idle — see the spread note below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.1 | 9 |
| akka | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 9 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.3.1 | 9 |
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
| actor-ts [^1] | bun 1.3.1 | 48,613 actor/s | 20.57 µs | 1.51 ms | 11.07 ms | +13.7 MB |
| nact [^2] | bun 1.3.1 | 211,510 actor/s | 4.73 µs | 372.50 µs | 3.39 ms | +26.4 MB |
| vanilla [^3] | bun 1.3.1 | 5,207,520 actor/s | 192 ns | 15.50 µs | 82.20 µs | +0.8 MB |
| xstate [^4] | bun 1.3.1 | 66,716 actor/s | 14.99 µs | 1.09 ms | 8.24 ms | +29.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^5] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 23,207 actor/s | 43.09 µs | 4.25 ms | 6.70 ms | — |
| pekko [^6] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 21,945 actor/s | 45.57 µs | 4.32 ms | 7.87 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 890,946 msg/s | 1.12 µs | 930.30 µs | 3.65 ms | −1.4 MB |
| nact | bun 1.3.1 | 390,841 msg/s | 2.56 µs | 2.44 ms | 5.18 ms | +0.0 MB |
| vanilla [^7] | bun 1.3.1 | 222,915,738 msg/s | 4 ns | 3.40 µs | 17.80 µs | +0.2 MB |
| xstate [^8] | bun 1.3.1 | 196,593 msg/s | 5.09 µs | 4.25 ms | 23.05 ms | −76.1 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,031,963 msg/s | 492 ns | 488.30 µs | 743.30 µs | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,268,458 msg/s | 788 ns | 773.40 µs | 1.52 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 979,351 msg/s | 1.02 µs | 9.08 ms | 12.23 ms | −32.0 MB |
| nact | bun 1.3.1 | 410,817 msg/s | 2.43 µs | 23.37 ms | 27.65 ms | −0.3 MB |
| vanilla [^7] | bun 1.3.1 | 517,687,662 msg/s | 2 ns | 16.40 µs | 59.70 µs | +0.0 MB |
| xstate [^8] | bun 1.3.1 | 177,804 msg/s | 5.62 µs | 47.24 ms | 81.53 ms | −33.8 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,727,669 msg/s | 367 ns | 3.67 ms | 5.35 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,736,565 msg/s | 365 ns | 3.74 ms | 4.34 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 110,462 ask/s | 9.05 µs | 7.30 µs | 25.60 µs | +10.1 MB |
| nact | bun 1.3.1 | 130,387 ask/s | 7.67 µs | 6.30 µs | 20.90 µs | +10.8 MB |
| vanilla [^9] | bun 1.3.1 | 651,093 ask/s | 1.54 µs | 800 ns | 12.60 µs | +5.0 MB |
| xstate [^10] | bun 1.3.1 | 48,581 ask/s | 20.58 µs | 15.90 µs | 58.80 µs | +6.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 20,228 ask/s | 49.44 µs | 44.30 µs | 117.20 µs | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 19,613 ask/s | 50.99 µs | 47.10 µs | 107.30 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 111,864 exchange/s | 8.94 µs | 76.14 ms | 118.89 ms | −33.7 MB |
| nact | bun 1.3.1 | 159,200 exchange/s | 6.28 µs | 50.69 ms | 84.93 ms | −12.2 MB |
| vanilla [^11] | bun 1.3.1 | 336,021,505 exchange/s | 3 ns | 26.80 µs | 42.30 µs | +0.4 MB |
| xstate | bun 1.3.1 | 68,905 exchange/s | 14.51 µs | 145.55 ms | 166.22 ms | −14.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 315,427 exchange/s | 3.17 µs | 32.08 ms | 41.96 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 354,939 exchange/s | 2.82 µs | 28.89 ms | 34.57 ms | — |

## Notes

[^1]: One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.
[^2]: nact creates actors synchronously — `initialStateFunc` has run for the whole batch when the spawn loop returns — so only the stops are awaited.
[^3]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Construction and disposal are synchronous, so there is no start to wait for.
[^4]: XState starts and stops actors synchronously; confirmation is a snapshot status read.
[^5]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Akka Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^6]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Pekko Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^7]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.
[^8]: XState processes events synchronously on the caller's stack — this row does not measure a mailbox.
[^9]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  One awaited microtask is the floor for a request/response pair.
[^10]: XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, which is the idiomatic equivalent but not a native ask.
[^11]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Two objects calling each other in a loop — no scheduling between hops.

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
