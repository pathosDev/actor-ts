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
| actor-ts (bun) | 2026-08-18 | 0.16.0 | `56f5587b` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| nact (bun) | 2026-08-18 | 0.16.0 | `56f5587b` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| vanilla (bun) | 2026-08-18 | 0.16.0 | `56f5587b` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |
| xstate (bun) | 2026-08-18 | 0.16.0 | `56f5587b` | AMD Ryzen 9 7940HX with Radeon Graphics | 32 | 15.2 GiB | win32 10.0.26200 (x64) |

## Arms

`rounds` is how many interleaved measurements each published row is the
median of.  A single round is not a measurement on a machine that is not
otherwise idle — see the spread note below.

| framework | version | language | licence | runtime | rounds |
| --------- | ------- | -------- | ------- | ------- | ------ |
| actor-ts | 0.16.0 | TypeScript | MIT | bun 1.3.1 | 9 |
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
| actor-ts [^1] | bun 1.3.1 | 41,668 actor/s | 24.00 µs | 1.72 ms | 9.37 ms | +75.1 MB |
| nact [^2] | bun 1.3.1 | 156,591 actor/s | 6.39 µs | 496.10 µs | 4.48 ms | +35.4 MB |
| vanilla [^3] | bun 1.3.1 | 3,538,570 actor/s | 283 ns | 24.10 µs | 82.40 µs | +2.1 MB |
| xstate [^4] | bun 1.3.1 | 58,616 actor/s | 17.06 µs | 1.24 ms | 9.34 ms | +40.4 MB |

## tell-throughput

Fire-and-forget messages into one actor and read back how many it handled.

### batch=1k

100 measured iterations of 1,000 msg(s) each — 100,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 849,504 msg/s | 1.18 µs | 1.01 ms | 3.79 ms | +9.1 MB |
| nact | bun 1.3.1 | 365,928 msg/s | 2.73 µs | 2.49 ms | 4.63 ms | +13.8 MB |
| vanilla [^5] | bun 1.3.1 | 194,476,857 msg/s | 5 ns | 3.40 µs | 44.40 µs | +0.2 MB |
| xstate [^6] | bun 1.3.1 | 192,500 msg/s | 5.19 µs | 4.37 ms | 12.62 ms | −12.7 MB |

### batch=10k

30 measured iterations of 10,000 msg(s) each — 300,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 899,568 msg/s | 1.11 µs | 10.75 ms | 14.08 ms | −32.4 MB |
| nact | bun 1.3.1 | 403,790 msg/s | 2.48 µs | 23.58 ms | 28.44 ms | −17.8 MB |
| vanilla [^5] | bun 1.3.1 | 581,620,783 msg/s | 2 ns | 13.90 µs | 53.40 µs | +0.0 MB |
| xstate [^6] | bun 1.3.1 | 208,810 msg/s | 4.79 µs | 47.38 ms | 58.81 ms | −22.4 MB |

## ask-round-trip

Sequential request/response round trips, depth 1 — a latency measurement, so the percentiles are the point and throughput is derived.

### sequential

5,000 measured iterations of 1 ask(s) each — 5,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 102,965 ask/s | 9.71 µs | 7.80 µs | 27.30 µs | +4.4 MB |
| nact | bun 1.3.1 | 111,102 ask/s | 9.00 µs | 6.90 µs | 27.70 µs | +5.2 MB |
| vanilla [^7] | bun 1.3.1 | 495,162 ask/s | 2.02 µs | 1.00 µs | 13.60 µs | +7.3 MB |
| xstate [^8] | bun 1.3.1 | 67,162 ask/s | 14.89 µs | 11.70 µs | 48.00 µs | +11.5 MB |

## ping-pong

Two actors volleying — the scheduler with nothing else in the way.

### exchanges=10k

20 measured iterations of 10,000 exchange(s) each — 200,000 operations per arm, every one of them completion-verified.

**JavaScript — same machine, same harness**

| framework | runtime | throughput | per op | p50 | p99 | ΔRSS |
| --------- | ------- | ---------- | ------ | --- | --- | ---- |
| actor-ts | bun 1.3.1 | 138,390 exchange/s | 7.23 µs | 72.39 ms | 77.09 ms | −22.0 MB |
| nact | bun 1.3.1 | 196,615 exchange/s | 5.09 µs | 49.89 ms | 60.78 ms | −7.6 MB |
| vanilla [^9] | bun 1.3.1 | 341,064,120 exchange/s | 3 ns | 26.80 µs | 65.10 µs | +0.0 MB |
| xstate | bun 1.3.1 | 69,832 exchange/s | 14.32 µs | 139.30 ms | 163.48 ms | −19.5 MB |

## Notes

[^1]: One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.
[^2]: nact creates actors synchronously — `initialStateFunc` has run for the whole batch when the spawn loop returns — so only the stops are awaited.
[^3]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Construction and disposal are synchronous, so there is no start to wait for.
[^4]: XState starts and stops actors synchronously; confirmation is a snapshot status read.
[^5]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.
[^6]: XState processes events synchronously on the caller's stack — this row does not measure a mailbox.
[^7]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  One awaited microtask is the floor for a request/response pair.
[^8]: XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, which is the idiomatic equivalent but not a native ask.
[^9]: Floor, not a framework: direct calls with no mailbox, supervision, lifecycle or back-pressure.  Two objects calling each other in a loop — no scheduling between hops.

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
