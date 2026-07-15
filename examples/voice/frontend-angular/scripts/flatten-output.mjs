/**
 * Post-build step: copy `dist/browser/*` (the artefacts the browser
 * actually loads) into `../static/angular/`, which is what the chat
 * backend's `@fastify/static` serves under `/static/angular/`.
 *
 * Why we need this: Angular 21's `@angular/build:application`
 * builder always emits a `browser/` subdirectory under the
 * configured output path, even when SSR is disabled.  Flattening
 * here keeps the URL shape simple (`/static/angular/index.html`
 * rather than `/static/angular/browser/index.html`) without
 * hand-editing the generated `index.html` to compensate.
 *
 * Idempotent — wipes the destination first so removing files in
 * Angular and re-building doesn't leak old assets.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const browserDir = join(root, 'dist', 'browser');
const targetDir = resolve(root, '..', 'static', 'angular');

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

function copyTree(src, dst) {
  for (const entry of readdirSync(src)) {
    const sourcePath = join(src, entry);
    const destPath = join(dst, entry);
    if (statSync(sourcePath).isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTree(sourcePath, destPath);
    } else {
      copyFileSync(sourcePath, destPath);
    }
  }
}
copyTree(browserDir, targetDir);
console.log(`flatten-output → ${targetDir}`);
