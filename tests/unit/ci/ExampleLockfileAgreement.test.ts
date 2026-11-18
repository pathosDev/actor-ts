import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  advisoryDisagreements,
  bunAuditAdvisories,
  bunResolutions,
  majorDisagreements,
  majorLine,
  npmAuditAdvisories,
  npmResolutions,
  resolutionsIn,
} from '../../../scripts/example-lockfile-agreement.mjs';

/**
 * #1402 — every example frontend keeps a `package-lock.json` and a `bun.lock`,
 * and the two must agree within the tolerance documented in
 * `scripts/example-lockfile-agreement.mjs`. This is the offline half: no
 * package on another major line. The advisory half needs the registry and
 * runs as its own step in `examples.yml`; its rule is bound here on fixture
 * reports.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLES = join(REPOSITORY_ROOT, 'examples');

/** Every `examples/<app>/frontend-*` directory that carries both lockfiles. */
const frontends = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((app) =>
    readdirSync(join(EXAMPLES, app.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('frontend-'))
      .map((entry) => `${app.name}/${entry.name}`),
  )
  .filter((directory) =>
    existsSync(join(EXAMPLES, directory, 'package-lock.json')) || existsSync(join(EXAMPLES, directory, 'bun.lock')),
  )
  .sort();

const set = (...versions: string[]): Set<string> => new Set(versions);

describe('the example frontends\' two lockfiles agree (#1402)', () => {
  test('the scan finds the eight frontends, each with both lockfiles', () => {
    // A directory that drops one lockfile leaves nothing to compare, and a
    // scan that found nothing would pass the test below in silence.
    expect(frontends.length).toBeGreaterThanOrEqual(8);
    for (const directory of frontends) {
      expect(existsSync(join(EXAMPLES, directory, 'package-lock.json')), `${directory}/package-lock.json`).toBe(true);
      expect(existsSync(join(EXAMPLES, directory, 'bun.lock')), `${directory}/bun.lock`).toBe(true);
    }
  });

  test.each(frontends)('examples/%s resolves no package to another major line', (directory) => {
    const { npm, bun } = resolutionsIn(join(EXAMPLES, directory));
    // Both parsers read the real files, not an empty map.
    expect(npm.size).toBeGreaterThan(40);
    expect(bun.size).toBeGreaterThan(40);
    expect(
      majorDisagreements(npm, bun),
      'package-lock.json and bun.lock resolve a package to different major lines. Sync the stale '
      + 'half (`bun update <package> --lockfile-only`, or `npm install --package-lock-only`); the '
      + 'tolerance rule is in scripts/example-lockfile-agreement.mjs.',
    ).toEqual([]);
  });

  test('examples.yml runs the advisory half over both audit reports', () => {
    // The offline half above cannot see an advisory. If the CI step stops
    // calling the script with both reports, nothing does.
    const workflow = readFileSync(join(REPOSITORY_ROOT, '.github', 'workflows', 'examples.yml'), 'utf8');
    expect(workflow).toContain('bun audit --json > "$RUNNER_TEMP/bun-audit.json"');
    expect(workflow).toContain('npm audit --package-lock-only --json > "$RUNNER_TEMP/npm-audit.json"');
    expect(workflow).toContain('scripts/example-lockfile-agreement.mjs');
    expect(workflow).toContain('--bun-audit="$RUNNER_TEMP/bun-audit.json"');
    expect(workflow).toContain('--npm-audit="$RUNNER_TEMP/npm-audit.json"');
  });
});

describe('rule 1: the major line', () => {
  test('a major line is the major, or 0.<minor> below 1.0.0', () => {
    expect(majorLine('12.0.3')).toBe('12');
    expect(majorLine('0.30.21')).toBe('0.30');
    expect(majorLine('1.0.0-beta.2')).toBe('1');
    expect(majorLine('github:owner/repo#abc')).toBe('github:owner/repo#abc');
  });

  test('patch and minor differences are tolerated', () => {
    const npm = new Map([['react', set('19.2.8')], ['fast-uri', set('3.1.9')]]);
    const bun = new Map([['react', set('19.3.0')], ['fast-uri', set('3.1.7')]]);
    expect(majorDisagreements(npm, bun)).toEqual([]);
  });

  test('another major, another 0.x minor and a second major copy are not', () => {
    const npm = new Map([
      ['@inquirer/core', set('12.0.3')],
      ['magic-string', set('0.31.1')],
      ['ansi-styles', set('6.2.3', '7.0.0')],
      ['only-in-npm', set('1.0.0')],
    ]);
    const bun = new Map([
      ['@inquirer/core', set('11.2.1')],
      ['magic-string', set('0.30.21')],
      ['ansi-styles', set('6.2.3')],
    ]);
    expect(majorDisagreements(npm, bun).map(({ name }) => name)).toEqual(['@inquirer/core', 'ansi-styles', 'magic-string']);
  });
});

describe('the lockfile parsers', () => {
  test('package-lock.json: aliases under the real name, the root and links skipped', () => {
    const resolutions = npmResolutions(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '0.0.0' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b/node_modules/a': { version: '2.0.0' },
        'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' },
        'node_modules/local': { resolved: '../local', link: true },
      },
    }));
    expect([...resolutions.keys()].sort()).toEqual(['a', 'string-width']);
    expect(resolutions.get('a')).toEqual(set('1.0.0', '2.0.0'));
  });

  test('bun.lock: trailing commas, scoped names, nested copies', () => {
    const resolutions = bunResolutions(`{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "a": "^1.0.0", }, }, },
      "packages": {
        "@scope/a": ["@scope/a@1.2.3", "", {}, "sha512-x=="],
        "a": ["a@1.0.0", "", { "dependencies": { "b": "^2.0.0", }, }, "sha512-y=="],
        "b/a": ["a@2.0.0", "", {}, "sha512-z=="],
      },
    }`);
    expect(resolutions.get('@scope/a')).toEqual(set('1.2.3'));
    expect(resolutions.get('a')).toEqual(set('1.0.0', '2.0.0'));
  });
});

describe('rule 2: an advisory naming one lockfile only', () => {
  const advisory = 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz';
  const bunReport = { 'fast-uri': [{ id: 1, url: advisory, vulnerable_versions: '<3.1.9' }] };
  const npmReport = (flagged: boolean) => ({
    auditReportVersion: 2,
    vulnerabilities: flagged
      ? {
        'fast-uri': { name: 'fast-uri', via: [{ source: 1, name: 'fast-uri', url: advisory, range: '<3.1.9' }] },
        ajv: { name: 'ajv', via: ['fast-uri'] },
      }
      : {},
  });
  const lockfiles = (npmVersion: string, bunVersion: string) => ({
    npm: new Map([['fast-uri', set(npmVersion)]]),
    bun: new Map([['fast-uri', set(bunVersion)]]),
  });

  test('flagged in bun.lock while package-lock.json resolves it clear: a disagreement', () => {
    const { npm, bun } = lockfiles('3.1.9', '3.1.7');
    expect(advisoryDisagreements(
      { resolutions: npm, advisories: npmAuditAdvisories(npmReport(false)) },
      { resolutions: bun, advisories: bunAuditAdvisories(bunReport) },
    )).toEqual([{ name: 'fast-uri', advisory, vulnerable: 'bun', npm: ['3.1.9'], bun: ['3.1.7'] }]);
  });

  test('flagged in package-lock.json only: a disagreement the other way', () => {
    const { npm, bun } = lockfiles('3.1.7', '3.1.9');
    expect(advisoryDisagreements(
      { resolutions: npm, advisories: npmAuditAdvisories(npmReport(true)) },
      { resolutions: bun, advisories: bunAuditAdvisories({}) },
    ).map(({ vulnerable }) => vulnerable)).toEqual(['npm']);
  });

  test('flagged in both is agreement, and a package the other file lacks is not compared', () => {
    const both = lockfiles('3.1.7', '3.1.7');
    expect(advisoryDisagreements(
      { resolutions: both.npm, advisories: npmAuditAdvisories(npmReport(true)) },
      { resolutions: both.bun, advisories: bunAuditAdvisories(bunReport) },
    )).toEqual([]);

    // bun.lock resolves the flagged package, package-lock.json does not at all:
    // there is no second version to be clear, so nothing to disagree about.
    expect(advisoryDisagreements(
      { resolutions: new Map(), advisories: npmAuditAdvisories(npmReport(false)) },
      { resolutions: new Map([['fast-uri', set('3.1.7')]]), advisories: bunAuditAdvisories(bunReport) },
    )).toEqual([]);
  });

  test('npm\'s via names are not advisories, and a report that is not one is refused', () => {
    expect([...npmAuditAdvisories(npmReport(true)).keys()]).toEqual(['fast-uri']);
    expect(() => npmAuditAdvisories({ error: { code: 'ENOAUDIT' } })).toThrow(/not an npm audit report/);
    expect(() => npmAuditAdvisories({})).toThrow(/not an npm audit report/);
    expect(() => bunAuditAdvisories({ error: 'network' })).toThrow(/not a bun audit report/);
    expect(() => bunAuditAdvisories(null)).toThrow(/not a bun audit report/);
  });
});
