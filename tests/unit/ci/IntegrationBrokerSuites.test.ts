import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  BROKERS_DIRECTORY,
  composeArguments,
  discoverSuites,
  parseArguments,
  selectSuites,
} from '../../../scripts/integration-compose.mjs';

/**
 * Guards the one-driver refactor of the live-broker suites (#559).
 *
 * The suites used to be a `package.json` script pair each — 34 scripts whose
 * only difference was a compose path — plus two aggregate chains and a CI
 * matrix, so the list of backends existed in four places and adding one meant
 * editing all four.  Missing one was silent: the suite simply never ran.
 *
 * `scripts/integration-compose.mjs` discovers the suites instead, which leaves
 * exactly one list a human still maintains — the CI matrix, because it carries
 * a display label nothing can derive.  These tests are what keep that from
 * becoming a second source of truth again, and what make the refactor
 * checkable rather than merely plausible: the argument vectors below are
 * transcriptions of the removed scripts, so if this file is green, Docker is
 * being asked to do what it was asked to do before.
 *
 * Regex-based rather than YAML-parsed, for the reason
 * `tests/unit/ci/WorkflowHygiene.test.ts` states: the repository has no YAML
 * dependency, and every parser here is written to fail loudly, with a
 * guards-the-guard assertion rejecting a vacuous pass.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/** Split on `\r?\n` — a Windows checkout leaves a `\r` that breaks `$` anchors. */
const workflowLines: readonly string[] = readFileSync(
  join(REPOSITORY_ROOT, '.github', 'workflows', 'integration-brokers.yml'),
  'utf8',
).split(/\r?\n/);

const packageScripts: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
).scripts;

/** `- { dir: redis-streams, image: "Redis Streams" }` → `redis-streams`. */
const matrixDirectories: readonly string[] = workflowLines
  .map((line) => /^\s*-\s*\{\s*dir:\s*([A-Za-z0-9._-]+)\s*,/.exec(line)?.[1])
  .filter((name): name is string => name !== undefined);

describe('broker suite discovery', () => {
  test('finds every suite in the tree, and the parser is not matching nothing', () => {
    const suites = discoverSuites(REPOSITORY_ROOT);
    // Guards the guard: a discovery that found two things would pass every
    // agreement assertion below while leaving fifteen suites unrun.
    expect(suites.length).toBeGreaterThanOrEqual(15);
    expect(new Set(suites.map((s) => s.name)).size).toBe(suites.length);
  });

  test('a directory with no compose file is not a suite', () => {
    // `brokers/lib/` holds shared scenario helpers and no compose file.  It is
    // on disk, so this asserts an exclusion that actually had to happen rather
    // than one that is true because the directory is missing.
    expect(existsSync(join(REPOSITORY_ROOT, BROKERS_DIRECTORY, 'lib'))).toBe(true);
    expect(discoverSuites(REPOSITORY_ROOT).map((s) => s.name)).not.toContain('lib');
  });

  test('each compose file is named after its directory and reachable', () => {
    for (const suite of discoverSuites(REPOSITORY_ROOT)) {
      expect(suite.composeFile).toBe(
        `${BROKERS_DIRECTORY}/${suite.name}/docker-compose.${suite.name}.yml`,
      );
      expect(existsSync(join(REPOSITORY_ROOT, suite.composeFile))).toBe(true);
    }
  });
});

describe('compose commands are the ones the removed scripts ran', () => {
  const composeFile = `${BROKERS_DIRECTORY}/s3/docker-compose.s3.yml`;

  test('up matches the old `test:integration:<name>` verbatim', () => {
    // `--exit-code-from runner` is the load-bearing token: it propagates a
    // failing scenario out of the container.  Drop it and every broker suite
    // passes forever, green and meaningless.
    expect(composeArguments(composeFile, 'up')).toEqual([
      'compose', '-f', composeFile,
      'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'runner',
    ]);
  });

  test('down matches the old `:teardown` verbatim', () => {
    expect(composeArguments(composeFile, 'down')).toEqual([
      'compose', '-f', composeFile, 'down', '-v', '--remove-orphans',
    ]);
  });

  test('logs matches the workflow failure step verbatim', () => {
    expect(composeArguments(composeFile, 'logs')).toEqual([
      'compose', '-f', composeFile, 'logs', '--no-color',
    ]);
  });
});

describe('the CI matrix and the tree agree', () => {
  test('the matrix parser found the matrix', () => {
    expect(matrixDirectories.length).toBeGreaterThanOrEqual(15);
  });

  test('every matrix entry is a real suite, and every suite is in the matrix', () => {
    const discovered = discoverSuites(REPOSITORY_ROOT).map((s) => s.name);
    // Both directions on purpose.  One way catches a matrix entry pointing at
    // a deleted directory; the other catches a new backend that was added to
    // the tree and never wired into CI — the failure this refactor exists to
    // make impossible, and the one nothing would otherwise report.
    expect([...matrixDirectories].sort()).toEqual([...discovered].sort());
  });

  test('the matrix no longer carries a separate script-name column', () => {
    // `npm:` existed only because `redis-streams` ran through a `redis`
    // script.  The driver takes the directory name, so the mapping is gone.
    expect(workflowLines.filter((line) => /^\s*-\s*\{.*\bnpm:/.test(line))).toEqual([]);
  });
});

describe('the script sprawl does not come back', () => {
  test('exactly six integration scripts remain', () => {
    const integrationScripts = Object.keys(packageScripts)
      .filter((name) => name === 'test:integration' || name.startsWith('test:integration:'))
      .sort();
    expect(integrationScripts).toEqual([
      'test:integration',
      'test:integration:broker',
      'test:integration:broker:teardown',
      'test:integration:brokers',
      'test:integration:brokers:teardown',
      'test:integration:teardown',
    ]);
  });

  test('no script hardcodes a broker compose path', () => {
    const offenders = Object.entries(packageScripts)
      .filter(([, command]) => command.includes(`${BROKERS_DIRECTORY}/`));
    expect(offenders).toEqual([]);
  });

  test('the cluster suite is untouched and still targets the controller', () => {
    // `test:integration` means the multi-node cluster suite, not a broker.
    // Folding it into the driver would have been a behaviour change wearing a
    // refactor's clothes.
    expect(packageScripts['test:integration']).toContain('docker-compose.integration.yml');
    expect(packageScripts['test:integration']).toContain('--exit-code-from controller');
  });
});

describe('command line', () => {
  const suites = [
    { name: 'nats', composeFile: 'x/docker-compose.nats.yml' },
    { name: 's3', composeFile: 'x/docker-compose.s3.yml' },
  ] as const;

  test('defaults to bringing one suite up', () => {
    const options = parseArguments(['s3']);
    expect(options).toEqual({ mode: 'up', all: false, names: ['s3'] });
    expect(selectSuites(options, suites).map((s) => s.name)).toEqual(['s3']);
  });

  test('flags select the mode in any position', () => {
    expect(parseArguments(['--down', 's3']).mode).toBe('down');
    expect(parseArguments(['s3', '--logs']).mode).toBe('logs');
  });

  test('--all selects every suite', () => {
    expect(selectSuites(parseArguments(['--all']), suites).map((s) => s.name)).toEqual(['nats', 's3']);
  });

  test('an unknown suite names the ones that exist', () => {
    // The old failure for a typo was npm's "missing script", which said
    // nothing about which backends are available.
    expect(() => selectSuites(parseArguments(['redis']), suites)).toThrow(/no suite 'redis'.*nats, s3/s);
  });

  test('naming a suite and --all together is rejected rather than guessed at', () => {
    expect(() => selectSuites(parseArguments(['--all', 's3']), suites)).toThrow(/--all takes no suite names/);
  });

  test('an unknown flag is rejected rather than treated as a suite name', () => {
    expect(() => parseArguments(['--downn'])).toThrow(/unknown flag/);
  });
});
