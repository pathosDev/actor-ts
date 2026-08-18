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
`comparison-smoke` job in `.github/workflows/benchmarks.yml` runs it
against a frozen install of this directory.

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

5. **Home runtime first.**  The JS neighbours are written for Node;
   running them there is the fair measurement, and running them on Bun
   as well is extra information, not a substitute.

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

## Layout

```
benchmarks/comparison/
  package.json      this tree's dependency manifest (+ its own bun.lock)
  tsconfig.json     the only config that type-checks this tree
  js/               the JavaScript arms + shared workload / environment code
  results/          committed per-run JSON, one file per framework × runtime
  RESULTS.md        generated from results/ — never hand-edited
```

---

## Running it

Install this directory's manifest once (it is not part of the root
install):

```bash
bun install --cwd benchmarks/comparison
```

The arms, the driver and the report generator arrive with the phases
that add them; this file grows with them.
