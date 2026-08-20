# Framework-comparison benchmarks

Measures actor-ts against neighbouring actor frameworks under one
workload, so the project can answer "how do you compare to X?" with a
number instead of an adjective (#27).

This is a **separate tree from the rest of `benchmarks/`**, with its own
manifest, its own driver and its own rules.  The suites one level up
compare actor-ts against *itself* — commit to commit, mailbox to
mailbox, runtime to runtime.  This one puts third-party code on the
other side of the table, and that changes what "fair" has to mean.

---

## Why its own manifest

`benchmarks/comparison/package.json` installs the frameworks measured
here.  The root manifest does not, and must not:

- **The shipped closure stays tiny.**  actor-ts has two runtime
  dependencies; everything else is an optional peer.  A benchmark
  target is neither — it is third-party code that exists only to be
  measured.
- **`bun run lint:audit` stays meaningful.**  It audits the root
  `bun.lock`, i.e. what users actually install.  Advisories in a
  benchmark target are not advisories in actor-ts, and letting them
  into that report would train everyone to ignore it.
- **`bun run bench` stays runnable on a clean clone.**  The driver one
  level up (`benchmarks/run-all.ts`) skips this directory by name, and
  CI's `--frozen-lockfile` root install does not carry these packages.

Bun and Node resolve `import { … } from 'nact'` by walking up from the
importing file, so an arm in `js/` reaches this directory's
`node_modules` while `../../../src/index.js` and `../../lib/harness.js`
stay ordinary relative imports.  One file, both sides.

---

## What checks this tree

| Check | Covers this tree? |
| ----- | ----------------- |
| `bun run typecheck` | no — build config, excludes `benchmarks/` |
| `bun run typecheck:bench` | no — explicitly excluded (different manifest) |
| `bun run typecheck:dev` | no — explicitly excluded (different manifest) |
| `bun run typecheck:compare` | **yes** — `benchmarks/comparison/tsconfig.json` |
| `bun run bench` / `bench:smoke` | no — skipped by the discovery driver |
| `bun run lint:knip` | only until an arm imports a framework — then ignored |
| `bun run lint:audit` | no — audits the root lockfile only |

Every "no" above is deliberate and is annotated at the site that does
the excluding.  The one "yes" is why `typecheck:compare` exists: without
it this tree would be checked by nothing, which is precisely how ten
benchmark suites sat broken on a removed export for months (#506).  The
`comparison` job in `.github/workflows/benchmarks.yml` runs it against a
frozen install of this directory, then smoke-runs the JavaScript arms.

That job covers the JavaScript arms only (`--javascript-only`): CI installs
Bun and nothing else, and adding a JDK and a .NET SDK would buy nothing —
benchmark numbers from a shared runner are noise, and what the job checks is
that the arms still *execute* against the current `src/` API.  The
cross-language arms are therefore verified by running them, which is what
every measurement does.

The knip row is the odd one out, and deliberately so.  `knip.jsonc`
treats `benchmarks/**/*.ts` as entry points and errors on any import it
cannot attribute to the root manifest — so the moment an arm imports a
framework from *this* manifest, the tree needs an `ignore` entry there.
That entry lands with the first such arm and not before: knip reports a
redundant ignore as a configuration hint, and this repo's own rule for
that file is that "an ignore entry that is not needed hides a finding
later".

---

## The fairness contract

A comparison benchmark is easy to run and hard to believe.  These are
the rules every arm follows; a result that breaks one of them is a bug,
not a finding.

1. **Completed work is measured, never intended work.**  Every arm
   asserts that the system under test actually processed the number of
   operations the harness was told about, and writes *both* counts into
   its result file.  The report generator refuses to render a row where
   they differ.

   This rule exists because the last throughput figure this project
   published was roughly 10× too high: the mailbox silently dropped 90 %
   of a synchronous enqueue and the harness computed its total from the
   batch size it had asked for (#1027, #972).  Foreign frameworks have
   bounded queues and drop policies too, and nothing about being
   third-party makes them immune.

2. **One workload, one set of constants.**  Batch sizes and iteration
   counts live in `js/workload.ts` and are mirrored — as literals, with
   a pointer back — in the cross-language runners.  The report
   generator cross-checks them and fails on divergence, because a
   constant that drifts in one runner turns the whole table into
   fiction while every individual row still looks plausible.

3. **Logging off everywhere.**  An arm that writes log lines is
   measuring its logger.

4. **One framework per subprocess.**  Module-level state, JIT profiles
   and GC pressure do not cross arms.

5. **One runtime, named.**  Every JavaScript arm runs on **Bun**, and every
   published table says so.

   This is a limitation, not a preference, and it is worth stating exactly.
   The shared harness reaches `highResNow()` in `src/runtime/Detect.ts`, so
   it pulls in `src/` — which carries the project's `.js` import suffixes
   and two `enum` declarations, neither of which Node's strip-only
   TypeScript mode can load without a build step.  Running the neighbours
   on Node would therefore mean *not* running them through the same
   harness.  An identical measurement path is the one fairness property
   this suite can actually offer rather than merely assert, so it wins.

   The cost: the JS neighbours are written for Node, and their numbers on
   their home runtime may differ from these.  Restoring that arm needs the
   harness's `src/` dependency resolvable from a build — future work, named
   here rather than quietly skipped.

6. **Semantic mismatches are labelled, never silently mapped.**  Where
   a framework has no equivalent of an operation, the arm records a
   skip with a reason rather than substituting the nearest thing and
   reporting a bare number.  Where the nearest thing *is* used, the row
   carries a note that says so, and the note travels with it into
   `RESULTS.md` and the published tables.

7. **Same-runtime and cross-language results never share a table.**
   Comparing two JavaScript frameworks on one machine is a measurement.
   Comparing a JavaScript framework to one on another virtual machine
   is a different kind of claim, and the harness on the far side is a
   mirror rather than the same code.  Both are worth publishing; mixing
   them into one ranking is not.

---

## The arms

| arm | what it is | why it is here |
| --- | ---------- | -------------- |
| **actor-ts** | this project | the reference implementation of all four scenarios |
| **nact** | the most-starred dedicated actor library for Node | the closest neighbour: same model, same runtime, functional API |
| **XState v5** | the most widely used actor implementation in JavaScript | reach — though it is a statechart library whose actors are the delivery mechanism |
| **Akka** (JVM, Java) | the reference actor implementation, on another virtual machine | the cross-language question: how much does the runtime cost us? |
| **Akka** (JVM, Scala 3) | the same framework through its native-language API | the binding question: what does the idiomatic Scala style cost against the Java one, at the same version? |
| **Pekko** (JVM, Java) | its Apache-licensed fork | what staying on Apache-2.0 costs — and a control on the JVM arm itself |
| **Pekko** (JVM, Scala 3) | the fork through *its* native-language API | the fourth corner: down a column is the licence question, across a row the binding one |
| **Akka.NET** (.NET) | the same actor model on the CLR | a third runtime for the same design, which is what makes the runtime's own contribution visible |
| **Orleans** (.NET) | virtual actors | the one genuinely different model here — grains activate on call, and three of its rows measure a near-equivalent |

Each arm's own header comment records where its framework's semantics
differ from the scenario definition, and those notes travel with the
numbers into `RESULTS.md` and every published table.  The two that matter
most: XState processes events synchronously and has no request/response
primitive, so its `ask` row is `send` + `waitFor` on a snapshot; nact
creates actors synchronously, where actor-ts defers construction to a
dispatcher turn.

### The JVM arms

`akka-java/` and `pekko-java/` are Mill modules built against the respective
Typed **Java** APIs, so the JDK is the only extra toolchain.  Their Java
sources are identical apart from the package prefix — same harness, same
actors, same result schema — which is the point: the two arms differ only in
their dependency, so any gap between them is the fork rather than the
benchmark.

The directory names carry the binding because the framework name alone stopped
being enough to identify an arm — see *The build tool* below for why they moved
to Mill, and note that the published result files, table columns and
`--framework` keys moved with them.

#### The build tool

Mill, and the same one for every JVM arm here.  Three build tools across four
cross-language arms was a variable with nothing to do with what is measured.

The launcher is committed the way the Maven wrapper was: two scripts, `mill`
and `mill.bat`, and no binary in the tree — on first run it downloads itself
from Maven Central, then the dependency closure from the same place.  On
Windows the `.bat` is not a convenience but the only entry point: the POSIX
script refuses to run anywhere that is not Linux or macOS, which is why the
driver picks between them rather than relying on a shebang.

**`.mill-version` is mandatory, not tidiness.**  The launcher scripts carry a
nightly development build as their fallback default, so a tree without the pin
would silently build with whatever that happens to be.

The JDK is pinned too, in each `build.mill`.  Mill provisions one through
coursier's JVM index rather than using whatever is on the machine; naming the
version makes that a decision rather than a default, and means two machines
measure on the same build.  The result files record the JVM either way.

**One consequence is measurement-visible and worth stating plainly.**  The
Maven goal these arms used ran the benchmark *inside Maven's own JVM* — warm,
its JIT already exercised, its heap already grown.  `run` forks a clean
process, which is what every other arm in this suite has always done.  Isolated
by running the same compiled classes three ways, the difference is not the
build tool and not the JDK: it is the fork, and it costs the alternating-volley
row roughly a third to a half of the figure the warm host was producing.  The
other four scenarios do enough of their own warmup not to notice.  So the JVM
volley numbers published before this change were flattered by a harness
artefact, and removing it is a correction rather than a regression — fairness
rule 4 ("one framework per subprocess") was true of these two arms only in
letter until now.

Pekko is pinned to **1.6.0**, the newest *stable* release.  2.0.0-M3 exists and
is newer; publishing a comparison against a milestone would measure a released
framework against an unreleased one.

Having both also makes the licence question concrete.  Pekko is Apache-2.0 and
is the fork the community took up after the other project moved to BUSL-1.1;
the two rows together answer what staying on an OSI-approved licence costs in
throughput.

Two more things about the Akka arm are decisions rather than defaults:

- **Version 2.8.8, from Maven Central.**  Releases from 2.9 onwards are
  published only to `repo.akka.io`, which answers **403** to an anonymous
  request.  A benchmark nobody else can reproduce is not evidence, so this
  arm stays on the newest publicly resolvable artifact and says so.
- **BUSL-1.1, not Apache-2.0.**  Akka 2.7 and later restrict production use.
  Benchmarking falls under the non-production grant, and the licence is
  carried into every published table next to the number, because a reader
  comparing frameworks is usually also choosing one.
- **A hand-mirrored harness, deliberately not JMH.**  JMH is the better
  microbenchmark tool and measures differently — forked JVMs, blackholes, its
  own warmup policy.  A comparison whose two sides use different
  methodologies cannot be read as one table, so this side reproduces the
  JavaScript protocol exactly instead, down to the percentile rule.  That is
  also why cross-language rows never share a table with same-runtime ones
  (fairness rule 7): "the same code ran on both sides" is a claim only the
  JavaScript arms can make.

### The Scala 3 arms

`akka-scala/` and `pekko-scala/` measure the *same frameworks at the same
versions* as the Java arms — the `_3` artifacts of 2.8.8 and 1.6.0 sit on Maven
Central beside the `_2.13` ones — through the Scala API, built by the same
launcher on the same pinned JDK.  Everything is held constant except the
binding, which is what makes the gap between a pair readable as the binding.

**They are written in the idiomatic functional style, not as a transliteration
of the Java arm.**  State is carried in behavior parameters and advanced by
returning a new behavior; the Java arms use `AbstractBehavior` subclasses with
mutable fields.  Porting the Java shape into Scala would have measured javadsl
idioms spoken with a Scala accent and answered nothing the Java arm does not
already answer.  Measuring what people actually write is the point of having
the arm at all.

That choice has a cost, and it is disclosed rather than absorbed: a counter
that recurses allocates a behavior and a closure per message where a mutable
field allocates nothing.  The three rows where that can move a number — both
tell cases and the volley — carry a note saying so, and the note is
byte-identical in both Scala arms so the report prints it once.  The *sending*
side is deliberately identical: the Scala arms hoist a single `Increment` out
of the send loop exactly as the Java arms hoist their single `new Increment()`,
because a pair that differs in two things measures neither.

Brace-less indentation syntax throughout, on Scala **3.3.8** — the newest patch
of the current LTS line.  The framework artifacts carry TASTy from older 3.x
compilers (3.2.2 and 3.3.7 respectively) and Scala 3 guarantees forward
compatibility, so a newer compiler reads both; the pin is there because "Next"
moves every few months and a benchmark baseline should not.

**Read the JVM ask rows with care.**  Every arm drives the system under test
from an external caller.  On a JavaScript event loop that is a microtask; in
.NET it is an `await`; on the JVM, from a non-actor thread, it is a real thread
parking and unparking on a `CompletableFuture`.

That is not a hypothesis — the .NET arms make it measurable.  They run the same
actor model through the same scenarios and land roughly **five times higher**
on the ask row than the JVM arms, while the JVM arms lead the tell rows by a
wide margin.  So the ask row measures *the cost of asking from outside the
actor system on that runtime*, not the framework's messaging speed.  The note
travels with the number into every published table.

### The .NET arms

`akka-net/` uses the classic actor API — the one its own documentation leads
with.  `orleans/` is the virtual-actor model and the only arm here whose
semantics genuinely differ: grains activate on first call, there is no
caller-visible create or stop, and a grain call is an RPC.  Three of its four
rows therefore measure a near-equivalent and say so in a note:
activation-on-first-call for spawn, `[OneWay]` for tell, and a driven chain of
awaited calls for ping-pong.

Both pin their transitive closure with `RestorePackagesWithLockFile` and a
committed lock file, which is the .NET equivalent of the pinned pom, and both
run under workstation GC — the default a console application gets, and a knob
no other arm has been tuned on.

### Removed: the no-framework floor

An eighth arm used to sit at the end of every table — plain objects and direct
method calls, meant as a floor showing what the actor abstraction costs.  It
was removed, and the reason is worth keeping:

- **It invited the wrong conclusion.**  A column running two to three orders of
  magnitude above the others reads as "the frameworks are wasteful", when what
  it actually shows is that a direct call does none of the work — no queue, no
  scheduler, no supervision, no lifecycle, no back-pressure.  Every caveat in
  the world next to the number did not stop the number from being the thing
  people take away.
- **It was the least trustworthy figure in the suite.**  A loop a JIT can
  flatten is barely a measurement: it moved 16 % between two consecutive runs
  of everything else, more than any real arm.

A comparison should help someone choose between the options in front of them.
"Use no framework" is not one of those options, and pricing it to three
significant figures pretended otherwise.

### Evaluated and rejected: comedy

`comedy` was installed, measured as a candidate and removed.  It declares
`@types/node` as a **runtime dependency**, resolving to **10.3.3** — old
enough that it shadows the real one for this whole tree, and every
`node:`-prefixed import in `src/` stops type-checking the moment it is
installed.  It also brings `core-js@2.6.12` with a lifecycle script and
`babel-polyfill`, for 37 packages in service of one arm.

That is recorded here rather than silently omitted: a reader comparing
JavaScript actor libraries deserves to know the third one was considered.
The measurement is not the reason it is absent — the cost to the tree is.

---

## Layout

```
benchmarks/comparison/
  package.json        this tree's dependency manifest (+ its own bun.lock)
  tsconfig.json       the only config that type-checks this tree
  run-comparison.ts   driver — one framework per subprocess
  report.ts           validates results/ and generates RESULTS.md
  akka-java/          a JVM arm — Mill, Akka Typed Java API
    mill, mill.bat    Mill launcher, script-only — no binary committed
    .mill-version     pins the launcher; its baked-in default is a nightly
    build.mill        pinned dependency, JDK and the reasoning behind both
    src/comparison/   harness, JSON writer, actors, entry point
    resources/        application.conf — logging off
  akka-scala/         the same framework through its Scala 3 API
    build.mill        the `_3` artifact of the identical version
    src/comparison/   functional scaladsl, brace-less
  pekko-java/         the other JVM arm — same sources, different package prefix
                      (same launcher files, byte for byte)
  pekko-scala/        and its Scala 3 binding — the second pair
  akka-net/           the .NET arm — classic actor API, committed lock file
  orleans/            the virtual-actor arm — grains, single-silo localhost
  js/
    workload.ts       the batch sizes, iteration counts and warmup, once
    arm.ts            shared runner + completion accounting
    environment.ts    hardware / runtime / commit capture
    result-file.ts    the on-disk schema
    actor-ts.ts       the reference arm
    nact.ts           the JavaScript neighbours
    xstate.ts
    merge-rounds.ts   averages interleaved rounds into results/
  results/            committed per-run JSON, one file per framework × runtime
  RESULTS.md          generated from results/ — never hand-edited
```

---

## Running it

Install this directory's manifest once (it is not part of the root
install):

```bash
bun install --cwd benchmarks/comparison
```

Measure every arm, each in its own subprocess:

```bash
bun run bench:compare
```

### What each arm needs installed

| arm | needs |
| --- | ----- |
| the three JavaScript arms | Bun, and this directory's manifest |
| the four JVM arms | `curl`; the Mill launcher fetches its own JDK |
| the two .NET arms | the .NET 10 SDK on `PATH` |

**An arm whose toolchain is absent is skipped, not failed.** The driver checks
before it runs anything, names what is missing, and finishes with the arms that
can run — the exit code stays 0. That is deliberate: `RESULTS.md` carries a
date and a commit per arm, so a partial run leaves the untouched arms visibly
attributed to the run that did measure them, which is more useful than refusing
to measure anything. The summary lists every skipped arm on the success path
too, because a partial run reported as a plain green tick is how a release
publishes figures for arms that never ran.

Use `--javascript-only` to skip the cross-language arms deliberately rather
than by omission — that is what CI does, since it installs Bun and nothing
else.

A launcher that is present but not executable is *not* a missing toolchain: it
is a broken checkout, and the run fails with the `chmod` that fixes it. The
POSIX `mill` scripts are committed as mode `100755` for that reason, and
`tests/unit/ci/ComparisonLauncherModes.test.ts` asserts it against the git
index — the working tree cannot answer the question on Windows, which is
exactly why the four JVM arms were unrunnable on Linux for as long as they
were (#1325).

Then regenerate the published tables from what was measured:

```bash
bun run bench:compare:report
```

One arm only, while working on it:

```bash
bun run bench:compare -- --framework=actor-ts
```

Prove the arms still execute without measuring anything (this is what CI
runs — one unwarmed iteration per case, and **no** result files written,
so a smoke run can never overwrite a real measurement):

```bash
bun run bench:compare:smoke
```

Type-check the tree — the only check that covers it:

```bash
bun run typecheck:compare
```

### Before publishing a measurement

**Publish from `--rounds`, never from a single run:**

```bash
bun run bench:compare -- --rounds=7
```

This runs the arms **interleaved** — round 1 of every arm, then round 2 —
and publishes the per-scenario **mean**, together with the spread of the
rounds behind it.

Interleaving means whatever else the machine is doing lands on every arm
rather than on whichever one happened to run during it.  The mean means
all ten rounds are used: publishing the median would report one round and
discard nine.  The cost of that choice is that a disturbed round is
carried rather than dropped, which is exactly why the spread is published
next to every figure — a row whose rounds disagreed is then visible as
that, instead of averaging into a confident-looking number.

The measured need for it, on an ordinary desktop with nothing unusual
running: across five consecutive single rounds the ask rate varied by
2 % on one arm, 15 % on another and 34 % on a third — while the ordering
of the three was identical every time.  A single round would have put
that coin toss into a table readers quote to three significant figures.

Averaging is **per metric**, so a published row is a summary rather than a
single observation — that is the honest way to describe it.  `min` and
`max` are the exception: they are the smallest and largest iteration seen
across all rounds, because a mean of extremes describes nothing that
happened.

Commit `results/` and the regenerated `RESULTS.md` together, **on a clean
tree**: the environment block records the commit and marks it `-dirty`
otherwise, which is a number nobody can reproduce.  The per-round working
files under `results/.rounds/` are git-ignored — the median is the
artefact.
