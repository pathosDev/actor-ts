# Contributing to actor-ts

This document captures the conventions the project actually uses today.
Everything here came out of running PRs and commits — if you find a
gap, send a PR (preferably one that closes an issue under the rules
below).

> **Pre-1.0 reminder.**  No backwards-compatibility guarantees, no
> stable API surface, no semver promises.  Wire formats change when
> a fix is cleaner without preserving them.  See [`README.md`](./README.md)'s
> top-level disclaimer for the full warning.

## Setup

```bash
bun install                # fetches deps (Bun is the primary runtime)
bun run typecheck          # tsc --noEmit  (src only)
bun run typecheck:dev      # full workspace incl. tests + benchmarks
bun run build              # emit dist/ with declarations
```

**Runtime support targets** are Bun ≥ 1.1, Node.js ≥ 20, Deno ≥ 2.
Production code stays runtime-neutral; runtime-specific adapters live
under [`src/runtime/`](./src/runtime/) and are loaded lazily via
dynamic `import(…)`.

If you need an optional peer dep (Cassandra, S3, Redis, kafkajs, …),
install it locally — none ship as hard dependencies.

## Test layout

```text
tests/
├── unit/             # bun:test — narrow unit-of-functionality tests
├── multi-node/       # bun:test — cluster / sharding / pubsub scenarios
├── smoke/            # plain ESM — cross-runtime smoke (Bun, Node, Deno)
├── actor.test.ts     # top-level — Actor base-class behaviours
├── cluster.test.ts   # top-level — Cluster lifecycle + tombstones
└── sharding-advanced.test.ts
```

Three rules:

1. **`bun:test` is the test framework.**  No new framework allowed —
   migrating the whole suite to a runtime-neutral runner is a separate
   piece of work that hasn't been done yet.
2. **Cross-runtime checks go through `tests/smoke/`.**  That directory
   is plain-ESM only; it must run identically on Bun, Node, and Deno
   without modification.  Don't reach for `bun:test` there.
3. **Multi-node tests live under `tests/multi-node/`.**  They run
   in-process with multiple `ActorSystem` + `InMemoryTransport`
   instances; never spawn real subprocesses unless the test
   explicitly needs cross-process semantics (see
   `FilesystemObjectStorageBackend.multiprocess.test.ts` for the
   one current exception).

### Running tests

```bash
bun test                                      # full suite (~120 s)
bun test tests/unit/persistence/              # one directory
bun test tests/cluster.test.ts                # one file
bun test --coverage
```

```bash
bun run smoke:bun                             # cross-runtime smoke (Bun)
bun run smoke:node                            # cross-runtime smoke (Node, requires build)
bun run smoke:deno                            # cross-runtime smoke (Deno, requires build)
bun run smoke                                 # all three sequentially
```

### Stability discipline

Time-sensitive tests (timer-driven FSMs, gossip-cadence assertions,
TTL prunes) must run **5×** locally without a flake before being
committed.  CI runs sometimes hit slower scheduling than dev
machines — pin generous time windows (≥ 60 ms) and prefer
"3 readings stable" predicates over single-shot `waitFor` when the
metric can flutter.

## Commit conventions

```
<type>(<scope>): <short summary, imperative mood>

<one or more paragraphs explaining the why; what the change does;
trade-offs accepted; anything a future archaeologist would want to
know>

Closes #NN

Co-Authored-By: <name> <email>
```

`<type>` is one of:

| type    | when                                                     |
| ------- | -------------------------------------------------------- |
| `feat`  | new user-facing capability                               |
| `fix`   | bug or correctness fix                                   |
| `docs`  | README / CONTRIBUTING / ROADMAP / inline-doc only        |
| `chore` | release plumbing, dependency bumps, repo housekeeping    |
| `test`  | tests-only, no production-code change                    |
| `refactor` | structural change without behaviour change            |
| `ci`    | `.github/workflows/` only                                |
| `build` | `package.json` / `tsconfig*.json` / build-tool changes  |

`<scope>` matches the touched directory family — `cluster`,
`cluster/pubsub`, `persistence/cassandra`, `fsm/persistent`,
`io/broker/kafka`, `examples/chat`, `tests/multi-node/cluster-router`,
etc.  Stay specific; "core" or "misc" is almost always the wrong
answer.

The body is **mandatory** for non-trivial changes.  A one-liner is
fine for typo fixes; anything that touches behaviour deserves a
paragraph or three.

### Multi-issue close syntax — the gotcha

GitHub's auto-close parser requires **each issue number to be
prefixed with its own keyword**.  This works:

```
Closes #17. Closes #57. Closes #58.
```

This DOES NOT — only `#17` gets closed:

```
Closes #17, #57, #58.
```

If a single commit legitimately closes several issues, give each its
own `Closes` clause.  When in doubt, follow with `gh issue close NN
-c "Code shipped in <commit-sha>."` for any that didn't auto-close.

### Co-authoring trailer

When AI pair-programming was meaningfully involved, add a trailer
of the form:

```
Co-Authored-By: <Tool / Model name> <noreply@anthropic.com>
```

Example used across v1 + v2 + v3:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

This is opt-in transparency, not a quality signal in either
direction.  Hand-written commits don't need it.

## Issue-to-commit workflow

The cadence the project actually runs in:

1. **Plan a batch of issues** — group ~6-8 items spanning bugs /
   features / docs into a Mixed Shortlist.  See the existing
   plan-doc workflow under
   [`~/.claude/plans/`](https://github.com/pathosDev/actor-ts/issues)
   for shape examples (v1, v2, v3 plans are public in the issue
   tracker).
2. **One commit per issue.**  Each finished issue lands as its own
   commit with `Closes #NN` in the body — no "tier" or "batch"
   commits that bundle multiple issues.  Keeps history grep-able and
   makes individual reverts safe.
3. **`bun run typecheck` + relevant `bun test` suites green** before
   the commit.  Full-suite run before pushing the batch.
4. **README / ROADMAP updates inline with the feature commit**, not
   in a separate "docs" commit, when the user-visible surface
   changes (new exports, new opt-in option, new sample directory).
   Pure CONTRIBUTING / inline-doc cleanups are fine as `docs(...)`
   commits.

The reward: each commit is independently mergeable, the test-count
badge updates monotonically per issue, and `git log --oneline` reads
like a release-note draft.

## Release & changelog

Pre-1.0, every commit is potentially breaking — tracking a strict
release cadence isn't worth the friction.  The project ships
continuously off `main`.  [`CHANGELOG.md`](./CHANGELOG.md) groups
recent landings by theme rather than version.

When you add a notable user-visible feature or break an API, add
an entry to the top of the relevant CHANGELOG section in the same
commit.  Keep entries terse (one or two lines per landing) — the
commit body is the canonical detailed log.

## Code style

- **TypeScript strict mode**, full `strict: true` block plus
  `noUncheckedIndexedAccess` enabled.  Every test directory and
  benchmark target compiles under the same flags.
- **No `any`** outside type-erasure boundaries (interop with
  untyped peer deps, JSON parsing, dynamic-import results that
  the dependency itself doesn't type).  When `any` shows up, wrap
  it in a local `unknown` cast plus a narrowing predicate.
- **`Option<T>` over `T | null`** for "may be absent" return values
  — see [`src/util/Option.ts`](./src/util/Option.ts) for the full
  Scala-style API.  `null` is fine for "explicitly absent in the
  source data" but never as a "missing" sentinel from a returning
  function.
- **`ts-pattern`** for non-trivial discriminated-union dispatch.
  A two-arm `switch` is fine; once you're nesting or chaining,
  reach for `match(msg).with({ kind: 'foo' }, …).exhaustive()`.
- **Comments explain *why*, not *what***.  Inline doc strings
  cover the "how to use" surface; in-method comments cover
  trade-offs and gotchas the reader can't reconstruct from the
  code alone.

## What's deliberately out of scope

Things that have been considered and explicitly turned down:

- **Auto-formatting via Prettier.**  The codebase prefers visual
  groupings (aligned imports, consistent JSDoc indenting) that
  Prettier flattens.  Hand-formatted is the convention.
- **Runtime-neutral test runner.**  The `bun:test` lock-in is
  acknowledged.  Migration is its own multi-day effort that
  hasn't surfaced enough pain to schedule.
- **Conventional Commits with footers.**  Trailer-based footers
  (`Closes`, `Co-Authored-By`) are the only structured metadata.
  No `BREAKING CHANGE:` (it's pre-1.0; assume so).

## Where to file what

- **Bugs / feature requests** → [issue tracker](https://github.com/pathosDev/actor-ts/issues),
  one issue per topic, label with `priority: low | medium | high`.
- **Release-blocker bugs** → tag the issue with `priority: high`
  and reference it in the next plan-doc.
- **Roadmap items** → [`ROADMAP.md`](./ROADMAP.md) and the issue
  tracker; the plan-doc picks from those.
- **Discussions / design questions** → issue with the `enhancement`
  label, prefix the title `Design:` so it sorts cleanly.
