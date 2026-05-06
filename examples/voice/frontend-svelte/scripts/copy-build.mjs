/**
 * Post-build step: copy `build/` (SvelteKit's adapter-static output)
 * into `../static/svelte/`, where the chat backend's @fastify/static
 * mount picks it up.
 *
 * Idempotent — wipes the destination first so removed files don't
 * leak between builds.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const buildDir = join(root, 'build');
const targetDir = resolve(root, '..', 'static', 'svelte');

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

function copyTree(src, dst) {
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}
copyTree(buildDir, targetDir);
console.log(`copy-build → ${targetDir}`);
