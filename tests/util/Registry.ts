import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reader for `tests/quarantine.json` — the one list of divergences this suite
 * takes on purpose (#1410, #1411).
 *
 * Two consumers read it and one guard enforces it, so the parsing lives here
 * rather than three times: `tests/util/Platform.ts` for a per-platform
 * expectation, `tests/util/Quarantine.ts` for a suite CI does not run, and
 * `tests/unit/ci/QuarantineRegistry.test.ts` for the invariants over both.
 *
 * **The file is read, never imported.**  A `resolveJsonModule` import would
 * bind the registry into the module graph of every test file that skips
 * itself, and `tsconfig.json` does not enable it; reading is also what the
 * sibling repo-file guards do (`WorkflowHygiene`, `SleepRatchet`), so a
 * failure here has the shape the repository already knows.
 */

/** Where the repository root sits, relative to this file. */
export const REPOSITORY_ROOT = join(import.meta.dir, '..', '..');

/** The registry's path.  Exported so a failure message can name it. */
export const REGISTRY_PATH = join(REPOSITORY_ROOT, 'tests', 'quarantine.json');

/** A renewal of an entry: when, and on what grounds. */
export type RegistryRenewal = {
  readonly date: string;
  readonly reason: string;
};

/**
 * One divergence.  `kind` discriminates the two consumers; `label` is present
 * only on a `platform-expectation`, where one file may carry more than one.
 */
export type RegistryEntry = {
  readonly kind: 'quarantine' | 'platform-expectation';
  readonly file: string;
  readonly label?: string;
  readonly issue: number;
  readonly since: string;
  readonly expires: string;
  readonly reason: string;
  readonly history: ReadonlyArray<RegistryRenewal>;
  /** Paths `bunfig.toml` excludes from coverage because of this entry. */
  readonly coverageIgnore?: ReadonlyArray<string>;
  /** A `bench:smoke` suite excluded because of this entry. */
  readonly benchmarkExclude?: string;
};

let cached: ReadonlyArray<RegistryEntry> | undefined;

/** Every entry, parsed once per process. */
export function registryEntries(): ReadonlyArray<RegistryEntry> {
  cached ??= (JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
    entries: ReadonlyArray<RegistryEntry>;
  }).entries;
  return cached;
}

/**
 * `path` with Windows separators turned into POSIX ones.
 *
 * The same file is `tests\util\Platform.ts` on a Windows clone and
 * `tests/util/Platform.ts` everywhere else, and the registry has to name it
 * once — the same reason `scripts/stress-test.mjs` normalises the `file`
 * attribute of a JUnit report before comparing identities across machines.
 */
export function toPosixPath(path: string): string {
  return path.split(SEPARATOR).join('/');
}

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const SEPARATOR = String.fromCharCode(92);

/** The repository-relative POSIX path of the file that called into a helper. */
export function callerFile(importMeta: ImportMeta): string {
  const absolute = importMeta.path ?? fileURLToPath(importMeta.url);
  return toPosixPath(absolute).slice(toPosixPath(REPOSITORY_ROOT).length + 1);
}
