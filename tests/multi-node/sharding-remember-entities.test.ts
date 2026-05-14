/**
 * End-to-end test for persistent remember-entities (#49).
 *
 * Validates that the registry of entities-per-shard survives a full
 * cluster cold-restart.  Without persistence, `rememberEntities: true`
 * silently degraded after restart: the new coordinator started
 * empty, and entities only existed in memory after the first
 * user-issued message arrived for each one.  With #49, the new
 * coordinator loads the previous-life registry from the journal so
 * the very first shard allocation after restart pre-spawns every
 * known entity for that shard.
 *
 * Test shape:
 *
 *   Round 1:
 *     - 3-node cluster with `rememberEntities: true` and a SHARED
 *       InMemoryJournal injected into every role's
 *       PersistenceExtension.
 *     - Use `numShards: 1` so every entity lands on the same shard
 *       — that lets us trigger the entire registry's respawn with
 *       a single user message in round 2.
 *     - Spawn 5 entities by sending one message each.  Track every
 *       entity's `preStart` in a module-level Set.
 *     - Stop the cluster.
 *
 *   Round 2 (cold restart):
 *     - Fresh `MultiNodeSpec`, fresh ActorSystems, but the SAME
 *       journal injected.
 *     - Send a single message to ONE of the 5 entities.  That
 *       triggers the lone shard's allocation → coordinator ships
 *       `RememberedEntities` (loaded from journal) → region
 *       pre-creates all five entities → all five `preStart`s fire.
 *     - Assert: every entity's preStart fired in round 2 even
 *       though only one user message was sent.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ClusterSharding } from '../../src/cluster/sharding/ClusterSharding.js';
import { JournalRememberEntitiesStore } from '../../src/cluster/sharding/RememberEntitiesStore.js';
import { InMemoryJournal } from '../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId } from '../../src/persistence/PersistenceExtension.js';
import { Props } from '../../src/Props.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import type { ActorRef } from '../../src/ActorRef.js';

type Cmd = { id: string; op: 'ping' };

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

/** Module-level — survives across the two MultiNodeSpec lifetimes. */
const preStartedRound1 = new Set<string>();
const preStartedRound2 = new Set<string>();
let currentRound: 1 | 2 = 1;

class Entity extends Actor<Cmd> {
  override preStart(): void {
    const id = this.context.path.name.replace(/^entity-/, '');
    if (currentRound === 1) preStartedRound1.add(id);
    else preStartedRound2.add(id);
  }
  override onReceive(m: Cmd): void {
    if (m.op === 'ping') this.sender.forEach((s) => s.tell('pong'));
  }
}

async function withSharedJournal<T>(
  body: (journal: InMemoryJournal) => Promise<T>,
): Promise<T> {
  const journal = new InMemoryJournal();
  return body(journal);
}

async function startSpec(
  journal: InMemoryJournal,
): Promise<{ spec: MultiNodeSpec; regions: Record<'a' | 'b' | 'c', ActorRef<Cmd>> }> {
  const spec = new MultiNodeSpec({
    roles: ['a', 'b', 'c'],
    failureDetector: TIGHT_FD,
    gossipIntervalMs: 80,
  });
  await spec.start();
  await Promise.all(['a', 'b', 'c'].map((r) => spec.awaitMembers(r, 3)));

  // Inject the shared journal into every role's PersistenceExtension
  // BEFORE we touch ClusterSharding (which reads
  // `extension(PersistenceExtensionId).journal` at coordinator-
  // construction time).  Same journal across all roles + across
  // both lifecycles → cluster shutdowns don't lose the registry.
  for (const role of ['a', 'b', 'c'] as const) {
    spec.systemFor(role).extension(PersistenceExtensionId).setJournal(journal);
  }

  const start = (role: 'a' | 'b' | 'c'): ActorRef<Cmd> =>
    spec.clusterFor(role).sharding.start<Cmd>({
      typeName: 'entity',
      entityProps: Props.create(() => new Entity()),
      extractEntityId: (m) => m.id,
      numShards: 1,                         // all entities on one shard
      rememberEntities: true,
      // Pass an explicit store using the shared journal; this also
      // sidesteps any ordering between extension setup and
      // resolveRememberEntitiesStore.
      rememberEntitiesStore: new JournalRememberEntitiesStore(journal),
      rebalanceIntervalMs: 200,
    });

  const regions = { a: start('a'), b: start('b'), c: start('c') };
  return { spec, regions };
}

describe('Sharding remember-entities — persistent registry', () => {
  test('cluster cold-restart respawns every previously-known entity for a shard', async () => {
    preStartedRound1.clear();
    preStartedRound2.clear();
    currentRound = 1;

    await withSharedJournal(async (journal) => {
      // ---------------- Round 1 ----------------
      const { spec, regions } = await startSpec(journal);
      const ids = ['e-1', 'e-2', 'e-3', 'e-4', 'e-5'];

      // Each ask spawns an entity (it didn't exist before) and
      // triggers an EntityStarted notification to the coordinator,
      // which appends to the registry journal.
      for (const id of ids) {
        const reply = await regions.a.ask<string>({ id, op: 'ping' }, 3_000);
        expect(reply).toBe('pong');
      }
      // Allow EntityStarted journal writes to settle (fire-and-forget
      // chain inside the coordinator).
      await Bun.sleep(200);
      expect(preStartedRound1.size).toBe(5);

      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();

      // ---------------- Round 2: cold restart ----------------
      currentRound = 2;
      const { spec: spec2, regions: regions2 } = await startSpec(journal);

      // Send ONE message to one entity → triggers the single shard's
      // allocation → coordinator ships RememberedEntities (loaded
      // from journal) → region pre-creates ALL five.
      const reply = await regions2.a.ask<string>({ id: 'e-1', op: 'ping' }, 3_000);
      expect(reply).toBe('pong');

      // Allow the region to drain RememberedEntities + spawn the rest.
      const deadline = Date.now() + 3_000;
      while (preStartedRound2.size < 5 && Date.now() < deadline) {
        await Bun.sleep(50);
      }

      expect(preStartedRound2.size).toBe(5);
      expect(new Set(preStartedRound2)).toEqual(new Set(ids));

      await spec2.stop();
      MultiNodeTransport._resetRegistryForTest();
    });
  }, 30_000);
});
