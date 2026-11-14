/**
 * #1245 — `resolver()` is consulted for events the vector clocks call
 * concurrent.
 *
 * The hook was declared, documented on four pages and never called: the fold
 * ran every event through `onEvent` in `(timestamp, replica, seqAtReplica)`
 * order, so a `CustomMergeResolver` override changed nothing.  What is pinned
 * here:
 *
 *   - **A resolver changes the folded state.**  The events *set* a value, so
 *     the plain fold keeps whichever sorts last and a summing merge is
 *     visibly different from it.
 *   - **Only concurrent events reach it.**  An event that happens after
 *     another is folded after it, resolver or not.
 *   - **The result does not depend on arrival order.**  Two instances fed the
 *     same events in opposite orders fold the same state — the convergence
 *     the resolver contract exists for.
 *   - **The default reproduces the fold the class always had** — every event,
 *     concurrent or not, through `onEvent` in canonical order.
 *
 * Events are delivered by hand as `PubSubEnvelope`s from peer addresses — the
 * shape the mediator hands an origin subscriber — so each test chooses the
 * vector clocks exactly.  One node over `InMemoryTransport`; no port is bound.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { PubSubEnvelope } from '../../../../../src/cluster/pubsub/Messages.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { gracefulStop } from '../../../../../src/pattern/GracefulStop.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  CustomMergeResolver,
  type ConflictCandidate,
  type ConflictResolver,
} from '../../../../../src/persistence/replicated/ConflictResolver.js';
import type { VectorClockData } from '../../../../../src/persistence/replicated/VectorClock.js';
import {
  ReplicatedEventSourcedActor,
  type ReplicatedEventEnvelope,
} from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type SetCommand = { readonly kind: 'set'; readonly value: number };
type Command = SetCommand;

type SetEvent = { readonly kind: 'set'; readonly value: number };
type Event = SetEvent;

type State = { readonly value: number; readonly applied: number };

const WAIT = { timeoutMs: 3_000, intervalMs: 5 } as const;

const PEER_P = 'resolver-peer-p@h:1';
const PEER_Q = 'resolver-peer-q@h:2';
const PEER_S = 'resolver-peer-s@h:3';

/** Which resolver an instance runs with — `undefined` keeps the default. */
type ResolverChoice = (() => ConflictResolver<Event> | null) | undefined;

/** A register: each event replaces the value, so a merge is visible in the result. */
class Register extends ReplicatedEventSourcedActor<Command, Event, State> {
  static readonly instances = new Map<string, Register>();

  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly choice: ResolverChoice) {
    super();
    this.persistenceId = persistenceId;
    Register.instances.set(persistenceId, this);
  }

  get current(): State { return this.state; }

  snapshotNow(): Promise<void> { return this.saveSnapshot(); }

  protected override resolver(): ConflictResolver<Event> | null {
    return this.choice === undefined ? super.resolver() : this.choice();
  }

  initialState(): State { return { value: 0, applied: 0 }; }

  onEvent(state: State, event: Event): State { return { value: event.value, applied: state.applied + 1 }; }

  async onCommand(_state: State, command: Command): Promise<void> {
    await this.persist({ kind: 'set', value: command.value });
  }
}

/** Two concurrent sets merge to their sum — unlike any order of applying them. */
const summing = (): ConflictResolver<Event> =>
  new CustomMergeResolver<Event>((a, b) => ({ kind: 'set', value: a.value + b.value }));

let system: ActorSystem;
let cluster: Cluster;

beforeAll(async () => {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  system = ActorSystem.create('resolver-wiring', options);
  system.extension(PersistenceExtensionId).configure({
    journal: new InMemoryJournal(), snapshotStore: new InMemorySnapshotStore(),
  });
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(84_201)
    .withTransport(new InMemoryTransport(new NodeAddress('resolver-wiring', 'h', 84_201)));
  cluster = await Cluster.join(system, clusterOptions);
});

afterAll(async () => {
  await cluster.leave();
  await system.terminate();
});

function envelope(
  persistenceId: string,
  replica: string,
  seqAtReplica: number,
  timestamp: number,
  vc: VectorClockData,
  value: number,
): ReplicatedEventEnvelope<Event> {
  return {
    persistenceId,
    replica,
    seqAtReplica,
    eventId: `${replica}#${String(seqAtReplica).padStart(24, '0')}`,
    vc,
    timestamp,
    event: { kind: 'set', value },
  };
}

const references = new Map<string, ActorRef<Command | ReplicatedEventEnvelope<Event>>>();

async function spawnRegister(persistenceId: string, choice: ResolverChoice, name = persistenceId): Promise<Register> {
  references.set(persistenceId, system.spawn(() => new Register(persistenceId, choice), name));
  await awaitCondition(() => Register.instances.has(persistenceId), { ...WAIT, label: `${persistenceId} constructed` });
  return Register.instances.get(persistenceId)!;
}

/** Deliver each envelope as the mediator would, then wait until all are folded. */
async function deliver(persistenceId: string, envelopes: ReadonlyArray<ReplicatedEventEnvelope<Event>>): Promise<State> {
  const register = Register.instances.get(persistenceId)!;
  const ref = references.get(persistenceId)!;
  for (const sent of envelopes) {
    const delivery = new PubSubEnvelope(`replicated-es:${persistenceId}`, sent, NodeAddress.parse(sent.replica));
    ref.tell(delivery as unknown as Command);
  }
  await awaitCondition(() => seenAll(register, envelopes), {
    ...WAIT, label: `${persistenceId}: every envelope absorbed`,
  });
  return register.current;
}

/** All delivered envelopes absorbed — read off the actor's history length. */
function seenAll(register: Register, envelopes: ReadonlyArray<ReplicatedEventEnvelope<Event>>): boolean {
  return (register as unknown as { _events: unknown[] })._events.length === envelopes.length;
}

describe('ReplicatedEventSourcedActor — resolver() reconciles concurrent events (#1245)', () => {
  test('a CustomMergeResolver merges two concurrent events into one folded event', async () => {
    const id = 'resolver-merge';
    await spawnRegister(id, summing);
    const state = await deliver(id, [
      envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 10),
      envelope(id, PEER_Q, 1, 2_000, { [PEER_Q]: 1 }, 5),
    ]);
    // The plain fold would end on the later set, 5, after two applications.
    expect(state).toEqual({ value: 15, applied: 1 });
  });

  test('the default — no resolver — folds every event in canonical order, as before #1245', async () => {
    const id = 'resolver-default';
    await spawnRegister(id, undefined);
    const state = await deliver(id, [
      envelope(id, PEER_Q, 1, 2_000, { [PEER_Q]: 1 }, 5),
      envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 10),
    ]);
    // Out of arrival order: the later timestamp is applied last.
    expect(state).toEqual({ value: 5, applied: 2 });
  });

  test('an event that happens after another never reaches the resolver', async () => {
    const id = 'resolver-causal';
    const calls: Array<[number, number]> = [];
    const recording = (): ConflictResolver<Event> => ({
      resolve(a: ConflictCandidate<Event>, b: ConflictCandidate<Event>): Event {
        calls.push([a.event.value, b.event.value]);
        return { kind: 'set', value: a.event.value + b.event.value };
      },
    });
    await spawnRegister(id, recording);
    const state = await deliver(id, [
      envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 10),
      // Q had seen P's event: causally after it, though stamped earlier.
      envelope(id, PEER_Q, 1, 500, { [PEER_P]: 1, [PEER_Q]: 1 }, 5),
    ]);
    expect(calls).toEqual([]);
    expect(state).toEqual({ value: 10, applied: 2 });
  });

  test('three mutually concurrent events reduce pairwise to one folded event', async () => {
    const id = 'resolver-three';
    await spawnRegister(id, summing);
    const state = await deliver(id, [
      envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 1),
      envelope(id, PEER_Q, 1, 2_000, { [PEER_Q]: 1 }, 20),
      envelope(id, PEER_S, 1, 3_000, { [PEER_S]: 1 }, 300),
    ]);
    expect(state).toEqual({ value: 321, applied: 1 });
  });

  test('opposite arrival orders fold the same state', async () => {
    const forward = 'resolver-order-forward';
    const backward = 'resolver-order-backward';
    await spawnRegister(forward, summing);
    await spawnRegister(backward, summing);
    const events = (id: string): ReplicatedEventEnvelope<Event>[] => [
      envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 1),
      envelope(id, PEER_P, 2, 1_100, { [PEER_P]: 2 }, 2),
      envelope(id, PEER_Q, 1, 1_050, { [PEER_Q]: 1 }, 40),
      envelope(id, PEER_Q, 2, 1_200, { [PEER_P]: 2, [PEER_Q]: 2 }, 80),
    ];
    const forwardState = await deliver(forward, events(forward));
    const backwardState = await deliver(backward, events(backward).reverse());
    expect(backwardState).toEqual(forwardState);
    // Canonical order P1 Q1 P2 Q2: {P1, Q1} concurrent → 41; P2 follows P1 but
    // not Q1, so it opens the next group alone → 2; Q2 saw P2 → 80.
    expect(forwardState).toEqual({ value: 80, applied: 3 });
  });

  test('after a recovery from a snapshot, a concurrent arrival still joins the group the snapshot ended on', async () => {
    const id = 'resolver-snapshot';
    const first = await spawnRegister(id, summing);
    await deliver(id, [envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 10)]);
    await first.snapshotNow();
    expect(await gracefulStop(references.get(id)!, 2_000)).toBe(true);
    Register.instances.delete(id);

    // The snapshot holds the state, not the groups: the restarted instance
    // must not treat the history as closed and apply Q's event on its own.
    const restarted = await spawnRegister(id, summing, `${id}-restarted`);
    await awaitCondition(() => restarted.current.value === 10, { ...WAIT, label: 'recovered from the snapshot' });
    const state = await deliver(id, [
      envelope(id, PEER_P, 1, 1_000, { [PEER_P]: 1 }, 10),
      envelope(id, PEER_Q, 1, 2_000, { [PEER_Q]: 1 }, 5),
    ]);
    expect(state).toEqual({ value: 15, applied: 1 });
  });
});
