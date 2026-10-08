import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SECRETS_CONF_FILENAME } from '../../../src/config/Constants.js';

/**
 * The repository ignores the secrets file `Config.load` reads by default
 * (found while #1546).
 *
 * The configuration reference tells an application to keep `secrets.conf` out
 * of version control.  A process started from a clone of this repository
 * reads `./secrets.conf` from its working directory exactly as an application
 * does — the root for `bun examples/…`, an example's own directory for a run
 * from there — so whoever tries the layer out the way the docs describe leaves
 * a credential file in the tree, and `git add -A` commits it without a word.
 *
 * Asked of git rather than read out of `.gitignore`: what matters is what git
 * does with the path, and a negation further down, a pattern anchored to the
 * root or a broader pattern that happens to match first all change that
 * answer without removing the line.  The file name is the loader's own
 * constant, so a renamed default fails here until the rule follows it.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * The `.gitignore` rule that decides `path` — `source:line:pattern` — or
 * `null` when no rule matches.
 *
 * `--no-index` so a tracked file is judged by the patterns alone, which is the
 * question for a file nobody has added yet.  With `--verbose`, git reports a
 * matching negation (`!pattern`) too and exits 0 for it, so the pattern is
 * what a caller compares, never the exit code alone.
 */
function ruleFor(path: string): string | null {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--verbose', '--', path], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  if (result.status === 1) return null;
  expect(result.status, `git check-ignore failed: ${result.stderr}`).toBe(0);
  return result.stdout.split('\t')[0]!;
}

describe('the default secrets file stays out of version control — #1546', () => {
  test.each([
    [DEFAULT_SECRETS_CONF_FILENAME],
    [`examples/config/${DEFAULT_SECRETS_CONF_FILENAME}`],
  ])('%s is ignored by the root .gitignore, by name', (path) => {
    const rule = ruleFor(path);
    expect(rule, `${path} is not ignored`).not.toBeNull();
    // `.gitignore:<line>:secrets.conf` — the root file, and the bare name,
    // so the rule matches at any depth and is not a negation.
    const [source, line, pattern] = rule!.split(':');
    expect(source).toBe('.gitignore');
    expect(Number(line)).toBeGreaterThan(0);
    expect(pattern).toBe(DEFAULT_SECRETS_CONF_FILENAME);
  });

  test('a configuration file an example ships is not ignored with it', () => {
    // What a broader pattern — `*.conf` — would take along: the sample
    // `application.conf` beside the examples has to stay addable.
    expect(ruleFor('examples/config/application.conf')).toBeNull();
  });
});
