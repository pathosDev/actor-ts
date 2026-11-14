import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { match, P } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import type { Clock } from '../../src/Clock.js';
import type { ActorCell } from '../../src/internal/ActorCell.js';
import type { CellInspection } from '../../src/internal/Instrumentation.js';
import type { LocalActorRef } from '../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import {
  ActorInitializationError,
  AllForOneStrategy,
  Directive,
  OneForOneStrategy,
  type SupervisorStrategy,
} from '../../src/Supervision.js';
import { Terminated } from '../../src/SystemMessages.js';
import { TestKit } from '../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../src/testkit/TestKitOptions.js';

/**
 * Supervision under failures inside the restart machinery itself (#1384).
 *
 * `Supervision.test.ts` and `RestartRegressions.test.ts` raise their failures
 * from message handling.  The sites this file adds are the ones a restart runs
 * through — the constructor, `preStart`, `preRestart`, `postRestart` and
 * `postStop` — each of which leaves the cell in a different intermediate state
 * with its mailbox suspended.  The interesting failures are combinations, so
 * this is a generated walk rather than a case matrix: a random tree, a random
 * strategy per supervisor (scope, directive, a finite or unlimited budget, a
 * window on virtual time), and a random sequence of failures, each arming a
 * random set of lifecycle sites before it throws.
 *
 * The invariants are checked by the actors themselves while the walk runs, and
 * once more on the quiet tree at the end:
 *
 * - no actor processes a message while its cell is suspended or not running;
 * - every failure a supervisor is asked about traces back to an injected one —
 *   a stray `Child name … is not unique` would mean a restart raced its own
 *   children;
 * - every terminated cell's watcher got exactly one `Terminated`, and no live
 *   cell's watcher got one;
 * - no cell is left suspended, creating or half-stopped once the tree is quiet,
 *   and every live cell still answers a message;
 * - every live cell is listed by its live parent, and no terminated one is;
 * - no node that no decision touched has gone missing;
 * - restart attempts never exceed the budget: per child name within a window
 *   (#917), per child cell for a strategy without one.
 *
 * The seed is the suite's pinned one (`tests/setup/property-seed.ts`), so a
 * failure is reproducible from the seed and path fast-check prints.
 */

type FailureSite = 'constructor' | 'preStart' | 'preRestart' | 'postRestart' | 'postStop';

const FAILURE_SITES: ReadonlyArray<FailureSite> = ['constructor', 'preStart', 'preRestart', 'postRestart', 'postStop'];

type StrategySpec = {
  readonly scope: 'one-for-one' | 'all-for-one';
  readonly directive: Directive;
  readonly maxRetries: number;
  readonly withinTimeRangeMs: number;
};

type TreeSpec = {
  /** How this node supervises its own children. */
  readonly strategy: StrategySpec;
  readonly children: ReadonlyArray<TreeSpec>;
};

type FlatNode = {
  /** Slash-joined child indices from the root, `r`, `r/0`, `r/0/1`. */
  readonly id: string;
  readonly name: string;
  readonly parent: FlatNode | null;
  readonly children: FlatNode[];
  readonly strategy: SupervisorStrategy;
  readonly strategySpec: StrategySpec;
};

/** `followUps` ordinary messages are sent in the same breath, so they are queued behind the failure while it is being decided. */
type FailStep = {
  readonly kind: 'fail';
  readonly node: number;
  readonly sites: ReadonlyArray<FailureSite>;
  readonly followUps: number;
};

/**
 * Arm lifecycle sites without failing the node now, so a site fires when
 * something else restarts it — and a `constructor` armed this way is what
 * makes a *fresh* cell fail its very first construction when an ancestor's
 * restart spawns it again, the one path where the cell has no instance at all.
 */
type ArmStep = { readonly kind: 'arm'; readonly node: number; readonly sites: ReadonlyArray<FailureSite> };
type WorkStep = { readonly kind: 'work'; readonly node: number };
type AdvanceStep = { readonly kind: 'advance'; readonly ms: number };
type Step = FailStep | ArmStep | WorkStep | AdvanceStep;

type FailMessage = { readonly kind: 'fail'; readonly sites: ReadonlyArray<FailureSite> };
type WorkMessage = { readonly kind: 'work' };
type NodeMessage = FailMessage | WorkMessage;

type WatchMessage = { readonly kind: 'watch'; readonly ref: ActorRef };
type WatcherMessage = WatchMessage | Terminated;

/** One construction of a node's instance after the first, i.e. one restart attempt. */
type RestartAttempt = {
  readonly parentCell: string;
  readonly childName: string;
  readonly childCell: string;
  readonly at: number;
  readonly strategy: StrategySpec;
};

/**
 * One answer of a supervisor: the child it was asked about, the directive, and
 * every child the directive reaches — the failing one alone under one-for-one,
 * all of its siblings under all-for-one.
 */
type Decision = { readonly child: string; readonly directive: Directive; readonly affected: ReadonlyArray<string> };

/** Whether `nodeId` is `ancestorId` or lies below it. */
const isAtOrBelow = (nodeId: string, ancestorId: string): boolean =>
  nodeId === ancestorId || nodeId.startsWith(`${ancestorId}/`);

class InjectedFailure extends Error {
  constructor(readonly nodeId: string, readonly site: FailureSite | 'onReceive') {
    super(`injected ${site} failure in ${nodeId}`);
    this.name = 'InjectedFailure';
  }
}

const cellOf = (ref: ActorRef): ActorCell<unknown> => (ref as LocalActorRef<unknown>).getCell();

/**
 * Cell identity, not `path#uid`.  A uid is a counter on the parent *cell*, so a
 * parent stopped and spawned again hands its new children the uids its old
 * ones had, and two incarnations of a grandchild share `path#uid`.
 */
const cellNumbers = new WeakMap<ActorCell<unknown>, number>();
let nextCellNumber = 0;
const keyOf = (ref: ActorRef): string => {
  const cell = cellOf(ref);
  let number = cellNumbers.get(cell);
  if (number === undefined) {
    number = ++nextCellNumber;
    cellNumbers.set(cell, number);
  }
  return `${ref.path.toString()}@${number}`;
};

/** Everything the actors report into, and everything the end-of-run checks read. */
class StressHarness {
  readonly violations: string[] = [];
  readonly decisions: Decision[] = [];
  readonly restartAttempts: RestartAttempt[] = [];
  /** Every cell ever spawned for a node, in spawn order. */
  readonly cells: Array<{ readonly node: FlatNode; readonly ref: ActorRef }> = [];
  readonly terminatedSeen = new Map<string, number>();
  readonly processed = new Map<string, number>();
  private readonly armed = new Map<string, Map<FailureSite, number>>();
  watcher: ActorRef<WatcherMessage> | null = null;

  constructor(readonly clock: Clock) {}

  arm(nodeId: string, sites: ReadonlyArray<FailureSite>): void {
    const counters = this.armed.get(nodeId) ?? new Map<FailureSite, number>();
    for (const site of sites) counters.set(site, (counters.get(site) ?? 0) + 1);
    this.armed.set(nodeId, counters);
  }

  /** Throw if `site` is armed for `nodeId`, consuming one arming. */
  consume(nodeId: string, site: FailureSite): void {
    const counters = this.armed.get(nodeId);
    const left = counters?.get(site) ?? 0;
    if (left === 0) return;
    counters!.set(site, left - 1);
    throw new InjectedFailure(nodeId, site);
  }

  /**
   * Spawn `node` through `spawn` with a factory that counts its calls: every
   * call after the first is a restart attempt of that one cell.
   */
  spawnNode(
    node: FlatNode,
    parentCell: string,
    supervision: StrategySpec,
    spawn: (factory: () => StressNode) => ActorRef,
  ): void {
    let constructions = 0;
    let childCell = '?';
    const ref = spawn(() => {
      constructions++;
      if (constructions > 1) {
        this.restartAttempts.push({
          parentCell, childName: node.name, childCell, at: this.clock.now(), strategy: supervision,
        });
      }
      return new StressNode(this, node);
    });
    childCell = keyOf(ref);
    this.cells.push({ node, ref });
    this.watcher!.tell({ kind: 'watch', ref });
  }

  /** The strategy `node` supervises its children with, recording every decision it takes. */
  strategyFor(spec: StrategySpec, children: () => ReadonlyArray<FlatNode>): SupervisorStrategy {
    const decider = (error: Error): Directive => {
      const cause = error instanceof ActorInitializationError ? error.cause : error;
      if (!(cause instanceof InjectedFailure)) {
        this.violations.push(`a supervisor was asked about a failure nobody injected: ${String(cause)}`);
        return spec.directive;
      }
      const child = children().find((candidate) => isAtOrBelow(cause.nodeId, candidate.id));
      const childId = child?.id ?? `?${cause.nodeId}`;
      this.decisions.push({
        child: childId,
        directive: spec.directive,
        affected: spec.scope === 'all-for-one' ? children().map((sibling) => sibling.id) : [childId],
      });
      return spec.directive;
    };
    const options = { maxRetries: spec.maxRetries, withinTimeRangeMs: spec.withinTimeRangeMs };    return spec.scope === 'one-for-one'
      ? new OneForOneStrategy(decider, options)
      : new AllForOneStrategy(decider, options);
  }

  /**
   * Whether a `Resume` reaching `nodeId` was decided after the first
   * `fromDecision` decisions — about the node itself, an ancestor (a resume
   * resumes the whole subtree, #635), or an all-for-one sibling of either.
   */
  resumedSince(nodeId: string, fromDecision: number): boolean {
    return this.decisions.slice(fromDecision).some((decision) => decision.directive === Directive.Resume
      && decision.affected.some((affected) => isAtOrBelow(nodeId, affected)));
  }
}

class StressNode extends Actor<NodeMessage> {
  /**
   * How many decisions had been taken when this instance last failed in
   * `onReceive`, or `null` while it has not.  The ground truth for "suspended"
   * that does not ask the cell: a cell that forgot to suspend itself would also
   * report itself running.
   */
  private failedAtDecision: number | null = null;

  constructor(private readonly harness: StressHarness, private readonly node: FlatNode) {
    super();
    harness.consume(node.id, 'constructor');
  }

  /** Read lazily: the context is attached after the constructor returns. */
  get cellKey(): string { return keyOf(this.context.self); }

  override supervisorStrategy(): SupervisorStrategy { return this.node.strategy; }

  override preStart(): void {
    this.harness.consume(this.node.id, 'preStart');
    const parentCell = keyOf(this.context.self);
    for (const child of this.node.children) {
      this.harness.spawnNode(
        child,
        parentCell,
        this.node.strategySpec,
        (factory) => this.context.spawn(factory, child.name),
      );
    }
  }

  override preRestart(reason: Error): void | Promise<void> {
    this.harness.consume(this.node.id, 'preRestart');
    return super.preRestart(reason);
  }

  override postRestart(reason: Error): void | Promise<void> {
    this.harness.consume(this.node.id, 'postRestart');
    return super.postRestart(reason);
  }

  override postStop(): void {
    this.harness.consume(this.node.id, 'postStop');
  }

  override onReceive(message: NodeMessage): void {
    // The invariant the whole file exists for: every failure path runs with the
    // mailbox suspended, and none of them may let a message through early.
    const inspection = (this.context as unknown as { _inspect(): CellInspection })._inspect();
    if (inspection.suspended || inspection.cellState !== 'running') {
      this.harness.violations.push(
        `${inspection.path} processed ${message.kind} while ${inspection.cellState}`
        + `${inspection.suspended ? ' with its mailbox suspended' : ''}`,
      );
    }
    // The same invariant from outside the cell: an instance that failed runs
    // again only once a `Resume` reached it.  A restart or a stop replaces or
    // ends the instance, so neither lets this one process anything.
    if (this.failedAtDecision !== null) {
      if (!this.harness.resumedSince(this.node.id, this.failedAtDecision)) {
        this.harness.violations.push(`${inspection.path} processed ${message.kind} after failing, before any Resume reached it`);
      }
      this.failedAtDecision = null;
    }
    const key = this.cellKey;
    this.harness.processed.set(key, (this.harness.processed.get(key) ?? 0) + 1);
    match(message)
      .with({ kind: 'fail' }, (m) => this.onFail(m))
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onFail(message: FailMessage): void {
    this.harness.arm(this.node.id, message.sites);
    this.failedAtDecision = this.harness.decisions.length;
    throw new InjectedFailure(this.node.id, 'onReceive');
  }

  private onWork(): void {}
}

/** Watches every cell the tree ever spawns and counts the `Terminated` each one earns. */
class DeathWatcher extends Actor<WatcherMessage> {
  constructor(private readonly harness: StressHarness) { super(); }

  override onReceive(message: WatcherMessage): void {
    match(message)
      .with(P.instanceOf(Terminated), (m) => this.onTerminated(m))
      .with({ kind: 'watch' }, (m) => this.onWatch(m))
      .exhaustive();
  }

  private onWatch(message: WatchMessage): void {
    this.context.watch(message.ref);
  }

  private onTerminated(message: Terminated): void {
    const key = keyOf(message.actor);
    this.harness.terminatedSeen.set(key, (this.harness.terminatedSeen.get(key) ?? 0) + 1);
  }
}

/* ------------------------------- Generation ------------------------------- */

const directiveArbitrary = fc.constantFrom(Directive.Restart, Directive.Resume, Directive.Stop, Directive.Escalate);

const strategyArbitrary = (directives: fc.Arbitrary<Directive>): fc.Arbitrary<StrategySpec> => fc.record({
  scope: fc.constantFrom<'one-for-one' | 'all-for-one'>('one-for-one', 'all-for-one'),
  directive: directives,
  maxRetries: fc.constantFrom(-1, 1, 2, 3),
  withinTimeRangeMs: fc.constantFrom(0, 1_000),
});

/**
 * A tree of at most three levels below the root and two children per node —
 * small enough that a run takes milliseconds, deep enough that an escalation
 * crosses two supervisors and a restart tears down a grandchild.
 */
const leafArbitrary: fc.Arbitrary<TreeSpec> = fc.record({
  strategy: strategyArbitrary(directiveArbitrary),
  children: fc.constant([]),
});
const levelTwoArbitrary: fc.Arbitrary<TreeSpec> = fc.record({
  strategy: strategyArbitrary(directiveArbitrary),
  children: fc.array(leafArbitrary, { maxLength: 2 }),
});
const levelOneArbitrary: fc.Arbitrary<TreeSpec> = fc.record({
  strategy: strategyArbitrary(directiveArbitrary),
  children: fc.array(levelTwoArbitrary, { maxLength: 2 }),
});
const rootArbitrary: fc.Arbitrary<TreeSpec> = fc.record({
  strategy: strategyArbitrary(directiveArbitrary),
  children: fc.array(levelOneArbitrary, { minLength: 1, maxLength: 2 }),
});

/**
 * How the user guardian supervises the root — never `Escalate`, which would
 * fail the guardian and take the whole system down with it, a different test;
 * and never all-for-one, which would widen to the guardian's other child, the
 * death watcher the checks read from.
 */
const rootSupervisionArbitrary: fc.Arbitrary<StrategySpec> = strategyArbitrary(
  fc.constantFrom(Directive.Restart, Directive.Resume, Directive.Stop),
).map((spec) => ({ ...spec, scope: 'one-for-one' as const }));

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('fail' as const),
      node: fc.nat(),
      sites: fc.subarray([...FAILURE_SITES]),
      followUps: fc.integer({ min: 0, max: 2 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('arm' as const), node: fc.nat(), sites: fc.subarray([...FAILURE_SITES], { minLength: 1 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('work' as const), node: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.constantFrom(400, 1_001) }) },
);

/**
 * Steps per run.  Enough for a budget of three to be spent and its window to
 * pass, and for a child to spend part of its allowance, be rebuilt by its
 * parent's restart and fail again inside the window — the sequence that tells a
 * per-name allowance (#917) from a per-cell one, which at 12 steps the suite's
 * 120 runs did not reach.
 */
const MAXIMUM_STEPS = 20;

/**
 * Sites armed before the tree is built, so a node can fail its very first
 * start.  Not redundant with an `arm` step: a cell built later is built by an
 * ancestor's restart, and a restart resumes the subtree it rebuilt — so only
 * the initial build reaches `onRecreate` on a cell that never got an instance
 * without a `resume` arriving after it (#914).
 */
const initialArmsArbitrary = fc.array(
  fc.record({ node: fc.nat(), sites: fc.subarray([...FAILURE_SITES], { minLength: 1 }) }),
  { maxLength: 3 },
);

const scenarioArbitrary = fc.record({
  tree: rootArbitrary,
  rootSupervision: rootSupervisionArbitrary,
  initialArms: initialArmsArbitrary,
  steps: fc.array(stepArbitrary, { minLength: 1, maxLength: MAXIMUM_STEPS }),
});

type InitialArm = { readonly node: number; readonly sites: ReadonlyArray<FailureSite> };

type Scenario = {
  readonly tree: TreeSpec;
  readonly rootSupervision: StrategySpec;
  readonly initialArms: ReadonlyArray<InitialArm>;
  readonly steps: ReadonlyArray<Step>;
};

function flatten(harness: StressHarness, spec: TreeSpec, parent: FlatNode | null, index: number, into: FlatNode[]): FlatNode {
  const id = parent === null ? 'r' : `${parent.id}/${index}`;
  const children: FlatNode[] = [];
  const node: FlatNode = {
    id,
    name: parent === null ? 'stress-root' : `n${index}`,
    parent,
    children,
    strategySpec: spec.strategy,
    strategy: harness.strategyFor(spec.strategy, () => children),
  };
  into.push(node);
  spec.children.forEach((child, childIndex) => children.push(flatten(harness, child, node, childIndex, into)));
  return node;
}

/* ------------------------------ The property ------------------------------ */

async function runScenario(scenario: Scenario): Promise<string[]> {
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const { kit } = TestKit.withManualScheduler('supervision-stress', kitOptions);
  try {
    const harness = new StressHarness(kit.system.clock);
    const nodes: FlatNode[] = [];
    const root = flatten(harness, scenario.tree, null, 0, nodes);
    const guardian = { id: 'guardian', children: [root] };
    for (const initialArm of scenario.initialArms) {
      harness.arm(nodes[initialArm.node % nodes.length]!.id, initialArm.sites);
    }
    harness.watcher = kit.system.spawn(() => new DeathWatcher(harness), 'death-watcher');
    const rootStrategy = harness.strategyFor(scenario.rootSupervision, () => guardian.children);
    harness.spawnNode(
      root,
      guardian.id,
      scenario.rootSupervision,
      (factory) => kit.system.spawn(factory, root.name, { supervisorStrategy: rootStrategy }),
    );
    await kit.settle();

    for (const step of scenario.steps) {
      await applyStep(kit, harness, nodes, step);
      await kit.settle();
    }

    checkQuietTree(harness, nodes);
    await checkLiveCellsAnswer(kit, harness);
    checkRestartBudgets(harness);
    return harness.violations;
  } finally {
    await kit.shutdown();
  }
}

/** The newest cell spawned for `node`, live or not. */
function latestCell(harness: StressHarness, node: FlatNode): ActorRef | null {
  for (let index = harness.cells.length - 1; index >= 0; index--) {
    if (harness.cells[index]!.node === node) return harness.cells[index]!.ref;
  }
  return null;
}

async function applyStep(kit: TestKit, harness: StressHarness, nodes: ReadonlyArray<FlatNode>, step: Step): Promise<void> {
  if (step.kind === 'advance') {
    await kit.advance(step.ms);
    return;
  }
  const node = nodes[step.node % nodes.length]!;
  if (step.kind === 'arm') {
    harness.arm(node.id, step.sites);
    return;
  }
  const target = latestCell(harness, node);
  if (target === null) return;
  const nodeRef = target as ActorRef<NodeMessage>;
  if (step.kind === 'work') {
    nodeRef.tell({ kind: 'work' });
    return;
  }
  nodeRef.tell({ kind: 'fail', sites: step.sites });
  for (let followUp = 0; followUp < step.followUps; followUp++) nodeRef.tell({ kind: 'work' });
}

function checkQuietTree(harness: StressHarness, nodes: ReadonlyArray<FlatNode>): void {
  for (const { ref } of harness.cells) {
    const key = keyOf(ref);
    const cell = cellOf(ref);
    const inspection = cell._inspect();
    const seen = harness.terminatedSeen.get(key) ?? 0;
    const parentRef = cell.parent.toNullable();
    const parent = parentRef === null ? null : cellOf(parentRef);
    const listed = parent !== null && parent._findChildCell(ref.path.name) === cell;
    if (inspection.cellState === 'terminated') {
      if (seen !== 1) harness.violations.push(`${key} terminated and its watcher got ${seen} Terminated`);
      if (listed) harness.violations.push(`${key} terminated but its parent still lists it`);
      continue;
    }
    if (seen !== 0) harness.violations.push(`${key} is ${inspection.cellState} but its watcher got ${seen} Terminated`);
    if (inspection.cellState !== 'running' || inspection.suspended) {
      harness.violations.push(
        `${key} was left ${inspection.cellState}${inspection.suspended ? ', mailbox suspended' : ''} on a quiet tree`,
      );
    }
    if (!listed) harness.violations.push(`${key} is live but its parent does not list it`);
    if (parent !== null && parent._inspect().cellState === 'terminated') {
      harness.violations.push(`${key} is live under a terminated parent`);
    }
  }
  for (const key of harness.terminatedSeen.keys()) {
    if (!harness.cells.some(({ ref }) => keyOf(ref) === key)) harness.violations.push(`Terminated for unknown ${key}`);
  }

  // A node nothing decided about — not itself, not an ancestor, not an
  // all-for-one sibling of either — has no reason to be gone.
  const touched = new Set<string>();
  for (const decision of harness.decisions) for (const affected of decision.affected) touched.add(affected);
  for (const node of nodes) {
    let ancestor: FlatNode | null = node;
    let isTouched = false;
    while (ancestor !== null) {
      if (touched.has(ancestor.id)) { isTouched = true; break; }
      ancestor = ancestor.parent;
    }
    if (isTouched) continue;
    const ref = latestCell(harness, node);
    if (ref === null || cellOf(ref)._inspect().cellState === 'terminated') {
      harness.violations.push(`${node.id} is gone although no decision touched it or an ancestor`);
    }
  }
}

/** Every live cell takes one more message: nothing is parked behind a suspension nobody lifts. */
async function checkLiveCellsAnswer(kit: TestKit, harness: StressHarness): Promise<void> {
  const live = harness.cells.filter(({ ref }) => cellOf(ref)._inspect().cellState !== 'terminated');
  const before = new Map(live.map(({ ref }) => [keyOf(ref), harness.processed.get(keyOf(ref)) ?? 0]));
  for (const { ref } of live) (ref as ActorRef<NodeMessage>).tell({ kind: 'work' });
  await kit.settle();
  for (const { ref } of live) {
    const key = keyOf(ref);
    if ((harness.processed.get(key) ?? 0) !== before.get(key)! + 1) {
      harness.violations.push(`${key} is live but did not process a message sent to it on a quiet tree`);
    }
  }
}

/**
 * Restart attempts never exceed the allowance.  Within a window the allowance
 * belongs to the child's *name* on its parent cell and survives re-creation
 * (#917); without a window it is dropped when the child terminates, so it
 * bounds one child cell.  Both hold for all-for-one too, whose group tally
 * charges once per group restart and so at most once per child.
 */
function checkRestartBudgets(harness: StressHarness): void {
  for (const attempt of harness.restartAttempts) {
    const { maxRetries, withinTimeRangeMs } = attempt.strategy;
    if (maxRetries < 0) continue;
    const counted = harness.restartAttempts.filter((other) => withinTimeRangeMs > 0
      ? other.parentCell === attempt.parentCell && other.childName === attempt.childName
        && other.at <= attempt.at && other.at >= attempt.at - withinTimeRangeMs
      : other.childCell === attempt.childCell && other.at <= attempt.at);
    if (counted.length > maxRetries) {
      harness.violations.push(
        `${attempt.parentCell} restarted ${attempt.childName} ${counted.length} times against maxRetries ${maxRetries}`
        + `${withinTimeRangeMs > 0 ? ` within ${withinTimeRangeMs} ms` : ''}`,
      );
    }
  }
}

/**
 * The per-test cap for this file's walk.  The suite's 120 runs take about a
 * second here (each builds and shuts down a system); the margin is for a
 * loaded runner, not for a larger run count.
 */
const STRESS_TIMEOUT_MS = 20_000;

describe('supervision under failures inside the restart machinery (#1384)', () => {
  test('random trees, strategies and lifecycle failures keep every supervision invariant', async () => {
    // The suite's policy stops at the first failure without shrinking it.  To
    // shrink a counterexample from here, pass `{ endOnFailure: false }` as
    // `fc.assert`'s second argument locally; the seed and path it prints
    // reproduce the run either way.
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const violations = await runScenario(scenario);
        expect(violations).toEqual([]);
      }),
    );
  }, STRESS_TIMEOUT_MS);
});

/**
 * Counterexamples the walk above found, kept as plain examples so they survive
 * a change of seed.
 */
describe('supervision counterexamples (#1384)', () => {
  /**
   * Shrunk from the walk: a parent whose strategy answers `Resume` and a child
   * whose constructor throws.  #914 closed the `Restart` half of this — there
   * is no instance to restart, so the cell stops — but `Resume` lifted the
   * suspension off a cell that never got an instance.  It stayed `creating`
   * for good: its messages queued and were never read, it was never removed
   * from its parent, and its watchers never heard of it.
   */
  test('resuming a child whose constructor threw stops it rather than leaving it creating', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const { kit } = TestKit.withManualScheduler('supervision-resume-unconstructed', kitOptions);
    try {
      const terminated: string[] = [];
      class Unconstructible extends Actor<string> {
        constructor() {
          super();
          throw new Error('constructor failed');
        }
        override onReceive(): void {}
      }
      type ParentMessage = { readonly kind: 'spawn' } | Terminated;
      class ResumingParent extends Actor<ParentMessage> {
        override supervisorStrategy(): SupervisorStrategy {
          return new OneForOneStrategy(() => Directive.Resume);
        }
        override onReceive(message: ParentMessage): void {
          if (message instanceof Terminated) {
            terminated.push(message.actor.path.name);
            return;
          }
          this.context.watch(this.context.spawn(Unconstructible, 'unconstructible'));
        }
      }
      const parent = kit.system.spawn(ResumingParent, 'resuming-parent');
      parent.tell({ kind: 'spawn' });
      await kit.settle();

      const parentCell = cellOf(parent);
      expect(terminated).toEqual(['unconstructible']);
      expect(parentCell._findChildCell('unconstructible')).toBeNull();
    } finally {
      await kit.shutdown();
    }
  });
});
