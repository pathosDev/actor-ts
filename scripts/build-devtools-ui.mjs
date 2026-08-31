#!/usr/bin/env bun
/**
 * Bundle the DevTools UI and embed it into a TypeScript module.
 *
 * Why embed instead of copying files into `dist/`: `bunx tsc` copies no
 * static assets, so shipping files would need a publish-time copy step;
 * resolving a path relative to the compiled module breaks as soon as a
 * consumer bundles their server or runs `deno compile`; and Deno would
 * need a read permission for the package directory.  A generated module
 * flows through the normal build, ships with `files: ["dist/"]`
 * unchanged, and needs no filesystem access at runtime.
 *
 * Assets are gzipped and hashed HERE so the server spends no CPU per
 * request and the ETag is content-derived — an mtime-based one would
 * change on every `npm install`, invalidating caches for no reason.
 *
 *   bun scripts/build-devtools-ui.mjs            build + regenerate the module
 *   bun scripts/build-devtools-ui.mjs --check    assert the committed module is current
 *   bun scripts/build-devtools-ui.mjs --dev      plain files in devtools-ui/.dev
 *   bun scripts/build-devtools-ui.mjs --dev --watch
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { mkdir, readdir, readFile, rm, watch, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireUiToolchain } from './ui-toolchain.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = join(repositoryRoot, 'devtools-ui');
const indexHtml = join(uiRoot, 'index.html');
const buildDirectory = join(uiRoot, '.angular-build');
const developmentDirectory = join(uiRoot, '.dev');
const generatedModule = join(repositoryRoot, 'src', 'devtools', 'generated', 'UiAssets.ts');

/**
 * Build output that must not be embedded.
 *
 * `stats.json` is the builder's own metafile — it is how chunks are attributed
 * to panels below, and it is bigger than several panels put together.
 * `prerendered-routes.json` describes a prerender this application does not do.
 * Neither is ever requested by the served document.
 */
const IGNORED_OUTPUTS = new Set(['stats.json', 'prerendered-routes.json']);

/**
 * gzip size ceilings, in kibibytes.
 *
 * Each panel is a lazy chunk, and every chunk is attributed to exactly one
 * bucket — that is the real reason the bundle is split, more than load time.
 * Everything else (entry, shared chunks, CSS, HTML) is the shell, which every
 * page load pays for and is therefore held tightest.  The per-panel numbers
 * come from the panel issues: #204 asks for ≤ 200 KB, #217 for ≤ 100 KB.
 *
 * The shell figure moved from 60 to 100 KiB when Angular replaced the
 * hand-rolled framework (#483): the framework's core and its bootstrap land
 * there, and the ceiling is what the shell may cost, not a target it should
 * grow into.  `charts` is declared ahead of #486 for the same reason the
 * dependency is installed early — ECharts is lazy and shared by four panels,
 * so it needs a bucket of its own rather than inflating whichever panel
 * happens to pull it first.  The 400 KiB total is unchanged.
 */
const SHELL_BUDGET_KIB = 100;
const TOTAL_BUDGET_KIB = 400;
const PANEL_BUDGETS_KIB = {
  // 200, not the 150 #486 estimated.  Measured, because the estimate could not
  // be met by any import set: ECharts costs 165.9 KB gzip with a SINGLE chart
  // type registered, and the two this UI additionally needs are cheap on top of
  // that floor — CustomChart (flame graph, icicle) adds 8.3 KB and GraphChart
  // (cluster ring) adds 14.7 KB, for 188.9 KB in total.  So the number is the
  // library, not the drawings, and trimming further would mean giving up a
  // chart kind rather than shaving a budget.
  //
  // It stays a bucket of its own because it is LAZY: the chunk loads when a
  // charting panel opens, so a reader who opens the actor tree pays none of it.
  // The 400 KiB total is what actually protects the reader, and it holds with
  // roughly a quarter to spare.
  charts: 200,
  dashboard: 60,
  timeTravel: 80,
  profiler: 100,
  actors: 200,
  cluster: 120,
  tracing: 100,
  explain: 60,
  deadLetters: 60,
  eventStream: 60,
  config: 60,
  send: 60,
};

/**
 * `src/panels/timetravel/timeTravelPanel.ts` → `timeTravel`.
 *
 * The bucket name comes from the file, not the directory: the budget keys
 * predate this change and are camelCase (`timeTravel`) while the directory is
 * not (`timetravel`).  Deriving from the file keeps every existing budget key
 * valid, so this issue changes how attribution is discovered without changing
 * what is being budgeted.
 *
 * `PanelComponent` is accepted alongside `Panel` so a panel keeps its bucket
 * across the port to an Angular component (#485), where `explainPanel.ts`
 * becomes `ExplainPanelComponent.ts`.  Without it the renamed chunk would land
 * in the shell bucket — which is worse than failing, because the budget would
 * still be green while no longer measuring the thing it names.
 */
function panelFromEntryPoint(entryPoint) {
  // Anything the chart module tree is the entry point of belongs to `charts`,
  // not to whichever panel happened to pull it in first.  ECharts is lazy and
  // shared by four panels, so attributing it to one of them would make that
  // panel's budget meaningless and leave the others looking free (#486).
  if (/(?:^|\/)src\/app\/charts\//.test(entryPoint)) return 'charts';
  const name = /(?:^|\/)([A-Za-z0-9]+)Panel(?:Component)?\.ts$/.exec(entryPoint)?.[1];
  // Lower-cased first letter because a component file is PascalCase
  // (`ExplainPanelComponent.ts`) while a legacy one is not (`explainPanel.ts`),
  // and both have to land in the same bucket — the budget keys name the panel,
  // not the file.  Idempotent for the names that were already camelCase.
  return name === undefined ? null : name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Read `stats.json` and map each emitted file to its bucket.
 *
 * Only entry points that are panels produce a bucket; `src/main.ts` and every
 * chunk without an entry point fall through to the shell, which is the same
 * split the previous build applied by file name.
 */
async function readChunkAttribution(outputDirectory) {
  const statsPath = join(outputDirectory, 'stats.json');
  if (!existsSync(statsPath)) {
    throw new Error(
      `${relative(repositoryRoot, statsPath)} is missing — the build cannot attribute `
      + 'chunks to size budgets without it. `statsJson` must stay enabled in angular.json.',
    );
  }
  const stats = JSON.parse(await readFile(statsPath, 'utf8'));
  const attribution = new Map();
  for (const [path, output] of Object.entries(stats.outputs ?? {})) {
    const panel = output.entryPoint === undefined ? null : panelFromEntryPoint(output.entryPoint);
    if (panel !== null) attribution.set(path.replaceAll('\\', '/'), panel);
  }
  return attribution;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const development = process.argv.includes('--dev');
const watchMode = process.argv.includes('--watch');
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  await checkFreshness();
} else {
  await run();
  if (watchMode) await watchForChanges();
}

async function run() {
  requireUiToolchain('the DevTools UI build');

  const outputDirectory = development ? developmentDirectory : buildDirectory;
  await rm(outputDirectory, { recursive: true, force: true });
  runAngularBuild();

  // Angular writes `index.html` itself, with its own hashed `<script>` and
  // `<link>` injected, so the document is no longer read from source here —
  // reading it would embed the version that references nothing.
  const emitted = await filesUnder(outputDirectory);
  const files = [];
  for (const absolute of emitted) {
    const path = relative(outputDirectory, absolute).replaceAll('\\', '/');
    if (IGNORED_OUTPUTS.has(path)) continue;
    files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
  }

  assertServableUnderAnyPrefix(files);

  if (development) {
    // The dev root is served straight off disk via `uiDevelopmentRoot`, and
    // the builder already wrote index.html into it.
    report(files.map((file) => ({ ...file, bucket: 'shell', gzipBytes: gzip(file.bytes) })));
    console.log(`\ndev bundle → ${relative(repositoryRoot, outputDirectory)}`);
    return;
  }

  const attribution = await readChunkAttribution(outputDirectory);
  const bucketed = files.map((file) => ({ ...file, bucket: attribution.get(file.path) ?? 'shell' }));
  assertNoCarriageReturns(bucketed);

  const assets = rehashChunkNames(bucketed).map((file) => {
    const gzipBytes = gzip(file.bytes);
    return {
      path: file.path,
      bucket: file.bucket,
      contentType: contentTypeOf(file.path),
      size: file.bytes.byteLength,
      etag: `"${createHash('sha256').update(file.bytes).digest('base64url').slice(0, 27)}"`,
      gzipBase64: Buffer.from(gzipBytes).toString('base64'),
      gzipBytes,
    };
  });

  enforceBudgets(assets);
  report(assets);
  await emitModule(assets, await sourceHash());
}

/**
 * Run the nested Angular build, inheriting its output so a template error
 * reads the way it would if you had run `ng build` yourself.
 */
function runAngularBuild() {
  const script = development ? 'build:dev' : 'build';
  const result = spawnSync('bun', ['run', script], {
    cwd: uiRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw new Error(`DevTools UI build could not start — ${result.error.message}`);
  if (result.status !== 0) throw new Error('DevTools UI bundle failed');
}

/**
 * The served document has to work at the server root (`DevTools.attach`) AND
 * under a prefix (`DevTools.mount('/devtools')`), which is what the
 * trailing-slash 301 in `UiAssetRoutes.ts` exists for.  Two ways to lose that,
 * both silent until someone mounts under a prefix:
 *
 *   - a base element resolving to the server root.  Angular's builder always
 *     emits one; `angular.json`'s `"baseHref": "./"` is what makes it `./`
 *     rather than `/`, and `./` is exactly right — it anchors every relative
 *     reference to the directory the document was served from, whatever that
 *     directory turns out to be.
 *   - any root-relative `src`/`href`, which resolves past the prefix
 *     regardless of the base.
 *
 * `data:` URIs are exempt: the inline favicon is one, and it references
 * nothing on the server.
 */
function assertServableUnderAnyPrefix(files) {
  const document = files.find((file) => file.path === 'index.html');
  if (document === undefined) throw new Error('DevTools UI build produced no index.html');
  const html = new TextDecoder().decode(document.bytes);

  const base = /<base\b[^>]*\bhref="([^"]*)"/i.exec(html)?.[1];
  if (base !== undefined && base.startsWith('/')) {
    throw new Error(
      `index.html carries <base href="${base}">, which pins every asset to the server root `
      + "and breaks DevTools.mount('/devtools'). Set `baseHref` to './' in "
      + 'devtools-ui/angular.json.',
    );
  }

  const rooted = [...html.matchAll(/\b(?:src|href)="([^"]*)"/gi)]
    .map((match) => match[1])
    .filter((reference) => reference.startsWith('/'));
  if (rooted.length > 0) {
    throw new Error(
      `index.html references ${rooted.join(', ')} from the server root, which breaks `
      + "DevTools.mount('/devtools'). Asset references must be relative.",
    );
  }
}

/**
 * Fail on a CRLF in any embedded text asset.
 *
 * `index.html` used to be read through {@link readNormalised}, which stripped
 * them; it now comes out of the builder along with everything else, and
 * normalising minified output blindly would corrupt a string literal that
 * legitimately contains one.  Asserting instead keeps the bundle a function of
 * the sources on Windows and Linux alike, and says so when it is not.
 */
function assertNoCarriageReturns(files) {
  const decoder = new TextDecoder();
  const offenders = files
    .filter((file) => /\.(?:js|css|html|json|svg)$/.test(file.path))
    .filter((file) => decoder.decode(file.bytes).includes('\r\n'));
  if (offenders.length > 0) {
    throw new Error(
      `CRLF line endings in built assets: ${offenders.map((file) => file.path).join(', ')}. `
      + 'The embedded bundle would then differ between Windows and Linux for the same commit. '
      + 'Check .gitattributes for the sources these were built from.',
    );
  }
}

/**
 * Assert the committed module was generated from the sources present.
 *
 * Compares the `source-hash` in its header against a freshly computed
 * one — it does NOT rebuild.  A rebuild-and-diff is the obvious way to
 * write this check and the wrong one: the emitted bytes are not a
 * function of the sources alone.  `gzipSync` stamps the compiling
 * platform's OS code into byte 9 of every member (0x0a on Windows, 0x03
 * on Linux), and `Bun.build`'s minifier output moves between Bun
 * releases while CI tracks `latest`.  Either one makes a byte diff fire
 * on a bundle that is perfectly current (#521).
 *
 * What this catches is the thing worth catching: sources changed and
 * nobody ran `bun run build:ui`.  What it deliberately does not catch is
 * bundler drift — a newer Bun emitting smaller output for unchanged
 * sources is not staleness, and treating it as such is what made the
 * previous gate unpassable.
 */
async function checkFreshness() {
  const expected = await sourceHash();
  const source = existsSync(generatedModule)
    ? await readFile(generatedModule, 'utf8')
    : null;
  const committed = source === null
    ? null
    : /^ \* source-hash: ([0-9a-f]+)$/m.exec(source)?.[1] ?? null;

  if (committed === expected) {
    console.log(`embedded DevTools UI bundle is current (source-hash ${expected})`);
    return;
  }

  const detail = committed === null
    ? `${relative(repositoryRoot, generatedModule)} is missing or carries no source-hash`
    : `it was generated from ${committed}, the sources hash to ${expected}`;
  const message = `Committed DevTools UI bundle is stale — ${detail}. `
    + "Run 'bun run build:ui' and commit the result.";
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::error file=${posixPath(generatedModule)}::${message}`);
  }
  console.error(message);
  process.exitCode = 1;
}

/**
 * Hash of everything the bundle is built from.
 *
 * Embedded in the generated module so `--check` can tell a stale bundle
 * from a current one without rebuilding — see {@link checkFreshness} for
 * why rebuilding is not an option.  Line endings are normalised and
 * paths are compared in POSIX form, so the same commit hashes the same
 * on every platform.
 *
 * `package.json`'s `dependencies` are in there because `ts-pattern` gets
 * bundled into the output: a version bump makes the committed bundle
 * stale without touching one UI source file.
 */
async function sourceHash() {
  const inputs = [
    posixPath(indexHtml),
    posixPath(join(uiRoot, 'tsconfig.json')),
    posixPath(join(uiRoot, 'tsconfig.app.json')),
    posixPath(join(uiRoot, 'angular.json')),
    posixPath(join(uiRoot, 'package.json')),
    posixPath(fileURLToPath(import.meta.url)),
    ...(await filesUnder(join(uiRoot, 'src'))).map(posixPath),
  ].sort();

  const digest = createHash('sha256');
  for (const path of inputs) {
    digest.update(path);
    digest.update('\0');
    digest.update(await readNormalised(join(repositoryRoot, path)));
    digest.update('\0');
  }
  // The root's `dependencies` still count: `ts-pattern` is bundled into the
  // output, so a version bump makes the committed bundle stale without any UI
  // source changing.  `devtools-ui/package.json` is hashed whole, above, which
  // covers the Angular and ECharts versions the same way.
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  digest.update(JSON.stringify(manifest.dependencies ?? {}));
  return digest.digest('hex').slice(0, 16);
}

/** Every file under `directory`, recursively.  Absolute paths. */
async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** Repository-relative path with forward slashes, on every platform. */
function posixPath(path) {
  return relative(repositoryRoot, path).replaceAll('\\', '/');
}

/**
 * Re-derive every hashed chunk name from the bytes the chunk ships.
 *
 * Bun's `[hash]` is not a pure function of a chunk's content: it also
 * varies with the path the module resolved from.  Bundling inside a git
 * worktree — whose `node_modules` sits several directories above the
 * project root — therefore emits byte-identical chunks under different
 * names than a plain checkout does, and the committed bundle reads as
 * stale for everyone whose layout differs from whoever last regenerated
 * it.  Nothing catches that: only the names move, so the sizes, the
 * typecheck and the tests all stay green.
 *
 * Hashing what we actually ship makes the bundle a pure function of the
 * sources, on any layout and any platform — the same reasoning that
 * already makes the ETags content-derived rather than mtime-derived.
 *
 * Names resolve dependency-first: renaming a chunk rewrites the
 * importers that reference it, which changes their bytes and so their
 * own names.  Dev builds are served off disk under Bun's names and are
 * never embedded, so they are left alone.
 */
function rehashChunkNames(files) {
  // Angular's builder hashes with a mixed-case, base64url-ish alphabet and
  // writes at the output root rather than under `assets/`
  // (`main-BRPG6UHL.js`, `chunk-DJ-4lt2t.js`, `styles-ACD2OGKC.css`), so the
  // shape this matches changed with the toolchain even though the reasoning
  // below did not.
  const hashedName = /^(.+)-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$/;
  const nameParts = new Map();
  for (const file of files) {
    const match = hashedName.exec(file.path);
    if (match !== null) nameParts.set(file.path, { stem: match[1], extension: match[2] });
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const textual = (path) => /\.(?:js|css|html)$/.test(path);
  const baseNameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

  const renamed = new Map();

  /** Substitute in ONE pass, so a rename can never be applied twice. */
  const rewrite = (file) => {
    if (!textual(file.path) || renamed.size === 0) return file.bytes;
    const substitutions = new Map(
      [...renamed].map(([from, to]) => [baseNameOf(from), baseNameOf(to)]),
    );
    const pattern = new RegExp(
      [...substitutions.keys()].map((name) => name.replaceAll('.', '\\.')).join('|'),
      'g',
    );
    const text = decoder.decode(file.bytes).replace(pattern, (name) => substitutions.get(name));
    return encoder.encode(text);
  };

  const hashedChunksReferencedBy = (file) => {
    if (!textual(file.path)) return [];
    const text = decoder.decode(file.bytes);
    return [...nameParts.keys()]
      .filter((path) => path !== file.path && text.includes(baseNameOf(path)));
  };

  // A chunk can be named as soon as every hashed chunk it imports has
  // its final name; the import graph is a DAG, so this always drains.
  const pending = [...nameParts.keys()];
  while (pending.length > 0) {
    const ready = pending.filter((path) =>
      hashedChunksReferencedBy(byPath.get(path)).every((dependency) => renamed.has(dependency)));
    if (ready.length === 0) {
      throw new Error('DevTools UI chunk graph is cyclic — cannot derive stable chunk names');
    }
    for (const path of ready) {
      const file = byPath.get(path);
      file.bytes = rewrite(file);
      const { stem, extension } = nameParts.get(path);
      const digest = createHash('sha256').update(file.bytes).digest('hex').slice(0, 8);
      renamed.set(path, `${stem}-${digest}${extension}`);
      pending.splice(pending.indexOf(path), 1);
    }
  }

  return files.map((file) => ({
    ...file,
    path: renamed.get(file.path) ?? file.path,
    bytes: rewrite(file),
  }));
}

/**
 * Read a text file with its line endings normalised to LF.
 *
 * `index.html` is embedded verbatim, so its bytes would otherwise
 * depend on how the checkout converted line endings — the same commit
 * producing a different bundle on Windows than on Linux, and the
 * freshness check failing for half the contributors.  `.gitattributes`
 * pins the checkout too; this is the belt to that pair of braces.
 */
async function readNormalised(path) {
  const text = await readFile(path, 'utf8');
  return new TextEncoder().encode(text.split('\r\n').join('\n'));
}

function gzip(bytes) {
  // Maximum level: this runs once per build, and every byte saved is a
  // byte the published package carries forever.
  return gzipSync(bytes, { level: zlibConstants.Z_BEST_COMPRESSION });
}

function contentTypeOf(path) {
  const extension = path.slice(path.lastIndexOf('.'));
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

function enforceBudgets(assets) {
  const buckets = new Map([['shell', 0]]);
  for (const asset of assets) {
    buckets.set(asset.bucket, (buckets.get(asset.bucket) ?? 0) + asset.gzipBytes.byteLength);
  }

  const violations = [];
  for (const [bucket, bytes] of buckets) {
    const limitKib = bucket === 'shell' ? SHELL_BUDGET_KIB : PANEL_BUDGETS_KIB[bucket];
    if (limitKib === undefined) {
      // A new panel with no budget would otherwise grow unwatched.
      violations.push(`${bucket}: no size budget declared in build-devtools-ui.mjs`);
      continue;
    }
    if (bytes > limitKib * 1024) {
      violations.push(`${bucket}: ${kilobytes(bytes)} gzip exceeds the ${limitKib}.0 KB budget`);
    }
  }

  const total = [...buckets.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total > TOTAL_BUDGET_KIB * 1024) {
    violations.push(`total: ${kilobytes(total)} gzip exceeds the ${TOTAL_BUDGET_KIB}.0 KB budget`);
  }

  if (violations.length > 0) {
    throw new Error(`DevTools UI size budget exceeded:\n  - ${violations.join('\n  - ')}`);
  }
}

function report(assets) {
  const rows = assets.map((asset) => ({
    asset: asset.path,
    bucket: asset.bucket,
    raw: kilobytes(asset.size ?? asset.bytes.byteLength),
    gzip: kilobytes(asset.gzipBytes.byteLength),
  }));
  console.table(rows);
}

function kilobytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function emitModule(assets, hash) {
  const entries = assets.map((asset) => `  {
    path: ${JSON.stringify(asset.path)},
    contentType: ${JSON.stringify(asset.contentType)},
    size: ${asset.size},
    etag: ${JSON.stringify(asset.etag)},
    gzipBase64: ${JSON.stringify(asset.gzipBase64)},
  },`).join('\n');

  const source = `/* eslint-disable */
/**
 * GENERATED by \`bun run build:ui\` — do not edit.
 *
 * The DevTools UI bundle, gzip-compressed and base64-encoded so it
 * ships through the normal TypeScript build and needs no filesystem
 * access at runtime.  Regenerate after any change under \`devtools-ui/\`;
 * CI fails the build if this file is out of date.
 *
 * \`source-hash\` fingerprints what the bundle was built FROM — the UI
 * sources, the build script and the bundled dependencies — which is what
 * \`bun run build:ui --check\` compares against.  It says nothing about
 * the bytes below: those also vary with the platform and the Bun release
 * that produced them.
 *
 * source-hash: ${hash}
 */
import type { UiAsset } from '../UiAssetRoutes.js';

export const UI_ASSETS: ReadonlyArray<UiAsset> = [
${entries}
];
`;

  await mkdir(dirname(generatedModule), { recursive: true });
  // Read the current module directly rather than existsSync()+readFile: the
  // check-then-use pattern races the writeFile() below (CodeQL
  // js/file-system-race).  A missing file is the only expected error.
  let previous = null;
  try {
    previous = await readFile(generatedModule, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Skip an identical write so a running `tsc --watch` does not churn.
  if (previous === source) {
    console.log('\nembedded bundle unchanged');
    return;
  }
  await writeFile(generatedModule, source, 'utf8');
  console.log(`\nembedded bundle → ${relative(repositoryRoot, generatedModule)} (${hash})`);
}

async function watchForChanges() {
  console.log('\nwatching devtools-ui/ …');
  const watcher = watch(join(uiRoot, 'src'), { recursive: true });
  let queued = null;
  for await (const _event of watcher) {
    // Editors write several times per save; collapse the burst.
    if (queued !== null) clearTimeout(queued);
    queued = setTimeout(() => {
      queued = null;
      run().catch((error) => console.error(error.message));
    }, 80);
  }
}
