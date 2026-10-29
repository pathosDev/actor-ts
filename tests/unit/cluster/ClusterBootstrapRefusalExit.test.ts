import { describe, expect, spyOn, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions, DEFAULT_AWAIT_READY_MS } from '../../../src/cluster/ClusterBootstrapOptions.js';
import type { ClusterBootstrapOptionsBuilder } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { ClusterJoinUnsuccessfulReason, CoordinatedShutdownId, Phases, type Reason } from '../../../src/CoordinatedShutdown.js';
import type { OtelLogsApiLike } from '../../../src/tracing/OtelLogsAdapter.js';
import { OtelLogsAdapterOptions } from '../../../src/tracing/OtelLogsAdapterOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/**
 * A refused `Cluster.bootstrap` under `exit-process` (D-M5 1, 2026-10-27): a
 * failure never exits 0, and it is logged first.
 *
 * The bootstrap's guard ends the system it built when a start is refused after
 * the system exists, and with
 * `actor-ts.coordinated-shutdown.run-by-actor-system-terminate` on that end is
 * a run of the pipeline.  With `exit-process` on as well, the run used to exit
 * with `exit-code` — `0` by default — from inside the guard, before the
 * refusal could reach `main`: the process ended with a status that reads as a
 * clean stop and with no line saying why (#860, #1455).  Each case below
 * refuses one field the bootstrap forwards, the ones that are refused only
 * once the system exists, with `process.exit` replaced.  The replacement
 * returns, so the refusal still reaches the caller here, which is how a case
 * knows the line it found names the refusal and not something else.
 */

const HOST = '127.0.0.1';

/**
 * Both switches the defect needed, `exit-code` left at its shipped `0` unless
 * `extra` says otherwise, and `hocon` beside them for a case refused from the
 * file.
 */
function exitingThroughThePipeline(extra = '', hocon = ''): Config {
  return Config.parseString(`actor-ts.coordinated-shutdown {
    exit-process = on
    run-by-actor-system-terminate = on
    ${extra}
  }
  ${hocon}`);
}

/** A node that founds its own cluster at once and returns without waiting, logging into `log`. */
function singleNode(name: string, port: number): ClusterBootstrapOptionsBuilder {
  return ClusterBootstrapOptions.create(name)
    .withHost(HOST)
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, HOST, port)))
    .withSeeds([])
    .withReceptionist(false)
    .withShutdownOnSignals(false)
    .withAwaitReady(false);
}

/**
 * The lower address of a two-node seed list behind stable observation, which
 * wins the election — so a give-up inside the founder's grace plus the
 * readiness budget is refused before the join (#1500).
 */
const ELECTION_GRACE_MS = 250;
function electedNode(name: string, port: number): ClusterBootstrapOptionsBuilder {
  return ClusterBootstrapOptions.create(name)
    .withHost('h')
    .withPort(port)
    .withSeeds([`${name}@h:${port}`, `${name}@h:${port + 1}`])
    .withStableObservation({ pollIntervalMs: 5, stableMarginMs: 0, maxWaitMs: 2_000, selfElectionGraceMs: ELECTION_GRACE_MS })
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withReceptionist(false)
    .withShutdownOnSignals(false)
    .withAwaitReady(false);
}

/** A stand-in `@opentelemetry/api-logs` whose logger refuses every record. */
function otelLogsThatThrow(): OtelLogsApiLike {
  return {
    SeverityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 },
    logs: {
      getLoggerProvider: () => ({
        getLogger: () => ({ emit() { throw new Error('the log collector refused the record'); } }),
      }),
    },
  };
}

type Refusal = {
  /** The node, carrying the refused value; the case adds the config and, where it is the test's, the logger. */
  readonly node: (name: string, port: number) => ClusterBootstrapOptionsBuilder;
  /** HOCON beside the two switches, for a value refused from the file rather than from code. */
  readonly hocon?: string;
  /** What the bootstrap rejects with. */
  readonly refusedWith: abstract new (...args: never[]) => Error;
  /**
   * Where the refusal can be reported: the system logger, or — where that
   * logger is the very thing that failed — the console it falls back to.
   */
  readonly reportedOn: 'logger' | 'console';
};

/**
 * Every input the verifier found reaching the silent exit that is still
 * refused here: the join's app-version check, the resolver's validator, the
 * give-up's two rules, and a logger that throws on the bootstrap's first line
 * — plus the app-version from the file, the route that exited 0 before any of
 * these fields was forwarded.  Auto-down beside a downing provider is not
 * among them: #1426 dropped that cross-field rule, so the pair now starts.
 */
const REFUSALS: ReadonlyArray<readonly [string, Refusal]> = [
  ['appVersion, empty', {
    node: (name, port) => singleNode(name, port).withAppVersion(''),
    refusedWith: OptionsError,
    reportedOn: 'logger',
  }],
  ['appVersion, with a space', {
    node: (name, port) => singleNode(name, port).withAppVersion('2.4 rc'),
    refusedWith: OptionsError,
    reportedOn: 'logger',
  }],
  ['appVersion from the file, empty', {
    node: (name, port) => singleNode(name, port),
    hocon: 'actor-ts.cluster.app-version = ""',
    refusedWith: Error,
    reportedOn: 'logger',
  }],
  ['splitBrainResolver, stableAfterMs 0', {
    node: (name, port) => singleNode(name, port).withSplitBrainResolver({ stableAfterMs: 0 }),
    refusedWith: OptionsError,
    reportedOn: 'logger',
  }],
  ['shutdownAfterUnsuccessfulJoinMs, shorter than one seed round', {
    node: (name, port) => singleNode(name, port).withShutdownAfterUnsuccessfulJoinMs(1),
    refusedWith: OptionsError,
    reportedOn: 'logger',
  }],
  ['shutdownAfterUnsuccessfulJoinMs, inside the election budget', {
    node: (name, port) => electedNode(name, port)
      .withShutdownAfterUnsuccessfulJoinMs(ELECTION_GRACE_MS + DEFAULT_AWAIT_READY_MS),
    refusedWith: OptionsError,
    reportedOn: 'logger',
  }],
  ['otelLogs, whose logger throws', {
    node: (name, port) => {
      const otelLogsOptions = OtelLogsAdapterOptions.create().withApi(otelLogsThatThrow());
      return singleNode(name, port).withOtelLogs(otelLogsOptions);
    },
    refusedWith: Error,
    reportedOn: 'console',
  }],
];

/** What held at the moment `process.exit` was called. */
type ExitObservation = {
  readonly status: number;
  /** The ERROR lines the system logger had recorded by then. */
  readonly loggedErrors: string[];
  /** What had gone to `console.error` by then. */
  readonly console: string[];
};

type Outcome = {
  readonly caught: unknown;
  readonly exits: ExitObservation[];
  /** Whether each system the bootstrap built was down when the bootstrap rejected. */
  readonly terminatedAtRejection: boolean[];
  /** The reason of every pipeline run, as the first phase saw it. */
  readonly reasons: Reason[];
};

/**
 * Bootstrap `options` with `process.exit` and `console.error` replaced and
 * `ActorSystem.create` observed, and report what the exit saw.
 *
 * A system the bootstrap left up — a case it did not refuse — is torn down
 * bare, and before the real `process.exit` is put back: a plain `terminate()`
 * under these switches is a pipeline run that ends in that exit.
 */
async function bootstrapRefused(options: ClusterBootstrapOptionsBuilder, log?: RecordingLogger): Promise<Outcome> {
  const systems: ActorSystem[] = [];
  const reasons: Reason[] = [];
  const consoleLines: string[] = [];
  const exits: ExitObservation[] = [];
  const create = ActorSystem.create.bind(ActorSystem);
  const createSpy = spyOn(ActorSystem, 'create').mockImplementation((...args: Parameters<typeof ActorSystem.create>) => {
    const system = create(...args);
    systems.push(system);
    system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'record-the-reason', (reason) => {
      reasons.push(reason);
    });
    return system;
  });
  const consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  });
  const realExit = process.exit;
  process.exit = ((code?: number): never => {
    exits.push({
      status: code ?? Number.NaN,
      loggedErrors: (log?.records ?? []).filter((record) => record.level === 'error').map((record) => record.message),
      console: [...consoleLines],
    });
    return undefined as never;
  }) as typeof process.exit;
  let caught: unknown = 'the bootstrap resolved';
  let terminatedAtRejection: boolean[] = [];
  try {
    await bootstrapCluster(options);
  } catch (error) {
    caught = error;
    terminatedAtRejection = systems.map((system) => system.isTerminated);
  } finally {
    for (const system of systems) {
      if (!system.isTerminated) await system.terminate({ runCoordinatedShutdown: false }).catch(() => {});
    }
    process.exit = realExit;
    consoleSpy.mockRestore();
    createSpy.mockRestore();
  }
  return { caught, exits, terminatedAtRejection, reasons };
}

/** Whether one of `lines` carries the message of `error`. */
function names(lines: ReadonlyArray<string>, error: unknown): boolean {
  const message = (error as Error).message;
  return typeof message === 'string' && message !== '' && lines.some((line) => line.includes(message));
}

describe('a refused bootstrap under exit-process and run-by-actor-system-terminate (D-M5 1)', () => {
  test.each(REFUSALS.map(([what, refusal], index) => [what, refusal, index] as const))(
    '%s: logged at error, then an exit with status 1',
    async (_what, refusal, index) => {
      const name = `refused-exit-${index}`;
      const log = new RecordingLogger();
      const options = refusal.node(name, 46_900 + index * 2).withConfig(exitingThroughThePipeline('', refusal.hocon));
      if (refusal.reportedOn === 'logger') options.withLogger(log);

      const { caught, exits, terminatedAtRejection, reasons } = await bootstrapRefused(options, log);

      // Refused, and the refusal still reaches the caller once the replaced exit returns.
      expect(caught).toBeInstanceOf(refusal.refusedWith);
      // One exit, with a status that does not read as a clean stop.
      expect(exits.map((exit) => exit.status)).toEqual([1]);
      // Named before the exit, on the one channel left to name it on.
      const lines = refusal.reportedOn === 'logger' ? exits[0]!.loggedErrors : exits[0]!.console;
      expect(names(lines, caught)).toBe(true);
      // The run says why it ran — a node that could not join — and took the system down.
      expect(reasons).toEqual([ClusterJoinUnsuccessfulReason.instance]);
      expect(terminatedAtRejection).toEqual([true]);
    },
  );

  test('a configured exit-code that already says "failed" is kept', async () => {
    const log = new RecordingLogger();
    const options = singleNode('refused-exit-keeps-its-code', 46_960)
      .withAppVersion('')
      .withConfig(exitingThroughThePipeline('exit-code = 17'))
      .withLogger(log);

    const { caught, exits } = await bootstrapRefused(options, log);

    expect(caught).toBeInstanceOf(OptionsError);
    expect(exits.map((exit) => exit.status)).toEqual([17]);
  });

  test('with run-by-actor-system-terminate off nothing exits, and the refusal reaches the caller', async () => {
    // The bare teardown runs no pipeline, so exit-process never fires: `main`
    // gets the refusal and decides the status — the behaviour the switch
    // had to be on to lose.  Still logged, and the system still goes down.
    const log = new RecordingLogger();
    const options = singleNode('refused-no-pipeline', 46_962)
      .withAppVersion('')
      .withConfig(Config.parseString('actor-ts.coordinated-shutdown.exit-process = on'))
      .withLogger(log);

    const { caught, exits, terminatedAtRejection, reasons } = await bootstrapRefused(options, log);

    expect(caught).toBeInstanceOf(OptionsError);
    expect(exits).toEqual([]);
    expect(reasons).toEqual([]);
    expect(names(log.records.filter((record) => record.level === 'error').map((record) => record.message), caught))
      .toBe(true);
    expect(terminatedAtRejection).toEqual([true]);
  });
});
