/**
 * Generic worker-side bootstrap for `ParallelMultiNodeSpec`.  Each
 * worker spawned by the harness runs this script; the harness drives
 * the worker via a control-channel piggybacked on the same
 * `postMessage` socket that `WorkerNode.join()` uses for its
 * lifecycle handshake.
 *
 * Test-local actor logic is loaded via a **scenario module** —
 * `initData.scenarioModule` is a URL passed by the harness; the
 * bootstrap dynamically imports it and calls its `setup(context)` hook
 * after the cluster joins, then dispatches `run-command` requests
 * through the module's `commands` map.  The scenario module owns
 * everything actor-shaped (entity classes, sharding setup, …) —
 * the harness only ever sees JSON-serialisable command/response
 * pairs.
 *
 * **Why a separate file**: the worker process can't see the test
 * file's closures (workers run in their own JS context with their
 * own module graph).  A standalone bootstrap that loads scenario
 * modules by URL is the cleanest way to thread test-specific code
 * into the worker without leaking it through `postMessage`.
 */
import { match } from 'ts-pattern';
import { ActorSystem } from '../../ActorSystem.js';
import { ActorSystemOptions } from '../../ActorSystemOptions.js';
import { Cluster } from '../../cluster/Cluster.js';
import { ClusterOptions } from '../../cluster/ClusterOptions.js';
import type { Member } from '../../cluster/Member.js';
import type { FailureDetectorOptionsType } from '../../cluster/FailureDetectorOptions.js';
import { LogLevel, NoopLogger } from '../../Logger.js';
import { WorkerNode } from '../../worker/WorkerNode.js';

/* ------------------------------ scenario module API ------------------ */

/**
 * Optional shape a scenario module exports.  All hooks are optional —
 * a scenario can be just `{ setup }` for static fixture setup, or
 * just `{ commands }` for a request/reply tester, or both.  The
 * `context` parameter holds the worker's `ActorSystem` + `Cluster` plus
 * the role name + any role-specific init data.
 */
export type ScenarioContext = {
  readonly role: string;
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly initData: unknown;
  /** Per-role state the scenario wants to keep across commands. */
  readonly state: Record<string, unknown>;
};

export interface ScenarioModule {
  setup?: (context: ScenarioContext) => void | Promise<void>;
  commands?: Record<
    string,
    (args: unknown, context: ScenarioContext) => unknown | Promise<unknown>
  >;
}

/* ----------------------------- wire protocol ------------------------- */

type InitData = {
  readonly role: string;
  readonly seeds: ReadonlyArray<string>;
  readonly failureDetector?: Partial<FailureDetectorOptionsType>;
  readonly gossipIntervalMs?: number;
  readonly logLevel?: LogLevel;
  readonly scenarioModule?: string;       // serialised URL string
  readonly scenarioInitData?: unknown;    // forwarded to setup()'s context
};

type QueryMembersRequest = { kind: 'mns-test.query-members'; reqId: number };
type QueryLeaderRequest = { kind: 'mns-test.query-leader'; reqId: number };
type LeaveRequest = { kind: 'mns-test.leave'; reqId: number };
type RunCommandRequest = { kind: 'mns-test.run-command'; reqId: number; command: string; args: unknown };

type ControlRequest = QueryMembersRequest | QueryLeaderRequest | LeaveRequest | RunCommandRequest;

type ControlResponse =
  | { kind: 'mns-test.query-members-response'; reqId: number; members: MemberSnapshot[] }
  | { kind: 'mns-test.query-leader-response'; reqId: number; leader: string | null }
  | { kind: 'mns-test.leave-response'; reqId: number; error?: string }
  | { kind: 'mns-test.run-command-response'; reqId: number; result: unknown; error?: string };

/** Member view as a JSON-serialisable snapshot — Member instances
 *  themselves carry NodeAddress objects which postMessage flattens
 *  into plain data anyway, but defining the shape here makes the
 *  cross-process contract explicit. */
export type MemberSnapshot = {
  readonly address: string;
  readonly status: Member['status'];
  readonly roles: ReadonlyArray<string>;
};

interface WorkerScope {
  addEventListener?(ev: string, h: (e: { data: unknown }) => void): void;
  postMessage?(v: unknown): void;
}

/* ------------------------------- main loop --------------------------- */

async function main(): Promise<void> {
  const context = await WorkerNode.join<InitData>();
  const init = context.initData;

  const system = ActorSystem.create(context.systemName, ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(init.logLevel ?? LogLevel.Off));
  const clusterOptions = ClusterOptions.create()
    .withHost(context.self.host)
    .withPort(context.self.port)
    .withSeeds([...init.seeds])
    .withTransport(context.transport);
  if (init.failureDetector) clusterOptions.withFailureDetector(init.failureDetector);
  if (init.gossipIntervalMs !== undefined) {
    clusterOptions.withGossipIntervalMs(init.gossipIntervalMs);
  }
  const cluster = await Cluster.join(system, clusterOptions);

  const scenarioContext: ScenarioContext = {
    role: init.role,
    system,
    cluster,
    initData: init.scenarioInitData,
    state: {},
  };

  // Dynamically import the scenario module (if any) and run its
  // setup hook.  The module's URL was resolved on the main thread
  // — we just import the string verbatim.
  let scenario: ScenarioModule = {};
  if (init.scenarioModule) {
    try {
      scenario = await import(init.scenarioModule) as ScenarioModule;
    } catch (err) {
      // Without the scenario, setup-dependent commands will fail —
      // surface the import error early rather than at first
      // invocation.
      // eslint-disable-next-line no-console
      console.error('ParallelMultiNodeBootstrap: scenario import failed', err);
    }
  }
  if (scenario.setup) {
    try { await scenario.setup(scenarioContext); }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error('ParallelMultiNodeBootstrap: scenario.setup() threw', err);
    }
  }

  // Wire the control channel — listen on the worker's main port for
  // test commands.  Replies go on the same port via postMessage.
  const globalScope = globalThis as unknown as { self?: WorkerScope } & WorkerScope;
  const selfScope: WorkerScope = globalScope.self ?? globalScope;
  const post = selfScope.postMessage ?? globalScope.postMessage;

  const reply = (message: ControlResponse): void => {
    post?.call(selfScope, message);
  };

  const onQueryMembers = (request: QueryMembersRequest): void => {
    const snap: MemberSnapshot[] = cluster.getMembers().map((mem) => ({
      address: mem.address.toString(),
      status: mem.status,
      roles: Array.from(mem.roles),
    }));
    reply({ kind: 'mns-test.query-members-response', reqId: request.reqId, members: snap });
  };

  const onQueryLeader = (request: QueryLeaderRequest): void => {
    const ldr = cluster.leader().toNullable();
    reply({
      kind: 'mns-test.query-leader-response',
      reqId: request.reqId,
      leader: ldr ? ldr.address.toString() : null,
    });
  };

  // Every failure below is reported back rather than thrown: the requester is
  // a test in another process awaiting this reply, and a rejected promise here
  // would leave it hanging until its own timeout with no reason attached.
  const onLeave = async (request: LeaveRequest): Promise<void> => {
    try {
      await cluster.leave();
      reply({ kind: 'mns-test.leave-response', reqId: request.reqId });
    } catch (err) {
      reply({
        kind: 'mns-test.leave-response', reqId: request.reqId,
        error: (err as Error).message,
      });
    }
  };

  const onRunCommand = async (request: RunCommandRequest): Promise<void> => {
    const handler = scenario.commands?.[request.command];
    if (!handler) {
      reply({
        kind: 'mns-test.run-command-response', reqId: request.reqId, result: undefined,
        error: `no handler for command '${request.command}'`,
      });
      return;
    }
    try {
      const result = await handler(request.args, scenarioContext);
      reply({ kind: 'mns-test.run-command-response', reqId: request.reqId, result });
    } catch (err) {
      reply({
        kind: 'mns-test.run-command-response', reqId: request.reqId, result: undefined,
        error: (err as Error).message,
      });
    }
  };

  const onUnknownControl = (request: { kind?: string }): void => {
    // eslint-disable-next-line no-console
    console.error(`ParallelMultiNodeBootstrap: unknown control request '${request.kind}'`);
  };

  const onControl = async (data: unknown): Promise<void> => {
    const message = data as Partial<ControlRequest> | undefined;
    if (!message || typeof message.kind !== 'string' || !message.kind.startsWith('mns-test.')) return;

    // `.otherwise`, not `.exhaustive`: the prefix guard above admits any
    // `mns-test.*` kind, and this arrives as untrusted postMessage data from
    // another process.  A throw here would take down the control channel and
    // strand every subsequent request.
    await match(message as ControlRequest)
      .with({ kind: 'mns-test.query-members' }, (m) => onQueryMembers(m))
      .with({ kind: 'mns-test.query-leader' }, (m) => onQueryLeader(m))
      .with({ kind: 'mns-test.leave' }, (m) => onLeave(m))
      .with({ kind: 'mns-test.run-command' }, (m) => onRunCommand(m))
      .otherwise((m) => onUnknownControl(m));
  };

  if (typeof selfScope.addEventListener === 'function') {
    // No origin check: worker-thread message channel, not window.postMessage —
    // messages come only from the trusted parent, and payloads are validated by
    // `kind` in onControl (CodeQL js/missing-origin-check — false positive).
    selfScope.addEventListener('message', (e) => { void onControl(e.data); });
  }

  context.ready();
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('ParallelMultiNodeBootstrap: fatal', err);
});
