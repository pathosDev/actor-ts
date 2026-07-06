/**
 * Generic worker-side bootstrap for `ParallelMultiNodeSpec`.  Each
 * worker spawned by the harness runs this script; the harness drives
 * the worker via a control-channel piggybacked on the same
 * `postMessage` socket that `WorkerNode.join()` uses for its
 * lifecycle handshake.
 *
 * Test-local actor logic is loaded via a **scenario module** —
 * `initData.scenarioModule` is a URL passed by the harness; the
 * bootstrap dynamically imports it and calls its `setup(ctx)` hook
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
import { ActorSystem } from '../../ActorSystem.js';
import { Cluster, ClusterOptions } from '../../cluster/Cluster.js';
import type { Member } from '../../cluster/Member.js';
import type { FailureDetectorSettings } from '../../cluster/FailureDetector.js';
import { LogLevel, NoopLogger } from '../../Logger.js';
import { WorkerNode } from '../../worker/WorkerNode.js';

/* ------------------------------ scenario module API ------------------ */

/**
 * Optional shape a scenario module exports.  All hooks are optional —
 * a scenario can be just `{ setup }` for static fixture setup, or
 * just `{ commands }` for a request/reply tester, or both.  The
 * `ctx` parameter holds the worker's `ActorSystem` + `Cluster` plus
 * the role name + any role-specific init data.
 */
export interface ScenarioContext {
  readonly role: string;
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly initData: unknown;
  /** Per-role state the scenario wants to keep across commands. */
  readonly state: Record<string, unknown>;
}

export interface ScenarioModule {
  setup?: (ctx: ScenarioContext) => void | Promise<void>;
  commands?: Record<
    string,
    (args: unknown, ctx: ScenarioContext) => unknown | Promise<unknown>
  >;
}

/* ----------------------------- wire protocol ------------------------- */

interface InitData {
  readonly role: string;
  readonly seeds: ReadonlyArray<string>;
  readonly failureDetector?: Partial<FailureDetectorSettings>;
  readonly gossipIntervalMs?: number;
  readonly logLevel?: LogLevel;
  readonly scenarioModule?: string;       // serialised URL string
  readonly scenarioInitData?: unknown;    // forwarded to setup()'s ctx
}

type ControlRequest =
  | { kind: 'mns-test.query-members'; reqId: number }
  | { kind: 'mns-test.query-leader'; reqId: number }
  | { kind: 'mns-test.leave'; reqId: number }
  | { kind: 'mns-test.run-command'; reqId: number; command: string; args: unknown };

type ControlResponse =
  | { kind: 'mns-test.query-members-response'; reqId: number; members: MemberSnapshot[] }
  | { kind: 'mns-test.query-leader-response'; reqId: number; leader: string | null }
  | { kind: 'mns-test.leave-response'; reqId: number; error?: string }
  | { kind: 'mns-test.run-command-response'; reqId: number; result: unknown; error?: string };

/** Member view as a JSON-serialisable snapshot — Member instances
 *  themselves carry NodeAddress objects which postMessage flattens
 *  into plain data anyway, but defining the shape here makes the
 *  cross-process contract explicit. */
export interface MemberSnapshot {
  readonly address: string;
  readonly status: Member['status'];
  readonly roles: ReadonlyArray<string>;
}

interface WorkerScope {
  addEventListener?(ev: string, h: (e: { data: unknown }) => void): void;
  postMessage?(v: unknown): void;
}

/* ------------------------------- main loop --------------------------- */

async function main(): Promise<void> {
  const ctx = await WorkerNode.join<InitData>();
  const init = ctx.initData;

  const system = ActorSystem.create(ctx.systemName, {
    logger: new NoopLogger(),
    logLevel: init.logLevel ?? LogLevel.Off,
  });
  const clusterOptions = ClusterOptions.create()
    .withHost(ctx.self.host)
    .withPort(ctx.self.port)
    .withSeeds([...init.seeds])
    .withTransport(ctx.transport);
  if (init.failureDetector) clusterOptions.withFailureDetector(init.failureDetector);
  if (init.gossipIntervalMs !== undefined) {
    clusterOptions.withGossipIntervalMs(init.gossipIntervalMs);
  }
  const cluster = await Cluster.join(system, clusterOptions);

  const scenarioCtx: ScenarioContext = {
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
      console.error('parallel-multi-node-bootstrap: scenario import failed', err);
    }
  }
  if (scenario.setup) {
    try { await scenario.setup(scenarioCtx); }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error('parallel-multi-node-bootstrap: scenario.setup() threw', err);
    }
  }

  // Wire the control channel — listen on the worker's main port for
  // test commands.  Replies go on the same port via postMessage.
  const g = globalThis as unknown as { self?: WorkerScope } & WorkerScope;
  const selfScope: WorkerScope = g.self ?? g;
  const post = selfScope.postMessage ?? g.postMessage;

  const reply = (msg: ControlResponse): void => {
    post?.call(selfScope, msg);
  };

  const onControl = async (data: unknown): Promise<void> => {
    const msg = data as Partial<ControlRequest> | undefined;
    if (!msg || typeof msg.kind !== 'string' || !msg.kind.startsWith('mns-test.')) return;

    switch (msg.kind) {
      case 'mns-test.query-members': {
        const m = (msg as ControlRequest & { kind: 'mns-test.query-members' }).reqId;
        const snap: MemberSnapshot[] = cluster.getMembers().map((mem) => ({
          address: mem.address.toString(),
          status: mem.status,
          roles: Array.from(mem.roles),
        }));
        reply({ kind: 'mns-test.query-members-response', reqId: m, members: snap });
        return;
      }
      case 'mns-test.query-leader': {
        const reqId = (msg as { reqId: number }).reqId;
        const ldr = cluster.leader().toNullable();
        reply({
          kind: 'mns-test.query-leader-response',
          reqId,
          leader: ldr ? ldr.address.toString() : null,
        });
        return;
      }
      case 'mns-test.leave': {
        const reqId = (msg as { reqId: number }).reqId;
        try {
          await cluster.leave();
          reply({ kind: 'mns-test.leave-response', reqId });
        } catch (err) {
          reply({
            kind: 'mns-test.leave-response', reqId,
            error: (err as Error).message,
          });
        }
        return;
      }
      case 'mns-test.run-command': {
        const reqId = (msg as { reqId: number }).reqId;
        const command = (msg as { command: string }).command;
        const args = (msg as { args: unknown }).args;
        const handler = scenario.commands?.[command];
        if (!handler) {
          reply({
            kind: 'mns-test.run-command-response', reqId, result: undefined,
            error: `no handler for command '${command}'`,
          });
          return;
        }
        try {
          const result = await handler(args, scenarioCtx);
          reply({ kind: 'mns-test.run-command-response', reqId, result });
        } catch (err) {
          reply({
            kind: 'mns-test.run-command-response', reqId, result: undefined,
            error: (err as Error).message,
          });
        }
        return;
      }
    }
  };

  if (typeof selfScope.addEventListener === 'function') {
    selfScope.addEventListener('message', (e) => { void onControl(e.data); });
  }

  ctx.ready();
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('parallel-multi-node-bootstrap: fatal', err);
});
