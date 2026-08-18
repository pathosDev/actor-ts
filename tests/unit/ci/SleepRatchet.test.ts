import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * A ratchet over the *test* tree (#418): the fixed-delay waits this suite
 * still contains may shrink, never grow.
 *
 * `await sleep(N)` before an assertion is this suite's dominant flake shape —
 * `N` encodes the latency of one machine on one day, and under parallel load
 * the assertion reads a value that was never written.  `awaitCondition`
 * (`tests/util/AwaitCondition.ts`) is the replacement, and its adoption is
 * real: 691 call sites across 106 files.  What is *not* real is the
 * conversion, because the raw count has been going the wrong way while the
 * conversion was being planned:
 *
 *   2026-07-22  d2e2a1a5  552   (#418 filed)
 *   2026-08-11  5abad027  448   <- the low-water mark
 *   2026-08-15  d1123d40  460
 *   2026-08-16  a5423ef7  466
 *   2026-08-18  95db877c  479   (`git grep -o "await sleep(" <rev> -- 'tests/*.ts'`)
 *
 * Nothing reversed it; unrelated work simply kept writing new tests in the
 * old shape.  Two files that did not exist before 2026-08-16 arrived with
 * their own `Bun.sleep` shim that same day —
 * `tests/integration/in-process/persistence/query/RelationalQuery.test.ts`
 * (in `c612557c`) and `tests/unit/metrics/MailboxWaitHistogram.test.ts` (in
 * `2cfe6eb2`) — from two changes that had nothing to do with waiting.  So a
 * sweep with nothing holding the line behind it buys a snapshot, not a
 * property.  This file is the line.
 *
 * **It is deliberately not a ban on waiting.**  57 of the waits here are
 * followed by an assertion of an *absence* — "no second connect attempt
 * happened", "the actor handled no more messages after `die`" — and an absence
 * cannot be polled for: a predicate over a counter that is already 1 returns
 * on the first poll and the test then asserts nothing.  Those are correct code
 * (48 of them through a bare `sleep(`, the rest inline), and a gate
 * that forbade them would be deleted within a week, taking the rest of this
 * file with it.  What the gate forbids instead is narrower and has a
 * zero-cost remedy in every case:
 *
 *  1. An **unexplained** wait.  The convention already says the reason goes
 *     in a comment — *"A sleep with a reason is documentation; a sleep
 *     without one is a bet"*
 *     (`docs/src/content/docs/testing/overview.mdx`).  A new wait lands by
 *     stating why, which is a line of prose, not a redesign.
 *  2. A **re-declared** `sleep`, when `tests/util/AwaitCondition.ts` already
 *     exports one.  85 files re-declare `const sleep = (ms: number) =>
 *     Bun.sleep(ms)` against 8 that import the shared one; the remedy is the
 *     import.
 *  3. A **re-invented** polling helper.  35 modules hand-roll a
 *     `waitFor` / `waitUntil` / `awaitConvergence` with its own timeout, its
 *     own poll step and no label; the remedy is `awaitCondition`, or a
 *     two-line wrapper over it (two files already do exactly that).
 *
 * Each of the three ledgers below is a **ceiling that only ever moves down**.
 * A change that would need one raised is a change that should have carried a
 * reason comment or an import instead — so the messages here never print a
 * paste-ready replacement for the growth direction, only for the shrink
 * direction, where updating the ledger is the last step of real work.
 *
 * **One re-measurement is legitimate**, and only one: merging this guard
 * forward onto a `develop` that moved while the branch was open.  A ratchet
 * measured at one revision cannot know the waits that landed after it, and
 * those are baseline debt rather than a regression the author could have
 * avoided — they predate the rule.  `ACTOR_TS_SLEEP_RATCHET_REMEASURE=1`
 * prints all three ledgers for exactly that step (see the bottom of this
 * file); after the merge, they shrink and nothing else.
 *
 * Expressed as a test rather than a lint rule on purpose: the Biome rule
 * banning raw timers in `tests/` belongs to **#417** by #417's own scope, and
 * this repository has no `biome.json` yet.  `bun test` already runs this, so
 * it needs no new tooling and no workflow change — the same shape as
 * `tests/unit/ci/AwaitConditionBudgets.test.ts`,
 * `tests/unit/ci/WorkflowHygiene.test.ts` and
 * `tests/unit/config/NoDeadConfigKeys.test.ts`.
 *
 * Refs #418, #290, #417.
 */

const TESTS_DIRECTORY = join(import.meta.dir, '..', '..');
const REPOSITORY_ROOT = join(TESTS_DIRECTORY, '..');

/**
 * The one module allowed to declare a `sleep` and to wait on a raw timer —
 * it *is* the shared helper, so its own declaration and the poll inside
 * `awaitCondition` are the implementation, not debt.
 */
const CANONICAL_WAIT_HELPER = 'tests/util/AwaitCondition.ts';

/** Where the three ledgers below were measured, for the failure messages. */
/**
 * The ledgers were measured at `LEDGER_REVISION`.  They have been reconciled
 * once since, and only in the two directions this guard permits:
 *
 * - **Recorded**, because it predates the rule from this branch's side: the
 *   `EmailBridgeActor` work merged into `develop` (12539abd) while wave 3's
 *   phase-1 branches were open, bringing 40 fixed-delay waits and one `sleep`
 *   shim with it.  Nobody on those branches could have avoided them.
 * - **Credited**, because it was paid off: `ReliableDelivery.test.ts` drops out
 *   of the unexplained ledger entirely.  Wave 3 converted one wait to a poll
 *   and gave the rest the reason they were missing.
 *
 * Nothing the wave's own agents introduced was recorded here.  Two of them did
 * add unexplained waits — this guard caught both on the very phase it landed
 * in — and both were converted or explained at the call site instead.
 */
const LEDGER_REVISION = '95db877c';
const LEDGER_MEASURED_ON = '2026-08-18';

/**
 * Every module that declares its own `sleep`, measured at
 * {@link LEDGER_REVISION}: 84 × `Bun.sleep(ms)` plus 8 × a `setTimeout`
 * promise, and `tests/integration/scenarios/Types.ts`, which re-exports one
 * for the Docker-only scenario tree.
 *
 * A file is on this list because it already had the duplicate, not because
 * the duplicate is acceptable — the remedy is
 * `import { sleep } from '<relative>/util/AwaitCondition.js'`, which is why a
 * *new* file can never need an entry here.
 *
 * One entry was removed when this guard landed:
 * `tests/unit/ActorSelection.test.ts` declared the shim and called it zero
 * times.  It survived because no tsconfig in the repository sets
 * `noUnusedLocals`, so nothing flagged it.
 */
const LEGACY_SLEEP_DECLARATIONS: readonly string[] = [
  'tests/Actor.test.ts',
  'tests/Cluster.test.ts',
  'tests/ShardingAdvanced.test.ts',
  'tests/integration/in-process/cluster/MessageChannelTransport.test.ts',
  'tests/integration/in-process/cluster/RefAcrossNodes.test.ts',
  'tests/integration/in-process/cluster/WorkerMesh.test.ts',
  'tests/integration/in-process/cluster/downing/DowningWiring.test.ts',
  'tests/integration/in-process/cluster/pubsub/DistributedPubSub.test.ts',
  'tests/integration/in-process/cluster/pubsub/DistributedPubSubAnycast.test.ts',
  'tests/integration/in-process/cluster/router/ClusterRouter.test.ts',
  'tests/integration/in-process/cluster/sharding/ClusterSharding.test.ts',
  'tests/integration/in-process/cluster/sharding/RemoteShardRef.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardCountMismatch.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardCountPropagation.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardHandOffBuffer.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardIntrospection.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardPassivation.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardRememberEntitiesRecovery.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardedDaemonProcess.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardingHoconConfig.test.ts',
  'tests/integration/in-process/cluster/sharding/ShardingLease.test.ts',
  'tests/integration/in-process/cluster/singleton/ClusterSingleton.test.ts',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonHostChange.test.ts',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonLease.test.ts',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonRestart.test.ts',
  'tests/integration/in-process/http/websocket/WebsocketBackendSuite.ts',
  'tests/integration/in-process/http/websocket/WebsocketClientActor.test.ts',
  'tests/integration/in-process/io/broker/BrokerActor.test.ts',
  'tests/integration/in-process/io/broker/EmailBridgeActor.test.ts',
  'tests/integration/in-process/io/broker/JetStreamActor.test.ts',
  'tests/integration/in-process/io/broker/KafkaActor.test.ts',
  'tests/integration/in-process/io/broker/MqttActor.test.ts',
  'tests/integration/in-process/io/broker/MqttOptions.test.ts',
  'tests/integration/in-process/io/broker/NatsActor.test.ts',
  'tests/integration/in-process/io/broker/Phase2.smoke.test.ts',
  'tests/integration/in-process/io/broker/TcpSocketActor.test.ts',
  'tests/integration/in-process/io/broker/UdpSocketActor.test.ts',
  'tests/integration/in-process/persistence/BidirectionalMapRecovery.test.ts',
  'tests/integration/in-process/persistence/BidirectionalMultiMapRecovery.test.ts',
  'tests/integration/in-process/persistence/CachedSnapshotStore.test.ts',
  'tests/integration/in-process/persistence/CassandraTagIndex.test.ts',
  'tests/integration/in-process/persistence/CborRichTypeRecovery.test.ts',
  'tests/integration/in-process/persistence/Compaction.test.ts',
  'tests/integration/in-process/persistence/DurableState.test.ts',
  'tests/integration/in-process/persistence/PersistentActor.test.ts',
  'tests/integration/in-process/persistence/PersistentActorFencing.test.ts',
  'tests/integration/in-process/persistence/RichTypePayloadRecovery.test.ts',
  'tests/integration/in-process/persistence/projection/ProjectionActor.test.ts',
  'tests/integration/in-process/persistence/query/PersistenceQuery.test.ts',
  'tests/integration/in-process/persistence/query/PushBasedQuery.test.ts',
  'tests/integration/in-process/persistence/query/RelationalQuery.test.ts',
  'tests/integration/in-process/persistence/replicated/Snapshotting.test.ts',
  'tests/integration/scenarios/Types.ts',
  'tests/multi-node/LogContextCrossNode.test.ts',
  'tests/unit/Actor.test.ts',
  'tests/unit/Ask.test.ts',
  'tests/unit/CoordinatedShutdown.test.ts',
  'tests/unit/DeadLetter.test.ts',
  'tests/unit/DeathWatch.test.ts',
  'tests/unit/Dispatcher.test.ts',
  'tests/unit/InMemoryTransport.test.ts',
  'tests/unit/MdcPropagation.test.ts',
  'tests/unit/ReceiveTimeout.test.ts',
  'tests/unit/RestartRegressions.test.ts',
  'tests/unit/Router.test.ts',
  'tests/unit/Scheduler.test.ts',
  'tests/unit/Timers.test.ts',
  'tests/unit/cache/InMemoryCache.test.ts',
  'tests/unit/cache/_Contract.ts',
  'tests/unit/cluster/sharding/ShardingAuthority.test.ts',
  'tests/unit/coordination/InMemoryLease.test.ts',
  'tests/unit/coordination/KubernetesLease.test.ts',
  'tests/unit/crdt/DistributedDataAuthority.test.ts',
  'tests/unit/crdt/DistributedDataDecodeIsolation.test.ts',
  'tests/unit/crdt/DistributedDataProtoKey.test.ts',
  'tests/unit/crdt/DurableDistributedData.test.ts',
  'tests/unit/crdt/ORSetTagForgery.test.ts',
  'tests/unit/delivery/ReliableDelivery.test.ts',
  'tests/unit/discovery/DnsSeedProvider.test.ts',
  'tests/unit/fsm/PersistentFSM.test.ts',
  'tests/unit/http/BodyStreamingCap.test.ts',
  'tests/unit/http/cache/RateLimit.test.ts',
  'tests/unit/http/cache/ResponseCache.test.ts',
  'tests/unit/http/websocket/WebsocketClientOversizeLogging.test.ts',
  'tests/unit/http/websocket/WebsocketServerActor.test.ts',
  'tests/unit/internal/ActorThrottle.test.ts',
  'tests/unit/mailbox/MailboxVariants.test.ts',
  'tests/unit/metrics/MailboxWaitHistogram.test.ts',
  'tests/unit/metrics/StockMetrics.test.ts',
  'tests/unit/pattern/BackoffSupervisor.test.ts',
  'tests/unit/pattern/CircuitBreaker.test.ts',
  'tests/unit/pattern/FuturesPatterns.test.ts',
  'tests/unit/tracing/ActorTracing.test.ts',
  'tests/unit/typed/Behaviors.test.ts',
];

/**
 * Every hand-rolled polling helper, as `<file>#<name>`, measured at
 * {@link LEDGER_REVISION}: 32 × `waitFor`, 2 × `waitUntil`, 1 ×
 * `awaitConvergence`.
 *
 * Each is a strictly worse `awaitCondition` — its own default timeout (2 s /
 * 3 s / 4 s / 5 s / 10 s), its own poll step (10 / 20 / 25 / 100 ms), no
 * label, and a silent fall-through when the deadline passes.  Thirteen of
 * them default to exactly 5 000 ms, which is bun's per-test cap, so their
 * timeout can never report before the runner kills the test.
 *
 * Two modules already took the cheap way out and are therefore *not* here:
 * `tests/unit/discovery/Receptionist.test.ts` and
 * `tests/unit/EntityContext.test.ts` keep the name and delegate the body to
 * `awaitCondition`, which converts every call site without touching a single
 * assertion.
 */
const LEGACY_POLLING_HELPERS: readonly string[] = [
  'tests/Cluster.test.ts#waitFor',
  'tests/ShardingAdvanced.test.ts#waitFor',
  'tests/integration/brokers/lib/Scenario.ts#waitFor',
  'tests/integration/in-process/cluster/RefAcrossNodes.test.ts#waitFor',
  'tests/integration/in-process/cluster/WorkerMesh.test.ts#waitFor',
  'tests/integration/in-process/cluster/downing/DowningWiring.test.ts#waitFor',
  'tests/integration/in-process/cluster/pubsub/DistributedPubSub.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ClusterSharding.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/RemoteShardRef.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardCountPropagation.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardHandOffBuffer.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardIntrospection.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardKey.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardPassivation.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardRememberEntitiesRecovery.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardedDaemonProcess.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardingHoconConfig.test.ts#waitFor',
  'tests/integration/in-process/cluster/sharding/ShardingLease.test.ts#waitFor',
  'tests/integration/in-process/cluster/singleton/ClusterSingleton.test.ts#waitFor',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonApi.test.ts#waitFor',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonHostChange.test.ts#waitFor',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonLease.test.ts#waitFor',
  'tests/integration/in-process/cluster/singleton/ClusterSingletonRestart.test.ts#waitFor',
  'tests/integration/in-process/http/websocket/WebsocketClientActor.test.ts#waitUntil',
  'tests/integration/in-process/persistence/projection/ProjectionActor.test.ts#waitFor',
  'tests/integration/scenarios/Types.ts#waitFor',
  'tests/multi-node/ClusterSecurity.test.ts#waitFor',
  'tests/multi-node/DistributedData.test.ts#awaitConvergence',
  'tests/multi-node/LogContextCrossNode.test.ts#waitFor',
  'tests/unit/cluster/GossipReplayGuard.test.ts#waitFor',
  'tests/unit/crdt/DistributedDataProtoKey.test.ts#waitFor',
  'tests/unit/crdt/DurableDistributedData.test.ts#waitFor',
  'tests/unit/crdt/ORSetTagForgery.test.ts#waitFor',
  'tests/unit/http/websocket/WebsocketClientOversizeLogging.test.ts#waitUntil',
  'tests/unit/persistence/ProjectionFailureStrategy.test.ts#waitFor',
];

/**
 * How many fixed-delay waits each module still takes **without stating why**,
 * measured at {@link LEDGER_REVISION}: 486 across 141 files, out of 611 waits
 * in total — so 125 already carry their reason.
 *
 * Per file rather than one total on purpose.  A single number would say
 * "somebody, somewhere, added one" and would let debt move between files
 * unseen; a per-file count names the file in the failure and merges cleanly
 * when two branches each touch a different one.
 *
 * A count here is only ever *lowered* — by converting the wait to
 * `awaitCondition`, or by writing down the reason it has to stay.  Raising
 * one is never the right edit, which is why the growth message does not offer
 * the replacement text.
 */
const LEGACY_UNEXPLAINED_WAITS: Readonly<Record<string, number>> = {
  'tests/Actor.test.ts': 14,
  'tests/Cluster.test.ts': 7,
  'tests/ClusterBootstrap.test.ts': 1,
  'tests/ShardingAdvanced.test.ts': 14,
  'tests/integration/brokers/amqp/scenarios/02-ack-nack.ts': 1,
  'tests/integration/brokers/email/scenarios/01-send-and-receive.ts': 1,
  'tests/integration/brokers/email/scenarios/02-no-acknowledgment-redelivers.ts': 3,
  'tests/integration/brokers/email/scenarios/04-move-mode.ts': 2,
  'tests/integration/brokers/amqp/scenarios/03-fanout-exchange.ts': 1,
  'tests/integration/brokers/grpc/Runner.ts': 1,
  'tests/integration/brokers/kafka/scenarios/03-manual-commit.ts': 1,
  'tests/integration/brokers/kafka/scenarios/04-headers.ts': 3,
  'tests/integration/brokers/lib/Scenario.ts': 1,
  'tests/integration/brokers/lib/WaitForPort.ts': 1,
  'tests/integration/brokers/mqtt/scenarios/02-qos1.ts': 1,
  'tests/integration/brokers/mqtt/scenarios/03-qos2.ts': 1,
  'tests/integration/brokers/mqtt/scenarios/04-retained.ts': 2,
  'tests/integration/brokers/mqtt/scenarios/05-wildcard.ts': 2,
  'tests/integration/brokers/nats/scenarios/02-wildcard.ts': 2,
  'tests/integration/brokers/redis-streams/scenarios/03-maxlen.ts': 1,
  'tests/integration/in-process/cluster/MessageChannelTransport.test.ts': 1,
  'tests/integration/in-process/cluster/RefAcrossNodes.test.ts': 3,
  'tests/integration/in-process/cluster/WorkerMesh.test.ts': 2,
  'tests/integration/in-process/cluster/downing/DowningStrategies.test.ts': 3,
  'tests/integration/in-process/cluster/downing/DowningWiring.test.ts': 1,
  'tests/integration/in-process/cluster/pubsub/DistributedPubSub.test.ts': 10,
  'tests/integration/in-process/cluster/pubsub/DistributedPubSubAnycast.test.ts': 2,
  'tests/integration/in-process/cluster/sharding/ClusterSharding.test.ts': 7,
  'tests/integration/in-process/cluster/sharding/RemoteShardRef.test.ts': 4,
  'tests/integration/in-process/cluster/sharding/ShardCountMismatch.test.ts': 1,
  'tests/integration/in-process/cluster/sharding/ShardCountPropagation.test.ts': 1,
  'tests/integration/in-process/cluster/sharding/ShardHandOffBuffer.test.ts': 2,
  'tests/integration/in-process/cluster/sharding/ShardIntrospection.test.ts': 10,
  'tests/integration/in-process/cluster/sharding/ShardKey.test.ts': 1,
  'tests/integration/in-process/cluster/sharding/ShardPassivation.test.ts': 3,
  'tests/integration/in-process/cluster/sharding/ShardRememberEntitiesRecovery.test.ts': 2,
  'tests/integration/in-process/cluster/sharding/ShardedDaemonProcess.test.ts': 2,
  'tests/integration/in-process/cluster/sharding/ShardingHoconConfig.test.ts': 3,
  'tests/integration/in-process/cluster/sharding/ShardingLease.test.ts': 1,
  'tests/integration/in-process/cluster/singleton/ClusterSingleton.test.ts': 1,
  'tests/integration/in-process/cluster/singleton/ClusterSingletonApi.test.ts': 1,
  'tests/integration/in-process/cluster/singleton/ClusterSingletonHostChange.test.ts': 5,
  'tests/integration/in-process/cluster/singleton/ClusterSingletonLease.test.ts': 1,
  'tests/integration/in-process/cluster/singleton/ClusterSingletonRestart.test.ts': 1,
  'tests/integration/in-process/http/websocket/WebsocketBackendSuite.ts': 1,
  'tests/integration/in-process/http/websocket/WebsocketClientActor.test.ts': 1,
  'tests/integration/in-process/io/broker/EmailBridgeActor.test.ts': 34,
  'tests/integration/in-process/io/broker/BrokerActor.test.ts': 42,
  'tests/integration/in-process/io/broker/JetStreamActor.test.ts': 22,
  'tests/integration/in-process/io/broker/KafkaActor.test.ts': 19,
  'tests/integration/in-process/io/broker/MqttActor.test.ts': 16,
  'tests/integration/in-process/io/broker/MqttOptions.test.ts': 2,
  'tests/integration/in-process/io/broker/NatsActor.test.ts': 16,
  'tests/integration/in-process/io/broker/Phase2.smoke.test.ts': 3,
  'tests/integration/in-process/io/broker/UdpSocketActor.test.ts': 1,
  'tests/integration/in-process/persistence/BidirectionalMapRecovery.test.ts': 1,
  'tests/integration/in-process/persistence/BidirectionalMultiMapRecovery.test.ts': 1,
  'tests/integration/in-process/persistence/CachedSnapshotStore.test.ts': 1,
  'tests/integration/in-process/persistence/CassandraTagIndex.test.ts': 5,
  'tests/integration/in-process/persistence/CborRichTypeRecovery.test.ts': 1,
  'tests/integration/in-process/persistence/Compaction.test.ts': 1,
  'tests/integration/in-process/persistence/DeadLetterQueueRestart.test.ts': 1,
  'tests/integration/in-process/persistence/PersistentActor.test.ts': 3,
  'tests/integration/in-process/persistence/PersistentActorFencing.test.ts': 6,
  'tests/integration/in-process/persistence/projection/ProjectionActor.test.ts': 8,
  'tests/integration/in-process/persistence/query/PersistenceIds.test.ts': 1,
  'tests/integration/in-process/persistence/query/PersistenceQuery.test.ts': 11,
  'tests/integration/in-process/persistence/query/PushBasedQuery.test.ts': 6,
  'tests/integration/in-process/persistence/query/RelationalQuery.test.ts': 5,
  'tests/integration/scenarios/11-persistence-recovery.ts': 1,
  'tests/integration/scenarios/Types.ts': 2,
  'tests/multi-node/ClusterRouter.test.ts': 1,
  'tests/multi-node/ClusterSecurity.test.ts': 7,
  'tests/multi-node/DistributedData.test.ts': 1,
  'tests/multi-node/DistributedDataConsistency.test.ts': 1,
  'tests/multi-node/EnterBarrier.test.ts': 4,
  'tests/multi-node/LeaseMajority.test.ts': 1,
  'tests/multi-node/LogContextCrossNode.test.ts': 1,
  'tests/multi-node/ParallelPubSub.test.ts': 1,
  'tests/multi-node/ShardingFailover.test.ts': 4,
  'tests/unit/Actor.test.ts': 2,
  'tests/unit/CoordinatedShutdown.test.ts': 4,
  'tests/unit/DeadLetter.test.ts': 2,
  'tests/unit/DeathWatch.test.ts': 2,
  'tests/unit/DrainingShutdown.test.ts': 1,
  'tests/unit/InMemoryTransport.test.ts': 1,
  'tests/unit/LogContext.test.ts': 8,
  'tests/unit/MdcPropagation.test.ts': 3,
  'tests/unit/ReceivePathInstrumentation.test.ts': 1,
  'tests/unit/ReceiveTimeout.test.ts': 2,
  'tests/unit/RestartRegressions.test.ts': 5,
  'tests/unit/Router.test.ts': 5,
  'tests/unit/Scheduler.test.ts': 7,
  'tests/unit/Supervision.test.ts': 1,
  'tests/unit/Timers.test.ts': 4,
  'tests/unit/cache/InMemoryCache.test.ts': 6,
  'tests/unit/cache/_Contract.ts': 1,
  'tests/unit/cluster/GossipReplayGuard.test.ts': 1,
  'tests/unit/cluster/sharding/ShardingAuthority.test.ts': 5,
  'tests/unit/coordination/KubernetesLease.test.ts': 6,
  'tests/unit/crdt/DistributedDataAuthority.test.ts': 6,
  'tests/unit/crdt/DistributedDataDecodeIsolation.test.ts': 5,
  'tests/unit/crdt/DistributedDataProtoKey.test.ts': 3,
  'tests/unit/crdt/DurableDistributedData.test.ts': 3,
  'tests/unit/crdt/ORSetTagForgery.test.ts': 2,
  'tests/unit/devtools/ExplainMethods.test.ts': 1,
  'tests/unit/devtools/ExplainPlan.test.ts': 5,
  'tests/unit/devtools/Introspection.test.ts': 3,
  'tests/unit/devtools/Profiler.test.ts': 2,
  'tests/unit/devtools/SpanTap.test.ts': 1,
  'tests/unit/devtools/Taps.test.ts': 2,
  'tests/unit/devtools/TimeTravel.test.ts': 1,
  'tests/unit/discovery/DnsSeedProvider.test.ts': 1,
  'tests/unit/fsm/FSM.test.ts': 1,
  'tests/unit/fsm/PersistentFSM.test.ts': 1,
  'tests/unit/http/BodyStreamingCap.test.ts': 3,
  'tests/unit/http/HttpConfigDefaults.test.ts': 1,
  'tests/unit/http/cache/IdempotencyKey.test.ts': 1,
  'tests/unit/http/cache/ResponseCache.test.ts': 3,
  'tests/unit/http/middleware/Timeout.test.ts': 1,
  'tests/unit/http/websocket/WebsocketClientOversizeLogging.test.ts': 2,
  'tests/unit/http/websocket/WebsocketServerActor.test.ts': 4,
  'tests/unit/internal/ActorBatching.test.ts': 1,
  'tests/unit/internal/ActorThrottle.test.ts': 7,
  'tests/unit/logging/BatchingSink.test.ts': 1,
  'tests/unit/mailbox/MailboxVariants.test.ts': 3,
  'tests/unit/management/BuiltInHealthChecks.test.ts': 1,
  'tests/unit/management/Management.test.ts': 2,
  'tests/unit/management/ReadinessAfterLeave.test.ts': 1,
  'tests/unit/metrics/MailboxDepthSampler.test.ts': 2,
  'tests/unit/metrics/MailboxWaitHistogram.test.ts': 2,
  'tests/unit/metrics/StockMetrics.test.ts': 1,
  'tests/unit/pattern/BackoffSupervisor.test.ts': 4,
  'tests/unit/pattern/CircuitBreaker.test.ts': 3,
  'tests/unit/persistence/ProjectionFailureStrategy.test.ts': 2,
  'tests/unit/persistence/SqliteClient.test.ts': 1,
  'tests/unit/runtime/Detect.test.ts': 1,
  'tests/unit/testkit/TestKit.test.ts': 1,
  'tests/unit/testkit/TestProbe.test.ts': 2,
  'tests/unit/tracing/ActorTracing.test.ts': 3,
  'tests/unit/tracing/Tracer.test.ts': 1,
  'tests/unit/typed/Behaviors.test.ts': 3,
  'tests/unit/util/Lazy.test.ts': 2,
  'tests/util/AwaitCondition.test.ts': 1,
};

/**
 * A floor under the total the scanner finds, so a scanner that silently
 * stopped matching cannot satisfy every ceiling above by reading nothing.
 * 611 waits were found at {@link LEDGER_REVISION}; the floor sits far enough
 * below that a real conversion sweep does not trip it and a broken regex
 * does.
 */
const SCANNER_SANITY_FLOOR = 400;

/* ------------------------------------------------------------------ */
/* A very small TypeScript scanner                                     */
/* ------------------------------------------------------------------ */

/**
 * Comments, string bodies and regex literals blanked out, character for
 * character so every index still lines up with the original source, plus the
 * mask saying which characters were comment.  Both halves are needed here:
 * code is read from the blanked copy (a `// await sleep(30) used to be here`
 * must not count as a wait, and neither must the fixture sources quoted at
 * the bottom of this very file), while a wait's *reason* is a comment and can
 * only be seen through the mask.
 *
 * `tests/unit/ci/AwaitConditionBudgets.test.ts` carries the same pass without
 * the mask; each guard staying self-contained is worth one duplicate here,
 * because a shared scanner would put a `tests/util/` module on the import
 * path of two gates that must keep working when it is edited.
 */
type BlankedSource = {
  /** Same length as the input; non-code characters replaced by spaces. */
  readonly code: string;
  /** True where the original character was part of a comment. */
  readonly comment: readonly boolean[];
};

function blankNonCode(source: string): BlankedSource {
  const out = source.split('');
  const comment = new Array<boolean>(source.length).fill(false);
  const length = source.length;
  let index = 0;
  let previous = '';
  while (index < length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') { comment[index] = true; out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        comment[index] = true;
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < length) {
        comment[index] = true;
        comment[index + 1] = true;
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 2;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      out[index] = ' ';
      index++;
      while (index < length) {
        if (source[index] === '\\') {
          out[index] = ' ';
          if (index + 1 < length && source[index + 1] !== '\n') out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < length) out[index] = ' ';
      index++;
      previous = 'x';
      continue;
    }
    // A `/` right after an operator or an opener starts a regex, not a
    // division — the standard heuristic, and sufficient here.
    if (character === '/' && /[=(,:[!&|?{};+\-*%~^<>]/.test(previous)) {
      out[index] = ' ';
      index++;
      let inCharacterClass = false;
      while (index < length && source[index] !== '\n') {
        if (source[index] === '\\') {
          out[index] = ' ';
          if (index + 1 < length) out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === '[') inCharacterClass = true;
        else if (source[index] === ']') inCharacterClass = false;
        else if (source[index] === '/' && !inCharacterClass) break;
        out[index] = ' ';
        index++;
      }
      if (index < length) out[index] = ' ';
      index++;
      previous = 'x';
      continue;
    }
    if (!/\s/.test(character!)) previous = character!;
    index++;
  }
  return { code: out.join(''), comment };
}

/** Index of the closer matching the opener at `open`, or -1. */
function matchDelimiter(code: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === opener) depth++;
    else if (code[index] === closer) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * A module-level `sleep`, in any of the shapes the tree uses.  Anchored at
 * column zero because that is what "module level" means in this codebase —
 * no file here wraps declarations in a namespace — and because an indented
 * `const sleep` inside a test body is a local, not a rival declaration.
 */
const SLEEP_DECLARATION =
  /^(?:export\s+)?(?:(?:const|let|var)\s+sleep\b|(?:async\s+)?function\s+sleep\s*\()/gm;

/**
 * The three shapes a fixed-delay wait takes here, and the reason all three
 * are counted: a gate that only knew `sleep(` would name one shape and leave
 * two doors open beside it.  At {@link LEDGER_REVISION} the tree held 479 of
 * the first, 61 of the second and 71 of the third — so the two "rare" shapes
 * are more than a quarter of the debt, and dropping a shim in favour of a
 * bare `Bun.sleep(20)` would otherwise read as progress.
 *
 * The delay-promise form is matched only when `new Promise` and `setTimeout`
 * sit in one expression, which is what makes it a *delay* rather than a
 * scheduled callback: the 71 `setTimeout` calls that reject a pending promise
 * or close a socket later are not waits and are correctly not counted.  The
 * optional type argument is not cosmetic — `new Promise<void>((r) =>
 * setTimeout(r, ms))` is the same bet and is what a strict codebase writes;
 * one site already sat in that gap while this pattern was being written.
 *
 * It is a ratchet, not an adversary.  A determined evasion (a `setTimeout`
 * assigned to a local inside a braced executor, a delay reached through an
 * imported wrapper) is not caught, and hardening against that would cost the
 * precision that keeps the gate from firing on correct code.
 */
const FIXED_DELAY_WAIT = new RegExp(
  [
    '(?<![.\\w$])sleep\\s*\\(',
    '(?<![\\w$])Bun\\s*\\.\\s*sleep\\s*\\(',
    '(?<![\\w$])new\\s+Promise\\s*(?:<[^>()]*>)?\\s*\\(\\s*\\(?\\s*[A-Za-z_$][\\w$]*\\s*\\)?\\s*=>\\s*\\{?\\s*(?:void\\s+)?setTimeout\\s*\\(',
  ].join('|'),
  'g',
);

/**
 * A module-level declaration that could be a polling helper.  The arrow form
 * requires a parenthesised parameter list so that `const deadline = Date.now()`
 * does not open a candidate.
 */
const HELPER_DECLARATION =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\()/gm;

/**
 * A parameter that returns a boolean — the signature of a predicate, and what
 * separates a polling helper from any other helper with a callback and a
 * timer in it.  Order-independent on purpose: two of the tree's `waitFor`s
 * take `(description, check)`, so keying on the *first* parameter would have
 * missed them for a reason that has nothing to do with what they do.
 */
const PREDICATE_PARAMETER = /=>\s*(?:Promise\s*<\s*)?boolean/;

type SleepDeclaration = { readonly file: string; readonly line: number; readonly source: string };
type FixedDelayWait = {
  readonly file: string;
  readonly line: number;
  readonly source: string;
  /** True when a comment sits on the same line, or on the line above. */
  readonly explained: boolean;
};
type PollingHelper = { readonly file: string; readonly line: number; readonly name: string };
type FileScan = {
  readonly declarations: readonly SleepDeclaration[];
  readonly waits: readonly FixedDelayWait[];
  readonly helpers: readonly PollingHelper[];
};

const EMPTY_SCAN: FileScan = { declarations: [], waits: [], helpers: [] };

function scanSource(file: string, source: string): FileScan {
  if (file === CANONICAL_WAIT_HELPER) return EMPTY_SCAN;
  const { code, comment } = blankNonCode(source);
  const lines = source.split('\n');
  /** Offset at which each 1-based line starts, for line lookup and masking. */
  const lineStart: number[] = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') lineStart.push(index + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStart.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStart[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  const declarations: SleepDeclaration[] = [];
  const declarationLines = new Set<number>();
  for (const match of code.matchAll(SLEEP_DECLARATION)) {
    const line = lineOf(match.index);
    declarationLines.add(line);
    declarations.push({ file, line, source: lines[line - 1]!.trim() });
  }

  const waits: FixedDelayWait[] = [];
  for (const match of code.matchAll(FIXED_DELAY_WAIT)) {
    const line = lineOf(match.index);
    // The `Bun.sleep(ms)` inside `const sleep = … => Bun.sleep(ms)` is the
    // declaration, not a wait the test takes.
    if (declarationLines.has(line)) continue;
    const from = lineStart[line - 1]!;
    const to = line < lineStart.length ? lineStart[line]! : source.length;
    let explained = false;
    for (let index = from; index < to; index++) if (comment[index]) explained = true;
    if (!explained && line >= 2) explained = /^\s*(?:\/\/|\/\*|\*)/.test(lines[line - 2]!);
    waits.push({ file, line, source: lines[line - 1]!.trim(), explained });
  }

  const helpers: PollingHelper[] = [];
  for (const match of code.matchAll(HELPER_DECLARATION)) {
    const name = match[1] ?? match[2];
    if (name === undefined || name === 'sleep') continue;
    const parameterOpen = code.indexOf('(', match.index);
    const parameterClose = parameterOpen < 0 ? -1 : matchDelimiter(code, parameterOpen, '(', ')');
    if (parameterClose < 0) continue;
    if (!PREDICATE_PARAMETER.test(code.slice(parameterOpen + 1, parameterClose))) continue;
    const brace = code.indexOf('{', parameterClose);
    const semicolon = code.indexOf(';', parameterClose);
    const end = brace >= 0 && (semicolon < 0 || brace < semicolon)
      ? matchDelimiter(code, brace, '{', '}')
      : semicolon;
    if (end < 0) continue;
    const body = code.slice(match.index, end);
    FIXED_DELAY_WAIT.lastIndex = 0;
    const sleepsInside = FIXED_DELAY_WAIT.test(body);
    FIXED_DELAY_WAIT.lastIndex = 0;
    // A helper that delegates to the shared one is the recommended shape, not
    // a rival: two files keep the `waitFor` name and forward the body.
    if (!sleepsInside || /\bawaitCondition\s*\(/.test(body)) continue;
    helpers.push({ file, line: lineOf(match.index), name });
  }

  return { declarations, waits, helpers };
}

function testTreeFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) testTreeFiles(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const relativeToRoot = (absolutePath: string): string =>
  relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');

const scannedFiles = testTreeFiles(TESTS_DIRECTORY).map(relativeToRoot).sort();
const scans = scannedFiles.map((file) =>
  scanSource(file, readFileSync(join(REPOSITORY_ROOT, file), 'utf8')),
);
const declarations = scans.flatMap((scan) => scan.declarations);
const waits = scans.flatMap((scan) => scan.waits);
const helpers = scans.flatMap((scan) => scan.helpers);

const unexplainedByFile = new Map<string, FixedDelayWait[]>();
for (const wait of waits) {
  if (wait.explained) continue;
  const found = unexplainedByFile.get(wait.file);
  if (found === undefined) unexplainedByFile.set(wait.file, [wait]);
  else found.push(wait);
}

/** The ledger text to paste, printed only where the ratchet moves down. */
const ledgerLines = (entries: readonly string[]): string =>
  entries.map((entry) => `    '${entry}',`).join('\n');

/* ------------------------------------------------------------------ */
/* The ratchet                                                         */
/* ------------------------------------------------------------------ */

describe('fixed-delay waits in the test tree only ever get fewer', () => {
  test('no module declares a sleep the ledger does not already carry', () => {
    const known = new Set(LEGACY_SLEEP_DECLARATIONS);
    const offenders = declarations
      .filter((declaration) => !known.has(declaration.file))
      .map((declaration) => `  ${declaration.file}:${declaration.line}\n      ${declaration.source}`);
    expect(
      offenders,
      `${offenders.length} module(s) declare their own \`sleep\` on top of the ${LEGACY_SLEEP_DECLARATIONS.length} `
      + `that already did at ${LEDGER_REVISION} (${LEDGER_MEASURED_ON}):\n${offenders.join('\n')}\n`
      + `${CANONICAL_WAIT_HELPER} exports one — import it instead:\n`
      + "  import { sleep } from '<relative>/util/AwaitCondition.js';\n"
      + 'Adding a line to LEGACY_SLEEP_DECLARATIONS is not the fix: that ledger only shrinks.',
    ).toEqual([]);
  });

  test('the sleep-declaration ledger carries nothing the tree has already dropped', () => {
    const found = new Set(declarations.map((declaration) => declaration.file));
    const stale = LEGACY_SLEEP_DECLARATIONS.filter((file) => !found.has(file));
    expect(
      stale,
      `${stale.length} ledger entr(y|ies) no longer declare a \`sleep\` — the ratchet moved down and has to `
      + `be tightened, or the next file to re-add the shim goes unnoticed:\n`
      + `${stale.map((file) => `  ${file}`).join('\n')}\n`
      + `Replace LEGACY_SLEEP_DECLARATIONS with:\n${ledgerLines([...found].sort())}`,
    ).toEqual([]);
  });

  test('no module hand-rolls a polling helper the ledger does not already carry', () => {
    const known = new Set(LEGACY_POLLING_HELPERS);
    const offenders = helpers
      .filter((helper) => !known.has(`${helper.file}#${helper.name}`))
      .map((helper) => `  ${helper.file}:${helper.line}  ${helper.name}()`);
    expect(
      offenders,
      `${offenders.length} module(s) declare a hand-rolled polling helper on top of the `
      + `${LEGACY_POLLING_HELPERS.length} that already did at ${LEDGER_REVISION} (${LEDGER_MEASURED_ON}):\n`
      + `${offenders.join('\n')}\n`
      + 'Call `awaitCondition(predicate, { timeoutMs, label })` directly, or — to keep existing call sites '
      + 'byte-identical — forward the body to it, the way tests/unit/EntityContext.test.ts does. '
      + 'A hand-rolled deadline loop has no label and falls through silently when it expires.',
    ).toEqual([]);
  });

  test('the polling-helper ledger carries nothing the tree has already dropped', () => {
    const found = new Set(helpers.map((helper) => `${helper.file}#${helper.name}`));
    const stale = LEGACY_POLLING_HELPERS.filter((entry) => !found.has(entry));
    expect(
      stale,
      `${stale.length} ledger entr(y|ies) are gone from the tree — tighten the ratchet so the name cannot `
      + `come back:\n${stale.map((entry) => `  ${entry}`).join('\n')}\n`
      + `Replace LEGACY_POLLING_HELPERS with:\n${ledgerLines([...found].sort())}`,
    ).toEqual([]);
  });

  test('no module takes an unexplained fixed-delay wait beyond its recorded count', () => {
    const offenders: string[] = [];
    for (const [file, unexplained] of [...unexplainedByFile].sort()) {
      const recorded = LEGACY_UNEXPLAINED_WAITS[file] ?? 0;
      if (unexplained.length <= recorded) continue;
      offenders.push(
        `  ${file}: ${unexplained.length} unexplained, ledger records ${recorded}\n`
        + unexplained.map((wait) => `      :${wait.line}  ${wait.source}`).join('\n'),
      );
    }
    expect(
      offenders,
      `${offenders.length} module(s) wait on a fixed delay more often than the ledger recorded at `
      + `${LEDGER_REVISION} (${LEDGER_MEASURED_ON}), without saying why:\n${offenders.join('\n')}\n`
      + 'Two ways out, both cheap. Wait on the state instead —\n'
      + "  await awaitCondition(() => received.length >= 3, { label: 'the third event arrived' });\n"
      + '— polling the same object the following `expect` reads, not one mailbox hop upstream of it '
      + '(#1145). Or, if the wait has to stay because the assertion is an absence or the elapsed time '
      + 'IS the assertion, say so in a comment on the line above or at the end of the line. '
      + 'Raising the ledger is not one of the ways out.',
    ).toEqual([]);
  });

  test('the unexplained-wait ledger carries no count the tree has already beaten', () => {
    const slack: string[] = [];
    for (const file of Object.keys(LEGACY_UNEXPLAINED_WAITS).sort()) {
      const recorded = LEGACY_UNEXPLAINED_WAITS[file]!;
      const actual = unexplainedByFile.get(file)?.length ?? 0;
      if (actual < recorded) slack.push(`  ${file}: ${actual} unexplained, ledger records ${recorded}`);
    }
    const replacement = [...unexplainedByFile.entries()]
      .sort()
      .map(([file, unexplained]) => `    '${file}': ${unexplained.length},`)
      .join('\n');
    expect(
      slack,
      `${slack.length} ledger entr(y|ies) sit above the tree — the waits went away but the ceiling did `
      + `not, so that much debt could come back unnoticed:\n${slack.join('\n')}\n`
      + `Replace LEGACY_UNEXPLAINED_WAITS with:\n${replacement}`,
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Guards on the guard                                                 */
/* ------------------------------------------------------------------ */

describe('the sleep ratchet is still reading the tree', () => {
  /**
   * A scanner that silently stopped matching would satisfy every ceiling
   * above by finding nothing, and the ratchet would read as green forever.
   */
  test('the scan still finds the tree, and all three wait shapes in it', () => {
    expect(scannedFiles.length).toBeGreaterThan(400);
    expect(waits.length).toBeGreaterThan(SCANNER_SANITY_FLOOR);
    expect(declarations.length).toBeGreaterThan(0);
    expect(helpers.length).toBeGreaterThan(0);
    // Both classes must be represented, or the "explained" test is vacuous in
    // one direction.
    expect(waits.some((wait) => wait.explained)).toBe(true);
    expect(waits.some((wait) => !wait.explained)).toBe(true);
    const shapes = waits.map((wait) => wait.source);
    expect(shapes.some((source) => /(?<![.\w$])sleep\s*\(/.test(source))).toBe(true);
    expect(shapes.some((source) => /Bun\.sleep\s*\(/.test(source))).toBe(true);
    expect(shapes.some((source) => /new Promise[\s\S]*setTimeout/.test(source))).toBe(true);
  });

  /**
   * The canonical helper is the one module that must keep its declaration and
   * its raw timer, so it is excluded by name rather than by any pattern that
   * a rewrite of it could accidentally satisfy.
   */
  test('the canonical helper is out of scope but still on disk', () => {
    expect(scannedFiles).toContain(CANONICAL_WAIT_HELPER);
    expect(declarations.map((declaration) => declaration.file)).not.toContain(CANONICAL_WAIT_HELPER);
    expect(waits.map((wait) => wait.file)).not.toContain(CANONICAL_WAIT_HELPER);
    const source = readFileSync(join(REPOSITORY_ROOT, CANONICAL_WAIT_HELPER), 'utf8');
    expect(source).toContain('export function sleep(');
    expect(source).toContain('export async function awaitCondition(');
  });

  /**
   * This file quotes every shape it forbids, in strings and in comments.  If
   * the blanking pass ever stopped working, the guard would report itself —
   * and, worse, would keep reporting a violation nobody can fix.
   */
  test('the scanner does not count the shapes quoted inside this file', () => {
    const own = relativeToRoot(import.meta.path);
    expect(scannedFiles).toContain(own);
    const scan = scanSource(own, readFileSync(import.meta.path, 'utf8'));
    expect(scan.declarations).toEqual([]);
    expect(scan.waits).toEqual([]);
    expect(scan.helpers).toEqual([]);
    expect(LEGACY_UNEXPLAINED_WAITS[own]).toBeUndefined();
  });

  /**
   * The Node/Deno smoke cases are `.mjs` and therefore outside the walk.
   * That is deliberate and not an oversight: they run under three runtimes,
   * cannot import a `.ts` helper, and a local `setTimeout` shim is the
   * correct answer there — see `.github/workflows/multi-runtime.yml`, which
   * states that the `bun test` suite is not portable to Node/Deno at all.
   */
  test('the Node and Deno smoke cases are deliberately outside the scan', () => {
    const cases = readdirSync(join(TESTS_DIRECTORY, 'smoke', 'cases'));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((entry) => entry.endsWith('.mjs'))).toBe(true);
    expect(scannedFiles.filter((file) => file.startsWith('tests/smoke/cases/'))).toEqual([]);
  });

  /**
   * `file:line` is the whole actionability of every message above — a count
   * without it just says somebody, somewhere, added one — and the offset-to-
   * line lookup is a binary search, which is exactly the kind of code that is
   * off by one until something checks it.
   */
  test('the scanner reports the line each finding sits on', () => {
    const scan = scanSource('tests/unit/Fixture.test.ts', [
      "import { test } from 'bun:test';",
      'const sleep = (ms: number): Promise<void> => Bun.sleep(ms);',
      '',
      'await sleep(30);',
      'async function waitFor(predicate: () => boolean): Promise<void> {',
      '  while (!predicate()) await sleep(5);',
      '}',
    ].join('\n'));
    expect(scan.declarations.map((declaration) => declaration.line)).toEqual([2]);
    expect(scan.waits.map((wait) => wait.line)).toEqual([4, 6]);
    expect(scan.waits[0]!.source).toBe('await sleep(30);');
    expect(scan.helpers.map((helper) => helper.line)).toEqual([5]);
  });

  test.each([
    {
      what: 'a Bun.sleep shim declaration',
      source: 'const sleep = (ms: number): Promise<void> => Bun.sleep(ms);\n',
      declarations: 1,
      waits: 0,
      unexplained: 0,
      helpers: 0,
    },
    {
      what: 'a setTimeout shim declaration',
      source: 'const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));\n',
      declarations: 1,
      waits: 0,
      unexplained: 0,
      helpers: 0,
    },
    {
      what: 'an unexplained wait through a local shim',
      source: 'const sleep = (ms: number): Promise<void> => Bun.sleep(ms);\nawait sleep(30);\n',
      declarations: 1,
      waits: 1,
      unexplained: 1,
      helpers: 0,
    },
    {
      what: 'a wait explained at the end of its own line',
      source: 'await sleep(80);  // reconnect is off, so a second attempt must never happen\n',
      declarations: 0,
      waits: 1,
      unexplained: 0,
      helpers: 0,
    },
    {
      what: 'a wait explained on the line above',
      source: '// let the coordinator rebalance timer fire once\nawait sleep(2_200);\n',
      declarations: 0,
      waits: 1,
      unexplained: 0,
      helpers: 0,
    },
    {
      // The evasion a `sleep(`-only gate would invite: drop the shim, call
      // Bun directly, and the count goes down while the bet stays.
      what: 'an inline Bun.sleep with no shim in the file',
      source: 'await Bun.sleep(20);\n',
      declarations: 0,
      waits: 1,
      unexplained: 1,
      helpers: 0,
    },
    {
      what: 'an inline delay promise',
      source: 'await new Promise((resolve) => setTimeout(resolve, 50));\n',
      declarations: 0,
      waits: 1,
      unexplained: 1,
      helpers: 0,
    },
    {
      what: 'a delay promise with a braced executor and a type argument',
      source: 'await new Promise<void>((resolve) => { setTimeout(resolve, 50); });\n',
      declarations: 0,
      waits: 1,
      unexplained: 1,
      helpers: 0,
    },
    {
      // Not a wait: the timer schedules a rejection, it does not delay the
      // caller.  Counting it would make the gate fire on correct code.
      what: 'a setTimeout that schedules a callback rather than a delay',
      source: 'const timer = setTimeout(() => reject(new Error("too slow")), timeoutMs);\n',
      declarations: 0,
      waits: 0,
      unexplained: 0,
      helpers: 0,
    },
    {
      what: 'a hand-rolled polling helper',
      source: 'async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {\n'
        + '  const deadline = Date.now() + timeoutMs;\n'
        + '  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(10); }\n'
        + '}\n',
      declarations: 0,
      waits: 1,
      unexplained: 1,
      helpers: 1,
    },
    {
      // The recommended shape: same name, same call sites, body forwarded.
      what: 'a wrapper that forwards to awaitCondition',
      source: 'const waitFor = (predicate: () => boolean, label: string): Promise<void> =>\n'
        + '  awaitCondition(predicate, { timeoutMs: 4_000, label });\n',
      declarations: 0,
      waits: 0,
      unexplained: 0,
      helpers: 0,
    },
    {
      // A predicate is a parameter that returns boolean.  A helper with a
      // void callback and a timer is not a polling helper.
      what: 'a helper with a callback parameter but no predicate',
      source: 'function afterOpen(onOpen: () => void, ms: number): void {\n'
        + '  setTimeout(onOpen, ms);\n'
        + '}\n',
      declarations: 0,
      waits: 0,
      unexplained: 0,
      helpers: 0,
    },
    {
      what: 'a predicate that is not the first parameter',
      source: 'export async function waitFor(\n'
        + '  description: string,\n'
        + '  check: () => Promise<boolean> | boolean,\n'
        + '): Promise<void> {\n'
        + '  while (true) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }\n'
        + '}\n',
      declarations: 0,
      waits: 1,
      unexplained: 1,
      helpers: 1,
    },
    {
      what: 'the shapes quoted inside a string or a comment',
      source: '// await sleep(30) used to live here\n'
        + "const example = 'const sleep = (ms: number) => Bun.sleep(ms);';\n"
        + 'const alsoExample = "await new Promise((r) => setTimeout(r, 10));";\n',
      declarations: 0,
      waits: 0,
      unexplained: 0,
      helpers: 0,
    },
    {
      // An indented declaration is a local inside a test, not a module-level
      // rival — and the ledger is keyed on modules.
      what: 'an indented sleep declaration inside a block',
      source: 'test("x", async () => {\n  const sleep = (ms: number) => Bun.sleep(ms);\n  await sleep(5);\n});\n',
      declarations: 0,
      waits: 2,
      unexplained: 2,
      helpers: 0,
    },
  ])('the scanner reads $what', ({ source, declarations: expectedDeclarations, waits: expectedWaits, unexplained, helpers: expectedHelpers }) => {
    const scan = scanSource('tests/unit/Fixture.test.ts', source);
    expect(scan.declarations).toHaveLength(expectedDeclarations);
    expect(scan.waits).toHaveLength(expectedWaits);
    expect(scan.waits.filter((wait) => !wait.explained)).toHaveLength(unexplained);
    expect(scan.helpers).toHaveLength(expectedHelpers);
  });
});

/* ------------------------------------------------------------------ */
/* Re-measuring, for merging this guard forward                        */
/* ------------------------------------------------------------------ */

/**
 * `ACTOR_TS_SLEEP_RATCHET_REMEASURE=1 bun test tests/unit/ci/SleepRatchet.test.ts`
 * prints all three ledgers as they read against the current tree.
 *
 * It exists for one step: merging this guard forward onto a base that moved
 * while the branch was open.  The waits that landed in between predate the
 * rule, so they are baseline and not a regression anyone could have avoided —
 * and rebuilding 270 lines of ledger by hand at merge time is how a guard gets
 * deleted rather than reconciled.  It is *not* the answer to a red run on new
 * code: there the failure message names the two one-line remedies, and both
 * lower the debt instead of recording it.
 *
 * Skipped by default rather than printed always, because a gate that writes
 * 270 lines to the reporter on every green run is a gate people learn to
 * scroll past.
 */
test.skipIf(process.env.ACTOR_TS_SLEEP_RATCHET_REMEASURE !== '1')(
  're-measures the three ledgers against the current tree',
  () => {
    const shims = declarations.map((declaration) => declaration.file).sort();
    const polling = helpers.map((helper) => `${helper.file}#${helper.name}`).sort();
    const unexplained = [...unexplainedByFile.entries()].sort();
    console.log(
      `\nconst LEGACY_SLEEP_DECLARATIONS: readonly string[] = [\n${ledgerLines(shims)}\n];\n\n`
      + `const LEGACY_POLLING_HELPERS: readonly string[] = [\n${ledgerLines(polling)}\n];\n\n`
      + 'const LEGACY_UNEXPLAINED_WAITS: Readonly<Record<string, number>> = {\n'
      + `${unexplained.map(([file, waitsInFile]) => `    '${file}': ${waitsInFile.length},`).join('\n')}\n};\n`,
    );
    expect(shims.length).toBeGreaterThan(0);
    expect(polling.length).toBeGreaterThan(0);
    expect(unexplained.length).toBeGreaterThan(0);
  },
);
