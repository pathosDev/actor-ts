/**
 * What a node that its own downing decision stands down exits with, held to
 * the page that states it (#1456).
 *
 * With `run-coordinated-shutdown-when-down` on, the node runs the pipeline
 * with `ClusterDowningReason`, and with `exit-process` on that run ends the
 * process with `exit-code`, which ships as `0`: a downing is no failure, so a
 * supervisor that restarts only after one leaves the node down.  That was
 * kept, and `fundamentals/coordinated-shutdown.mdx` says so in English and in
 * German, with the two ways out.  The second, a non-zero `exit-code`, is not
 * the downing's status alone but the status of every run `exit-process` ends,
 * and the page says that too, so that nobody sets it without knowing.
 *
 * The suites that pin the exit status never open the page, and the case that
 * lists the reasons a clean stop exits with leaves the downing out.  So every
 * number the section quotes is measured here, from runs with `process.exit`
 * replaced, rather than kept as a second copy of the words.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import {
  ClusterDowningReason,
  ClusterJoinUnsuccessfulReason,
  CoordinatedShutdownId,
  Phases,
  ProcessTerminateReason,
  type Reason,
} from '../../../src/CoordinatedShutdown.js';
import { NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * The prose of one section of a page, from its heading to the next heading of
 * the same or a higher level.  MDX comments and code fences are cut first — a
 * sentence that lives only in one of them is not said in the prose — and every
 * run of whitespace is folded to one space, so rewrapping moves no pin.
 */
function sectionProse(relative: string, heading: string): string {
  const text = readFileSync(join(DOCS_ROOT, relative), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm, '');
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`${relative} has no heading "${heading}"`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const nextHeading = new RegExp(`\\n#{1,${level}} `, 'g');
  nextHeading.lastIndex = start + 1;
  const next = nextHeading.exec(text);
  return text.slice(start, next === null ? undefined : next.index).replace(/\s+/g, ' ');
}

/** A system with `actor-ts.coordinated-shutdown` set to `settings`, logging nowhere. */
function systemWith(name: string, settings: ConfigObject): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withConfig({ 'actor-ts': { 'coordinated-shutdown': settings } });
  return ActorSystem.create(name, systemOptions);
}

/** Replace `process.exit` until `body` is done, and hand back every status it was called with. */
async function exitStatusesDuring(body: () => Promise<unknown>): Promise<number[]> {
  const statuses: number[] = [];
  const realExit = process.exit;
  process.exit = ((code?: number): never => {
    statuses.push(code ?? Number.NaN);
    return undefined as never;
  }) as typeof process.exit;
  try {
    await body();
  } finally {
    process.exit = realExit;
  }
  return statuses;
}

/** The statuses a completed run with `reason` exits with, `exit-process` on and `settings` beside it. */
function statusesOfRun(name: string, reason: Reason, settings: ConfigObject = {}): Promise<number[]> {
  const system = systemWith(name, { 'exit-process': true, ...settings });
  return exitStatusesDuring(() => system.extension(CoordinatedShutdownId).run(reason));
}

/** The statuses a downing run exits with when a phase with `recover = false` halts it. */
async function statusesOfHaltedDowningRun(): Promise<number[]> {
  const system = systemWith('downed-and-halted', { 'exit-process': true, phases: { 'service-stop': { recover: false } } });
  const shutdown = system.extension(CoordinatedShutdownId);
  shutdown.addTask(Phases.ServiceStop, 'halts', () => { throw new Error('the halt'); });
  const statuses = await exitStatusesDuring(async () => {
    try {
      await shutdown.run(ClusterDowningReason.instance);
    } catch {
      // The halt rejects the run; the status is what is asked about.
    }
  });
  // The stand-in teardown ends a downed node whose run halted.
  await awaitCondition(() => system.isTerminated, { label: 'the halted downing run tore the system down', timeoutMs: 3_000 });
  return statuses;
}

/** A status that is not the shipped one, for the second way out. */
const NON_ZERO_EXIT_CODE = 3;

type Page = {
  readonly path: string;
  readonly heading: string;
  /** Every clause the section has to carry, given what was measured. */
  readonly clauses: (measured: Measured) => readonly string[];
};

type Measured = {
  readonly shippedExitCode: number;
  readonly haltedStatus: number;
  readonly failureStatus: number;
};

const PAGES: readonly Page[] = [
  {
    path: 'fundamentals/coordinated-shutdown.mdx',
    heading: '### When the cluster downs this node',
    clauses: (measured) => [
      `the run exits with \`exit-code\`, which ships as \`${measured.shippedExitCode}\``,
      `a run that a phase halts, which exits \`${measured.haltedStatus}\` here as well`,
      '`Restart=on-failure`',
      '`Restart=always`',
      'every run `exit-process` ends exits with it',
      'a signal\'s run and the run of a `system.terminate()` that runs the pipeline',
      `the runs for a failure exit with it instead of \`${measured.failureStatus}\``,
    ],
  },
  {
    path: 'de/fundamentals/coordinated-shutdown.mdx',
    heading: '### Wenn der Cluster diesen Knoten downt',
    clauses: (measured) => [
      `endet der Lauf mit \`exit-code\`, der als \`${measured.shippedExitCode}\` ausgeliefert wird`,
      `ein Lauf, den eine Phase anhält, der auch hier mit \`${measured.haltedStatus}\` endet`,
      '`Restart=on-failure`',
      '`Restart=always`',
      'Jeder Lauf, den `exit-process` beendet, endet mit ihm',
      'der Lauf eines Signals und der eines `system.terminate()`, das die Pipeline ausführt',
      `die Läufe für einen Fehlschlag enden mit ihm statt mit \`${measured.failureStatus}\``,
    ],
  },
];

type SupervisorPage = {
  readonly path: string;
  /** The clause the `Restart=on-failure` row carries, given the shipped `exit-code`. */
  readonly clause: (shippedExitCode: number) => string;
  /** The link from that row to the section above. */
  readonly link: string;
};

/**
 * The repository's own systemd unit is the supervisor the section warns about:
 * it restarts on failure only, so its row says what that does to a downed node.
 */
const SUPERVISOR_PAGES: readonly SupervisorPage[] = [
  {
    path: 'operations/deployment/process-manager.mdx',
    clause: (shippedExitCode) => `exits with status \`${shippedExitCode}\` as shipped, so this leaves it down`,
    link: '(/fundamentals/coordinated-shutdown/#when-the-cluster-downs-this-node)',
  },
  {
    path: 'de/operations/deployment/process-manager.mdx',
    clause: (shippedExitCode) => `endet wie ausgeliefert mit Status \`${shippedExitCode}\`, und das lässt ihn unten`,
    link: '(/de/fundamentals/coordinated-shutdown/#wenn-der-cluster-diesen-knoten-downt)',
  },
];

/** The table row of `relative` that explains a directive, MDX comments cut. */
function directiveRow(relative: string, directive: string): string | undefined {
  return readFileSync(join(DOCS_ROOT, relative), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .find((line) => line.startsWith(`| \`${directive}\` |`));
}

describe('a node its own downing decision stands down exits as a clean stop does (#1456)', () => {
  const shippedExitCode = Config.loadReference().getInt(ConfigKeys.coordinatedShutdown.exitCode);

  test('with exit-process on, the downing run exits with exit-code as shipped', async () => {
    expect(await statusesOfRun('downed', ClusterDowningReason.instance)).toEqual([shippedExitCode]);
  });

  test('a failure never exits with it, and a halted downing run is one', async () => {
    const [failureStatus] = await statusesOfRun('could-not-join', ClusterJoinUnsuccessfulReason.instance);
    expect(failureStatus).not.toBe(shippedExitCode);
    expect(await statusesOfHaltedDowningRun()).toEqual([failureStatus!]);
  });

  test('a non-zero exit-code is every run\'s status, and the failures\' instead of theirs', async () => {
    const settings = { 'exit-code': NON_ZERO_EXIT_CODE };
    expect(await statusesOfRun('downed-non-zero', ClusterDowningReason.instance, settings)).toEqual([NON_ZERO_EXIT_CODE]);
    expect(await statusesOfRun('signal-non-zero', new ProcessTerminateReason('SIGTERM'), settings)).toEqual([NON_ZERO_EXIT_CODE]);
    expect(await statusesOfRun('could-not-join-non-zero', ClusterJoinUnsuccessfulReason.instance, settings))
      .toEqual([NON_ZERO_EXIT_CODE]);
    const terminating = systemWith('terminate-non-zero', { 'exit-process': true, ...settings });
    expect(await exitStatusesDuring(() => terminating.terminate({ runCoordinatedShutdown: true })))
      .toEqual([NON_ZERO_EXIT_CODE]);
  });

  for (const page of PAGES) {
    test(`${page.path} states the status, the supervisor it leaves the node to, and both ways out`, async () => {
      const systemName = `${page.path.replace(/[^a-z0-9]+/gi, '-')}-could-not-join`;
      const [failureStatus] = await statusesOfRun(systemName, ClusterJoinUnsuccessfulReason.instance);
      const [haltedStatus] = await statusesOfHaltedDowningRun();
      const prose = sectionProse(page.path, page.heading);
      for (const clause of page.clauses({ shippedExitCode, haltedStatus: haltedStatus!, failureStatus: failureStatus! })) {
        expect(prose).toContain(clause);
      }
    });
  }

  for (const page of SUPERVISOR_PAGES) {
    test(`${page.path} says on its Restart=on-failure row that a downed node stays down`, () => {
      const row = directiveRow(page.path, 'Restart=on-failure');
      expect(row).toBeDefined();
      expect(row!).toContain(page.clause(shippedExitCode));
      expect(row!).toContain(page.link);
    });
  }
});
