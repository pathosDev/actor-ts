/**
 * Do the two lockfiles of an example frontend describe the same dependencies?
 *
 * ## Why this exists
 *
 * Every bundled example frontend carries a `package-lock.json` and a `bun.lock`
 * (#1402), and the maintainer decided to keep both: `npm ci` is what CI and the
 * documented build path install, and `bun install` is what a Bun user reaches
 * for. Dependabot's npm updater rewrites only the npm half, so the bun half
 * drifts — #1401 left `fast-uri` patched in one and vulnerable in the other,
 * #1518 did the same with `hono`. The frozen-lockfile leg in `examples.yml`
 * cannot see that: it compares a `bun.lock` with its own `package.json`, and a
 * stale *transitive* dependency contradicts neither.
 *
 * Strict equality is not the answer either. The two resolvers do not converge
 * even when both files are regenerated from one manifest in the same minute —
 * `bun install` keeps an existing resolution while the range admits it, `npm`
 * re-resolves — so a version-for-version compare would be red on dozens of
 * honest patch differences in every Angular frontend.
 *
 * ## The tolerance rule
 *
 * Two disagreements fail; every other difference is tolerated.
 *
 *  1. **A different major line of the same package.** For every package both
 *     lockfiles resolve, the set of major lines each one resolves it to must be
 *     the same. A major line is the major version, or `0.<minor>` below 1.0.0,
 *     where a minor bump is the breaking one (the caret's own reading). A
 *     package resolved twice — `ansi-styles` 6 and 7 side by side — counts
 *     both, so a second copy one lockfile has and the other lacks is a
 *     disagreement too. Patch and minor differences pass. Offline: it reads
 *     the two files and nothing else, so it runs in `bun test`
 *     (`tests/unit/ci/ExampleLockfileAgreement.test.ts`).
 *
 *  2. **An advisory names one lockfile's version while the other's is clear.**
 *     This needs the advisory database, so it cannot run offline; CI runs it as
 *     its own step. `examples.yml` runs `bun audit --json` over `bun.lock` and
 *     `npm audit --package-lock-only --json` over `package-lock.json` — both
 *     read the lockfile and query the registry's advisory endpoint, neither
 *     installs or executes anything — and hands both reports here. An
 *     advisory one report lists for a package fails when the *other* lockfile
 *     resolves that package and its report does not list the advisory. Both
 *     files vulnerable to the same advisory is agreement, not a pass on
 *     security: whether the frontends carry a vulnerable dependency at all is
 *     Dependabot's question, and this guard only asks whether the two halves
 *     answer it the same way.
 *
 * A report that is not an audit report — a network failure, an `error` object
 * — fails the run instead of reading as "nothing flagged".
 *
 * ## Usage
 *
 *   bun scripts/example-lockfile-agreement.mjs <directory>...
 *   bun scripts/example-lockfile-agreement.mjs \
 *     --bun-audit=<bun audit --json output> --npm-audit=<npm audit --json output> <directory>
 *
 * Exit 0 when the lockfiles agree, 1 when they do not, 2 on a usage error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {Map<string, Set<string>>} map */
function add(map, name, version) {
  let versions = map.get(name);
  if (versions === undefined) {
    versions = new Set();
    map.set(name, versions);
  }
  versions.add(version);
}

/**
 * Every package `package-lock.json` (lockfile v2 or v3) resolves, with the
 * versions it resolves it to. The root entry and workspace links carry no
 * registry version and are skipped; an aliased install is recorded under the
 * real package's name, the one an advisory names.
 *
 * @param {string} text
 * @returns {Map<string, Set<string>>}
 */
export function npmResolutions(text) {
  const lockfile = JSON.parse(text);
  if (lockfile === null || typeof lockfile.packages !== 'object') {
    throw new Error('package-lock.json has no `packages` map (lockfile v2 or later is required)');
  }
  const resolutions = new Map();
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === '' || entry.link === true || typeof entry.version !== 'string') continue;
    const marker = 'node_modules/';
    const name = typeof entry.name === 'string' ? entry.name : path.slice(path.lastIndexOf(marker) + marker.length);
    add(resolutions, name, entry.version);
  }
  return resolutions;
}

/**
 * Every package `bun.lock` resolves, with its versions. The file is JSON with
 * trailing commas; removing a comma before a closing bracket is safe here
 * because no value in a lockfile — names, versions, ranges, base64 integrity —
 * contains `,}` or `,]`. Each entry's first element is `name@version` for the
 * real package, which is the name to use for an alias as well.
 *
 * @param {string} text
 * @returns {Map<string, Set<string>>}
 */
export function bunResolutions(text) {
  const lockfile = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  if (lockfile === null || typeof lockfile.packages !== 'object') {
    throw new Error('bun.lock has no `packages` map');
  }
  const resolutions = new Map();
  for (const entry of Object.values(lockfile.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const at = entry[0].lastIndexOf('@');
    if (at <= 0) continue;
    add(resolutions, entry[0].slice(0, at), entry[0].slice(at + 1));
  }
  return resolutions;
}

/**
 * The major line of a version: `12` for `12.0.3`, `0.30` for `0.30.21`. A
 * version that is not semver-shaped (`github:…`, `workspace:…`) is its own
 * line, so two of them agree only when they are identical.
 *
 * @param {string} version
 */
export function majorLine(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (match === null) return version;
  return match[1] === '0' ? `0.${match[2]}` : match[1];
}

/**
 * Rule 1: packages both lockfiles resolve, to different sets of major lines.
 *
 * @param {Map<string, Set<string>>} npm
 * @param {Map<string, Set<string>>} bun
 * @returns {{ name: string, npm: string[], bun: string[] }[]}
 */
export function majorDisagreements(npm, bun) {
  const disagreements = [];
  for (const [name, npmVersions] of npm) {
    const bunVersions = bun.get(name);
    if (bunVersions === undefined) continue;
    const lines = (versions) => [...new Set([...versions].map(majorLine))].sort().join(' ');
    if (lines(npmVersions) !== lines(bunVersions)) {
      disagreements.push({ name, npm: [...npmVersions].sort(), bun: [...bunVersions].sort() });
    }
  }
  return disagreements.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The advisories a `bun audit --json` report lists: `{ "<package>": [{ url, … }] }`.
 * Read by shape alone — an object of lists — because the keys are package
 * names, and `error` is one of those too.
 *
 * @param {unknown} report
 * @returns {Map<string, Set<string>>} package → advisory URLs
 */
export function bunAuditAdvisories(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error(`not a bun audit report: ${JSON.stringify(report).slice(0, 200)}`);
  }
  const advisories = new Map();
  for (const [name, entries] of Object.entries(report)) {
    if (!Array.isArray(entries)) throw new Error(`not a bun audit report: ${name} is not a list`);
    for (const entry of entries) add(advisories, name, String(entry.url));
  }
  return advisories;
}

/**
 * The advisories an `npm audit --json` report lists. Each entry under
 * `vulnerabilities` has a `via` list mixing advisory objects (with the
 * vulnerable package's `name` and the advisory `url`) and plain names of the
 * dependency it came through; only the advisory objects are read.
 *
 * @param {unknown} report
 * @returns {Map<string, Set<string>>} package → advisory URLs
 */
export function npmAuditAdvisories(report) {
  if (
    report === null || typeof report !== 'object' || 'error' in report
    || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null
  ) {
    throw new Error(`not an npm audit report: ${JSON.stringify(report).slice(0, 200)}`);
  }
  const advisories = new Map();
  for (const entry of Object.values(report.vulnerabilities)) {
    for (const via of entry.via ?? []) {
      if (via !== null && typeof via === 'object') add(advisories, String(via.name), String(via.url));
    }
  }
  return advisories;
}

/**
 * Rule 2: an advisory one lockfile is listed under while the other lockfile
 * resolves the same package and is not.
 *
 * @param {{ resolutions: Map<string, Set<string>>, advisories: Map<string, Set<string>> }} npm
 * @param {{ resolutions: Map<string, Set<string>>, advisories: Map<string, Set<string>> }} bun
 * @returns {{ name: string, advisory: string, vulnerable: 'npm' | 'bun', npm: string[], bun: string[] }[]}
 */
export function advisoryDisagreements(npm, bun) {
  const disagreements = [];
  const oneWay = (flagged, clear, vulnerable) => {
    for (const [name, urls] of flagged.advisories) {
      if (!clear.resolutions.has(name)) continue;
      for (const url of urls) {
        if (clear.advisories.get(name)?.has(url) === true) continue;
        disagreements.push({
          name,
          advisory: url,
          vulnerable,
          npm: [...(npm.resolutions.get(name) ?? [])].sort(),
          bun: [...(bun.resolutions.get(name) ?? [])].sort(),
        });
      }
    }
  };
  oneWay(npm, bun, 'npm');
  oneWay(bun, npm, 'bun');
  return disagreements.sort((left, right) =>
    left.name.localeCompare(right.name) || left.advisory.localeCompare(right.advisory));
}

/** The two resolution maps of one example frontend directory. */
export function resolutionsIn(directory) {
  return {
    npm: npmResolutions(readFileSync(join(directory, 'package-lock.json'), 'utf8')),
    bun: bunResolutions(readFileSync(join(directory, 'bun.lock'), 'utf8')),
  };
}

function main(argv) {
  const options = new Map();
  const directories = [];
  for (const argument of argv) {
    const match = /^--(bun-audit|npm-audit)=(.+)$/.exec(argument);
    if (match !== null) options.set(match[1], match[2]);
    else if (argument.startsWith('--')) {
      console.error(`unknown option ${argument}`);
      process.exit(2);
    } else directories.push(argument);
  }
  const audited = options.size > 0;
  if (directories.length === 0 || (audited && (options.size !== 2 || directories.length !== 1))) {
    console.error('usage: example-lockfile-agreement.mjs [--bun-audit=<file> --npm-audit=<file>] <directory>...');
    console.error('       (the audit reports describe one directory, so they take exactly one)');
    process.exit(2);
  }

  let failed = false;
  for (const directory of directories) {
    const { npm, bun } = resolutionsIn(directory);
    let disagrees = false;
    for (const { name, npm: npmVersions, bun: bunVersions } of majorDisagreements(npm, bun)) {
      disagrees = true;
      console.error(`${directory}: ${name} resolves to another major line — package-lock.json ${npmVersions.join(', ')}, bun.lock ${bunVersions.join(', ')}`);
    }
    if (audited) {
      const disagreements = advisoryDisagreements(
        { resolutions: npm, advisories: npmAuditAdvisories(JSON.parse(readFileSync(options.get('npm-audit'), 'utf8'))) },
        { resolutions: bun, advisories: bunAuditAdvisories(JSON.parse(readFileSync(options.get('bun-audit'), 'utf8'))) },
      );
      for (const { name, advisory, vulnerable, npm: npmVersions, bun: bunVersions } of disagreements) {
        disagrees = true;
        const file = vulnerable === 'npm' ? 'package-lock.json' : 'bun.lock';
        console.error(`${directory}: ${advisory} names ${name} in ${file} only — package-lock.json ${npmVersions.join(', ')}, bun.lock ${bunVersions.join(', ')}`);
      }
    }
    if (disagrees) failed = true;
    else console.log(`${directory}: the two lockfiles agree${audited ? ', advisories included' : ''}`);
  }
  if (failed) {
    console.error('Sync the stale half: `bun update <package> --lockfile-only` for bun.lock, `npm install --package-lock-only` for package-lock.json. The rule is in scripts/example-lockfile-agreement.mjs.');
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
