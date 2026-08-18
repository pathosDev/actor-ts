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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `b3029e85` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| akka (jvm) | 2026-08-18 | 0.16.0 | `b3029e85` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `b3029e85` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| vanilla (bun) | 2026-08-18 | 0.16.0 | `b3029e85` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `b3029e85` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

## Arms

`rounds` is how many interleaved measurements each published row is the
median of.  A single round is not a measurement on a machine that is not
otherwise idle — see the spread note below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.1 | 9 |
| akka | 2.8.8 | Java | BUSL-1.1 | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 9 |
| nact | 7.6.2 | JavaScript | Apache-2.0 | bun 1.3.1 | 9 |
| vanilla | n/a | TypeScript | MIT | bun 1.3.1 | 9 |
| xstate | 5.32.5 | TypeScript | MIT | bun 1.3.1 | 9 |

## spawn

Create a batch of actors and take them through their full lifecycle — spawn, confirmed start, stop, confirmed stop.

### batch=100

100 measured iterations of 100 actor(s) each — 10,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts [^1] | bun 1.3.1 | 47,903 actor/s | 20.88 µs | 1.50 ms | 9.09 ms | +20.4 MB |
| nact [^2] | bun 1.3.1 | 204,725 actor/s | 4.88 µs | 361.10 µs | 3.98 ms | +25.3 MB |
| vanilla [^3] | bun 1.3.1 | 5,188,337 actor/s | 193 ns | 16.00 µs | 69.20 µs | +0.9 MB |
| xstate [^4] | bun 1.3.1 | 64,095 actor/s | 15.60 µs | 1.10 ms | 9.55 ms | +33.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka [^5] | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 25,268 actor/s | 39.58 µs | 3.89 ms | 6.57 ms | — |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 877,480 msg/s | 1.14 µs | 949.10 µs | 3.25 ms | +1.8 MB |
| nact | bun 1.3.1 | 391,264 msg/s | 2.56 µs | 2.40 ms | 5.27 ms | +0.3 MB |
| vanilla [^6] | bun 1.3.1 | 220,022,002 msg/s | 5 ns | 3.40 µs | 18.20 µs | +0.3 MB |
| xstate [^7] | bun 1.3.1 | 185,761 msg/s | 5.38 µs | 4.38 ms | 21.65 ms | −73.3 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,159,935 msg/s | 463 ns | 448.60 µs | 815.60 µs | — |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 924,985 msg/s | 1.08 µs | 9.30 ms | 18.85 ms | −29.2 MB |
| nact | bun 1.3.1 | 408,624 msg/s | 2.45 µs | 23.35 ms | 28.15 ms | +0.3 MB |
| vanilla [^6] | bun 1.3.1 | 574,712,644 msg/s | 2 ns | 14.00 µs | 72.90 µs | +0.0 MB |
| xstate [^7] | bun 1.3.1 | 176,115 msg/s | 5.68 µs | 47.36 ms | 80.76 ms | −38.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 2,851,868 msg/s | 351 ns | 3.63 ms | 4.08 ms | — |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 107,128 ask/s | 9.33 µs | 7.30 µs | 26.50 µs | +10.2 MB |
| nact | bun 1.3.1 | 126,368 ask/s | 7.91 µs | 6.20 µs | 21.90 µs | +9.3 MB |
| vanilla [^8] | bun 1.3.1 | 634,389 ask/s | 1.58 µs | 900 ns | 13.10 µs | +4.0 MB |
| xstate [^9] | bun 1.3.1 | 48,951 ask/s | 20.43 µs | 15.80 µs | 56.70 µs | +6.6 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 20,375 ask/s | 49.08 µs | 45.90 µs | 106.00 µs | — |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 115,433 exchange/s | 8.66 µs | 71.98 ms | 114.69 ms | −36.8 MB |
| nact | bun 1.3.1 | 162,405 exchange/s | 6.16 µs | 49.37 ms | 92.29 ms | −10.1 MB |
| vanilla [^10] | bun 1.3.1 | 344,946,533 exchange/s | 3 ns | 26.50 µs | 54.30 µs | +0.2 MB |
| xstate | bun 1.3.1 | 71,300 exchange/s | 14.03 µs | 143.50 ms | 164.57 ms | −14.4 MB |

**Cross-language — different virtual machine, mirrored harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| akka | jvm 21.0.8 (OpenJDK 64-Bit Server VM) | 351,019 exchange/s | 2.85 µs | 28.56 ms | 34.61 ms | — |

## Notes

[^1]: One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.
[^2]: nact creates actors synchronously — `initialStateFunc` has run for the whole batch when the spawn loop returns — so only the stops are awaited.
[^3]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Construction and disposal are synchronous, so there is no start to wait for.
[^4]: XState starts and stops actors synchronously; confirmation is a snapshot status read.
[^5]: One operation is the full lifecycle: spawn, confirmed start, stop, confirmed termination. Akka Typed only lets an actor spawn actors, so the batch is driven through a guardian.
[^6]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.
[^7]: XState processes events synchronously on the caller's stack — this row does not measure a mailbox.
[^8]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  One awaited microtask is the floor for a request/response pair.
[^9]: XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, which is the idiomatic equivalent but not a native ask.
[^10]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Two objects calling each other in a loop — no scheduling between hops.

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
