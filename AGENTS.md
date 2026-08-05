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
- **The README test-count / coverage badges are bot-maintained** — a CI
  workflow pushes `chore(readme): update test count + coverage stats
  [skip ci]` commits directly to `develop` after test runs. Do NOT edit
  those numbers by hand (the bot overwrites them, with CI-measured values
  that skip the quarantined multi-node suites via
  `ACTOR_TS_SKIP_FLAKY_MNS`, so they differ slightly from a local full
  run). After pushing `develop`, fetch again before branching — a bot
  commit may already have landed on top.
- Adding a page: keep `docs/scripts/scaffold.mjs` and the Astro sidebar
  (`docs/astro.config.mjs`) in sync — same path and label.

## Verification gates (before every commit)

- **`bun run typecheck`** (build tsconfig — excludes `examples/`,
  `tests/` and `benchmarks/`) passes. `bun run typecheck:dev`
  additionally checks those.
- **`bun test`** is green. Line coverage floor is **≥ 80 %** —
  `bun run test:coverage:gate`.
- **Cross-runtime:** `bun run smoke` runs `tests/smoke/cases/*.mjs` on
  Bun, Node, and Deno. Add a smoke case for anything runtime-sensitive.
- **Benchmarks:** a change to a `src/` API that `benchmarks/` calls also
  needs `bun run typecheck:bench` (benchmarks-only compile) and, for
  anything that could break at runtime, `bun run bench:smoke` (~30 s —
  every suite, one unwarmed iteration each). The build tsconfig excludes
  `benchmarks/`, so nothing else catches an orphaned benchmark; the
  `benchmarks` workflow gates both. The benchmarks are part of the
  adoption sweep for a breaking change, exactly like tests and examples.
- **DevTools UI:** a change under `devtools-ui/` needs **`bun run
  build:ui`** in the same commit — `src/devtools/generated/uiAssets.ts`
  is generated but committed, and a stale one is valid TypeScript, so
  nothing else notices. **`bun run check:ui`** asserts it (and gates the
  `build` workflow) by comparing a `source-hash` over the UI sources,
  the build script and the bundled dependencies. It deliberately does
  not compare the bundle's bytes: those vary with the OS and the Bun
  release that produced them, so a byte diff is not a staleness signal.
- **Don't hand-edit** the README test/coverage badges — CI updates them
  on push to `develop`.

## Runtime portability

- Code must run on **Bun, Node ≥ 24, and Deno**. Runtime-specific
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
  with a `Closes #NNN` (or `Fixes #NNN`) line in the commit body. (It
  resolves once the commit reaches `main` on push.)
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
  `infrastructure`, `dependencies`, plus the standard `bug` /
  `enhancement` / `documentation`. Audit-catalog items use the title
  prefixes `[Security] ` / `[Feature] `.
- **Security-first posture:** cap untrusted input (e.g. WebSocket /
  wire-frame size limits), never trust client-supplied integrity fields,
  use crypto-grade randomness for wire identifiers. A security-relevant
  change gets a `Security` CHANGELOG entry and a `severity:` label.
