/**
 * Live-database adapter for the parameterized persistence contract (#390).
 *
 * The scenarios themselves live in `persistence-contract/` and are shared with
 * the fast `bun test` pass (`PersistenceContract.test.ts`); this module only
 * adapts them to the `BrokerScenario` shape the Docker runners execute.  A
 * backend therefore gets its live coverage by supplying three factories — no
 * scenario is written twice, and a case added for one backend is immediately
 * checked against all of them.
 *
 * Persistence ids are namespaced with a per-process run id rather than reset
 * up front.  A journal's high-water mark deliberately survives compaction, so
 * "delete everything, then append at 0" is not a valid reset — after
 * `delete(pid, MAX_SAFE_INTEGER)` the mark *is* `MAX_SAFE_INTEGER` and every
 * later append correctly reports a concurrency conflict.  Fresh ids per run
 * make the suites idempotent without fighting that guarantee.
 */
import type { DurableStateStore } from '../../../../src/persistence/DurableStateStore.js';
import type { Journal } from '../../../../src/persistence/Journal.js';
import type { PersistenceQuery } from '../../../../src/persistence/query/PersistenceQuery.js';
import type { SnapshotStore } from '../../../../src/persistence/SnapshotStore.js';
import {
  durableStateContractScenarios,
  journalContractScenarios,
  snapshotContractScenarios,
  type ContractScenario,
  type DurableStateHarness,
  type JournalHarness,
  type SnapshotHarness,
} from './persistence-contract/index.js';
import type { BrokerScenario, BrokerScenarioContext } from './Scenario.js';

export interface SqlPersistenceContext extends BrokerScenarioContext {
  /** Short label — used in scenario names and to namespace persistence ids ("pg", "mariadb"). */
  readonly label: string;
  /** Build a journal against the live database.  Each scenario gets its own. */
  makeJournal(): Promise<Journal>;
  /**
   * Build the read side over a journal this context made.  Optional, and left
   * unset by a backend with no query class — the query-side scenarios then skip
   * rather than pass vacuously.  See `JournalHarness.makeQuery`.
   */
  makeQuery?(journal: Journal): PersistenceQuery;
  /** Build a snapshot store; `keepN` must be honoured so the prune scenarios are meaningful. */
  makeSnapshotStore(keepN?: number): Promise<SnapshotStore>;
  makeDurableStateStore(): Promise<DurableStateStore>;
}

/**
 * Unique per process: two runs against the same container (a re-run without
 * `docker compose down -v`) must not collide on persistence ids.
 */
const runId = `${Date.now().toString(36)}`;

function namespacer(context: SqlPersistenceContext, contract: string) {
  return (name: string): string => `${context.label}:${runId}:${contract}:${name}`;
}

/** Adapt one contract scenario to a `BrokerScenario`, honouring `skip`. */
function adapt<Harness>(
  contract: string,
  scenario: ContractScenario<Harness>,
  buildHarness: (context: SqlPersistenceContext) => Harness,
): BrokerScenario<SqlPersistenceContext> {
  return {
    name: `${contract} — ${scenario.name}`,
    async run(context) {
      const harness = buildHarness(context);
      const skipReason = scenario.skip?.(harness) ?? null;
      if (skipReason !== null) {
        console.log(`[runner] SKIP ${contract} — ${scenario.name}: ${skipReason}`);
        return;
      }
      await scenario.run(harness);
    },
  };
}

export function sqlPersistenceScenarios(): BrokerScenario<SqlPersistenceContext>[] {
  return [
    ...journalContractScenarios().map((scenario) => adapt('journal', scenario, (context): JournalHarness => ({
      label: context.label,
      pid: namespacer(context, 'journal'),
      make: () => context.makeJournal(),
      // Forwarded, not decided here: this adapter serves relational *and*
      // document backends (DynamoDB and MongoDB run through it too), so which
      // query class fits is the runner's call.  A context that leaves it unset
      // skips the query-side scenarios rather than passing them vacuously.
      // Wrapped rather than passed by reference so `this` stays the context,
      // the same way `make` is — the scenario calls it off the harness.
      makeQuery: context.makeQuery === undefined
        ? undefined
        : (journal) => context.makeQuery!(journal),
    }))),
    ...snapshotContractScenarios().map((scenario) => adapt('snapshot', scenario, (context): SnapshotHarness => ({
      label: context.label,
      pid: namespacer(context, 'snapshot'),
      capabilities: { keepN: 'configurable' },
      make: (keepN) => context.makeSnapshotStore(keepN),
    }))),
    ...durableStateContractScenarios().map((scenario) => adapt('durable-state', scenario, (context): DurableStateHarness => ({
      label: context.label,
      pid: namespacer(context, 'durable-state'),
      make: () => context.makeDurableStateStore(),
    }))),
  ];
}
