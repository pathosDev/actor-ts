/**
 * Regression for #632 — `rememberEntities` forgot everything on a rebalance.
 *
 * `ShardRegion.onHandOff` announced an `EntityStopped` to the coordinator for
 * *every* entity of the departing shard.  The coordinator applied those as
 * `{kind:'stopped'}` and persisted them, which deleted the shard's whole entry
 * from `entitiesPerShard` — and `onHandOffComplete` → `tryAllocate` →
 * `shipRememberedEntities` then found an empty set and shipped nothing.  The
 * new owner started with zero remembered entities: exactly the property
 * `rememberEntities` exists to provide, lost by the ordinary rebalance path.
 *
 * The existing suite only covered a cold restart
 * (`sharding-remember-entities.test.ts`), which reloads the registry from the
 * journal and so never exercised a live handoff.
 *
 * A stopping entity and a moving entity look identical on the wire, so the fix
 * is on both sides: the departing region no longer announces the move as a
 * stop, and the coordinator ignores an `EntityStopped` for a shard that is
 * mid-rebalance — which also covers an entity that passivates on its own
 * inside the handoff window.
 *
 * The rebalance is driven by a strategy that asks for the move on demand
 * rather than by waiting for a load imbalance, so the test asserts the
 * handoff's effect instead of racing the rebalancer's heuristics.
 */
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { JournalRememberEntitiesStore } from '../../src/cluster/sharding/RememberEntitiesStore.js';
import { InMemoryJournal } from '../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId } from '../../src/persistence/PersistenceExtension.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import type { AllocationStrategy } from '../../src/cluster/sharding/AllocationStrategy.js';
import type { ActorRef } from '../../src/ActorRef.js';

type PingCommand = { id: string; kind: 'ping' };
type Command = PingCommand;

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

/** Which node each entity's `preStart` ran on, keyed by entity id. */
const startedOn = new Map<string, string[]>();

class Entity extends Actor<Command> {
  override preStart(): void {
    // `this.entityId`, not a slice off the path: the child name escapes the
    // id (#568), so the path is a label rather than a second spelling of it.
    const id = this.entityId;
    const seen = startedOn.get(id) ?? [];
    seen.push(this.context.system.name);
    startedOn.set(id, seen);
  }

  override onReceive(m: Command): void {
    match(m)
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onPing(): void {
    this.sender.forEach((s) => s.tell('pong'));
  }
}

/**
 * Places every shard on the first candidate in address order, then moves shard
 * 0 exactly once when `demandMove` is flipped.  Deterministic where the
 * built-in strategies are load-driven: the point of the test is what a handoff
 * does to the registry, not when the rebalancer decides to start one.
 */
class OnDemandMoveStrategy implements AllocationStrategy {
  demandMove = false;
  private moved = false;
  /** The region that has already hosted the shard, so a move really moves. */
  private previousOwner: string | null = null;

  allocate(_shardId: number, candidates: ReadonlyArray<NodeAddress>): NodeAddress {
    const sorted = [...candidates].sort((a, b) => a.toString().localeCompare(b.toString()));
    const next = this.previousOwner === null
      ? sorted[0]!
      : sorted.find(c => c.toString() !== this.previousOwner) ?? sorted[0]!;
    this.previousOwner = next.toString();
    return next;
  }

  rebalance(
    _currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    _candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number> {
    if (!this.demandMove || this.moved || rebalanceInProgress.has(0)) return new Set();
    this.moved = true;
    return new Set([0]);
  }
}

describe('Sharding remember-entities — rebalance handoff (#632)', () => {
  test('every remembered entity returns on the new owner after a handoff', async () => {
    startedOn.clear();
    const journal = new InMemoryJournal();
    const strategy = new OnDemandMoveStrategy();

    const spec = new MultiNodeSpec({
      roles: ['a', 'b'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    await spec.start();
    await Promise.all(['a', 'b'].map((r) => spec.awaitMembers(r, 2)));

    for (const role of ['a', 'b'] as const) {
      spec.systemFor(role).extension(PersistenceExtensionId).setJournal(journal);
    }

    // Kept, not inlined: the registry it writes is the precondition for the
    // handoff below, and reading it back is how the test waits for it.
    const rememberStore = new JournalRememberEntitiesStore(journal);
    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('entity')
      .withEntityActor(Entity)
      .withExtractEntityId((m) => m.id)
      .withNumShards(1)                       // one shard, so one handoff moves everything
      .withRememberEntities(true)
      .withRememberEntitiesStore(rememberStore)
      .withAllocationStrategy(strategy)
      .withRebalanceIntervalMs(150);

    const regions: Record<'a' | 'b', ActorRef<Command>> = {
      a: spec.clusterFor('a').sharding.start<Command>(shardingOptions),
      b: spec.clusterFor('b').sharding.start<Command>(shardingOptions),
    };

    const ids = ['e-1', 'e-2', 'e-3', 'e-4', 'e-5'];
    for (const id of ids) {
      expect(await regions.a.ask<string>({ id, kind: 'ping' }, 3_000)).toBe('pong');
    }
    // Wait for the coordinator's EntityStarted journal chain, which is
    // fire-and-forget, to have all five entities on record — that registry is
    // what the handoff is supposed to carry over, so a handoff forced before
    // it is complete would test nothing.  Reading it back is exact; the 250 ms
    // it replaces was a guess at five chained journal appends.
    await awaitCondition(
      async () => {
        const started = new Set(
          (await rememberStore.load('entity'))
            .filter(event => event.kind === 'started')
            .map(event => event.entityId),
        );
        return ids.every(id => started.has(id));
      },
      { timeoutMs: 10_000, intervalMs: 25, label: 'all five entities are in the remembered registry' },
    );

    const firstHosts = new Map(ids.map(id => [id, startedOn.get(id)!.length]));
    expect([...firstHosts.values()]).toEqual([1, 1, 1, 1, 1]);

    // ---- force the handoff ----
    strategy.demandMove = true;

    // Every entity must come back on the new owner *without* a user message:
    // that is what the remembered registry is for.  Pre-fix the registry was
    // emptied by the handoff, so this count stayed at 5 forever.
    const respawned = (): number =>
      ids.filter(id => (startedOn.get(id)?.length ?? 0) >= 2).length;
    await awaitCondition(
      () => respawned() === ids.length,
      { timeoutMs: 8_000, intervalMs: 25, label: 'all five entities respawned on the new owner' },
    );
    expect(respawned()).toBe(ids.length);

    // …and on the *other* node, not re-created where they already were.
    for (const id of ids) {
      const hosts = startedOn.get(id)!;
      expect(hosts.length).toBeGreaterThanOrEqual(2);
      expect(hosts[1]).not.toBe(hosts[0]);
    }

    await spec.stop();
    MultiNodeTransport._resetRegistryForTest();
  }, 30_000);
});
