import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Repo-file guard over the comparison suite's committed build-tool launchers,
 * in the same family as `tests/unit/ci/SupplyChainDocs.test.ts` and
 * `tests/unit/ci/WorkflowHygiene.test.ts`: assertions about files no compiler
 * reads and no other test would otherwise open.
 *
 * The defect it pins (#1325). Every JVM arm ships a pair of launcher scripts —
 * a POSIX `mill` and a Windows `mill.bat` — and the POSIX one was recorded at
 * mode `100644`. On Linux that is fatal: `/bin/sh` refuses to exec a file
 * without its executable bit and the arm dies with exit 126 before the build
 * tool is even reached. On Windows it is invisible, because there the `.bat`
 * is the entry point and `core.fileMode` is false regardless. So four of the
 * nine arms were unrunnable on Linux — through the Maven wrappers these
 * replaced and then through the replacement — while `bun run typecheck`, the
 * full suite and every workflow stayed green, since nothing in this repository
 * looks at a file mode.
 *
 * **The assertion reads the git index, not the working tree.** A `statSync`
 * here would answer with whatever the checkout happened to produce, which on
 * Windows is `100644` for every file in the repository — so it would fail on
 * the one platform where the bug does not bite and pass on the one where it
 * does. The index is the thing that actually travels to a Linux clone.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const COMPARISON_ROOT = join('benchmarks', 'comparison');

/** Mode -> path, as `git ls-files -s` reports it for one pathspec. */
function indexModes(pathspec: string): ReadonlyMap<string, string> {
  const listed = spawnSync('git', ['ls-files', '-s', '--', pathspec], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });

  // Deliberately not a skip. A guard that quietly passes when it cannot run is
  // worth less than no guard, and every context this suite runs in — CI,
  // `prepublishOnly`, a developer checkout — is a git working tree.
  expect(listed.error, `could not run git for "${pathspec}"`).toBeUndefined();
  expect(listed.status, listed.stderr).toBe(0);

  const modes = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [meta, path] = line.split('\t');
    modes.set(path!.trim(), meta!.split(' ')[0]!);
  }
  return modes;
}

describe('comparison build-tool launchers', () => {
  test('every POSIX launcher is executable in the index', () => {
    const modes = indexModes(join(COMPARISON_ROOT, '*', 'mill'));

    // One per JVM arm. Pinned from below so that adding an arm without its
    // launcher, or dropping one, is a failure rather than a silent shrink of
    // what this test covers.
    expect(modes.size).toBeGreaterThanOrEqual(4);

    for (const [path, mode] of modes) {
      expect(mode, `${path} must be executable (100755) or Linux cannot run it`).toBe('100755');
    }
  });

  test('the Windows launcher stays a plain file', () => {
    const modes = indexModes(join(COMPARISON_ROOT, '*', 'mill.bat'));

    expect(modes.size).toBeGreaterThanOrEqual(4);

    // Not cosmetic symmetry: cmd.exe does not consult a mode, so marking the
    // `.bat` executable would assert something no platform checks and blur what
    // the mode on its sibling means.
    for (const [path, mode] of modes) {
      expect(mode, `${path} is invoked through cmd.exe and needs no mode`).toBe('100644');
    }
  });

  test('every JVM arm ships both launchers', () => {
    const posix = indexModes(join(COMPARISON_ROOT, '*', 'mill'));
    const windows = indexModes(join(COMPARISON_ROOT, '*', 'mill.bat'));

    const directoryOf = (path: string): string => path.split('/').slice(-2, -1)[0]!;
    const posixArms = [...posix.keys()].map(directoryOf).sort();
    const windowsArms = [...windows.keys()].map(directoryOf).sort();

    // An arm with only one of the two runs on exactly one platform, which is
    // the failure mode this file exists for — just spelled the other way.
    expect(posixArms).toEqual(windowsArms);
  });
});
