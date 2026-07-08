# AGENTS.md — working standards for actor-ts

Standards for anyone (human or coding agent) making changes in this
repo. Read this before you start. These are conventions the project
already follows; keep them consistent.

## Project snapshot

`actor-ts` is a **pre-1.0** actor-model framework for TypeScript that
runs on **Bun, Node.js (≥ 20), and Deno**. ESM throughout; **Bun** is
the primary toolchain (`bun test`, `bunx tsc`). Runtime dependencies are
deliberately tiny — `fastify` + `ts-pattern` — and everything else
(Express, Hono, `ws`, brokers, SQL/Cassandra drivers, S3, …) is an
**optional peer dependency**, lazy-loaded on demand.

## Commit strategy

- **Conventional Commits**: `type(scope): subject`. Types in use:
  `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `build`.
  Scope is the module/area, e.g. `http`, `http/ws`, `io`,
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
2. Merge `develop` → `main` with `git merge --no-ff`, then push `main`.
3. `gh release create vX.Y.Z --target main` (a normal **Latest** release, no
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
- Adding a page: keep `docs/scripts/scaffold.mjs` and the Astro sidebar
  (`docs/astro.config.mjs`) in sync — same path and label.

## Verification gates (before every commit)

- **`bun run typecheck`** (build tsconfig — excludes `examples/` and
  `tests/`) passes. `bun run typecheck:dev` additionally checks those.
- **`bun test`** is green. Line coverage floor is **≥ 80 %** —
  `bun run test:coverage:gate`.
- **Cross-runtime:** `bun run smoke` runs `tests/smoke/cases/*.mjs` on
  Bun, Node, and Deno. Add a smoke case for anything runtime-sensitive.
- **Don't hand-edit** the README test/coverage badges — CI updates them
  on push to `develop`.

## Runtime portability

- Code must run on **Bun, Node ≥ 20, and Deno**. Runtime-specific
  primitives (HTTP serve, sockets, workers, SQLite, …) live behind small
  abstractions in **`src/runtime/`** and auto-detect at startup.
- **Optional peer dependencies:** `import()` them lazily with a clear
  *"install it with `bun add …`"* error on failure. Declare them in
  `peerDependencies` **and** `peerDependenciesMeta.<pkg>.optional = true`,
  and add a matching `devDependency` so the test suite can exercise them.

## Code style

- **Strict TypeScript.** ESM with the **`.js` import suffix** on
  relative imports (required by the build's module resolution).
- Discriminated-union handling via **`ts-pattern`**
  (`match(x).with(…).exhaustive()`).
- HOCON config keys go through **`src/config/ConfigKeys.ts`** (typed,
  single source of truth). Options resolve with precedence:
  **explicit options > HOCON > built-in defaults**.
- **JSDoc explains the *why*** — constraints, rationale, non-obvious
  trade-offs — not a restatement of the code. Match the surrounding
  comment density; no narration or noise.

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
- **All option-relevant types are co-located in `XOptions.ts`** — including the
  `XOptionsType` interface (the config contract read by `readOptionsFromConfig`).
  The functional file (actor/store/factory) imports `XOptions` + `XOptionsType`
  **type-only** from `./XOptions.js`; both directions are `import type`, so there
  is no runtime cycle.
- **A builder *is* its options.** `OptionsBuilder.set` writes each field as an
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
  with a `Closes #NNN` (or `Fixes #NNN`) line in the commit body. (It
  resolves once the commit reaches `main` on push.)
- Open an issue before non-trivial work to align on the approach first.

## Labels & security

- Label taxonomy: `priority: {high,medium,low}`,
  `severity: {critical,high,medium,low}`, `security`, `i18n`,
  `infrastructure`, `dependencies`, plus the standard `bug` /
  `enhancement` / `documentation`. Audit-catalog items use the title
  prefixes `[Security] ` / `[Feature] `.
- **Security-first posture:** cap untrusted input (e.g. WebSocket /
  wire-frame size limits), never trust client-supplied integrity fields,
  use crypto-grade randomness for wire identifiers. A security-relevant
  change gets a `Security` CHANGELOG entry and a `severity:` label.
