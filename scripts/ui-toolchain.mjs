#!/usr/bin/env bun
/**
 * The gate between the repository and the DevTools UI's nested toolchain (#483).
 *
 * `devtools-ui/` has its own `package.json` and its own install, deliberately
 * not a workspace, so a plain `bun install` at the root does NOT produce a tree
 * that can run `ng build`.  That is a feature — the root install stays two
 * runtime dependencies and Angular never enters `bun audit`'s surface — but it
 * means every entry point that reaches the UI has to answer the same question
 * first, and answer it differently depending on what it is:
 *
 *   - **Building** requires the toolchain, always.  There is no degraded build:
 *     without Angular there is no bundle, so this fails hard and prints the
 *     exact command, in the style of the optional-peer errors elsewhere.
 *   - **Type-checking** must NOT require it locally.  `bun run typecheck`,
 *     `bun test` and `bun run smoke` all have to work from a fresh clone with
 *     nothing installed but the root — which is possible only because
 *     `src/devtools/generated/UiAssets.ts` is committed.  So a missing
 *     toolchain warns and skips.
 *
 * Skipping locally and gating in CI is the part worth stating plainly, because
 * "warns and skips" is how a check quietly stops being one.  Under CI the same
 * absence is a hard failure: the UI's types are checked on every run, and the
 * only people who ever see the skip are contributors who have not opted into
 * the Angular install.
 *
 *   bun scripts/ui-toolchain.mjs --typecheck   guard, then type-check the UI
 *   bun scripts/ui-toolchain.mjs --test        guard, then run the UI's specs
 *   bun scripts/ui-toolchain.mjs --require     guard only, exit 1 if absent
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The nested package's directory, repo-relative for messages. */
export const UI_DIRECTORY = 'devtools-ui';

/** What a contributor has to run once, quoted verbatim in every message below. */
export const INSTALL_COMMAND = 'bun run ui:install';

/** Whether the nested install exists. */
export function uiToolchainPresent(repositoryRoot = REPOSITORY_ROOT) {
  return existsSync(join(repositoryRoot, UI_DIRECTORY, 'node_modules'));
}

/**
 * True when this process is a CI run.  `CI` is set by GitHub Actions and by
 * every other runner worth naming; `GITHUB_ACTIONS` alone would let the same
 * skip go silent on any other provider.
 */
export function runningInContinuousIntegration(environment = process.env) {
  return environment['CI'] === 'true' || environment['GITHUB_ACTIONS'] === 'true';
}

/**
 * The message a missing toolchain produces.  One function so the build path and
 * the typecheck path cannot drift into describing different fixes.
 */
export function missingToolchainMessage(task) {
  return `The DevTools UI toolchain is not installed, so ${task} cannot run.\n`
    + `  Install it with: ${INSTALL_COMMAND}\n`
    + `  It lives in ${UI_DIRECTORY}/ and is deliberately a separate install — `
    + 'the root stays small and Angular never reaches the published closure.';
}

/** Fail hard unless the toolchain is present.  For anything that must build. */
export function requireUiToolchain(task) {
  if (uiToolchainPresent()) return;
  throw new Error(missingToolchainMessage(task));
}

/**
 * Run one of the nested package's own scripts, inheriting its output.
 *
 * @param {'typecheck' | 'test'} script
 */
function runNested(script) {
  const result = spawnSync('bun', ['run', script], {
    cwd: join(REPOSITORY_ROOT, UI_DIRECTORY),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`ui-toolchain: could not run the UI ${script} — ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

function main() {
  const typecheck = process.argv.includes('--typecheck');
  const test = process.argv.includes('--test');
  const requireOnly = process.argv.includes('--require');
  if (!typecheck && !test && !requireOnly) {
    console.error('ui-toolchain: pass --typecheck, --test or --require');
    process.exit(2);
  }

  if (!uiToolchainPresent()) {
    const task = typecheck ? 'the DevTools UI typecheck' : test ? 'the DevTools UI specs' : 'this step';
    // The specs are not optional the way the typecheck is: `bun test` covers
    // the framework-free half from a fresh clone, so asking for the UI's own
    // suite is asking for the half that needs the toolchain.
    if (requireOnly || test || runningInContinuousIntegration()) {
      console.error(missingToolchainMessage(task));
      process.exit(1);
    }
    console.warn(`skipping ${task} — ${UI_DIRECTORY}/node_modules is absent. `
      + `Run '${INSTALL_COMMAND}' to include it. (This is a hard failure in CI.)`);
    process.exit(0);
  }

  if (typecheck) process.exit(runNested('typecheck'));
  if (test) process.exit(runNested('test'));
  process.exit(0);
}

if (import.meta.main) main();
