# AGENTS.md — working standards for actor-ts

Standards for anyone (human or coding agent) making changes in this
repo. Read this before you start. These are conventions the project
already follows; keep them consistent.

## Project snapshot

`actor-ts` is a **pre-1.0** actor-model framework for TypeScript that
runs on **Bun, Node.js (≥ 24), and Deno**. ESM throughout; **Bun** is
the primary toolchain (`bun test`, `bunx tsc`). Runtime dependencies are
deliberately tiny — `fastify` + `ts-pattern` — and everything else
(Express, Hono, `ws`, brokers, SQL/Cassandra drivers, S3, …) is an
**optional peer dependency**, lazy-loaded on demand.

## Commit strategy

- **Conventional Commits**: `type(scope): subject`. Types in use:
  `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `build`.
  Scope is the module/area, e.g. `http`, `http/websocket`, `io`,
  `persistence/postgres`, `testkit`, `cluster`, `deps`, `deps-dev`,
  `readme`, `changelog`, `roadmap`, `integration`.
- **Small, focused commits.** Each commit should keep
  `bun run typecheck` + `bun test` green — so a bisect never lands on a
  broken tree.
- The **body explains what + why** (and the mechanics for non-trivial
  changes). Reference issues as `#NNN`; close them with `Closes #NNN`
  (see *Issues & workflow*).
- Commits that only touch CI-maintained artifacts (e.g. the README
  test/coverage badges) use `[skip ci]`.
- **Commit as the private identity `~/.gitconfig` declares** — the one the
  whole history already uses. This is a personal project; a work address
  does not belong in it. The config is correct, but something in the
  tooling has been observed substituting a work address at commit time,
  and a wrong author only surfaces afterwards in the log. **So pin the
  identity explicitly instead of trusting that the config is honoured** —
  environment variables outrank both `--local` config and
  `-c user.email=…`:

  ```sh
  name=$(git config user.name); mail=$(git config user.email)
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$mail" \
  GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$mail" \
  git commit -F <message-file>
  ```

  Reading the values back out of `git config` is deliberate: it keeps the
  address itself out of this file, and it makes the recipe work unchanged
  in a fork, where the right author is whoever is doing the work.

  Applies to merge commits too. Verify afterwards with
  `git log --format='%an <%ae> | %cn <%ce>' -1` — checking `git config
  user.email` proves nothing, since the override does not live there.
  Nothing is pushed by the agent, so a wrong author is always still
  fixable: rewind the branch with a mixed `git reset <base>`, re-commit
  the same file sets with the identity pinned, and confirm the rewrite
  changed nothing but authorship by comparing `git rev-parse HEAD^{tree}`
  against the old tip's tree.

## Branches & pushing

- **`develop` is the integration branch** — all ongoing development lands
  there. **`main` holds releases only**: it moves only when a release is cut
  (a `--no-ff` merge from `develop`, see *Release strategy*), never via direct
  feature work.
- **All work happens on a feature branch under `features/…`** — one branch per
  unit of work, branched off `develop` (e.g. `features/ws-backpressure`,
  `features/fix-mqtt-reconnect`; even fixes and chores use the `features/`
  prefix). The sole exception is cutting a release, which uses a
  `release/vX.Y.Z` branch (see *Release strategy*). **No direct commits to
  `develop`**, not even small fixes or follow-ups — everything lands through a
  branch. Delete the branch after it merges.
- **Always integrate with a merge commit (`git merge --no-ff`) — never rebase,
  never fast-forward.** This holds in both directions: `features/…` → `develop`
  and, at release time, `develop` → `main`. History stays a true graph; it is
  never rewritten or flattened.
- **Do not push.** The agent commits locally only — on its `features/…` branch
  and when merging into `develop`; the human pushes `develop`. The single
  exception is cutting a release (below) — merging `develop` → `main` and
  creating the tag/GitHub Release is explicitly authorized.
- **`main` is branch-protected** — merges require a pull request and the `test`
  status check; the maintainer (admin) may bypass for the release merge.

## Release strategy

SemVer, and the project is **pre-1.0**:

- **patch `0.x.Y`** — bug fixes only, no breaking changes.
- **minor `0.X.0`** — new features; **may include breaking changes**.
- **`1.0.0`** — the API-stability commitment.

Tags are `vX.Y.Z`; GitHub Releases are cut as normal **Latest** releases
(not flagged pre-release) — `gh release create` without `--prerelease`.

**CHANGELOG** (`CHANGELOG.md`) follows *Keep a Changelog*: an
`[Unreleased]` section with `Added` / `Changed` / `Fixed` / `Removed` /
`Security` subsections. **Breaking changes are flagged prominently**
(a `BREAKING` marker + a short migration note). Reference issues as
`#NNN`.

**Cutting a release** (only when explicitly asked) — promotes `develop` to `main`:

1. On a `release/vX.Y.Z` branch off `develop`: bump `version` in
   `package.json` and move `[Unreleased]` → `[X.Y.Z]` (dated) in `CHANGELOG.md`;
   commit (`chore(release): vX.Y.Z`). Merge it into `develop` (`--no-ff`) and
   push `develop`.
2. **Re-measure the comparison benchmarks and carry the figures to every
   surface that quotes them.** Those numbers name the version that produced
   them — `environment.actorTsVersion` in each result file comes from
   `package.json`, and the docs tables label their columns with it — so a
   release that skips this ships figures attributed to a version that never
   ran. **Order matters:** bump and commit first (step 1), *then* measure, so
   the results carry the new version and a clean commit rather than recording
   themselves as `-dirty`.

   ```sh
   bun run bench:compare -- --rounds=100  # every arm, machine otherwise idle, hours
   bun run bench:compare:report           # regenerates RESULTS.md
   ```

   Then update the five hand-maintained surfaces in a second commit on the
   release branch: `README.md`, `docs/.../reference/benchmarks.mdx` (EN + DE)
   and the `tell`/`ask` figures quoted in `docs/.../reference/faq.mdx`
   (EN + DE). **Version labels belong in the docs tables and in `RESULTS.md`,
   never in `README.md`** — the README is the summary and links to the full
   tables for the pins. #1322.

   The cross-language arms need a JDK and a .NET SDK; if a toolchain is
   missing, re-measure the arms you can rather than skipping the step. Each
   result file carries its own date and commit and `RESULTS.md` prints one
   environment row per arm, precisely so a stale arm is visible as stale
   instead of averaging in silently.
3. Merge `develop` → `main` with `git merge --no-ff`, then push `main`.
4. `gh release create vX.Y.Z --target main` (a normal **Latest** release, no
   `--prerelease`) with **emoji-sectioned notes** (`## 🚀 New features`,
   `## ⚠️ Breaking changes`, `## 🔒 Security`, `## 🐛 Fixed`, …) matching the
   style of prior releases.

Publishing the release triggers `.github/workflows/publish.yml`, which
runs typecheck + test + build and then `npm publish --provenance` via
**npm Trusted Publishing (OIDC)** — no long-lived token. It is
version-guarded, so re-running is safe. Locally, `prepublishOnly` runs
clean + build + typecheck + test.

## Breaking changes

**Pre-1.0, a hard cut is fine.** Remove or replace an API directly — no
deprecation cycle is required. Flag it as **BREAKING** in the CHANGELOG
with a one-line migration note, and update every in-repo caller
(examples, tests, docs) in the same change. (Post-1.0 this tightens to
conservative SemVer.) See `docs/.../reference/version-policy.mdx`.

## Documentation (all languages)

- Docs are **Starlight MDX** under `docs/src/content/docs/` (English),
  mirrored **1:1** under `docs/src/content/docs/de/` (German). **Every
  content change updates BOTH languages** — code samples stay identical,
  prose is translated. The `i18n` label tracks translation work.
- Feature or behavior changes also update **`README.md`** and
  **`CHANGELOG.md`**.
- **The README test-count / coverage badges are bot-maintained** — a CI
  workflow pushes `chore(readme): update test count + coverage stats
  [skip ci]` commits directly to `develop` after test runs. Do NOT edit
  those numbers by hand (the bot overwrites them, with CI-measured values
  that skip the quarantined multi-node suites via
  `ACTOR_TS_SKIP_FLAKY_MNS` — see *Verification gates* — so they differ
  slightly from a local full run). After pushing `develop`, fetch again
  before branching — a bot commit may already have landed on top.
- Adding a page: keep `docs/scripts/scaffold.mjs` and the Astro sidebar
  (`docs/astro.config.mjs`) in sync — same path and label.

## Knowledge graph (`graphify-out/`)

`graphify-out/` holds a committed knowledge graph of the repository —
`graph.json`, `graph.html`, `GRAPH_REPORT.md` and `cache/`. It is tracked
**on purpose** (`.gitignore` says why): the cache keys on repo-relative
paths plus a hash of the extraction prompt, so a fresh clone replays it
instead of paying a ~7.2M-token semantic re-extraction of `docs/`. Only
run-local files (`manifest.json`, `cost.json`, `.graphify_*`) are ignored.

- **The graph is bot-maintained.** `.github/workflows/graphify.yml` runs
  weekly (and on `workflow_dispatch`), re-extracts the **code** side, and
  pushes `chore(graphify): refresh knowledge graph [skip ci]` to `develop`
  — the same shape as the README badge bot above, so the same caveat
  applies: fetch again before branching.
- **Weekly, not per push, and that is deliberate.** `graph.json` is ~36 MB
  and reorders on rebuild, so it deltas poorly; a commit per push would add
  gigabytes to the history. Landing a large refactor is what the manual
  dispatch is for.
- **CI refreshes code nodes only.** Documentation nodes come from semantic
  extraction, which needs an LLM — run `/graphify . --update` in an agent
  session after a docs sweep. Community labels are re-derived on every
  rebuild (Louvain ids move when nodes change), so hand-curated labels do
  not survive automation. #1345.
- **The graphify version in that workflow is pinned** because the AST cache
  lives under `cache/ast/v<version>/`. Bumping it orphans the committed
  cache and commits a second copy — a deliberate change, never a drive-by.
- **Local git hooks are deliberately not used.** `graphify hook install`
  offers `post-commit`/`post-checkout`; the checkout hook runs a full
  re-extraction on every branch switch and leaves the tree dirty, which with
  several worktrees in play fires constantly. The merge driver it registers
  (`.gitattributes`, `merge=graphify`) is kept — it union-merges two branches
  that both rebuilt the graph. Configure it **directly**, once per clone;
  do not reach for `graphify hook install`, which would reinstate the hooks
  along with it:

  ```sh
  git config merge.graphify.name 'graphify graph.json union merge'
  git config merge.graphify.driver 'graphify merge-driver %O %A %B'
  ```

  Without it git just falls back to a normal merge, which on a 36 MB
  reordered JSON means a conflict you resolve by rebuilding.

## Verification gates (before every commit)

- **`bun run typecheck`** (build tsconfig — excludes `examples/`,
  `tests/` and `benchmarks/`) passes.
- **`bun run typecheck:dev`** passes too — same compile plus those three
  trees. Green since #540 and gated by the `typecheck (dev)` workflow, so
  a regression is a red check rather than a number that drifts. It is the
  only gate that sees the library from a *caller's* side, which is a whole
  class of defect on its own: an exported class narrower than the interface
  it implements still satisfies `implements`, and an exported type whose
  properties are all optional is satisfied by nothing at all. Neither shows
  up in `bun test` (which transpiles without checking) or in `bun run
  typecheck` (which never compiles a call site).

  `tsconfig.dev.json` excludes the three trees whose imports another
  manifest resolves — the example frontends, the broker runners, and three
  examples demonstrating an undeclared optional peer. Its header says which
  CI job covers each. Adding to that list is not a way to make a compile
  error go away: the rule is a *different manifest*, not a difficult error.
- **`bun test`** is green. Line coverage floor is **≥ 80 %** —
  `bun run test:coverage:gate`.

  That command enforces **two** floors, from the two artifacts of one
  `bun test --coverage` run. The aggregate ≥ 80 % comes from the `All files`
  row of bun's text table, which is also what `test.yml` parses in bash and
  what CI actually enforces. Per-module floors — **`src/cluster/` ≥ 90 %** and
  **`src/persistence/` ≥ 90 %** — come from the lcov report, as
  `Σ LH / Σ LF` per path prefix, because a rollup of bun's per-file
  percentages would average a ten-line barrel against a thousand-line
  coordinator. The module floors are configured in
  `scripts/coverage-gate.mjs` and nowhere else, deliberately: an environment
  override in a workflow file is a second place the number lives and a way to
  loosen the gate without the loosening showing up in a diff of the gate.
  The module floors are **not wired into CI yet** — that needs #1016, which
  owns inverting this script so `test.yml` can gate the run it already made
  instead of running the suite a second time. #541.

  **Ratchet policy: a floor may be raised, never lowered silently.** Raising
  one is ordinary work — do it when a release is cut, or when a module has
  held well above its floor for a while. Lowering one requires the measured
  figure that forces it, written down beside the number, and it is worth
  asking first whether the honest change is a test rather than a floor. The
  history here is the reason: the aggregate floor was 89 until `83b0a4af`
  dropped it to 80, because quarantining the worker-thread suites (#538) had
  taken hosted CI to 86 % — a defensible call, but one whose reasoning lived
  only in a commit message, with nothing under `tests/` even naming
  `COVERAGE_LINE_FLOOR`. Both floors are now pinned from below by
  `tests/unit/ci/CoverageGate.test.ts`, which also fails when the script, the
  workflow and this file stop quoting the same aggregate number — so lowering
  a floor means editing that test, in the same commit, on purpose.
- **Three suites do not run in CI at all.** `ACTOR_TS_SKIP_FLAKY_MNS=1` in
  `test.yml`, `multi-runtime.yml` and `publish.yml` skips
  `tests/multi-node/LeaseMajority.test.ts`,
  `tests/multi-node/ParallelPubSub.test.ts` and
  `tests/unit/testkit/ParallelMultiNodeSpec.test.ts` — Bun on GitHub's hosted
  runners cannot respawn functional worker threads after the first worker
  test, which also starves LeaseMajority's lease arbitration into a false
  split-brain. **A local `bun test` runs them; a green CI check says nothing
  about them.** `.github/workflows/nightly-flakes.yml` runs them nightly with
  the flag OFF; its header carries the exit criterion (14 consecutive green
  nights), and `docs/…/testing/diagnosing-flakes.mdx` states it in prose.
  #538.
- **Repeat-run flake hunting:** `bun run test:stress`
  (`scripts/stress-test.mjs`) loops the suite N times and aggregates failures
  by test identity, splitting *flaky* (failed in some runs) from
  *consistently failing* (broken, not flaky). It **drops
  `ACTOR_TS_SKIP_FLAKY_MNS` from the child environment by default** — a
  harness that inherited it would report a reliable pass rate over exactly
  the tests known not to be reliable. Not a per-commit gate; reach for it
  when a test fails intermittently, or when a nightly names one. #290.
- **Cross-runtime:** `bun run smoke` runs `tests/smoke/cases/*.mjs` on
  Bun, Node, and Deno. Add a smoke case for anything runtime-sensitive.
  A case must release every handle it opens **on every path**, not just the
  happy one: a socket abandoned on a timeout or an error keeps Deno's event
  loop alive, and the run then hangs after its last green line instead of
  exiting — no exit code, so the gate stops being a gate (#1196). The
  runner's watchdog demotes that to a warning after 15 s; it does not excuse
  it. `deno test -A --trace-leaks` over the suspect case names the op.
- **Examples:** `bun run test:examples` spawns every runnable snippet under
  `examples/` and asserts on its output (~90 s). A change to a `src/` API
  that an example calls needs it; the `examples` workflow gates it, and its
  path filter carries `src/**` for that reason.

  Every standalone example is classified in
  `tests/examples/examples.manifest.json` — either runnable, with a
  substring of its output that must appear, or skipped with the reason it
  cannot run (a Docker broker, cloud credentials, an optional peer nothing
  declares). The runner fails when the manifest and the tree disagree in
  either direction, so **a new example is not finished until it has an
  entry**. The output assertion is not decoration: `exited 0` is also what
  `examples/io/grpc-sensor.ts` does after ten failed actor starts, so a
  runnable case without an `expect` would gate on nothing.

  Runs on Bun only, deliberately — the cross-runtime question belongs to
  `bun run smoke`, whose cases are written runtime-neutral; the examples
  are written for Bun.
- **Benchmarks:** a change to a `src/` API that `benchmarks/` calls also
  needs `bun run typecheck:bench` (benchmarks-only compile) and, for
  anything that could break at runtime, `bun run bench:smoke` (~30 s —
  every suite, one unwarmed iteration each). The build tsconfig excludes
  `benchmarks/`, so nothing else catches an orphaned benchmark; the
  `benchmarks` workflow gates both. The benchmarks are part of the
  adoption sweep for a breaking change, exactly like tests and examples.
- **DevTools UI:** the UI has its own Angular toolchain in a nested
  `devtools-ui/` package, installed once with **`bun run ui:install`** and
  deliberately not a bun workspace — hoisting would put `@angular/core` in the
  root `node_modules` and in Dependabot's view of a manifest that ships two
  runtime dependencies, and Angular pins a TypeScript the library does not use
  (#483). `bun run build:ui` fails hard without it; `bun run typecheck` skips
  the UI half with a warning locally and fails hard under CI, which is what
  keeps `typecheck`, `bun test` and `bun run smoke` working from a fresh clone.
  `bun run build:lib` is `tsc` alone, for the jobs that want `dist/` and have
  no opinion about the UI.

  The UI has **two test runners, and their file patterns must stay disjoint**.
  The framework-free half (`format`, `history`, `flamegraph`, `profileTree`,
  `stateDiff`, `actorsTree`, `uptime`, and the chart-option builders) runs
  under `bun test` from `devtools-ui/tests/*.test.ts` and needs no DOM. The
  Angular half runs under Vitest in jsdom, as `bun run test:ui`, from
  `devtools-ui/src/**/*.ng-spec.ts`. The `.ng-spec.ts` suffix is not a style
  choice: `bun test` collects `*.spec.ts` anywhere in the tree and would try
  to run specs that need Vitest and a DOM. Renaming them back breaks the root
  suite, not just the UI one (#487).

  A change under `devtools-ui/` needs **`bun run
  build:ui`** in the same commit — `src/devtools/generated/UiAssets.ts`
  is generated but committed, and a stale one is valid TypeScript, so
  nothing else notices. **`bun run check:ui`** asserts it (and gates the
  `build` workflow) by comparing a `source-hash` over the UI sources,
  the build script and the bundled dependencies. It deliberately does
  not compare the bundle's bytes: those vary with the OS and the Bun
  release that produced them, so a byte diff is not a staleness signal.
  Which means **review is the only thing that ever looks at the embedded
  payload** — hence `.gitattributes` gives `UiAssets.ts` a plain textual
  `diff` and not `-diff`. Restoring `-diff` (or otherwise hiding those
  bytes) removes the last check on them; the `git show` noise it saves is
  a per-clone problem with per-clone fixes (`git diff --stat`, a pathspec
  exclude, `.git/info/attributes`).
- **Security scanning is CI-side, with one local half.** `bun run
  lint:audit` is `bun audit --audit-level=high` over `bun.lock` and gates
  `package-health.yml`; run it after any dependency change, because that
  is the one that can turn it red. It reads the lockfile deliberately —
  GitHub's dependency graph resolves only the ranges in `package.json`,
  so Dependabot and `dependency-review-action` are blind to the shipped
  closure and are not used as gates here. Advisories that predate the
  gate are suppressed by ID in the script *and* listed in `SECURITY.md`;
  `tests/unit/ci/SecurityPolicy.test.ts` fails if the two sets differ, so
  never silence one without the other. **CodeQL** (`codeql.yml`, pull
  requests + weekly) and the workflow-hygiene invariants asserted by
  `tests/unit/ci/WorkflowHygiene.test.ts` — SHA-pinned actions, explicit
  read-only workflow permissions, frozen installs — are the rest of it.
  A new workflow file has to satisfy that test on the first `bun test`.
- **Don't hand-edit** the README test/coverage badges — CI updates them
  on push to `develop`.

## Runtime portability

- Code must run on **Bun, Node ≥ 24, and Deno**. Runtime-specific
  primitives (HTTP serve, sockets, workers, SQLite, …) live behind small
  abstractions in **`src/runtime/`** and auto-detect at startup.
- **Optional peer dependencies:** `import()` them lazily with a clear
  *"install it with `bun add …`"* error on failure, and declare them in
  `peerDependencies` **and** `peerDependenciesMeta.<pkg>.optional = true`.

  Then declare the package a **second** time, in **one of exactly two
  dependency contexts**. Which one is not a preference — it follows from how
  the adapter is actually exercised:

  - **Root `devDependencies`** when a suite under `bun test`, or a
    `tests/smoke/` case, imports the **real** module. What that buys is
    narrower than it looks, and worth stating exactly, because the obvious
    answer is wrong: installing a package makes **no** existing suite
    exercise it. Nothing in `tests/` is conditioned on module availability,
    and every adapter path runs against a hand-rolled fake
    (`FakeCassandraClient`, `FakeMemcached`, `mock.module('@aws-sdk/client-s3',
    …)`) — which is the right shape for fast feedback and stays. What the
    fakes cannot cover is the seam between themselves and reality: each
    adapter reaches its peer through a hand-written structural type
    (`MemjsClientStatic`, `CassandraDriver`, `WebsocketServerLike`), and a
    fake satisfies that stub by construction, so the stub is checked against
    nothing. A **root devDependency is justified by a test that imports the
    real module and asserts the shape the adapter destructures** — see
    `tests/unit/ci/OptionalPeerModuleShapes.test.ts`. Use a **literal**
    specifier there: it is the only form that pins the package at the install,
    and the only one `knip` can attribute to the manifest entry, which is what
    keeps it out of `knip.jsonc`'s `ignoreDependencies`.
  - **`tests/integration/brokers/package.json`** when the adapter earns its
    coverage against a live broker in Docker. Those packages are absent from
    the root `node_modules` **by design** — the rationale is in
    `tsconfig.dev.json`'s exclude entry and
    `tests/integration/brokers/README.md` — and that is what keeps the root
    install tiny (two runtime dependencies) and keeps heavyweight driver
    closures out of `bun audit`'s surface.

  A peer in **neither** context is the defect (#676): nothing installs it, so
  the structural stub standing in for its types is checked against nothing,
  and no gate notices — `bun run typecheck` never compiles a call site and the
  adapter suites all pass against their fakes.
  `tests/unit/ci/OptionalPeerDeclarations.test.ts` asserts the split, in both
  directions, so it cannot rot silently again.

  Three traps, all silent:

  - **`bun add <pkg>` no-ops** when `<pkg>` is already an optional peer — bun
    treats it as declared and does nothing. Write the `devDependencies` entry
    **by hand** and materialise it with `bun install`.
  - **A package that ships no types of its own** (`ws`, `memjs`) needs its
    `@types/*` alongside, or the literal import fails `typecheck:dev` under
    `noImplicitAny`.
  - **A root devDependency enters `bun audit`'s surface**, so `bun run
    lint:audit` is the gate that decides whether a peer *can* live there at
    all — a driver whose closure carries an unfixable high advisory cannot,
    and that is a security decision, not a packaging one. Do not reach for a
    new `--ignore`: every suppression in `lint:audit` predates the gate, and
    adding one to get a change through is how a gate stops gating. Record the
    gap in the guard's allow-list instead and raise it. This is why
    `cassandra-driver` is still declared nowhere (#676).

## Code style

- **Strict TypeScript.** ESM with the **`.js` import suffix** on
  relative imports (required by the build's module resolution).
- Discriminated-union handling via **`ts-pattern`**
  (`match(x).with(…).exhaustive()`).
- **Every `match` arm delegates to a private `onXxx` handler.** Wherever a
  `match(…)` dispatches an **incoming message, event, or command** — an actor's
  `onReceive`/`onCommand`/`onEvent` (or a router it calls), a cluster-event
  subscription (`cluster.subscribe(evt => match(evt)…)`), or a wire/system-command
  dispatcher — every arm (each `.with(…)` **and** any `.otherwise(…)`) is a thin
  call into a private method (`.with({ kind: 'data' }, (m) => this.onData(m))`,
  `.otherwise((m) => this.onUnhandled(m))`), never an inline body, even a
  one-liner — no exceptions. Name it `on` + the PascalCase discriminant
  (`onData`, `onMemberUp`, `onCreate`); type the parameter as the **named variant
  type** (see next bullet), or omit it for payload-free kinds. Keeps the matcher
  a scannable dispatch table. **Exempt:** matches on *internal state* (a state
  machine / behavior / directive reducer) or that *compute a value* in a helper
  (config, codec, route, priority) stay inline.
- **Measured-hot-path exemption.** Where a `match(…)` dispatches on a path a
  benchmark **in this repository** has measured as hot, it may be a `switch` on
  `kind` instead — every `case` still a thin `onXxx` delegation, exhaustiveness
  restored by a `default` that assigns the scrutinee to `never` (the shape
  `decodeCrdt` in `crdt/DistributedData.ts` documents as the reference) — and
  the site **must** carry a comment naming the benchmark and the measured
  delta. The exemption is per-site and evidence-carrying: a `switch` without
  that comment is a style violation, and the comment is the token the
  pattern-matching conformance sweep (#494) recognises as exempt and must not
  convert back.

  The rule it bends is a good one — a matcher reads as a dispatch table where a
  chain of ifs reads as logic — and the arms staying delegations is what keeps
  that. What changes is the construct, and only where a number justifies it:
  building a matcher and one closure per arm is free at a call rate of one per
  request and is not at one per actor lifecycle. Two sites qualify today
  (`ActorCell.handleSystemCommand`, `BoundedMailbox.enqueue`), and a third
  needs its own measurement, not an appeal to these.
- **`interface` for contracts and heritage, `type` for everything else.** A
  declaration is an `interface` when it prescribes **function heads** — any
  method, call or construct signature — or when it **`extends`** another
  shape. Everything else is a `type X = { … }`: plain data shapes, unions,
  mapped and conditional types. The split follows what the declaration is
  *for*. An interface states a contract someone implements, and `extends`
  reads as a hierarchy where an intersection only reads as conjunction; a
  data shape states a value's layout, and there `type` composes with the
  union aliases the project already uses (`type XOptions`, `type Command`).
  A function-typed **property** (`onLost?: () => void`) is not a function
  head — that shape stays a `type`. An interface may extend a type alias, so
  a contract built on a plain data base is written `interface X extends
  XBase { … }` with `XBase` staying a `type`; the mixture is intended.
- **Discriminated unions are defined as named variant types.** Declare each
  tagged union as a union of **named** members
  (`type Command = DepositCommand | WithdrawCommand | BalanceCommand`), never an
  inline object-literal union — including the union alias itself
  (`type Command`, not `type Cmd`). Name a variant `PascalCase(kind)` + a role
  suffix matching the union (`Command`/`Event`/`Message`) — collision-safe (`Set`,
  `Get`, `Publish` never bare); keep variant types module-local where the union
  is. Handlers take the **named variant type** (`onDeposit(c: DepositCommand)`),
  not `Extract<Union, { kind }>`.
- **The discriminant field is always `kind`** (never `type` or `tag`) — including
  the WebSocket/wire protocols of the examples. `type` collides with the `type`
  keyword; `kind` is the single project-wide convention.
- **Pass the actor class, not a closure around it.** Every slot typed
  `ActorClassOrFactory` — `spawn` / `spawnAnonymous`, `withEntityActor` /
  `withActor` / `withSingletonActor`, the `entityActor` / `singletonActor` /
  `actor` / `child` fields, the `Router.*` routee — takes `MyActor` directly;
  `actorFactoryOf` does the wrapping. `spawn(() => new MyActor(), 'x')` is a
  leftover from the `Props` era and reads as noise. The **factory form is for
  constructor arguments** (`() => new Worker(database)`) and for anything the
  class form cannot express — nothing else. Per-actor configuration is the
  third argument, `ActorOptions`, never a closure.
- **Spell out abbreviations in identifiers** — types, classes, files, aliases,
  generic type parameters, methods, fields, **and** locals/params, plus the `kind`
  **string-literal values**. Full words: `Command`/`Message`/`Acknowledgment`/
  `NegativeAcknowledgment`/`Terminate`/`Increment`/`DirectMessage`/`Request`/
  `Response`/`Function`/`Context`/`Connection`/`Arguments`/`Directory`/
  `Repository`/`Deduplication`/`PersistenceId`/`Implementation`/`Constructor`
  (not `Cmd`/`Msg`/`Ack`/`Nak`/`Nack`/`Term`/`Inc`/`Dm`/`Req`/`Res`/`Fn`/`Ctx`/
  `Conn`/`Args`/`Dir`/`Repo`/`Dedup`/`Pid`/`Impl`/`Ctor`). **Two exceptions only:**
  (1) single-letter loop/lambda/catch vars (`m`, `e`, `i`) may stay; (2) names
  mirroring an **external API** or established **domain acronyms** stay verbatim —
  nats.js (`.ack()`/`.nak()`, `max_msgs`), prom-client (`inc()`/`dec()`/`set()`),
  amqplib (`noAck`), DOM (`AudioContext`), `MsgPack` (MessagePack), and `PubSub`,
  `K8s`, `AMQP`, `MQTT`, `SQL`, `S3`, `DNS`, `CBOR`.
- HOCON config keys go through **`src/config/ConfigKeys.ts`** (typed,
  single source of truth). Options resolve with precedence:
  **explicit options > HOCON > built-in defaults** — layered with
  `mergeOptions` from `src/util/OptionsMerge.ts`, where `undefined` on a
  higher layer means "not set" and falls through rather than shadowing.
  **A key in `reference.conf` must be reachable from `ConfigKeys` and read
  by something in `src/`** — `tests/unit/config/NoDeadConfigKeys.test.ts`
  fails otherwise. A knowingly-unimplemented key goes in that test's
  `KNOWN_DEAD_KEYS` with the issue that will remove it; adding a key
  nothing reads is not an option.
- **JSDoc explains the *why*** — constraints, rationale, non-obvious
  trade-offs — not a restatement of the code. Match the surrounding
  comment density; no narration or noise.

### Angular components (`devtools-ui/`)

- **The template is always a separate `.html` file — never an inline
  string.** Every `@Component` uses `templateUrl: './XComponent.html'`,
  pointing at a file named after the component and sitting beside it. This
  holds without exception, including for a component that renders no markup
  of its own: `EChartComponent.html` is a lone HTML comment explaining why
  it is empty, which says more than `template: ''` did and keeps the rule
  free of edge cases to argue about.

  The reason is that markup and logic are read, reviewed and edited by
  different motions. A hundred-line template inside a decorator pushes the
  class it belongs to off the screen, gives the markup no HTML tooling —
  no formatter, no tag matching, no syntax awareness — and makes a diff
  that touches one `<span>` look like a change to the component. It also
  puts HTML inside a template literal, where a stray backtick or `${`
  terminates the string and the error surfaces as `NG1010: template must
  be a string`, nowhere near the character that caused it. That has
  actually happened here, twice, both times from a backtick inside an HTML
  comment.

  `styles` may stay inline: they are usually a line or two of `:host`
  rules, and the UI's real styling lives in `devtools-ui/src/styles/`.

- **Nothing else needs adjusting when a template moves out.** The
  `source-hash` behind `bun run check:ui` hashes *every* file under
  `devtools-ui/src`, extension-blind, so a template-only edit already
  marks the committed bundle stale — verified by making one and watching
  the check fail. Size budgets are unaffected too: the compiler inlines
  the template into the component's chunk, so attribution and the
  per-panel numbers do not move.

### Constants

A module-level `SCREAMING_SNAKE` constant lives in one of four places.
Check them **in order** and take the first that matches:

1. **`XOptions.ts`** — it is the built-in default of an `XOptionsType`
   field, or a bound that file's `XOptionsValidator` checks. This covers
   the lowerCamelCase default *objects* of the same family too
   (`defaultFailureDetectorOptions`, `defaultPhiAccrualOptions`).
2. **It stays where it is** — a closed list of six kinds, not a loophole:
   - **wire/format vocabulary** whose meaning *is* the codec beside it —
     `JsonTree.ts` tags, `CborCodec.ts` tag numbers, `BodyCodec.ts` flags
     and `ATS1_MAGIC`, `Protocol.ts` `HEADER_SIZE`;
   - **algorithm-derived** sizes fixed by a primitive chosen in that file —
     `Encryption.ts` `IV_LENGTH`/`KEY_LENGTH`, `MAX_KEY_VERSION`;
   - a **regex or lookup table that is the implementation** — `Html.ts`
     `ESCAPES`, `Duration.ts` `UNIT_MS`, `MimeTypes.ts`
     `DEFAULT_MIME_TYPES`, `SystemPaths.ts` `GROUP_POLICIES`;
   - a **singleton or sentinel** needing a class or symbol from the same
     file — `NOOP_TRACER`, `Metrics.ts`'s `NOOP_*`, `Behaviors.ts`'s five
     `{ kind }` objects, `BackoffSupervisor.ts` `RESPAWN_TICK`;
   - a value **derived from another constant in the same file** —
     `FRAMING_TAGS`, `RESERVED_TAGS`, `HISTORY_MAXIMUM_SPAN_MS`;
   - a **protocol declaration** — bounds in a `*Frames.ts` that define the
     wire schema a client validates against (`TRACING_BUFFER_*`).
3. **`src/<subsystem>/Constants.ts`** — every other tuned value: cap,
   bound, timeout, buffer size, retry limit, protocol size. One file per
   **top-level** directory under `src/`; nested directories fold up
   (`src/http/websocket/*` → `src/http/Constants.ts`), root-level files use
   `src/Constants.ts`. Create it once a subsystem has two such constants,
   or one that more than one file reads.
4. **`src/util/Constants.ts`** — only when **two or more top-level
   subsystems** consume it. `src/util/` has no outward import, so it is the
   one module everything may depend on without coupling subsystems.

Further rules:

- A `Constants.ts` **imports nothing from its own subsystem** — cycle-free
  by construction, the same property `XOptions.ts` has. Importing
  `src/config/ConfigKeys.js` or another `Constants.ts` is fine.
- **Rule 3 is what rule 1 cannot express.** A default shared by *two*
  options types has no single `XOptions.ts` to sit in — co-location would
  put it in both. `DEFAULT_HEARTBEAT_INTERVAL_MS` and
  `DEFAULT_SQLITE_BUSY_TIMEOUT_MS` are that case. An `XOptions.ts` must
  never import a functional module to reach a constant.
- **Move the declaration with its JSDoc verbatim**, and carry `as const`
  and explicit type annotations across. Dropping them is how a "pure move"
  silently widens a type: `'drop-head' as const` becomes `string`, a
  `ReadonlySet` becomes mutable.
- **Constants move, `ConfigKeys` reads do not.**
  `tests/unit/config/NoDeadConfigKeys.test.ts` matches `ConfigKeys.<group>`
  and `.<leaf>` in the *same file*, so relocating a reader breaks it even
  when behaviour is identical. `bun run typecheck` cannot see that failure.
- **Naming:** `DEFAULT_<DOMAIN>_<UNIT>` with the unit suffix. Prefix a
  vendor limit with the vendor (`DYNAMODB_MAX_BATCH_ITEMS`) — a bare
  `MAX_BATCH_ITEMS` is unambiguous in one driver and meaningless in a
  shared namespace.
- **Public names stay public.** Barrels re-export from the new location, so
  relocating a declaration is never a breaking change.
- Two constants may share a value and still both stay: `MAX_WALL_CLOCK_SKEW_MS`
  (24 h security cap) and `DEFAULT_TOMBSTONE_TTL_MS` (retention window) are
  a documented non-merge, as are the three unrelated `EMPTY` sentinels.

### Options & settings

- **Every configurable thing has one `XOptions.ts` file with three exports**,
  all in the "Options" family — there is no separate "Settings" concept:
  - `XOptionsType` — the plain options-object shape (a bare `{ … }` you can
    pass directly).
  - `XOptionsBuilder` — the fluent builder, `extends OptionsBuilder<XOptionsType>`
    (broker actors via `BrokerOptionsBuilder<XOptionsType>`).
  - `XOptions` — **both** `type XOptions = XOptionsBuilder | XOptionsType` (the
    accepted-input union used in every consumer signature) **and** `const XOptions
    = XOptionsBuilder` (value alias, so `XOptions.create()` / `new XOptions()`
    resolve to the builder).

  Naming lockstep with **no divergence**: builder method `withX` ⇔ field `x` ⇔
  HOCON leaf `x` (e.g. `withQos` ⇔ `qos`, never `defaultQos`). Multi-arg sugar
  is fine when the field still matches the stem (`withCredentials(u, p)` → field
  `credentials`; `withCircuitBreaker(f, r)` → field `circuitBreaker`).
- **An optional fourth export, `XOptionsValidator`**, when the options have
  fields with real constraints (ports, positive durations/counts, byte sizes,
  enums, non-empty strings/arrays, URLs, cross-field rules). It `extends
  OptionsValidator<XOptionsType>` (broker actors via
  `BrokerOptionsValidator<XOptionsType>`) and implements `rules(s)` with the
  protected check helpers (`port`, `positiveNumber`, `positiveInt`,
  `nonNegativeInt`, `oneOf`, `nonEmptyString`, `url`, …) plus `fail(field,
  reason, value)` for cross-field/bespoke rules. Helpers take **only the field
  name** (typo-checked against `XOptionsType`) and are a **no-op on `undefined`**
  — an unset optional always passes; required-ness stays where it was
  (`BrokerActor.requiredOptions()` / an explicit guard). Options that are all
  booleans / strings / callbacks get no validator. Rejections throw
  `OptionsError` (source-agnostic — distinct from `BrokerOptionsError` for
  missing required fields and `ConfigError` for malformed HOCON).
  - **Validation runs once, at consume time, on the merged settings**, so the
    builder, a plain object, and HOCON are all covered and cross-field rules see
    the final values. Broker actors return `new XOptionsValidator()` from the
    `optionsValidator()` hook (run in `preStart` after the required-field check);
    non-broker consumers call `new XOptionsValidator().validate(settings)` once in
    their constructor, right after the defaults spread. This is not a `resolve`
    helper — the merge stays a plain spread; validation is a separate void
    assertion. `OptionsBuilder` has no set-time validation.
- **All option-relevant types are co-located in `XOptions.ts`** — including the
  `XOptionsType` declaration (the config contract read by `readOptionsFromConfig`)
  and, when present, the `XOptionsValidator` class. The functional file
  (actor/store/factory) imports the type contracts (`XOptions` + `XOptionsType`)
  **type-only** from `./XOptions.js`, and — when it validates — additionally
  **value-imports** `XOptionsValidator`. There is no runtime cycle: `XOptions.ts`
  never imports the functional file, so the value edge only runs one way.
- **A builder *is* its settings.** `OptionsBuilder.set` writes each field as an
  own enumerable property, so a builder instance is structurally a bag of the
  fields you set (the `withX` / `build` methods stay on the prototype and never
  surface when it's spread or serialized). Consumers take the `XOptions` union
  and read the argument **directly** — there is no `resolve` helper: `const s =
  options as XOptionsType` (or, to snapshot / merge, `{ ...defaults, ...(options
  as Partial<XOptionsType>) }`). A plain object and a builder are fully
  interchangeable. Keep the **union** (`XOptions`) in the signature — a
  methods-only builder is not assignable to a bare `XOptionsType` (TS weak-type
  check). Broker actors need nothing: `BrokerActor`'s constructor takes the union
  and snapshots it, so subclasses just `super(options)`. A subclass/consumer that
  *chains* builder methods on its parameter must type that parameter
  `XOptionsBuilder` (the union has no methods).
- **Builder-first is the documented/primary style** — docs and examples
  show the builder; the plain object is the shorthand alternative (mention
  it once per page, don't lead with it).
- **Never nest a builder into a call** — always assign it to its own
  contextual local variable first (`const mqttOptions = MqttOptions
  .create()…; new MqttActor(mqttOptions)`), then pass the variable.
- **Write builder chains multi-line — one `.withX()` per line — when there
  are two or more.** A chain with a *single* `.withX()` stays on one line
  (`const mqttOptions = MqttOptions.create().withClientId('x')`) — forcing a
  lone call onto its own line reads worse. Two or more calls always go
  one-per-line (never a single-line multi-call chain).
- **HOCON precedence is unchanged** — the builder / plain object feeds only
  the highest-precedence explicit layer; unset fields fall through to
  HOCON, then built-in defaults.

## Issues & workflow

- **Issue-first.** Before starting work, check for an existing issue
  (`gh issue list`, or search the tracker). If one exists, work against
  it and take its discussion into account. If none exists, **open one
  first** — for traceability — using the matching template in
  `.github/ISSUE_TEMPLATE/` (bug / feature / documentation / security).
- **Close via the commit body:** when the work lands, close the issue
  with a `Closes #NNN` (or `Fixes #NNN`) line in the commit body. GitHub
  resolves it once the commit reaches the repository's **default** branch
  — here `develop`, not `main` — so the issue closes on the next
  `develop` push rather than at release time. There is no release-window
  in which to reconsider: only add the line when the issue is genuinely
  finished.
- Open an issue before non-trivial work to align on the approach first.
- **Comment on the issue whenever the work changes course.** If something
  you find while working changes the diagnosis, the approach, the scope,
  or your confidence in any of them, say so on the issue *as you find it*
  — a new comment, not an edit to the body, so the sequence stays
  readable.

  The commit message records what was done and why; it is a poor place
  for what turned out to be wrong on the way there, and it is invisible
  to anyone reading the issue later. What is worth a comment:

  - **The report is inaccurate or stale.** The defect is already fixed,
    half-fixed, differently caused than described, or reproduces only
    under a precondition the report omits. Say which part still stands.
  - **The obvious fix does not work.** Record the attempt and why it
    failed, so the next person does not spend the same hour. (`Object.assign`
    reintroducing a prototype-pollution bug verbatim, because it is
    `[[Set]]` too, is exactly this.)
  - **A chosen bound, default or name changed after measuring.** Give the
    numbers that moved it.
  - **The scope moved.** The fix turns out to need a different layer, a
    new seam, or an API change the issue never mentioned — or part of it
    belongs in another issue. Note the split and where the rest went.
  - **A verification step proved nothing.** If a check you relied on was
    invalid, that matters more than the result it produced.

  This is the same reasoning as *Issue-first*: the value is traceability
  for whoever picks the thread up next, including you in six months. A
  duplicate, a wrong severity, or a fix that was tried and abandoned is
  worth more written down than re-derived.

## Labels & security

- Label taxonomy: `priority: {high,medium,low}`,
  `severity: {critical,high,medium,low}`, `security`, `i18n`,
  `infrastructure`, `dependencies`, `production-goal`, plus the standard
  `bug` / `enhancement` / `documentation`. Audit-catalog items use the
  title prefixes `[Security] ` / `[Feature] `.
- **`production-goal` marks the path to production readiness** — it is a
  gate, not a batch marker, so it belongs on any issue that blocks or
  defines that path regardless of which review found it, including ones
  filed long before. Filtering on it should answer "what is still between
  us and running this for real", which is why it is applied to existing
  issues rather than duplicating them.
- **Security-first posture:** cap untrusted input (e.g. WebSocket /
  wire-frame size limits), never trust client-supplied integrity fields,
  use crypto-grade randomness for wire identifiers. A security-relevant
  change gets a `Security` CHANGELOG entry and a `severity:` label.
