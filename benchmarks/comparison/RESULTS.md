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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `208b32ff-dirty` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-18 | 0.16.0 | `208b32ff-dirty` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `208b32ff-dirty` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| pekko (jvm) | 2026-08-18 | 0.16.0 | `208b32ff-dirty` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| vanilla (bun) | 2026-08-18 | 0.16.0 | `208b32ff-dirty` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `208b32ff-dirty` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

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
| actor-ts [^1] | bun 1.3.1 | 48,089 actor/s | 20.79 µs | 1.54 ms | 9.41 ms | +25.9 MB |
| nact [^2] | bun 1.3.1 | 214,482 actor/s | 4.66 µs | 344.90 µs | 3.48 ms | +24.7 MB |
| vanilla [^3] | bun 1.3.1 | 5,042,864 actor/s | 198 ns | 16.30 µs | 67.70 µs | +1.0 MB |
| xstate [^4] | bun 1.3.1 | 67,298 actor/s | 14.86 µs | 1.07 ms | 7.35 ms | +28.1 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^5] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 24,196 actor/s | 41.33 µs | 4.05 ms | 6.59 ms | — |
| pekko [^6] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 23,032 actor/s | 43.42 µs | 4.26 ms | 7.18 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 895,292 msg/s | 1.12 µs | 955.80 µs | 3.45 ms | −0.7 MB |
| nact | bun 1.3.1 | 380,849 msg/s | 2.63 µs | 2.53 ms | 5.60 ms | −0.7 MB |
| vanilla [^7] | bun 1.3.1 | 221,729,490 msg/s | 5 ns | 3.40 µs | 17.70 µs | +0.3 MB |
| xstate [^8] | bun 1.3.1 | 192,955 msg/s | 5.18 µs | 4.44 ms | 14.05 ms | −75.7 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,325,430 msg/s | 430 ns | 415.70 µs | 859.00 µs | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 1,295,951 msg/s | 772 ns | 784.20 µs | 1.54 ms | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 994,828 msg/s | 1.01 µs | 8.89 ms | 12.26 ms | −0.1 MB |
| nact | bun 1.3.1 | 408,643 msg/s | 2.45 µs | 23.48 ms | 27.75 ms | +0.6 MB |
| vanilla [^7] | bun 1.3.1 | 585,023,401 msg/s | 2 ns | 13.90 µs | 67.40 µs | +0.0 MB |
| xstate [^8] | bun 1.3.1 | 182,462 msg/s | 5.48 µs | 49.65 ms | 78.36 ms | −32.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,011,150 msg/s | 332 ns | 3.40 ms | 3.82 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 3,176,206 msg/s | 315 ns | 3.23 ms | 4.73 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 107,836 ask/s | 9.27 µs | 7.10 µs | 29.60 µs | +10.5 MB |
| nact | bun 1.3.1 | 131,646 ask/s | 7.60 µs | 6.20 µs | 21.40 µs | +9.9 MB |
| vanilla [^9] | bun 1.3.1 | 662,252 ask/s | 1.51 µs | 800 ns | 11.70 µs | +5.1 MB |
| xstate [^10] | bun 1.3.1 | 53,172 ask/s | 18.81 µs | 14.40 µs | 55.10 µs | +6.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 22,380 ask/s | 44.68 µs | 40.80 µs | 89.30 µs | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 21,030 ask/s | 47.55 µs | 45.20 µs | 89.30 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 115,047 exchange/s | 8.69 µs | 74.20 ms | 117.34 ms | −36.7 MB |
| nact | bun 1.3.1 | 162,339 exchange/s | 6.16 µs | 51.78 ms | 84.41 ms | −11.7 MB |
| vanilla [^11] | bun 1.3.1 | 352,795,908 exchange/s | 3 ns | 26.60 µs | 39.00 µs | +0.2 MB |
| xstate | bun 1.3.1 | 68,816 exchange/s | 14.53 µs | 143.77 ms | 167.04 ms | −20.1 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 449,822 exchange/s | 2.22 µs | 22.31 ms | 29.30 ms | — |
| pekko | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 419,680 exchange/s | 2.38 µs | 24.04 ms | 29.63 ms | — |

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
