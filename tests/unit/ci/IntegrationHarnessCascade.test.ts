import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Pins how the multi-node integration run ends (#1594).
 *
 * `bun run test:integration` is one `docker compose up`, and which of two
 * flags it carries decides what a container's exit means.  Under
 * `--abort-on-container-exit` — which `--exit-code-from` implies unless told
 * otherwise — the first exit of *any* attached container ends the run.  The
 * suite was written under that flag while a leaked interval (#1567) kept
 * every node's process alive after `CoordinatedShutdown.run()`, so nothing
 * noticed that scenario 13's victim is *supposed* to exit.  The day the leak
 * was fixed, the victim's clean exit stopped the controller mid-poll with a
 * SIGTERM, and the run reported the controller's 143 with every scenario
 * passing.
 *
 * Under `--abort-on-container-failure` a node exiting 0 is a scenario event,
 * a node exiting non-zero still aborts the run with its code — and compose
 * returns only when the last container is gone.  That last clause is the
 * contract the rest of this file pins: the controller has to end the run by
 * taking the cluster down, which is what scenario 17 does, and nothing may
 * run after it, because most scenarios *skip* rather than fail on a cluster
 * that is too small.  A scenario appended below 17 would be silently green
 * against a cluster that no longer exists.
 *
 * The broker suites keep `--abort-on-container-exit` on purpose: their
 * fixtures never exit on their own, so under the failure-only flag a green
 * runner would leave compose waiting on the brokers forever.  The two
 * scripts differ because the two harnesses differ, and
 * `tests/unit/ci/IntegrationBrokerSuites.test.ts` pins the other side.
 *
 * Text-based, like the workflow-hygiene guards: `Controller.ts` runs its
 * `main()` at import, so the scenario list is read, not imported.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

const packageScripts: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
).scripts;

/** Split on `\r?\n` — a Windows checkout leaves a `\r` that breaks `$` anchors. */
const controllerLines: readonly string[] = readFileSync(
  join(REPOSITORY_ROOT, 'tests', 'integration', 'Controller.ts'),
  'utf8',
).split(/\r?\n/);

/**
 * The identifiers inside `const scenarios: Scenario[] = [ … ];`, in order.
 * Each entry is one line — `  identifier,  // comment` — which is the shape
 * the file has always had; the parser fails the suite rather than guessing
 * if that changes.
 */
function scenarioListOf(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((line) => /^const scenarios: Scenario\[\] = \[$/.test(line));
  if (start < 0) throw new Error('Controller.ts: the `const scenarios: Scenario[] = [` line is gone');
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\];$/.test(line)) return names;
    const match = /^\s+([A-Za-z][A-Za-z0-9]*),/.exec(line);
    if (match === null) throw new Error(`Controller.ts: unexpected line in the scenario list: ${JSON.stringify(line)}`);
    names.push(match[1]!);
  }
  throw new Error('Controller.ts: the scenario list never closes');
}

describe('the multi-node integration run ends when the last container exits', () => {
  test('test:integration aborts on a container failure, never on a mere exit', () => {
    const script = packageScripts['test:integration'];
    expect(script).toBeDefined();
    expect(script).toContain('docker compose -f tests/integration/docker-compose.integration.yml up');
    expect(script).toContain('--abort-on-container-failure');
    expect(script).not.toContain('--abort-on-container-exit');
    // Still the relay for a failing scenario: the controller's 1 is the
    // run's 1.  Without it, a scenario failure would exit compose with 0.
    expect(script).toContain('--exit-code-from controller');
  });

  test('the controller shuts the cluster down last, and nothing runs after it', () => {
    const names = scenarioListOf(controllerLines);
    // Guards the guard: a parser that found two names would pass the
    // last-entry assertion below while the real list ran anything after 17.
    expect(names.length).toBeGreaterThanOrEqual(17);
    expect(names.at(-1)).toBe('clusterShutdown');
    expect(names.filter((name) => name === 'clusterShutdown')).toHaveLength(1);
  });

  test('the shutdown scenario is the one that closes every control port', () => {
    const source = readFileSync(
      join(REPOSITORY_ROOT, 'tests', 'integration', 'scenarios', '17-cluster-shutdown.ts'),
      'utf8',
    );
    expect(source).toContain("name: '17-cluster-shutdown'");
    expect(source).toContain("'/test/coordinated-shutdown'");
    // The controller can see ports, not processes; the process exit is
    // NodeRunner's watchdog's to assert, and it has to be the non-zero
    // kind of exit or the compose flag above never hears of it.
    const nodeRunner = readFileSync(join(REPOSITORY_ROOT, 'tests', 'integration', 'NodeRunner.ts'), 'utf8');
    expect(nodeRunner).toContain('system.whenTerminated().then(');
    expect(nodeRunner).toContain('process.exit(EXIT_CODE_LINGERING_PROCESS)');
    expect(nodeRunner).toMatch(/const EXIT_CODE_LINGERING_PROCESS = [1-9]\d*;/);
    expect(nodeRunner).toContain('watchdog.unref()');
  });
});
