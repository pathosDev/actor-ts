import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Repo-file guard over the optional-peer declaration split — the same class of
 * check as `tests/unit/ci/SecurityPolicy.test.ts` and
 * `tests/unit/config/NoDeadConfigKeys.test.ts`: assertions about manifests no
 * compiler reads, run under plain `bun test` because nothing else in the
 * toolchain would ever notice them rotting.
 *
 * Every optional peer is declared a second time, in one of exactly two
 * dependency contexts, and which one follows from how the adapter is exercised
 * (AGENTS.md, *Runtime portability*):
 *
 *   - the **root `devDependencies`**, when a suite under `bun test` or a
 *     `tests/smoke/` case imports the REAL module;
 *   - **`tests/integration/brokers/package.json`**, when the adapter earns its
 *     coverage against a live broker in Docker — those are absent from the root
 *     `node_modules` by design (`tsconfig.dev.json`'s exclude entry, #540).
 *
 * A peer in NEITHER context is the defect this guards (#676). Nothing installs
 * it, so the hand-written structural stub standing in for its types is checked
 * against nothing, and the failure is silent: `bun run typecheck` never
 * compiles a call site, and the adapter suites all run against fakes, so no
 * existing gate goes red. #676 found four in that state (`ws`,
 * `cassandra-driver`, `memjs`, `fzstd`), all four of them optional peers since
 * the initial scaffold.
 *
 * `ws` was the sharp one and is why the second test below exists. It was
 * present in `node_modules` the whole time — pulled in transitively by
 * `@fastify/websocket` (`dependencies.ws`) and `@hono/node-ws` — so
 * `tests/integration/in-process/http/websocket/ExpressWebsocket.test.ts` and
 * `tests/smoke/cases/20-express-upgrade-middleware.mjs` passed on hoisting
 * luck. Drop either upstream edge and both start failing, with no root
 * declaration to hold the package in the tree. A coverage check alone would not
 * have caught that: moving `ws` to the brokers manifest satisfies "declared
 * somewhere" while leaving the root `bun test` pass just as broken.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

type Manifest = {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function readManifest(...segments: readonly string[]): Manifest {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, ...segments), 'utf8')) as Manifest;
}

const rootManifest = readManifest('package.json');
const brokerManifest = readManifest('tests', 'integration', 'brokers', 'package.json');

const optionalPeers: readonly string[] = Object.entries(rootManifest.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta.optional === true)
  .map(([name]) => name)
  .sort();

const rootDevDependencies: readonly string[] = Object.keys(rootManifest.devDependencies ?? {});
const brokerDependencies: readonly string[] = Object.keys(brokerManifest.dependencies ?? {});

/**
 * Optional peers knowingly declared in neither context, each with the reason
 * and the issue that removes it — exactly how `KNOWN_DEAD_KEYS` works in
 * `tests/unit/config/NoDeadConfigKeys.test.ts`. An entry here is a standing
 * admission that one adapter's types are checked against nothing, so growing
 * this list is not the way to make the coverage test below pass.
 *
 * - `cassandra-driver` — blocked on `bun run lint:audit`, not on effort. The
 *   driver's newest release (4.9.0) declares `adm-zip: ~0.5.10` as a hard
 *   dependency, and GHSA-xcpc-8h2w-3j85 (high — a crafted ZIP triggers a 4 GB
 *   allocation) is fixed only in `adm-zip` 0.6.0, which that range cannot
 *   reach. So no published version of the driver installs cleanly here, and
 *   the ways out are all decisions above this test's pay grade:
 *
 *   1. Suppress the advisory — a new `--ignore` plus a `SECURITY.md` row.
 *      Every suppression on file predates the gate rather than having been
 *      added to get a change through, so this would be the first of its kind.
 *   2. Stand up a Cassandra Docker suite (#1169 tracks it from the coverage
 *      side), so the brokers manifest legitimately owns the driver and the
 *      root install never sees it.
 *   3. Drop the backend.
 *   4. Pin `adm-zip` past the advisory with an `overrides` / `resolutions`
 *      entry. This one is listed because leaving it out is how it gets
 *      rediscovered as a clever trick rather than weighed as what it is, and
 *      it does work: bun 1.4.0 honours both spellings, taking `~0.5.10` from
 *      0.5.18 to 0.6.0 (measured). It is also the worst of the four. npm-style
 *      overrides apply only while this package is the root project, so it
 *      would clear OUR audit while every consumer who installs the Cassandra
 *      backend resolves the vulnerable range exactly as before — option 1
 *      without the row anyone reviews.
 *      `tests/unit/ci/SecurityPolicy.test.ts` requires any override to be
 *      written up in `SECURITY.md`, so this route is open but not silent.
 *
 *   Until one is chosen, `CassandraClientLike` and the inline
 *   `CassandraDriver` type in `src/persistence/journals/CassandraClient.ts`
 *   are checked only against `FakeCassandraClient`. Refs #676.
 */
const DELIBERATELY_UNDECLARED: readonly string[] = ['cassandra-driver'];

/**
 * Test trees whose imports another manifest resolves, so a literal specifier
 * in them says nothing about the ROOT install.
 *
 * The same boundary `tsconfig.dev.json` draws, for the same reason:
 * `tests/integration/brokers/**` is compiled and run inside the containers
 * `bun run test:integration:brokers` starts, against
 * `tests/integration/brokers/package.json`. Its `await import('amqplib')` is
 * correct there and would be a false positive here.
 */
const FOREIGN_MANIFEST_TREES: readonly string[] = ['integration/brokers'];

/**
 * Sources whose content IS sample code rather than code, so a specifier in
 * them is data and says nothing about the install.
 *
 * `DocSampleHarness.test.ts` exercises the documentation-sample compiler by
 * feeding it fenced samples as string literals, and those samples import the
 * packages the documentation tells a reader to install — `import Redis from
 * 'ioredis'` among them. Nothing in that file resolves a module.
 *
 * A file-level exclusion for the same reason `withoutCommentLines` stops at
 * line level: separating a quoted specifier from a real one needs a string
 * parser, and a guard whose own machinery needs a test is not a guard. Adding
 * to this list is a claim that the whole file is fixture text, which is
 * verifiable by reading it; anything narrower would not be.
 */
const SAMPLE_FIXTURE_SOURCES: readonly string[] = ['unit/docs/DocSampleHarness.test.ts'];

/**
 * Drop whole-line comments before scanning for imports.
 *
 * Not fussiness — without it the scan reports the opposite of the truth twice
 * over. `tests/unit/persistence/object-storage/S3ObjectStorageBackend.test.ts`
 * explains its `mock.module` setup in a comment that quotes the very import
 * expression it is replacing, and this file's own documentation quotes an
 * `amqplib` specifier as an example of what NOT to count. Both are prose about
 * imports, and a substring match over raw text cannot tell prose from code.
 *
 * Line-level is deliberately as far as this goes. A real `import` statement or
 * `await import(…)` never begins a line with `//`, `*` or `/*`, so dropping
 * those lines cannot hide one; anything subtler would be a comment parser, and
 * a guard whose own machinery needs a test is not a guard.
 */
function withoutCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/** Every `tests/` file that `bun test` or `bun run smoke` resolves against the ROOT manifest. */
function rootScopedTestSources(): readonly string[] {
  const testsRoot = join(REPOSITORY_ROOT, 'tests');
  return readdirSync(testsRoot, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.mjs'))
    .filter((entry) => !FOREIGN_MANIFEST_TREES.some((tree) => entry.startsWith(`${tree}/`)))
    .filter((entry) => !SAMPLE_FIXTURE_SOURCES.includes(entry))
    .map((entry) => withoutCommentLines(readFileSync(join(testsRoot, entry), 'utf8')));
}

/** Every `src/` file the build compile (`bun run typecheck`) reads. */
function librarySources(): readonly string[] {
  const sourceRoot = join(REPOSITORY_ROOT, 'src');
  return readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => withoutCommentLines(readFileSync(join(sourceRoot, entry), 'utf8')));
}

/**
 * Optional peers that the given sources name in a LITERAL import specifier.
 *
 * Literal is the operative word, and it is not a stylistic preference: it is
 * the only form that actually resolves the real package at a fixed name. The
 * adapters deliberately use `const name = 'ws'; await import(name)` so that a
 * missing optional peer is a caught error rather than a hard module
 * resolution, and `mock.module('@aws-sdk/client-s3', …)` never loads the real
 * module at all — neither implies anything about the install. A literal
 * specifier does: the file cannot compile or run unless the package is really
 * there.
 *
 * Which is why one scanner serves both directions below. Over the test tree a
 * hit is a *requirement* — the package has to be a root devDependency. Over
 * `src/` a hit is a *defect*, and the same substring match decides both, so
 * the non-empty result next door is what proves this one's empty result means
 * something.
 */
function optionalPeersImportedLiterallyFrom(sources: readonly string[]): readonly string[] {
  return optionalPeers
    .filter((peer) => sources.some((source) => literalSpecifier(peer).test(source)))
    .sort();
}

/**
 * Matches a literal specifier naming `peer`, in every spelling that resolves
 * the real package.
 *
 * Two of them used to slip through a pair of exact substring checks, and both
 * were measured rather than imagined: `from "ws"` with double quotes, and a
 * subpath like `from 'ws/index.js'`. Neither is exotic, and for the ten
 * optional peers that are root devDependencies neither is caught downstream
 * either — `tsc` resolves the module, so TS2307 never fires, the specifier is
 * emitted into the published `.d.ts`, and a consumer who took the peer at its
 * word cannot resolve it. That is the exact harm this guard exists to prevent,
 * so the scan has to be as wide as the claim it makes.
 */
function literalSpecifier(peer: string): RegExp {
  const escaped = peer.replaceAll(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
  return new RegExp(`(?:from|import\\()\\s*['"]${escaped}(?:/[^'"]*)?['"]`);
}

function literallyImportedOptionalPeers(): readonly string[] {
  return optionalPeersImportedLiterallyFrom(rootScopedTestSources());
}

describe('optional peer declarations', () => {
  /**
   * Guards the guard. Every assertion below is a filter over three lists, and
   * a filter over an empty list is vacuously satisfied — so a renamed manifest
   * key or a moved file would turn this whole suite green while asserting
   * nothing. That is the failure mode #1194 taught this repository to write
   * assertions against.
   */
  test('both dependency contexts were actually read', () => {
    expect(
      optionalPeers.length,
      'No optional peers found in the root package.json. Either '
      + '`peerDependenciesMeta` was renamed or its entries stopped carrying '
      + '`optional: true` — every assertion below filters this list and would '
      + 'pass trivially.',
    ).toBeGreaterThan(20);
    expect(rootDevDependencies.length).toBeGreaterThan(10);
    expect(
      brokerDependencies.length,
      'tests/integration/brokers/package.json declares almost nothing. It is '
      + 'the manifest that owns the Docker-covered peers; an empty one makes '
      + 'the coverage test below pass by having nothing to compare.',
    ).toBeGreaterThan(10);
    expect(rootScopedTestSources().length).toBeGreaterThan(100);
  });

  /**
   * The core invariant: no optional peer is declared nowhere.
   *
   * This is what would have caught `imapflow` and `nodemailer` had the email
   * bridge forgotten them — they went into the brokers manifest correctly, but
   * nothing checked.
   */
  test('every optional peer is declared in one of the two contexts', () => {
    const undeclared = optionalPeers.filter((peer) =>
      !rootDevDependencies.includes(peer)
      && !brokerDependencies.includes(peer)
      && !DELIBERATELY_UNDECLARED.includes(peer));
    expect(
      undeclared,
      'These optional peers are declared in neither the root `devDependencies` '
      + 'nor tests/integration/brokers/package.json, so nothing ever installs '
      + 'them and the structural stubs standing in for their types are checked '
      + 'against nothing. Add the package to the root manifest when a suite can '
      + 'import the real module in-process, or to the brokers manifest when it '
      + 'earns its coverage against a live broker in Docker (see AGENTS.md, '
      + '*Runtime portability*). Note `bun add` no-ops for a package already '
      + 'listed as an optional peer — write the entry by hand, then `bun '
      + 'install`.',
    ).toEqual([]);
  });

  /**
   * The allow-list is the one part of this guard that can rot in the quiet
   * direction: a name left behind after the package stopped being an optional
   * peer, or misspelled from the start, suppresses nothing and looks like it
   * suppresses something — so the next real gap hides behind a dead entry.
   * Same reasoning as the bijection in `SecurityPolicy.test.ts`: the exemption
   * list and the thing it exempts have to move together.
   */
  test('the allow-list holds only optional peers that are really undeclared', () => {
    const notAPeerAnyMore = DELIBERATELY_UNDECLARED.filter((peer) => !optionalPeers.includes(peer));
    expect(
      notAPeerAnyMore,
      'DELIBERATELY_UNDECLARED names packages that are no longer optional peers '
      + '(removed, renamed, or misspelled). Delete them — a dead exemption is a '
      + 'gap the coverage test can never report.',
    ).toEqual([]);
    const quietlyDeclared = DELIBERATELY_UNDECLARED.filter((peer) =>
      rootDevDependencies.includes(peer) || brokerDependencies.includes(peer));
    expect(
      quietlyDeclared,
      'These are on the allow-list but ARE declared now, so the exemption is '
      + 'spent. Remove the entry and the issue reference with it — that is how '
      + 'the list stays a to-do rather than a permanent excuse.',
    ).toEqual([]);
  });

  /**
   * The sharper half, and the one that pins #676's actual defect: a peer a
   * root-scoped test imports by literal specifier has to be in the ROOT
   * manifest. Satisfying the coverage test above by putting it in the brokers
   * manifest would leave `bun test` resolving it through whatever transitive
   * edge happens to hoist it — which is precisely how `ws` passed from the
   * initial scaffold until #676.
   */
  test('every literally imported optional peer is a root devDependency', () => {
    const imported = literallyImportedOptionalPeers();
    // Guards this guard: the scan is a substring match, so a refactor that
    // reformatted every import would silently empty it.
    expect(
      imported.length,
      'No optional peer is imported by literal specifier from a root-scoped '
      + 'test any more. The scan below is a substring match over test sources; '
      + 'if the import style changed, it stopped finding anything and this '
      + 'assertion stopped meaning anything.',
    ).toBeGreaterThan(0);
    // And that it still DISCRIMINATES, which a count cannot show. `amqplib` is
    // imported by literal specifier — three times, under
    // tests/integration/brokers/amqp/scenarios/ — and is quoted in this file's
    // own prose. It must be absent on both counts: the brokers tree resolves
    // against its own manifest, and a comment is not an import. Drop either
    // filter and this fails while every assertion above still passes.
    expect(
      imported,
      'The scan picked up `amqplib`, which is declared in the brokers manifest '
      + 'on purpose. Either FOREIGN_MANIFEST_TREES stopped excluding '
      + 'tests/integration/brokers, or withoutCommentLines stopped dropping '
      + 'prose — both would make the assertion below demand root '
      + 'devDependencies for every Docker-only peer.',
    ).not.toContain('amqplib');
    const hoistingDependent = imported.filter((peer) => !rootDevDependencies.includes(peer));
    expect(
      hoistingDependent,
      'These optional peers are imported by literal specifier from a test that '
      + '`bun test` / `bun run smoke` resolves against the ROOT manifest, but '
      + 'the root manifest does not declare them. They resolve today only '
      + 'because something else happens to pull them in transitively, and that '
      + 'edge is not ours to rely on — when it goes, the suite fails with a '
      + '"Cannot find module" that looks nothing like a dependency-declaration '
      + 'bug. Add each one to the root `devDependencies` (#676).',
    ).toEqual([]);
  });

  /**
   * The opposite direction, and the one that settles #676's `nats` follow-up:
   * nothing in `src/` may name an optional peer in an import specifier. Every
   * adapter reaches its peer through a hand-written structural stub instead —
   * `NatsConnectionLike`, `CassandraDriver`, `MemjsClientStatic`,
   * `WebsocketServerLike` — and that is the design, not a placeholder.
   *
   * It reads like a placeholder, which is why this test exists. #676's
   * round-4 scan comment asked for the reverse: replace the `nats` stubs in
   * `src/io/broker/NatsActor.ts` and `src/io/broker/JetStreamActor.ts` with
   * the module's real types "once this issue adds the missing
   * devDependencies", so a `nats` major bump could not drift silently. The
   * precondition never arrived and cannot. `nats` is declared only in
   * `tests/integration/brokers/package.json`, which is deliberately not
   * installed at the root, so the build compile cannot resolve it — measured:
   * a type-only import of it from `src/` fails `bun run typecheck` with
   * TS2307.
   *
   * Installing it at the root would not make the follow-up right either, and
   * that is the part worth pinning, because it survives the install argument.
   * The stubs are *exported* — `NatsConnectionLike` and its siblings reach
   * `dist/io/index.d.ts` through `src/io/broker/index.ts`, a declared package
   * entry point — and `tsconfig.json` emits declarations. A real
   * `import type … from 'nats'` there would be emitted into a published
   * `.d.ts`, so a consumer who has not installed the optional peer resolves
   * nothing: TS2307 without `skipLibCheck`, a silent `any` with it. That is
   * precisely the cost "optional" is supposed to spare them.
   *
   * So the drift the comment worried about is real and is covered elsewhere —
   * by a live broker in Docker (`tests/integration/brokers/nats/`), which
   * catches a rename the types would only have caught at compile time in a
   * tree that cannot compile it. The follow-up is withdrawn, and this is the
   * assertion that says so instead of the silence that implied it.
   */
  test('no optional peer is named by a literal import specifier in src/', () => {
    const sources = librarySources();
    // Guards the guard: an empty or mis-rooted tree walk would make the
    // filter below vacuous, and this whole test asserts an ABSENCE.
    expect(
      sources.length,
      'The src/ tree walk found almost nothing. Every assertion here filters '
      + 'that list, and a filter over an empty list reports no violations.',
    ).toBeGreaterThan(400);
    const leaked = optionalPeersImportedLiterallyFrom(sources);
    expect(
      leaked,
      'These optional peers are named by a literal import specifier in `src/`. '
      + 'The library must reach every optional peer through a lazy '
      + '`lazyImportModule(name)` and a hand-written structural type, for two '
      + 'reasons that both outlive the install: the build compile has no '
      + 'access to a peer that only tests/integration/brokers/package.json '
      + 'declares, and an exported type that imports one would put that '
      + 'specifier into a published `.d.ts`, where a consumer who took the '
      + '"optional" at its word cannot resolve it. Widen the structural stub '
      + 'instead (#676).',
    ).toEqual([]);
  });
});

describe('the optional-peer rule in AGENTS.md', () => {
  const workingStandards = readFileSync(join(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8');

  /**
   * The rule and the tree contradicted each other for two waves, which is how
   * #676 came to prescribe adding all eighteen missing devDependencies —
   * correct arithmetic against a rationale that had stopped being true.
   * AGENTS.md said to add a devDependency "so the test suite can exercise
   * them"; `tsconfig.dev.json` said fourteen of them are absent from the root
   * install by design. An implementer reading either one alone does the wrong
   * thing, so the reconciled wording is worth pinning.
   */
  test('names both dependency contexts', () => {
    const rule = workingStandards.slice(workingStandards.indexOf('**Optional peer dependencies:**'));
    expect(rule.length).toBeGreaterThan(400);
    expect(
      rule,
      'The optional-peer rule must name tests/integration/brokers/package.json '
      + 'as the second dependency context. Naming only the root '
      + '`devDependencies` is the state that contradicted '
      + "tsconfig.dev.json's exclude entry.",
    ).toContain('tests/integration/brokers/package.json');
    expect(rule).toContain('devDependencies');
    expect(
      rule,
      'The rule must point at the guard that enforces it, so the split cannot '
      + 'be changed in prose alone.',
    ).toContain('OptionalPeerDeclarations.test.ts');
  });

  /**
   * The refuted rationale specifically. It is not a harmless simplification:
   * it is why the issue asked for eighteen packages that would have flipped
   * zero suites from skipped to running. No test in this repository conditions
   * on module availability — every adapter path runs against a hand-rolled
   * fake — so installing a package exercises nothing on its own. A test that
   * imports the real module is what buys the coverage, and the rule has to say
   * so or the next reader re-derives the wrong conclusion.
   */
  test('no longer claims a devDependency makes the suite exercise the peer', () => {
    expect(
      workingStandards.replace(/\s+/g, ' '),
      'AGENTS.md still carries "so the test suite can exercise them". Adding a '
      + 'devDependency does not make any suite exercise the package — nothing '
      + 'in tests/ is conditioned on module availability, so no suite changes '
      + 'behaviour when one appears. Say what it actually buys: a test that '
      + 'imports the real module and checks the shape the adapter destructures.',
    ).not.toMatch(/so the test suite can exercise them/);
  });
});
