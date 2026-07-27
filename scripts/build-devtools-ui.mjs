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
 *   bun scripts/build-devtools-ui.mjs --dev      plain files in devtools-ui/.dev
 *   bun scripts/build-devtools-ui.mjs --dev --watch
 */
import { createHash } from 'node:crypto';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { mkdir, readFile, rm, watch, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = join(repositoryRoot, 'devtools-ui');
const entrypoint = join(uiRoot, 'src', 'main.ts');
const indexHtml = join(uiRoot, 'index.html');
const buildDirectory = join(uiRoot, '.build');
const developmentDirectory = join(uiRoot, '.dev');
const generatedModule = join(repositoryRoot, 'src', 'devtools', 'generated', 'uiAssets.ts');

/**
 * gzip size ceilings, in kibibytes.
 *
 * Panel entry modules are named `<panel>Panel.ts`, so Bun's chunk names
 * carry the panel identity and each budget can be attributed exactly —
 * that is the real reason the bundle is split, more than load time.
 * Everything else (entry, shared chunks, CSS, HTML) is the shell, which
 * every page load pays for and is therefore held tightest.  The
 * per-panel numbers come from the panel issues: #204 asks for ≤ 200 KB,
 * #217 for ≤ 100 KB.
 */
const SHELL_BUDGET_KIB = 60;
const TOTAL_BUDGET_KIB = 400;
const PANEL_BUDGETS_KIB = {
  dashboard: 60,
  notImplemented: 10,
  actors: 200,
  cluster: 120,
  tracing: 100,
  explain: 60,
  timeTravel: 80,
  profiler: 100,
};

/** `assets/dashboardPanel-a1b2c3.js` → `dashboard`; anything else → shell. */
function panelOf(assetPath) {
  return /^assets\/([A-Za-z0-9]+)Panel(-[a-z0-9]+)?\.js$/.exec(assetPath)?.[1] ?? null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

const development = process.argv.includes('--dev');
const watchMode = process.argv.includes('--watch');

await run();
if (watchMode) await watchForChanges();

async function run() {
  const outputDirectory = development ? developmentDirectory : buildDirectory;
  await rm(outputDirectory, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: !development,
    sourcemap: development ? 'linked' : 'none',
    naming: {
      entry: 'assets/[name].[ext]',
      chunk: 'assets/[name]-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('DevTools UI bundle failed');
  }

  const files = [
    { path: 'index.html', bytes: new Uint8Array(await readFile(indexHtml)) },
    ...await Promise.all(result.outputs.map(async (output) => ({
      path: relative(outputDirectory, output.path).replaceAll('\\', '/'),
      bytes: new Uint8Array(await output.arrayBuffer()),
    }))),
  ];

  if (development) {
    // The dev root is served straight off disk via `uiDevelopmentRoot`,
    // so index.html only has to land next to what Bun already wrote.
    await writeFile(join(outputDirectory, 'index.html'), await readFile(indexHtml));
    report(files.map((file) => ({ ...file, gzipBytes: gzip(file.bytes) })));
    console.log(`\ndev bundle → ${relative(repositoryRoot, outputDirectory)}`);
    return;
  }

  const assets = files.map((file) => {
    const gzipBytes = gzip(file.bytes);
    return {
      path: file.path,
      contentType: contentTypeOf(file.path),
      size: file.bytes.byteLength,
      etag: `"${createHash('sha256').update(file.bytes).digest('base64url').slice(0, 27)}"`,
      gzipBase64: Buffer.from(gzipBytes).toString('base64'),
      gzipBytes,
    };
  });

  enforceBudgets(assets);
  report(assets);
  await emitModule(assets);
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
    const bucket = panelOf(asset.path) ?? 'shell';
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + asset.gzipBytes.byteLength);
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
    bucket: panelOf(asset.path) ?? 'shell',
    raw: kilobytes(asset.size ?? asset.bytes.byteLength),
    gzip: kilobytes(asset.gzipBytes.byteLength),
  }));
  console.table(rows);
}

function kilobytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function emitModule(assets) {
  const inputHash = createHash('sha256')
    .update(assets.map((asset) => `${asset.path}:${asset.etag}`).join('\n'))
    .digest('hex')
    .slice(0, 16);

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
 * bundle-hash: ${inputHash}
 */
import type { UiAsset } from '../UiAssetRoutes.js';

export const UI_ASSETS: ReadonlyArray<UiAsset> = [
${entries}
];
`;

  await mkdir(dirname(generatedModule), { recursive: true });
  const previous = existsSync(generatedModule)
    ? await readFile(generatedModule, 'utf8')
    : null;
  // Skip an identical write so a running `tsc --watch` does not churn.
  if (previous === source) {
    console.log('\nembedded bundle unchanged');
    return;
  }
  await writeFile(generatedModule, source, 'utf8');
  console.log(`\nembedded bundle → ${relative(repositoryRoot, generatedModule)} (${inputHash})`);
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
