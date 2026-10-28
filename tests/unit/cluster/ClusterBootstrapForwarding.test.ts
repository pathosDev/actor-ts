import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import type { ActorSystemOptionsType } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import type { BootstrappedCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions, DEFAULT_AWAIT_READY_MS } from '../../../src/cluster/ClusterBootstrapOptions.js';
import type {
  ClusterBootstrapOptionsBuilder,
  ClusterBootstrapOptionsType,
} from '../../../src/cluster/ClusterBootstrapOptions.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { KeepMajority } from '../../../src/cluster/downing/KeepMajority.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import type { LogSink } from '../../../src/logging/LogSink.js';
import { MultiSinkLogger } from '../../../src/logging/MultiSinkLogger.js';
import type { OtelLogRecord, OtelLogsApiLike } from '../../../src/tracing/OtelLogsAdapter.js';
import { OtelLogsAdapterOptions } from '../../../src/tracing/OtelLogsAdapterOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #860 — the settings `Cluster.bootstrap` forwards beside the ones it always
 * had: auto-down, the split-brain-resolver policy and the join give-up to
 * `Cluster.join`, `logSinks` and `otelLogs` to `ActorSystem.create`.  The app
 * version is pinned in `MemberAppVersion.test.ts`, next to its HOCON route,
 * and the give-up's composition with the readiness wait in
 * `tests/ClusterBootstrap.test.ts`.
 *
 * Every field is pinned in both directions, because forwarding goes wrong in
 * two opposite ways.  Not forwarded, an explicit value never reaches the node
 * and the file decides — where the bootstrap stood while these were reachable
 * only through `withConfig`.  Forwarded whether or not it was set, an unset
 * field arrives as an explicit default, which outranks the file in the join's
 * merge and shadows it without a word — what an unconditional `.withSeeds([])`
 * did to `actor-ts.cluster.seed-nodes` (#836).  So each case sets the same
 * setting in HOCON as well: an explicit value has to win over it, and an unset
 * one has to leave it standing.
 *
 * `false`, `0` and `[]` get cases of their own: each is an answer, and a
 * forward guarded by truthiness or by length would drop it and hand the
 * decision back to the file.  The last section pins the rule as a whole —
 * every shared field forwarded, and nothing forwarded that was not set.
 */

const HOST = '127.0.0.1';

const started: BootstrappedCluster[] = [];

afterEach(async () => {
  for (const node of started.splice(0)) {
    try { await node.shutdown(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * A single node on `InMemoryTransport` that founds its own cluster at once —
 * `seeds: []` is the explicit "I am the first", so discovery and the
 * environment it reads are never consulted — and returns without waiting.
 * The case adds the setting under test, its HOCON and, where the logger is
 * not what is under test, a quiet one.
 */
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

async function start(bootstrapOptions: ClusterBootstrapOptionsBuilder): Promise<BootstrappedCluster> {
  const node = await bootstrapCluster(bootstrapOptions);
  started.push(node);
  return node;
}

/**
 * The merged values `Cluster` keeps for the settings read here.  Private, and
 * read anyway: nothing public reports them, and the merge that decides them —
 * explicit over `actor-ts.cluster.*` over the built-in — runs once, in
 * `Cluster.join`, so these fields are the one place its answer is kept.  Every
 * case asserts a definite value in each direction, so a renamed field fails
 * here rather than passing on an `undefined`.
 */
type MergedClusterSettings = {
  readonly failureDetectorAutoDown: boolean;
  readonly shutdownAfterUnsuccessfulJoinMs: number;
  readonly stabilityWindow: {
    readonly stableAfterMs: number;
    readonly downAllWhenUnstable: boolean;
  };
};

function mergedSettingsOf(cluster: Cluster): MergedClusterSettings {
  return cluster as unknown as MergedClusterSettings;
}

describe('failureDetectorAutoDown reaches the join only when set (#860)', () => {
  test('an explicit true outranks the file', async () => {
    const autoDownOff = Config.parseString('actor-ts.cluster.failure-detector.auto-down = off');
    const bootstrapOptions = singleNode('forwarding-auto-down-true', 45_801)
      .withConfig(autoDownOff)
      .withLogger(new NoopLogger())
      .withFailureDetectorAutoDown(true);

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).failureDetectorAutoDown).toBe(true);
  });

  test('an explicit false outranks a file that turns it on', async () => {
    const autoDownOn = Config.parseString('actor-ts.cluster.failure-detector.auto-down = on');
    const bootstrapOptions = singleNode('forwarding-auto-down-false', 45_802)
      .withConfig(autoDownOn)
      .withLogger(new NoopLogger())
      .withFailureDetectorAutoDown(false);

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).failureDetectorAutoDown).toBe(false);
  });

  test('unset, the file decides', async () => {
    // `off` against the shipped `on`: a bootstrap that forwarded a value of its
    // own, or one whose join never saw the file, would both land on `true`.
    const autoDownOff = Config.parseString('actor-ts.cluster.failure-detector.auto-down = off');
    const bootstrapOptions = singleNode('forwarding-auto-down-unset', 45_803)
      .withConfig(autoDownOff)
      .withLogger(new NoopLogger());

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).failureDetectorAutoDown).toBe(false);
  });
});

describe('splitBrainResolver reaches the join only when set (#860)', () => {
  /** Both leaves of the policy, neither at its shipped value. */
  const resolverPolicy = Config.parseString(`actor-ts.cluster.split-brain-resolver {
    stable-after           = 9s
    down-all-when-unstable = on
  }`);

  test('an explicit field outranks the file, and the field it leaves out still comes from the file', async () => {
    // The join merges the policy per field, so the bootstrap must hand it the
    // caller's object as written: one that filled the missing field with a
    // default would turn off an escalation the deployment asked for.
    const bootstrapOptions = singleNode('forwarding-resolver-explicit', 45_811)
      .withConfig(resolverPolicy)
      .withLogger(new NoopLogger())
      .withSplitBrainResolver({ stableAfterMs: 7_000 });

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).stabilityWindow.stableAfterMs).toBe(7_000);
    expect(mergedSettingsOf(cluster).stabilityWindow.downAllWhenUnstable).toBe(true);
  });

  test('an explicit false outranks a file that turns the escalation on', async () => {
    const bootstrapOptions = singleNode('forwarding-resolver-false', 45_812)
      .withConfig(resolverPolicy)
      .withLogger(new NoopLogger())
      .withSplitBrainResolver({ downAllWhenUnstable: false });

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).stabilityWindow.downAllWhenUnstable).toBe(false);
    expect(mergedSettingsOf(cluster).stabilityWindow.stableAfterMs).toBe(9_000);
  });

  test('unset, the file decides both fields', async () => {
    const bootstrapOptions = singleNode('forwarding-resolver-unset', 45_813)
      .withConfig(resolverPolicy)
      .withLogger(new NoopLogger());

    const { cluster } = await start(bootstrapOptions);

    expect(mergedSettingsOf(cluster).stabilityWindow.stableAfterMs).toBe(9_000);
    expect(mergedSettingsOf(cluster).stabilityWindow.downAllWhenUnstable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The join give-up behind stable observation                                  */
/* -------------------------------------------------------------------------- */

/** Counts `start()` — what says a refused bootstrap never reached the join. */
class CountingTransport extends InMemoryTransport {
  startCalls = 0;

  override async start(): Promise<void> {
    this.startCalls++;
    await super.start();
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the bootstrap to reject, and it resolved');
}

/**
 * Every system `bootstrapCluster` creates while `run` runs.  The bootstrap
 * builds its system itself, so the one way to ask afterwards whether it is
 * still up is to see it created: `ActorSystem.create` is spied for the
 * duration and restored after (`spyOn` puts the property back;
 * `mock.module` would not).  Anything an assertion left running is
 * terminated on the way out.
 */
async function observingSystems<T>(run: (created: ActorSystem[]) => Promise<T>): Promise<T> {
  const created: ActorSystem[] = [];
  const create = ActorSystem.create.bind(ActorSystem);
  const spy = spyOn(ActorSystem, 'create').mockImplementation((...args: Parameters<typeof ActorSystem.create>) => {
    const system = create(...args);
    created.push(system);
    return system;
  });
  try {
    return await run(created);
  } finally {
    spy.mockRestore();
    for (const system of created) {
      if (!system.isTerminated) await system.terminate().catch(() => {});
    }
  }
}

describe('the give-up refusal reads the deadline the join will arm (#1500, #860)', () => {
  // Behind stable observation every node but the elected one waits out the
  // founder's grace with nothing able to promote it, so a give-up that does
  // not clear the grace plus the readiness budget is refused before the join.
  // The deadline the join arms is the caller's value over the file's — the
  // bootstrap forwards it — so that is the value the refusal has to judge:
  // judging the file alone would refuse a deadline the join never sees and
  // pass one it arms.
  const graceMs = 250;
  const budgetMs = graceMs + DEFAULT_AWAIT_READY_MS;
  const tuning = { pollIntervalMs: 5, stableMarginMs: 0, maxWaitMs: 2_000, selfElectionGraceMs: graceMs };

  /**
   * One node of a two-node seed list, the lower address, so it wins the
   * election — the refusal holds on the winner too — and, unrefused, returns
   * at once: `awaitReady: false` leaves the pending self-election behind it.
   */
  function electedNode(name: string, port: number, transport: InMemoryTransport): ClusterBootstrapOptionsBuilder {
    return ClusterBootstrapOptions.create(name)
      .withHost('h')
      .withPort(port)
      .withSeeds([`${name}@h:${port}`, `${name}@h:${port + 1}`])
      .withStableObservation(tuning)
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger());
  }

  function fileGiveUp(ms: number): Config {
    return Config.parseString(`actor-ts.cluster.shutdown-after-unsuccessful-join = ${ms}ms`);
  }

  test('a give-up on the bootstrap options inside the budget is refused before anything starts', async () => {
    // The budget exactly, which "does not exceed" includes.  The file says
    // nothing beyond the shipped `0s`, so only the explicit value can trip it.
    const name = 'forwarding-give-up-refused';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_821));
    const bootstrapOptions = electedNode(name, 45_821, transport)
      .withShutdownAfterUnsuccessfulJoinMs(budgetMs);

    const { caught, systems } = await observingSystems(async (created) => ({
      caught: await rejectionOf(bootstrapCluster(bootstrapOptions)),
      systems: [...created],
    }));

    expect(caught).toBeInstanceOf(OptionsError);
    const refusal = caught as OptionsError;
    expect(refusal.field).toBe('shutdownAfterUnsuccessfulJoinMs');
    expect(refusal.message).toContain('actor-ts.cluster.bootstrap.self-election-grace');
    expect(transport.startCalls).toBe(0);
    expect(systems.map((system) => system.isTerminated)).toEqual([true]);
  });

  test('a give-up on the bootstrap options past the budget overrides a file inside it', async () => {
    const name = 'forwarding-give-up-past-budget';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_831));
    const bootstrapOptions = electedNode(name, 45_831, transport)
      .withConfig(fileGiveUp(budgetMs))
      .withShutdownAfterUnsuccessfulJoinMs(budgetMs + 1);

    const node = await bootstrapCluster(bootstrapOptions);
    started.push(node);

    // Accepted, joined, and armed with the caller's deadline, not the file's.
    expect(transport.startCalls).toBe(1);
    expect(mergedSettingsOf(node.cluster).shutdownAfterUnsuccessfulJoinMs).toBe(budgetMs + 1);
  });

  test('a give-up of 0 on the bootstrap options overrides a file inside the budget', async () => {
    // `0` arms no deadline, so there is nothing to refuse — a refusal that
    // read truthiness would fall through to the file's value and refuse it.
    const name = 'forwarding-give-up-zero';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_841));
    const bootstrapOptions = electedNode(name, 45_841, transport)
      .withConfig(fileGiveUp(budgetMs))
      .withShutdownAfterUnsuccessfulJoinMs(0);

    const node = await bootstrapCluster(bootstrapOptions);
    started.push(node);

    expect(transport.startCalls).toBe(1);
    expect(mergedSettingsOf(node.cluster).shutdownAfterUnsuccessfulJoinMs).toBe(0);
  });

  test('with nothing on the bootstrap options, the file\'s give-up inside the budget is still refused', async () => {
    const name = 'forwarding-give-up-file-refused';
    const transport = new CountingTransport(new NodeAddress(name, 'h', 45_851));
    const bootstrapOptions = electedNode(name, 45_851, transport)
      .withConfig(fileGiveUp(budgetMs));

    const { caught, systems } = await observingSystems(async (created) => ({
      caught: await rejectionOf(bootstrapCluster(bootstrapOptions)),
      systems: [...created],
    }));

    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('shutdownAfterUnsuccessfulJoinMs');
    expect(transport.startCalls).toBe(0);
    expect(systems.map((system) => system.isTerminated)).toEqual([true]);
  });

  test('a give-up that is not a non-negative number is refused before any system exists', async () => {
    // The bootstrap judges the deadline itself, before the join's validator
    // ever sees it, so it holds the value to that validator's rule first —
    // otherwise `NaN` would reach the election rule and be refused for the
    // wrong reason, after a system had been built.
    const invalidCases = [
      { label: 'nan', giveUpMs: Number.NaN },
      { label: 'negative', giveUpMs: -1 },
    ] as const;
    for (const { label, giveUpMs } of invalidCases) {
      const name = `forwarding-give-up-${label}`;
      const transport = new CountingTransport(new NodeAddress(name, 'h', 45_861));
      const bootstrapOptions = electedNode(name, 45_861, transport)
        .withShutdownAfterUnsuccessfulJoinMs(giveUpMs);

      const { caught, systems } = await observingSystems(async (created) => ({
        caught: await rejectionOf(bootstrapCluster(bootstrapOptions)),
        systems: [...created],
      }));

      expect(caught).toBeInstanceOf(OptionsError);
      const refusal = caught as OptionsError;
      expect(refusal.field).toBe('shutdownAfterUnsuccessfulJoinMs');
      expect(refusal.message).toContain('must be a non-negative finite number');
      expect(systems).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The two logger fields, forwarded to ActorSystem.create                      */
/* -------------------------------------------------------------------------- */

const PROBE = 'forwarding-probe';

class RecordingSink implements LogSink {
  readonly name = 'recording';
  readonly minLevel = LogLevel.Debug;
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void { this.records.push(record); }
}

/** One `getLogger(name, version)` call, as the OTel logger provider received it. */
type GetLoggerCall = readonly [name: string, version: string | undefined];

/** A stand-in `@opentelemetry/api-logs` namespace: what the logger asked for, and what it emitted. */
type FakeOtelLogs = {
  readonly api: OtelLogsApiLike;
  readonly emitted: OtelLogRecord[];
  readonly getLoggerCalls: GetLoggerCall[];
};

function fakeOtelLogs(): FakeOtelLogs {
  const emitted: OtelLogRecord[] = [];
  const getLoggerCalls: GetLoggerCall[] = [];
  const api: OtelLogsApiLike = {
    SeverityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 },
    logs: {
      getLoggerProvider: () => ({
        getLogger(name, version) {
          getLoggerCalls.push([name, version]);
          return { emit(record) { emitted.push(record); } };
        },
      }),
    },
  };
  return { api, emitted, getLoggerCalls };
}

/**
 * The logger the file asks for — the console sink, on — and, for the
 * OpenTelemetry slot, the logger name the file gives it.  Both logger fields
 * replace the sink block wholesale when set; unset, it is the system logger.
 */
const fileLogger = Config.parseString(`actor-ts {
  logger.sinks.console.enabled = on
  tracing.logger-name          = "from-file"
}`);

/**
 * Run a node's whole life with `console.*` captured instead of printed: the
 * file's console sink writes text through it, so the captured lines are what
 * that sink received.  The node is shut down inside, so its leave is captured
 * too and nothing reaches the real console.
 */
async function withConsoleCaptured(run: (consoleLines: () => string[]) => Promise<void>): Promise<void> {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
    .map((method) => spyOn(console, method).mockImplementation(() => {}));
  const consoleLines = (): string[] => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
  try {
    await run(consoleLines);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('logSinks reaches ActorSystem.create only when set (#860)', () => {
  test('an explicit sink list outranks the file\'s sinks', async () => {
    const sink = new RecordingSink();
    const bootstrapOptions = singleNode('forwarding-log-sinks', 45_871)
      .withConfig(fileLogger)
      .withLogSinks([sink]);

    await withConsoleCaptured(async (consoleLines) => {
      const node = await bootstrapCluster(bootstrapOptions);
      try {
        node.system.log.warn(PROBE);
        expect(sink.records.map((record) => record.message)).toContain(PROBE);
        expect(consoleLines().some((line) => line.includes(PROBE))).toBe(false);
      } finally {
        await node.shutdown();
      }
    });
  });

  test('an explicit empty list is an answer too: no destination, the file\'s included', async () => {
    // The `seeds: []` lesson (#836): `[]` is a value, so a forward guarded by
    // its length would hand the decision back to the file.
    const bootstrapOptions = singleNode('forwarding-log-sinks-empty', 45_872)
      .withConfig(fileLogger)
      .withLogSinks([]);

    await withConsoleCaptured(async (consoleLines) => {
      const node = await bootstrapCluster(bootstrapOptions);
      try {
        node.system.log.warn(PROBE);
        expect(node.system.log).toBeInstanceOf(MultiSinkLogger);
        expect(consoleLines().some((line) => line.includes(PROBE))).toBe(false);
      } finally {
        await node.shutdown();
      }
    });
  });

  test('unset, the file\'s sinks are the system logger', async () => {
    const bootstrapOptions = singleNode('forwarding-log-sinks-unset', 45_873)
      .withConfig(fileLogger);

    await withConsoleCaptured(async (consoleLines) => {
      const node = await bootstrapCluster(bootstrapOptions);
      try {
        node.system.log.warn(PROBE);
        expect(consoleLines().some((line) => line.includes(PROBE))).toBe(true);
      } finally {
        await node.shutdown();
      }
    });
  });
});

describe('otelLogs reaches ActorSystem.create only when set (#860, #1466)', () => {
  test('the slot outranks the file\'s sinks, and is built by the system with the file\'s logger name under it', async () => {
    // Built by the system rather than handed over as a finished logger: the
    // file's `tracing.logger-name` reaches `getLogger`, which a bootstrap that
    // turned the slot into `withLogger(otelLogger(…))` would never consult.
    const otel = fakeOtelLogs();
    const otelLogsOptions = OtelLogsAdapterOptions.create().withApi(otel.api);
    const bootstrapOptions = singleNode('forwarding-otel-logs', 45_881)
      .withConfig(fileLogger)
      .withOtelLogs(otelLogsOptions);

    await withConsoleCaptured(async (consoleLines) => {
      const node = await bootstrapCluster(bootstrapOptions);
      try {
        node.system.log.warn(PROBE);
        expect(otel.getLoggerCalls).toEqual([['from-file', undefined]]);
        expect(otel.emitted.map((record) => record.body)).toContain(PROBE);
        expect(consoleLines().some((line) => line.includes(PROBE))).toBe(false);
      } finally {
        await node.shutdown();
      }
    });
  });

  test('a logger name on the slot outranks the file\'s', async () => {
    const otel = fakeOtelLogs();
    const otelLogsOptions = OtelLogsAdapterOptions.create()
      .withApi(otel.api)
      .withLoggerName('from-code');
    const bootstrapOptions = singleNode('forwarding-otel-logs-named', 45_882)
      .withConfig(fileLogger)
      .withOtelLogs(otelLogsOptions);

    await withConsoleCaptured(async () => {
      const node = await bootstrapCluster(bootstrapOptions);
      try {
        expect(otel.getLoggerCalls).toEqual([['from-code', undefined]]);
      } finally {
        await node.shutdown();
      }
    });
  });

  test('unset, the file\'s sinks are the system logger', async () => {
    const bootstrapOptions = singleNode('forwarding-otel-logs-unset', 45_883)
      .withConfig(fileLogger);

    await withConsoleCaptured(async (consoleLines) => {
      const node = await bootstrapCluster(bootstrapOptions);
      try {
        node.system.log.warn(PROBE);
        expect(node.system.log).toBeInstanceOf(MultiSinkLogger);
        expect(consoleLines().some((line) => line.includes(PROBE))).toBe(true);
      } finally {
        await node.shutdown();
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The rule as a whole: the shared fields, and nothing else                    */
/* -------------------------------------------------------------------------- */

/**
 * Every field `ClusterBootstrapOptionsType` shares, by name, with the options
 * of what it builds — the set `ClusterBootstrapOptionsType`'s doc says it
 * forwards.  The value maps below must name each one (`satisfies` over the
 * key set), so a field added to the bootstrap under a name the target already
 * uses fails `typecheck:dev` here until it has a value — and then fails the
 * run below unless it is forwarded.
 */
type SharedWithClusterOptions = keyof ClusterBootstrapOptionsType & keyof ClusterOptionsType;
type SharedWithActorSystemOptions = keyof ClusterBootstrapOptionsType & keyof ActorSystemOptionsType;

/**
 * Settings the join does not see while the run lasts: the variables the
 * address chain and the default discovery ladder read, cleared so that "the
 * caller set nothing" is what the empty case actually measures.
 */
const BOOTSTRAP_VARIABLES = [
  'CLUSTER_HOST',
  'POD_IP',
  'HOSTNAME',
  'CLUSTER_PORT',
  'CLUSTER_SEEDS',
  'CLUSTER_SERVICE_NAME',
  'CLUSTER_NAMESPACE',
  'KUBERNETES_SERVICE_HOST',
] as const;

class CapturedArgument extends Error {
  constructor() {
    super('captured — the bootstrap goes no further');
  }
}

/**
 * The options the bootstrap hands `Cluster.join`, captured on the way in.
 * The join never runs — the stand-in throws, the bootstrap's guard terminates
 * the system it built and rethrows — so nothing here depends on the values
 * being a node anyone could start.
 */
async function joinOptionsHandedOver(options: Partial<ClusterBootstrapOptionsType>): Promise<Record<string, unknown>> {
  let handed: Record<string, unknown> | undefined;
  const join = spyOn(Cluster, 'join').mockImplementation(async (_system, joinOptions) => {
    handed = joinOptions as unknown as Record<string, unknown>;
    throw new CapturedArgument();
  });
  try {
    expect(await rejectionOf(bootstrapCluster(options))).toBeInstanceOf(CapturedArgument);
  } finally {
    join.mockRestore();
  }
  if (handed === undefined) throw new Error('Cluster.join was never called');
  return handed;
}

/** The options the bootstrap hands `ActorSystem.create`, captured the same way, before any system exists. */
async function systemOptionsHandedOver(options: Partial<ClusterBootstrapOptionsType>): Promise<Record<string, unknown>> {
  let handed: Record<string, unknown> | undefined;
  const create = spyOn(ActorSystem, 'create').mockImplementation((_name, systemOptions) => {
    handed = systemOptions as unknown as Record<string, unknown>;
    throw new CapturedArgument();
  });
  try {
    expect(await rejectionOf(bootstrapCluster(options))).toBeInstanceOf(CapturedArgument);
  } finally {
    create.mockRestore();
  }
  if (handed === undefined) throw new Error('ActorSystem.create was never called');
  return handed;
}

describe('the bootstrap forwards exactly the fields it shares with its targets (#860)', () => {
  const savedVariables = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of BOOTSTRAP_VARIABLES) {
      savedVariables.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedVariables) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedVariables.clear();
  });

  test('every field it shares with ClusterOptions reaches Cluster.join as written', async () => {
    // `false` and `0` where the field allows them: a forward guarded by
    // truthiness drops exactly those.
    const shared = {
      host: '10.0.0.7',
      port: 25_520,
      advertisedHost: '10.0.0.8',
      advertisedPort: 35_520,
      transport: new InMemoryTransport(new NodeAddress('forwarding-shared-cluster', '10.0.0.8', 35_520)),
      seeds: ['forwarding-shared-cluster@10.0.0.9:2552'],
      roles: ['frontend'],
      appVersion: '3.1.4',
      failureDetector: { heartbeatIntervalMs: 250 },
      failureDetectorAutoDown: false,
      gossipIntervalMs: 750,
      downing: new KeepMajority(),
      splitBrainResolver: { downAllWhenUnstable: false },
      shutdownAfterUnsuccessfulJoinMs: 0,
    } satisfies { readonly [K in SharedWithClusterOptions]-?: NonNullable<ClusterBootstrapOptionsType[K]> };

    const handed = await joinOptionsHandedOver({
      name: 'forwarding-shared-cluster',
      logger: new NoopLogger(),
      ...shared,
    });

    for (const [field, value] of Object.entries(shared)) {
      expect(handed[field], field).toEqual(value);
    }
  });

  test('a bootstrap that sets none of them hands Cluster.join none of them', async () => {
    // Nothing named an address, no seeds were set and discovery found none,
    // so every one of these is left to the join — and to the file it reads.
    const handed = await joinOptionsHandedOver({ name: 'forwarding-shared-cluster-unset', logger: new NoopLogger() });

    expect(Object.keys(handed)).toEqual([]);
  });

  test('every field it shares with ActorSystemOptions reaches ActorSystem.create as written', async () => {
    const shared = {
      logger: new NoopLogger(),
      otelLogs: { api: fakeOtelLogs().api },
      logSinks: [],
      logLevel: LogLevel.Debug,
      config: Config.parseString(''),
      configFile: 'forwarding-shared.conf',
      persistence: {},
    } satisfies { readonly [K in SharedWithActorSystemOptions]-?: NonNullable<ClusterBootstrapOptionsType[K]> };

    const handed = await systemOptionsHandedOver({ name: 'forwarding-shared-system', ...shared });

    for (const [field, value] of Object.entries(shared)) {
      expect(handed[field], field).toEqual(value);
    }
  });

  test('a bootstrap that sets none of them hands ActorSystem.create none of them', async () => {
    const handed = await systemOptionsHandedOver({ name: 'forwarding-shared-system-unset' });

    expect(Object.keys(handed)).toEqual([]);
  });
});
