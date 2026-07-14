/**
 * Post-build step: copy `out/` (Next.js's static export directory)
 * into `../static/next/`, where the chat backend's @fastify/static
 * mount picks it up.
 *
 * Why a copy instead of building straight into the target: Next.js
 * insists on writing to the project-local `out/` directory regardless
 * of `output: 'export'` settings, and several internal flags compute
 * paths relative to it.  We accept the duplicated artefact and just
 * mirror it into place after each build.
 *
 * Idempotent — wipes the target first so removed pages don't linger.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'out');
const targetDir = resolve(root, '..', 'static', 'next');

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
copyTree(outDir, targetDir);
console.log(`copy-out → ${targetDir}`);
