import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions, ActorOptionsType } from '../../ActorOptions.js';
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import { ActorPath } from '../../ActorPath.js';
import {
  DEFAULT_ENTITY_RECOVERY_CONSTANT_RATE_FREQUENCY_MS,
  DEFAULT_ENTITY_RECOVERY_CONSTANT_RATE_NUMBER_OF_ENTITIES,
  DEFAULT_ENTITY_RECOVERY_STRATEGY,
  DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS,
  DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS,
  DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR,
  DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS,
  DEFAULT_NUM_SHARDS,
  DEFAULT_PASSIVATION_ADMISSION_FILTER,
  DEFAULT_PASSIVATION_ADMISSION_WINDOW_PROPORTION,
  DEFAULT_PASSIVATION_IDLE_MS,
  DEFAULT_PASSIVATION_REPLACEMENT,
  DEFAULT_PASSIVATION_SEGMENTED_PROTECTED_PROPORTION,
  DEFAULT_PASSIVATION_STOP_TIMEOUT_MS,
  DEFAULT_REGION_HEARTBEAT_INTERVAL_MS,
  DEFAULT_REGISTER_RETRY_INTERVAL_MS,
  DEFAULT_SHARD_FAILURE_BACKOFF_MAX_MS,
  DEFAULT_SHARD_FAILURE_BACKOFF_MIN_MS,
  DEFAULT_SHARD_FAILURE_BACKOFF_RANDOM_FACTOR,
  DEFAULT_SHARD_FAILURE_BACKOFF_RESET_AFTER_MS,
  DEFAULT_SHARD_REGION_BUFFER_SIZE,
} from './ShardingOptions.js';
import { exponentialBackoff, type BackoffPolicy } from '../../pattern/BackoffPolicy.js';
import { stoppingStrategy, type SupervisorStrategy } from '../../Supervision.js';
import type {
  EntityAdmissionFilter,
  EntityRecoveryStrategy,
  EntityReplacementPolicy,
  ShardingOptionsType,
} from './ShardingOptions.js';
import { createPassivationStrategy } from './PassivationStrategy.js';
import type { PassivationStrategy } from './PassivationStrategy.js';
import type { Cancellable, Scheduler } from '../../Scheduler.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { DeadLetter, Terminated } from '../../SystemMessages.js';
import { SystemGroups, shardCoordinatorName, systemActorPath } from '../../internal/SystemPaths.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMessage } from '../Protocol.js';
import {
  LeaderChanged,
  MemberRemoved,
  MemberUp,
  ShardMapChanged,
  ShardRegionRegistered,
  ShardRegionRegistrationRefused,
} from '../ClusterEvents.js';
import { metricsOf } from '../../metrics/MetricsExtension.js';
import { NodeAddress, type NodeAddressData } from '../NodeAddress.js';
import { RemoteActorRef, remoteActorPath } from '../RemoteActorRef.js';
import { hashShardId } from './ShardAllocator.js';
import { Passivate } from './Passivate.js';
import {
  Shard,
  ShardPassivationDeclined,
  ShardPassivationRequest,
  type ShardConfig,
  type ShardInbox,
  type ShardMessage,
} from './Shard.js';
import type { ShardInfo } from './ShardInfo.js';
import { ShardCoordinator } from './ShardCoordinator.js';
import {
  AuthenticatedShardingMessage,
  isShardingMessage,
  type RegisterRegion,
  type RegisterRefused,
  type RegionEvicted,
  type RegionHeartbeat,
  type RegionTerminated,
  type ShardEnvelope,
  type ShardReply,
  type ShardingMessage,
  type ClusterShardingStats,
  type GetShardHome,
  type GetShardLocation,
  type GetShardRegionStats,
  type GetShards,
  type ShardHome,
  type ShardLocation,
  type ShardMapUpdate,
  type ShardRegionStats,
  type HandOff,
  type HandOffComplete,
  type BeginHandOffAcknowledgment,
  type RememberedEntities,
  type RegisterAcknowledgment,
  type EntityEnvelope,
  type EntityStarted,
  type EntityStopped,
  type ToShard,
} from './ShardingProtocol.js';

export type ShardRegionConfig<TMessage> = {
  readonly typeName: string;
  readonly entityActor: ActorClassOrFactory<TMessage>;
  readonly entityOptions?: ActorOptions<TMessage>;
  readonly extractEntityId: (message: TMessage) => string;
  readonly extractEntityMessage: (message: TMessage) => unknown;
  readonly numShards: number;
  readonly role?: string;
  readonly proxy: boolean;
  readonly rememberEntities: boolean;
  readonly passivationIdleMs: number;
  readonly shardPassivationIdleMs: number;
  readonly maxEntities: number;
  /** Which resident entity the cap gives up on overflow (#848). */
  readonly passivationReplacement: EntityReplacementPolicy;
  /** Share of the cap held by the protected segment under segmented LRU (#848). */
  readonly passivationSegmentedProtectedProportion: number;
  /** Share of the cap held as a probationary admission window; `0` = none (#848). */
  readonly passivationAdmissionWindowProportion: number;
  /** Whether a candidate leaving the window must out-rank what it displaces (#848). */
  readonly passivationAdmissionFilter: EntityAdmissionFilter;
  /** How long a passivating entity may take to stop before the shard forces it (#848). */
  readonly passivationStopTimeoutMs: number;
  /** Region-wide cap on the routing buffer; `0` = never buffer (#849). */
  readonly bufferSize: number;
  /** How often an unacknowledged `Register` is re-sent, in ms (#849). */
  readonly registerRetryIntervalMs: number;
  /** How remembered entities are brought back after a shard lands here (#851). */
  readonly entityRecoveryStrategy: EntityRecoveryStrategy;
  /** Gap between two paced recovery batches, in ms (#851). */
  readonly entityRecoveryConstantRateFrequencyMs: number;
  /** Entities one paced recovery batch starts, region-wide (#851). */
  readonly entityRecoveryConstantRateNumberOfEntities: number;
  /** Beat to the coordinator so it can notice this region going silent (#853). */
  readonly staleRegionDetection: boolean;
  /** Gap between two beats, in ms; inert while `staleRegionDetection` is off (#853). */
  readonly regionHeartbeatIntervalMs: number;
  /** First wait before a shard that stopped unexpectedly is re-created, in ms (#1437). */
  readonly shardFailureBackoffMinMs: number;
  /** Ceiling the wait doubles up to, in ms (#1437). */
  readonly shardFailureBackoffMaxMs: number;
  /** Jitter on every wait, a fraction in `[0, 1]` (#1437). */
  readonly shardFailureBackoffRandomFactor: number;
  /** How long a shard has to go without failing, since it came back, for its next death to wait the first wait again, in ms (#1437). */
  readonly shardFailureBackoffResetAfterMs: number;
  /** First wait before a shard re-creates an entity that stopped without being passivated, in ms (#1437). */
  readonly entityRestartBackoffMinMs: number;
  /** Ceiling that entity wait doubles up to, in ms (#1437). */
  readonly entityRestartBackoffMaxMs: number;
  /** Jitter on every entity wait, a fraction in `[0, 1]` (#1437). */
  readonly entityRestartBackoffRandomFactor: number;
  /** How long an entity has to go without stopping unasked, since it came back, for its next such stop to wait the first wait again, in ms (#1437). */
  readonly entityRestartBackoffResetAfterMs: number;
  /**
   * How long this type's `shards()` and `shardRefFor()` wait by default on this
   * node, in ms — `shard-region-query-timeout` (#1436).  The region keeps a
   * query's caller at least this long, so an answer inside that wait still
   * finds it.  `ClusterSharding.start` supplies it; a region built any other
   * way has none, and the other bounds on `asksTtlMs` apply alone.
   */
  readonly queryTimeoutMs?: number;
  /**
   * Called when this region stops being registered without having been
   * refused — the coordinator evicted it, or the region stopped — so
   * `ClusterSharding.isRegistered` reads `false` until a new registration is
   * acknowledged (#1465).  `ClusterSharding.start` supplies it; a region built
   * any other way has none, and nothing outside it mirrors its registration.
   *
   * A direct call rather than a cluster event: nothing but this node's
   * `ClusterSharding` keeps the mirror, and a refusal, which does carry
   * something worth subscribing to, keeps its own event.
   */
  readonly onRegistrationLost?: () => void;
  readonly cluster: Cluster;
  readonly localResolver: (path: string) => ActorRef | null;
};

/**
 * One entity still owed a start by the paced recovery queue (#851).  The shard
 * travels with the id because the queue spans every shard the region owns —
 * that is what makes the batch size a budget for the whole sharded type on
 * this node rather than a per-shard one — and the shard has to be re-checked
 * at drain time anyway, since a rebalance can take it away while its entities
 * are still queued.
 */
type PendingEntityRecovery = {
  readonly shardId: number;
  readonly entityId: string;
};

/**
 * "Drain one recovery batch" — the region telling itself, on a timer (#851).
 *
 * A class rather than a `sharding.`-kinded object, and deliberately so on both
 * counts.  A remote frame arrives as decoded plain data, so nothing off the
 * wire can ever be `instanceof` this and no peer can pace another node's
 * recovery — the same argument that took `BackoffSupervisor`'s control ticks
 * off a value every caller could reconstruct.  And the timer's callback only
 * ever *sends* it, so the drain itself runs on the region's own turn rather
 * than inside the scheduler, where it would read and mutate the queue
 * concurrently with the mailbox (#952).
 */
class EntityRecoveryTick {}

/** The only instance ever sent — it carries nothing, so one is enough. */
const ENTITY_RECOVERY_TICK = new EntityRecoveryTick();

/**
 * "Run the passivation sweep" — the region telling itself, on a timer.
 *
 * The shape of {@link EntityRecoveryTick}, for the same two reasons.  Both
 * sweeps read and write the region's bookkeeping — the activity stamps, the
 * `passivating` set, the shard states — and tell shards to stop, so they
 * belong on the region's own turn: run from the scheduler's callback, beside
 * the mailbox rather than in it, a sweep judged an entity idle while a
 * message for it sat in that mailbox, already sent and not yet routed.  And a
 * class can never arrive off the wire, so no peer can make another node sweep.
 */
class PassivationSweepTick {}

/** The only instance ever sent — it carries nothing, so one is enough. */
const PASSIVATION_SWEEP_TICK = new PassivationSweepTick();

/**
 * "Forget the callers nobody answered" — the region telling itself, on a timer
 * (#1436).
 *
 * The shape of {@link PassivationSweepTick}, for the same two reasons.  The
 * sweep reads and deletes entries of the three tables of waiting callers, and
 * an answer for one of them can already sit in the mailbox when the timer
 * fires: run from the scheduler's callback, the sweep dropped that caller
 * before the region had read the answer meant for it.  On the region's turn it
 * runs behind whatever arrived first.  And a class can never arrive off the
 * wire, so no peer can make another node forget its callers.
 */
class AsksSweepTick {}

/** The only instance ever sent — it carries nothing, so one is enough. */
const ASKS_SWEEP_TICK = new AsksSweepTick();

/**
 * A shard's run of unexpected deaths, and the wait it is in (#1437).
 *
 * Kept from the first such death until the region gives the shard up — a
 * hand-off, a release, a move, the region's own stop — because the count has
 * to outlive the shard's incarnations: each death in a row waits twice as long
 * as the one before, and only a shard that went `reset-after` without failing
 * since it came back starts the count over.
 *
 * Measured from the shard's return, not from when its current incarnation was
 * created.  A passivation stops a healthy shard and the next message creates
 * a new incarnation, so a cold shard re-created by a poison message dies a few
 * milliseconds into its incarnation however long it had gone without failing —
 * and judged by that, it would carry on doubling from a run of failures that
 * ended long ago.
 */
type ShardFailureRecord = {
  /** Deaths that counted toward the current run; the next one waits `delayFor(attempts)`. */
  attempts: number;
  /** When the shard came back from its last wait, on `system.clock`; `null` while it is in one. */
  upSince: number | null;
  /** The one-shot that ends the current wait, or `null` while the shard is up. */
  timer: Cancellable | null;
};

/**
 * "A backing-off shard's wait is over" — the region telling itself, on a timer
 * (#1437).
 *
 * The shape of {@link EntityRecoveryTick}, for the same two reasons: nothing off
 * the wire can be `instanceof` it, so no peer can make another node re-create a
 * shard early; and the timer only sends it, so the re-creation runs on the
 * region's turn, behind whatever was queued first (#952).  It carries the
 * record that armed it, because a hand-off, a release or a move can drop that
 * record after the timer fired and before the tick is read — and a tick for a
 * record the shard no longer has is stale.
 */
class ShardRespawnTick {
  constructor(
    readonly shardId: number,
    readonly record: ShardFailureRecord,
  ) {}
}

/**
 * A caller of `ClusterSharding.shards()` or `shardRefFor()` still waiting for
 * its answer, and when the region stops holding it (#1436).
 *
 * Both queries wait on somebody else — the coordinator, or a home it has not
 * decided yet — and nothing guarantees that answer ever comes: an election in
 * flight, a coordinator that drops the request, a proxy-only type.  The expiry
 * is what turns "waiting" into "waiting for a while"; the caller's own ask has
 * long given up by then.
 */
type PendingQueryCaller = {
  readonly asker: ActorRef;
  readonly expireAt: number;
};

/**
 * A `shards()` caller still waiting, with the fan-out deadline it asked the
 * coordinator for — what asking again after a late registration needs.
 */
type PendingStatsQuery = PendingQueryCaller & {
  readonly timeoutMs: number;
};

/** What the region knows about a local entity — enough to decide passivation. */
type EntityActivity = {
  readonly shardId: number;
  lastActivity: number;
};

/**
 * What the region is currently doing with a shard.  `'handing-off'` and
 * `'passivating'` both mean "stop delivering, buffer instead"; they differ in
 * what happens once the actor is gone — a handoff gives ownership up, a
 * passivation keeps it and re-creates the shard on the next message.
 *
 * `'backing-off'` is the third reason to buffer, and the one with no actor at
 * all: the shard stopped without being asked to, the region keeps it, and
 * nothing re-creates it but its {@link ShardRespawnTick} (#1437).
 */
type ShardState = 'owned' | 'handing-off' | 'passivating' | 'backing-off';

/** Anything the region can route to an entity: a user message, or an id-addressed envelope. */
type RoutableMessage<TMessage> = TMessage | EntityEnvelope;

function isEntityEnvelope(message: unknown): message is EntityEnvelope {
  return typeof message === 'object'
    && message !== null
    && (message as { kind?: unknown }).kind === 'sharding.EntityEnvelope';
}

/**
 * ShardRegion is the node-local router for a sharded type.  It talks to
 * the ShardCoordinator to discover the home of each shard, hosts a
 * {@link Shard} actor for every shard that lives locally, and forwards
 * everything else to the remote region that owns the target shard.  Messages
 * whose shard home is unknown or in handoff are buffered until the
 * coordinator answers.
 *
 * Entities are grandchildren, not children: the region routes to a shard and
 * the shard owns the entity actors.  What the region deliberately keeps is
 * the *passivation policy* — the idle sweep, the `maxEntities` LRU, and the
 * shard-level sweep that stops a shard once it has stood empty long enough.
 * It sees every message for its sharded type on this node, so it is the only
 * place where the per-type entity cap (`maxEntities`) can be enforced; a
 * shard only ever sees its own slice.
 *
 * Deciding here is also what makes stopping a shard loss-free.  The region
 * marks the shard and stops routing to it in the same synchronous step as it
 * asks it to stop, so nothing it routes can land in a mailbox that is already
 * draining — a shard that timed itself out would have to tell the region
 * afterwards, and everything in that gap would be dropped.  The shard has the
 * last word all the same (#1441): the region's index learns of an entity only
 * from the shard's report, so the shard reads the request behind whatever the
 * region handed it first and stops only when that left it nothing to lose.
 */
export class ShardRegion<TMessage = unknown>
  extends Actor<
    | TMessage
    | ShardingMessage
    | AuthenticatedShardingMessage
    | Terminated
    | Passivate
    | EntityRecoveryTick
    | PassivationSweepTick
    | AsksSweepTick
    | ShardRespawnTick
    | ShardPassivationDeclined
  > {
  private readonly shardHomes = new Map<number, string>(); // shardId → region path
  private readonly shardHomeNodes = new Map<number, NodeAddress>();
  private readonly localShards = new Set<number>();
  private readonly shardState = new Map<number, ShardState>();
  /** Shard actors hosted here, keyed by shard id. */
  private readonly shards = new Map<number, ActorRef<ShardInbox>>();
  /** Shards stopped on purpose for a handoff — tells an expected stop from a crash. */
  private readonly handingOff = new Set<number>();
  /** Shards stopped on purpose because they stood empty — likewise an expected stop. */
  private readonly passivatingShards = new Set<number>();
  /**
   * Shards being given up because the coordinator took this region's
   * registration away — a `numShards` refusal (#633) or a staleness eviction
   * (#853).  A third kind of expected stop, and deliberately not either of the
   * other two: a handoff has a coordinator waiting for `HandOffComplete` and a
   * passivation keeps ownership, while a release has neither — the coordinator
   * does not have this region in `regions`, so there is nobody to answer and no
   * ownership to come back to.
   */
  private readonly releasingShards = new Set<number>();
  /**
   * Shards that stopped without being asked to, and the backoff each is in —
   * see {@link ShardFailureRecord} (#1437).  The fourth kind of stop, and the
   * only one the region did not order: a handoff, a passivation and a release
   * all mark their shard before the stop, and a death is whatever stops
   * unmarked.
   */
  private readonly shardFailures = new Map<number, ShardFailureRecord>();
  /**
   * Turns a death count into a wait: `min × 2^n` capped at `max`, spread by
   * the random factor (#1437).  Built in {@link preStart}, for the reason
   * {@link passivationStrategy} gives: constructing a region reads no config.
   */
  private shardFailureBackoff: BackoffPolicy | null = null;
  /** shardId → when it last became empty (or was created).  The shard sweep's clock. */
  private readonly shardEmptySince = new Map<number, number>();
  private readonly shardEntities = new Map<number, Set<string>>(); // shardId → entityIds
  private readonly entityActivity = new Map<string, EntityActivity>(); // entityId → activity
  /**
   * Replacement order for the `maxEntities` cap, or `null` when there is no cap
   * (#848).
   *
   * Deliberately a second structure beside {@link entityActivity} rather than a
   * replacement for it.  The two answer different questions: this one is "who
   * goes when the node is full", which is what the configured policy decides;
   * the map is "which shard hosts this entity and when did it last hear
   * anything", which the idle sweep and the stats replies need and no policy
   * has an opinion about.
   *
   * `null` at the shipped `maxEntities = 0`, so an uncapped region — the
   * overwhelmingly common one — pays a single branch on the routing path rather
   * than maintaining an index that bounds nothing.
   *
   * Built in {@link preStart} rather than in the constructor, and deliberately:
   * constructing a region must stay free of side effects — nothing has read
   * `config` there since the class was written, an admission filter allocates a
   * sketch sized from the cap, and no message can reach a region before
   * `preStart` anyway.
   */
  private passivationStrategy: PassivationStrategy | null = null;
  /** Entities we have already asked a shard to passivate — excluded from the LRU count. */
  private readonly passivating = new Set<string>();
  /** Messages buffered while their shard home is unknown or in transition. */
  private readonly buffer = new Map<
    number,
    Array<{ message: RoutableMessage<TMessage>; sender: ActorRef | null }>
  >();
  /**
   * How many messages {@link buffer} holds in total, across every shard —
   * the quantity `bufferSize` bounds (#849).
   *
   * Kept as a counter rather than summed on demand, and bounded as a *total*
   * rather than per queue, for the same reason: the map is keyed by shard id,
   * so a per-queue cap would admit `numShards × bufferSize` messages — 64×
   * the configured bound at the shipped default — and summing the queues on
   * every buffered message would put an O(numShards) walk on the routing path.
   */
  private bufferedCount = 0;
  /**
   * Whether the full-buffer warning has already gone out for the current
   * overflow episode.  Latched so a hot route cannot flood the log, and
   * cleared by {@link flushBuffer} once nothing is held any more, so a second
   * stall is reported rather than passing silently.
   */
  private warnedBufferFull = false;

  private coordinatorRef: ActorRef<ShardingMessage> | null = null;
  /**
   * The node this region currently believes hosts the coordinator — the sole
   * authority for the coordinator-only directives (#584).  Kept beside
   * `coordinatorRef` rather than derived from it because a `RemoteActorRef`
   * does not expose its target node, and the local branch has no node at all.
   */
  private coordinatorNode: NodeAddress | null = null;
  private unsubscribe: (() => void) | null = null;
  private envelopeUnsubscribe: (() => void) | null = null;
  private passivationTimer: Cancellable | null = null;
  private registerTimer: Cancellable | null = null;
  /**
   * Drives the liveness beat to the coordinator, or `null` when
   * `staleRegionDetection` is off — which it is unless a deployment asks for it
   * (#853).  Distinct from {@link registerTimer}, which retries *until*
   * acknowledged and is then cancelled; this one runs for the region's whole
   * life and claims nothing.
   */
  private heartbeatTimer: Cancellable | null = null;
  /**
   * Remembered entities still owed a start under `constant-rate` (#851).
   *
   * **One queue for the whole region, not one per shard.**  A shard only ever
   * sees its own slice, so a per-shard queue would make the configured batch
   * mean `numShards ×` itself on the node — the conflation `maxEntities` and
   * `bufferSize` are both kept region-wide to avoid, and the one the `Shard`
   * class's own JSDoc warns about.  The region is the only place that sees
   * every shard, so it is the only place the budget can span them.
   *
   * Which makes the budget **per sharded type on this node**, not per node: a
   * node runs one region per type, and each paces its own queue — the scope
   * `maxEntities` has, for the same reason.  One limiter shared by every
   * region on the node would change what the key means wherever a node runs
   * more than one paced type; whether recovery wants a per-node budget at all
   * is the question #1460 asks of the rebalance ceiling.
   *
   * Drained from {@link entityRecoveryHead} rather than with `shift`: a node
   * handed thousands of remembered entities is exactly the case this exists
   * for, and shifting each one off the front would make the drain quadratic in
   * the size of the burst it is supposed to smooth.
   */
  private readonly entityRecoveryQueue: PendingEntityRecovery[] = [];
  private entityRecoveryHead = 0;
  /**
   * Entity ids still *owed* a start by {@link entityRecoveryQueue} — the
   * queue's live set.  An entry whose id is not in it is spent, and the drain
   * skips it without charging the batch.
   *
   * Two jobs.  It keeps a registry shipped twice from queueing the same entity
   * twice — re-shipping is ordinary: a shard that dies outside a handoff asks
   * for its registry again (#894), and a leader change re-registers the
   * region — so the region stops arming batches as soon as nothing is owed.
   * And it is how an entity that starts some other way leaves the queue: the
   * routing step and every spawn report delete its id, so the drain never has
   * to guess from whether the entity happens to exist when its turn comes.
   */
  private readonly entityRecoveryQueued = new Set<string>();
  private entityRecoveryTimer: Cancellable | null = null;
  /**
   * Remembered entities that arrived for a shard while it was passivating,
   * under `entity-recovery.strategy = all`, held for the shard's return (#851).
   *
   * The paced drain holds such an entry in its own queue.  The unpaced path
   * has no queue, and telling the registry to the shard actor put it behind
   * the stop in a mailbox about to be dropped, so the shard came back empty
   * while the coordinator still listed every entity.  A passivation keeps the
   * shard this region's, so its entities are still owed a start here, and
   * {@link completeShardPassivation} gives it to the shard `ensureShard`
   * re-creates.  A set per shard, because a registry shipped twice during one
   * stop must not start an entity twice.
   */
  private readonly registriesHeldThroughPassivation = new Map<number, Set<string>>();
  /**
   * Set when the coordinator refused this region's `numShards` (#633).  A
   * refused region must stop hammering the register loop — the count is fixed
   * for the lifetime of the region, so retrying against the same coordinator
   * can only produce the same answer.  Cleared on a leader change, where the
   * coordinator moves to a node whose configuration we have not been told
   * about yet.
   */
  private registerRefused = false;

  /**
   * Whether {@link ShardRegionRegistered} has already been published for the
   * current registration (#1317).
   *
   * Held so the event marks the *transition* rather than every acknowledgment:
   * a leader change re-registers every region, and an event per acknowledgment
   * would report a state change that did not happen.  Cleared whenever the
   * registration is taken away — by a refusal (#633) and by a staleness
   * eviction (#853) — so the acknowledgment that follows either is a real
   * transition again: the region became routable a second time.  An eviction
   * and the region's own stop also clear `ClusterSharding.isRegistered`,
   * through {@link ShardRegionConfig.onRegistrationLost} (#1465); a refusal
   * does that through its own event.
   *
   * **Deliberately not called `registered`.**  #681 removed a field of that
   * name because it was written and never read, and
   * `tests/unit/cluster/DeadProtocolSurface.test.ts` pins its absence so it
   * cannot come back.  This flag is read — it is the guard one line below the
   * publish — but the name is the one that guard watches, and the more precise
   * name is the better one anyway: what this records is that the announcement
   * went out, while "is this region registered" is answered from outside by
   * `ClusterSharding.isRegistered`.
   */
  private registrationAnnounced = false;

  /**
   * Senders of messages currently awaiting a reply from a remote shard.
   * Keyed by a correlation id that travels with {@link ShardEnvelope} across
   * the wire; the owning region looks it up when a {@link ShardReply} arrives.
   */
  private readonly pendingAsks = new Map<number, { sender: ActorRef; expireAt: number }>();
  private nextCorrelation = 0;

  /** Local callers of `ClusterSharding.shards()`, keyed by their correlation. */
  private readonly pendingStatsAsks = new Map<number, PendingStatsQuery>();
  private nextStatsCorrelation = 0;
  /**
   * Local callers of `ClusterSharding.shardRefFor()`, keyed by shard — several
   * callers can wait on one shard, and each carries its own expiry, so a caller
   * that has given up goes without taking a newer one on the same shard along.
   */
  private readonly pendingLocationAsks = new Map<number, PendingQueryCaller[]>();
  /** Drives {@link onAsksSweepTick}, which drains all three tables above. */
  private asksSweepTimer: Cancellable | null = null;
  /**
   * The least time a waiting caller is kept, whatever is configured.  A
   * per-call `timeoutMs` is invisible to the region, and a minute covers the
   * common ones.
   */
  private readonly asksTtlFloorMs = 60_000;
  /**
   * How long a waiting caller is kept before the sweep forgets it, and how often
   * the sweep runs — resolved in {@link preStart}, see there.
   */
  private asksTtlMs = this.asksTtlFloorMs;

  constructor(public readonly config: ShardRegionConfig<TMessage>) { super(); }

  /**
   * A shard that fails is stopped, never restarted in place (#1437).
   *
   * What reaches here is a failure the shard did not absorb: an entity whose
   * own strategy escalates, or a fault in the shard's own handler.  The default
   * restarted the shard — ten times a minute, on one budget every shard of the
   * type on this node shares, since the budget is the parent's — and a restart
   * in place tore down every entity under the shard while the fresh instance
   * knew none of them.  No `EntityStopped` reached the region, so its index
   * went on claiming entities that were gone, and under `rememberEntities`
   * nothing brought them back, since only a stop asked for the registry.
   *
   * Stopping sends the shard down the one path that handles all of it: the
   * region forgets the shard's entities, backs it off, and asks for the
   * registry when it re-creates it ({@link backOffShard}).  An entity's own
   * failures inside its budget never get this far — the shard restarts those
   * itself, at once, on a budget its entities share.
   */
  override supervisorStrategy(): SupervisorStrategy { return stoppingStrategy; }

  static settingsToConfig<TMessage>(
    s: ShardingOptionsType<TMessage>,
    cluster: Cluster,
    localResolver: (path: string) => ActorRef | null,
  ): ShardRegionConfig<TMessage> {
    const passivationIdleMs = s.passivationIdleMs ?? DEFAULT_PASSIVATION_IDLE_MS;
    return {
      typeName: s.typeName,
      entityActor: s.entityActor,
      entityOptions: s.entityOptions,
      extractEntityId: s.extractEntityId,
      extractEntityMessage: s.extractEntityMessage ?? ((m: TMessage) => m as unknown),
      numShards: s.numShards ?? DEFAULT_NUM_SHARDS,
      role: s.role,
      proxy: s.proxy ?? false,
      rememberEntities: s.rememberEntities ?? false,
      passivationIdleMs,
      // The one place the "shards follow entities" default lives: a shard
      // stands empty precisely because its entities went idle, so absent an
      // explicit window the entity one applies a level up.
      shardPassivationIdleMs: s.shardPassivationIdleMs ?? passivationIdleMs,
      maxEntities: s.maxEntities ?? 0,
      // All five resolve whether or not there is a cap, because the cap can
      // arrive from the layer above; the strategy that reads them is only built
      // when `maxEntities > 0` (#848).
      passivationReplacement: s.passivationReplacement ?? DEFAULT_PASSIVATION_REPLACEMENT,
      passivationSegmentedProtectedProportion:
        s.passivationSegmentedProtectedProportion ?? DEFAULT_PASSIVATION_SEGMENTED_PROTECTED_PROPORTION,
      passivationAdmissionWindowProportion:
        s.passivationAdmissionWindowProportion ?? DEFAULT_PASSIVATION_ADMISSION_WINDOW_PROPORTION,
      passivationAdmissionFilter: s.passivationAdmissionFilter ?? DEFAULT_PASSIVATION_ADMISSION_FILTER,
      passivationStopTimeoutMs: s.passivationStopTimeoutMs ?? DEFAULT_PASSIVATION_STOP_TIMEOUT_MS,
      // Defaulted here as well as in `reference.conf`, so a directly-constructed
      // region is bounded exactly like a HOCON-fed one — the buffer is a safety
      // property, and one that only `ClusterSharding.start` supplied would be
      // absent from every region built any other way.
      bufferSize: s.bufferSize ?? DEFAULT_SHARD_REGION_BUFFER_SIZE,
      registerRetryIntervalMs: s.registerRetryIntervalMs ?? DEFAULT_REGISTER_RETRY_INTERVAL_MS,
      // `all` keeps the burst every release before #851 had.  Pacing changes
      // when an entity comes back, so defaulting it on would slow recovery for
      // every deployment that never asked — and how fast a journal can take the
      // replays is a fact about that journal, not about sharding.
      entityRecoveryStrategy: s.entityRecoveryStrategy ?? DEFAULT_ENTITY_RECOVERY_STRATEGY,
      entityRecoveryConstantRateFrequencyMs:
        s.entityRecoveryConstantRateFrequencyMs ?? DEFAULT_ENTITY_RECOVERY_CONSTANT_RATE_FREQUENCY_MS,
      entityRecoveryConstantRateNumberOfEntities:
        s.entityRecoveryConstantRateNumberOfEntities
        ?? DEFAULT_ENTITY_RECOVERY_CONSTANT_RATE_NUMBER_OF_ENTITIES,
      // Off unless asked for: the beat is only useful to a coordinator that is
      // sweeping, the same switch decides both, and a default that beat would
      // add a frame per interval per sharded type to every deployment for a
      // mechanism none of them turned on (#853).
      staleRegionDetection: s.staleRegionDetection ?? false,
      regionHeartbeatIntervalMs: s.regionHeartbeatIntervalMs ?? DEFAULT_REGION_HEARTBEAT_INTERVAL_MS,
      // Defaulted here too, for the reason `bufferSize` gives: the backoff is
      // what keeps a shard that fails on every start from looping, and a region
      // built any way but through `ClusterSharding.start` must not loop (#1437).
      shardFailureBackoffMinMs: s.shardFailureBackoffMinMs ?? DEFAULT_SHARD_FAILURE_BACKOFF_MIN_MS,
      shardFailureBackoffMaxMs: s.shardFailureBackoffMaxMs ?? DEFAULT_SHARD_FAILURE_BACKOFF_MAX_MS,
      shardFailureBackoffRandomFactor:
        s.shardFailureBackoffRandomFactor ?? DEFAULT_SHARD_FAILURE_BACKOFF_RANDOM_FACTOR,
      shardFailureBackoffResetAfterMs:
        s.shardFailureBackoffResetAfterMs ?? DEFAULT_SHARD_FAILURE_BACKOFF_RESET_AFTER_MS,
      // The entity half, defaulted here for the same reason and handed to every
      // shard whole by `shardConfigFor`: a value that stopped at the region would
      // leave each shard on its own defaults, configured or not (#1437).
      entityRestartBackoffMinMs: s.entityRestartBackoffMinMs ?? DEFAULT_ENTITY_RESTART_BACKOFF_MIN_MS,
      entityRestartBackoffMaxMs: s.entityRestartBackoffMaxMs ?? DEFAULT_ENTITY_RESTART_BACKOFF_MAX_MS,
      entityRestartBackoffRandomFactor:
        s.entityRestartBackoffRandomFactor ?? DEFAULT_ENTITY_RESTART_BACKOFF_RANDOM_FACTOR,
      entityRestartBackoffResetAfterMs:
        s.entityRestartBackoffResetAfterMs ?? DEFAULT_ENTITY_RESTART_BACKOFF_RESET_AFTER_MS,
      cluster,
      localResolver,
    };
  }

  override preStart(): void {
    // A waiting caller must outlive the deadline it is waiting out, or an
    // answer that arrives in time finds nobody to give it to (#1436): an `ask`
    // waits `actor-ts.actor.ask-timeout` unless it names its own, and a
    // `shards()` / `shardRefFor()` query this type's query timeout.  Raising
    // either raises the lifetime; neither can lower it below the floor.
    // Resolved once, here, because both are fixed for the life of the system.
    this.asksTtlMs = Math.max(
      this.asksTtlFloorMs,
      this.system._defaultAskTimeoutMs,
      this.config.queryTimeoutMs ?? 0,
    );

    this.passivationStrategy = createPassivationStrategy({
      capacity: this.config.maxEntities,
      replacement: this.config.passivationReplacement,
      segmentedProtectedProportion: this.config.passivationSegmentedProtectedProportion,
      admissionWindowProportion: this.config.passivationAdmissionWindowProportion,
      admissionFilter: this.config.passivationAdmissionFilter,
    });

    this.shardFailureBackoff = exponentialBackoff({
      minMs: this.config.shardFailureBackoffMinMs,
      maxMs: this.config.shardFailureBackoffMaxMs,
      randomFactor: this.config.shardFailureBackoffRandomFactor,
    });

    this.unsubscribe = this.config.cluster.subscribe(evt =>
      match(evt)
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .with(P.instanceOf(MemberRemoved), (event) => this.onMemberRemoved(event))
        .with(P.instanceOf(MemberUp), () => this.onMemberUp())
        .otherwise(() => this.onOtherClusterEvent()),
    );

    // Claim the region's own path on the envelope router *before* registering
    // with the coordinator, so nothing the registration provokes can arrive
    // before the handler that stamps it with its sender.  Generic path
    // resolution would deliver the same frames — that is what happened until
    // #584 — but it calls `ref.tell(body)` with no sender at all, throwing away
    // the one field of an inbound frame the sender cannot choose.
    this.envelopeUnsubscribe = this.config.cluster._registerEnvelopeHandler(
      this.self.path.toString(),
      (envelope, from) => this.onRemoteEnvelope(envelope, from),
    );

    this.ensureRegistered();

    // One timer drives both sweeps.  The interval is the shorter of the
    // windows actually enabled — a sweep is only ever as punctual as its
    // tick, so the tighter window sets the pace for both.
    const windows = [this.config.passivationIdleMs, this.config.shardPassivationIdleMs]
      .filter((ms) => ms > 0);
    if (windows.length > 0) {
      const intervalMs = Math.min(...windows);
      this.passivationTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        intervalMs, intervalMs,
        // Only ever *sends*: the sweeps decide on the region's turn, behind
        // whatever is already queued — see `PassivationSweepTick`.
        () => { this.self.tell(PASSIVATION_SWEEP_TICK); },
      );
    }

    this.asksSweepTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.asksTtlMs, this.asksTtlMs,
      // Only ever *sends*: the sweep runs on the region's turn, behind any
      // answer already queued — see `AsksSweepTick`.
      () => { this.self.tell(ASKS_SWEEP_TICK); },
    );

    // A proxy beats too.  It registers, so it is in the coordinator's `regions`
    // map and would be swept like any other silent entry — and being evicted
    // costs it the `ShardMapUpdate` broadcasts it routes by (#853).
    if (this.config.staleRegionDetection) {
      const beatMs = this.config.regionHeartbeatIntervalMs;
      this.heartbeatTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        beatMs, beatMs,
        () => this.sendRegionHeartbeat(),
      );
    }
  }

  /**
   * Tell the coordinator this region is still there (#853).
   *
   * Silent until there is a coordinator to tell, and while the registration
   * stands refused: a refused region is deliberately not in the coordinator's
   * map (#633), so a beat could only be ignored, and re-sending one every
   * interval is the hammering the refusal latch exists to stop.
   *
   * Sent through {@link tellCoordinatorRef} rather than `tellCoordinator`,
   * which re-enters {@link ensureRegistered} when there is no ref — re-running
   * the whole register loop off a liveness timer is exactly the coupling the
   * dedicated frame exists to avoid.  There is nothing to recover here anyway:
   * `ensureRegistered` already runs off every cluster event and its own retry.
   */
  private sendRegionHeartbeat(): void {
    const coordinator = this.coordinatorRef;
    if (!coordinator || this.registerRefused) return;
    const heartbeat: RegionHeartbeat = {
      kind: 'sharding.RegionHeartbeat',
      // Byte-identical to what `register()` sent, or the coordinator's
      // `regionKey` misses and the beat silently refreshes nothing.
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    try {
      this.tellCoordinatorRef(coordinator, heartbeat);
    } catch (error) {
      // A transport that is momentarily down must not take the timer with it:
      // the next beat is the retry, and `stale-after` is several intervals wide
      // precisely so a lost one is not a verdict.
      this.log.debug(
        `[sharding] could not beat to the coordinator for '${this.config.typeName}'`,
        error,
      );
    }
  }

  /**
   * An envelope addressed to this region arrived from `from`, whose identity
   * the transport authenticated (#584).
   *
   * Re-enqueued through `self.tell` so the region still processes it on its own
   * turn — the handler runs on the receive path, not in the actor.  Only a
   * sharding frame gets the wrapper: a region is also a legitimate target for
   * *user* messages, which `deliverRemote` forwards raw when there is no sender
   * to correlate, and those route by `extractEntityId` exactly as a local tell
   * does.  Nothing is lost by leaving them unwrapped — no user message can
   * reach a coordinator-only arm, since those dispatch on a `sharding.` kind.
   */
  private onRemoteEnvelope(envelope: EnvelopeMessage, from: NodeAddress): void {
    if (isShardingMessage(envelope.body)) {
      this.self.tell(new AuthenticatedShardingMessage(from, envelope.body));
      return;
    }
    this.self.tell(envelope.body as TMessage);
  }

  override postStop(): void {
    this.unsubscribe?.();
    this.envelopeUnsubscribe?.();
    this.passivationTimer?.cancel();
    this.registerTimer?.cancel();
    this.heartbeatTimer?.cancel();
    this.asksSweepTimer?.cancel();
    this.entityRecoveryTimer?.cancel();
    // A wait outliving the region would tick into a mailbox nobody reads; the
    // records go with it, since a restart builds a fresh region anyway.
    for (const record of this.shardFailures.values()) record.timer?.cancel();
    this.shardFailures.clear();
    this.tellCoordinatorTerminated();
    // A stopped region routes and hosts nothing, whatever a coordinator last
    // acknowledged — so `isRegistered` must not keep the node in rotation
    // (#1465).  A restart builds a fresh instance, which registers and
    // announces itself again from `preStart`.
    this.config.onRegistrationLost?.();
  }

  /**
   * Tell the coordinator this region is gone (#648).
   *
   * Without it the only thing that ever removes a region from the coordinator's
   * registry is `MemberRemoved`, so stopping a region on a node that stays in
   * the cluster left its shards allocated to an actor that no longer exists:
   * the coordinator kept answering `GetShardHome` with the dead region, senders
   * cached that home and delivered into a stopped cell, and nothing self-healed
   * — the coordinator checks a candidate's node for being `up`, never the
   * region itself for being alive, so the rebalance tick saw a perfectly
   * balanced cluster.
   *
   * Ordering is already safe: `postStop` runs only once every child has
   * terminated, so the entities are provably gone before the coordinator is
   * free to place their shards elsewhere.  Sent directly rather than through
   * `tellCoordinator`, which would re-enter the register loop (and arm a timer)
   * on a region that is shutting down.
   */
  private tellCoordinatorTerminated(): void {
    const coordinator = this.coordinatorRef;
    if (!coordinator) return;
    const terminated: RegionTerminated = {
      kind: 'sharding.RegionTerminated',
      // Must be byte-identical to what `register()` sent, or the coordinator's
      // `regionKey` misses and `onRegionTerminated` silently no-ops.
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    try {
      this.tellCoordinatorRef(coordinator, terminated);
    } catch (error) {
      // A transport that is already down on the shutdown path must not turn
      // into a failed `postStop`; the `MemberRemoved` route still covers it.
      this.log.debug(
        `[sharding] could not tell the coordinator that region '${this.config.typeName}' stopped`,
        error,
      );
    }
  }

  override onReceive(
    message:
      | TMessage
      | ShardingMessage
      | AuthenticatedShardingMessage
      | Terminated
      | Passivate
      | EntityRecoveryTick
      | PassivationSweepTick
      | AsksSweepTick
      | ShardRespawnTick
      | ShardPassivationDeclined,
  ): void {
    if (message instanceof EntityRecoveryTick) {
      this.onEntityRecoveryTick();
      return;
    }
    if (message instanceof ShardRespawnTick) {
      this.onShardRespawnTick(message);
      return;
    }
    if (message instanceof PassivationSweepTick) {
      this.onPassivationSweepTick();
      return;
    }
    if (message instanceof ShardPassivationDeclined) {
      this.onShardPassivationDeclined(message);
      return;
    }
    if (message instanceof AsksSweepTick) {
      this.onAsksSweepTick();
      return;
    }
    if (message instanceof AuthenticatedShardingMessage) {
      this.handleShardingMessage(message.message, message.peer);
      return;
    }
    if (isShardingMessage(message)) {
      this.handleShardingMessage(message, null);
      return;
    }
    if (message instanceof Terminated) {
      this.handleShardTerminated(message);
      return;
    }
    if (message instanceof Passivate) {
      this.handlePassivate(message);
      return;
    }
    this.routeMessage(message as TMessage, this.sender.toNullable());
  }

  /* ----------------------------- Routing -------------------------------- */

  /**
   * The single entry point for anything bound for an entity.  Two shapes get
   * here: a plain user message, whose entity id comes out of
   * `extractEntityId`, and an {@link EntityEnvelope} from an
   * {@link EntityRef}, which names its entity outright.  Everything after the
   * id is resolved is identical, so both go through {@link route}.
   */
  private routeMessage(message: RoutableMessage<TMessage>, sender: ActorRef | null): void {
    if (isEntityEnvelope(message)) {
      this.route(message.entityId, message.message as TMessage, message, sender);
      return;
    }
    const entityId = this.config.extractEntityId(message);
    const entityMessage = this.config.extractEntityMessage(message) as TMessage;
    this.route(entityId, entityMessage, message, sender);
  }

  /**
   * @param entityMessage what the entity itself receives when the shard is local
   * @param forwardMessage what gets buffered or handed to a remote region — the
   *   *un*-extracted form, so a replay or a second hop re-derives the id the
   *   same way this one did
   */
  private route(
    entityId: string,
    entityMessage: TMessage,
    forwardMessage: RoutableMessage<TMessage>,
    sender: ActorRef | null,
  ): void {
    const shardId = hashShardId(entityId, this.config.numShards);

    if (this.shardCannotTakeMessages(shardId)) {
      // The shard actor is on its way out, or gone and backing off; hold the
      // message until its `Terminated` says where the work goes next, or until
      // the respawn tick brings the shard back (#1437).
      this.bufferShard(shardId, forwardMessage, sender);
      return;
    }

    const ownerPath = this.shardHomes.get(shardId);
    if (!ownerPath) {
      this.bufferShard(shardId, forwardMessage, sender);
      this.askCoordinator(shardId);
      return;
    }

    if (this.localShards.has(shardId)) {
      this.deliverLocal(shardId, entityId, entityMessage, sender);
    } else {
      const node = this.shardHomeNodes.get(shardId);
      if (!node) { this.bufferShard(shardId, forwardMessage, sender); this.askCoordinator(shardId); return; }
      this.deliverRemote(node, ownerPath, forwardMessage, sender);
    }
  }

  /**
   * Whether a shard of this region's has no actor that can take a message now:
   * the one registered has been told to stop — a hand-off or a passivation — or
   * there is none, the shard backing off after a failure (#1437).
   *
   * One rule for every door into a shard.  `route` buffered in these states
   * from the start, but `onToShard` and `shardRef` asked `ensureShard`, which
   * returns whatever actor is registered, the stopping one included, so a
   * frame or a ref that arrived inside a hand-off or a passivation went down
   * with the actor.
   */
  private shardCannotTakeMessages(shardId: number): boolean {
    const state = this.shardState.get(shardId);
    return state === 'handing-off' || state === 'passivating' || state === 'backing-off';
  }

  private deliverLocal(shardId: number, entityId: string, message: TMessage, sender: ActorRef | null): void {
    if (this.config.proxy) {
      // Proxy regions should not own shards; this is a routing bug.
      this.log.warn(`proxy region got shard ${shardId} unexpectedly`);
      return;
    }
    this.recordActivity(shardId, entityId);
    // Forward the original sender so that ask-pattern replies bypass region
    // and shard and reach the caller directly.
    this.ensureShard(shardId).tell({ kind: 'sharding.EntityEnvelope', entityId, message }, sender);
  }

  /**
   * Stamp an entity as active — and, when this is the first message for a
   * not-yet-existing entity, make room for it first.  A message for an entity
   * that is already passivating changes nothing: the shard buffers it, and
   * the entity's slot is accounted for until `EntityStopped` arrives.
   */
  private recordActivity(shardId: number, entityId: string): void {
    if (this.passivating.has(entityId)) return;
    const existing = this.entityActivity.get(entityId);
    if (!existing) {
      this.admitEntity(shardId, entityId);
      this.entityActivity.set(entityId, { shardId, lastActivity: Date.now() });
      // Traffic got there first, so a paced recovery no longer owes it a start
      // (#851) — dropped here, in the routing step, rather than when the
      // shard's spawn report comes back, so a batch that runs in between
      // cannot spend a slot on it.
      this.entityRecoveryQueued.delete(entityId);
      return;
    }
    existing.lastActivity = Date.now();
    this.passivationStrategy?.touch(entityId);
  }

  /**
   * Take a newly-resident entity into the cap and passivate whatever the
   * configured policy gives up for it (#82, #848).  A no-op without a cap.
   *
   * The cap is deliberately **per sharded type on this node, not node-wide and
   * not per shard**.  Per shard it would divide across a set that changes on
   * every rebalance, making the effective limit unpredictable; node-wide it
   * would need a budget shared between regions that know nothing about each
   * other.  Two started types therefore each get the whole `maxEntities`, and
   * the node's bound is their sum — which is the one part of this an operator
   * has to read rather than guess, so the docs say it in those words.
   *
   * Called from **both** admission points.  The routing one is obvious; the
   * other is `onEntityStarted`, which is how a `rememberEntities` recovery
   * materialises entities nothing has routed to yet.  Until #848 that path
   * wrote the entity index directly and never consulted the cap, so a node
   * handed a large registry walked straight past it.
   *
   * The cap stays a steady-state upper bound: between asking the shard to stop
   * the victim and `EntityStopped` landing, the node briefly holds
   * `maxEntities + 1` entities.  Blocking the incoming message until the
   * passivation completed would be the alternative, and a worse one.
   */
  private admitEntity(shardId: number, entityId: string): void {
    const strategy = this.passivationStrategy;
    if (strategy === null) return;
    const victim = strategy.admit(entityId);
    if (victim === null) return;
    const victimShard = this.entityActivity.get(victim)?.shardId ?? shardId;
    this.log.debug(
      `[sharding] ${this.config.passivationReplacement} passivation: evicting '${victim}' to make room `
      + `for '${entityId}' (cap ${this.config.maxEntities} reached)`,
    );
    this.requestPassivation(victim, victimShard);
  }

  /**
   * Ask the shard that owns `entityId` to stop it gracefully.
   *
   * Dropping it from the replacement order here rather than on `EntityStopped`
   * is what keeps "already passivating does not count toward capacity" true —
   * the rule the linear scan this replaced expressed by skipping
   * {@link passivating} entities while counting.  Both callers rely on it: an
   * eviction has already made room for its newcomer, and an idle sweep must not
   * leave the swept entity as the next victim as well.
   *
   * A victim on a shard whose actor is gone cannot be reached, and the entity's
   * own bookkeeping is left alone in that case: the strategy has released the
   * slot either way, and the idle sweep still names the entity if it is somehow
   * still running.
   */
  private requestPassivation(entityId: string, shardId: number): void {
    this.passivationStrategy?.remove(entityId);
    const shard = this.shards.get(shardId);
    if (!shard) return;
    this.passivating.add(entityId);
    shard.tell({ kind: 'sharding.PassivateEntity', entityId });
  }

  private deliverRemote(
    node: NodeAddress,
    path: string,
    message: RoutableMessage<TMessage>,
    sender: ActorRef | null,
  ): void {
    if (sender === null) {
      // Nothing to reply to — skip the envelope wrapping.
      new RemoteActorRef<RoutableMessage<TMessage>>(node, path, this.config.cluster).tell(message);
      return;
    }

    // Preserve an existing correlation if this sender is itself a proxy
    // for an upstream asker (multi-hop forwarding).  Otherwise register a
    // fresh correlation keyed to our local pendingAsks table so the reply
    // reaches this region.
    let originNode: NodeAddress;
    let originRegion: string;
    let correlationId: number;
    if (sender instanceof ShardSenderRef) {
      originNode = sender.originNode;
      originRegion = sender.originRegion;
      correlationId = sender.correlationId;
    } else {
      originNode = this.config.cluster.selfAddress;
      originRegion = this.self.path.toString();
      correlationId = this.registerPendingAsk(sender);
    }

    const envelope: ShardEnvelope = {
      kind: 'sharding.Envelope',
      message,
      originNode: originNode.toJSON(),
      originRegion,
      correlationId,
    };
    new RemoteActorRef<ShardingMessage>(node, path, this.config.cluster).tell(envelope);
  }

  private registerPendingAsk(sender: ActorRef): number {
    const id = ++this.nextCorrelation;
    this.pendingAsks.set(id, { sender, expireAt: this.system.clock.now() + this.asksTtlMs });
    return id;
  }

  /**
   * The sweep timer fired: forget every waiting caller whose time is up, in all
   * three tables (#1436).
   *
   * Only the remote-ask table used to be swept.  The two query tables drained
   * on an answer alone, so a query nobody answered — a shard id the coordinator
   * drops, a coordinator in the middle of an election, a type only proxied here
   * — held its caller for the life of the region.  Each `shardRefFor()` caller
   * expires on its own, and a shard nobody is waiting on any more is deleted
   * rather than left as an empty list.
   *
   * Read off `system.clock`, like the stamps it compares against, so a test can
   * move the time forward instead of waiting it out.  The two query tables are
   * logged at debug, one line per shard and per query, because a caller dropped
   * here has already seen its own ask time out and this is the only trace of
   * why the answer never came.
   */
  private onAsksSweepTick(): void {
    const now = this.system.clock.now();
    for (const [id, entry] of this.pendingAsks) {
      if (entry.expireAt <= now) this.pendingAsks.delete(id);
    }
    for (const [correlationId, entry] of this.pendingStatsAsks) {
      if (entry.expireAt > now) continue;
      this.pendingStatsAsks.delete(correlationId);
      this.log.debug(
        `[sharding] forgetting the unanswered shards() query ${correlationId} of '${this.config.typeName}': `
        + `no answer within ${this.asksTtlMs} ms`,
      );
    }
    for (const [shardId, waiting] of this.pendingLocationAsks) {
      const live = waiting.filter((entry) => entry.expireAt > now);
      const dropped = waiting.length - live.length;
      if (dropped === 0) continue;
      if (live.length === 0) this.pendingLocationAsks.delete(shardId);
      else this.pendingLocationAsks.set(shardId, live);
      this.log.debug(
        `[sharding] forgetting ${dropped} unanswered shardRefFor() caller(s) of shard ${shardId} `
        + `of '${this.config.typeName}': no answer within ${this.asksTtlMs} ms`,
      );
    }
  }

  /**
   * The shard actor for `shardId`, spawning it if there isn't one.
   *
   * Creation is driven by *ownership*, not by the first message: `onShardHome`
   * calls this the moment the coordinator says the shard lives here, so an
   * allocated-but-empty shard still has a live ref for anyone asking the
   * region to locate it.  Ownership itself is demand-driven — the coordinator
   * only allocates a shard someone asked about — so nothing here runs at
   * `ClusterSharding.start` time.
   */
  private ensureShard(shardId: number): ActorRef<ShardInbox> {
    const existing = this.shards.get(shardId);
    if (existing) return existing;
    const shardConfig = shardConfigFor(this.config, shardId);
    const ref = this.context.spawn<ShardInbox>(
      () => new Shard(shardConfig),
      `shard-${shardId}`,
    );
    this.context.watch(ref);
    this.shards.set(shardId, ref);
    // A fresh shard is an empty shard, so its idle clock starts now — that is
    // what lets a shard allocated but never used go away again on its own.
    this.shardEmptySince.set(shardId, Date.now());
    return ref;
  }

  /* ----------------------------- Coordinator ---------------------------- */

  private ensureRegistered(): void {
    const leaderOption = this.config.cluster.leader();
    if (leaderOption.isNone()) { this.scheduleRegisterRetry(); return; }
    const leader = leaderOption.value;
    // Always re-target the coordinator on each leader change.
    //
    // Built from the *leader's* system name, not ours.  An actor path carries
    // the system it belongs to, and this one is an address for somebody else's
    // actor — so guessing it from the local name only happens to work when every
    // member shares one, and produces a path the leader never registered when
    // they do not.  Generic path resolution used to paper over the difference by
    // dropping the `actor-ts://<system>` prefix and walking the local tree; that
    // is also the leg that arrives with no sender, so the coordinator's own
    // per-path handler — the thing that attributes the frame — was unreachable
    // for exactly those nodes (#712).
    const coordinatorLocation = coordinatorPath(leader.address.systemName, this.config.typeName);
    // Recorded before the ref is resolved: it is what the origin gate compares
    // against, and a directive can legitimately arrive while the local lookup
    // below is still failing.
    this.coordinatorNode = leader.address;
    if (leader.address.equals(this.config.cluster.selfAddress)) {
      const local = this.config.localResolver(coordinatorLocation) as ActorRef<ShardingMessage> | null;
      if (!local) { this.scheduleRegisterRetry(); return; }
      this.coordinatorRef = local;
    } else {
      this.coordinatorRef = new RemoteActorRef<ShardingMessage>(
        leader.address, coordinatorLocation, this.config.cluster,
      );
    }
    if (this.registerRefused) return;
    this.register();
  }

  private scheduleRegisterRetry(): void {
    this.registerTimer?.cancel();
    this.registerTimer = this.system.scheduler.scheduleOnceFunction(
      this.config.registerRetryIntervalMs,
      () => this.ensureRegistered(),
    );
  }

  /**
   * Claim this region with the coordinator — and keep claiming until it
   * answers one way or the other.
   *
   * `Register` is a fire-and-forget frame aimed at a path that need not exist
   * yet.  A node that joins and immediately takes leadership — the election
   * rule is "lowest address", so a replacement pod routinely does — has no
   * coordinator behind that path until its own `sharding.start(...)` runs, and
   * anything aimed at it inside that window is dropped by the receiving side
   * as an envelope with no handler.  Nothing re-sent it: `ensureRegistered`
   * runs off cluster events, and the events for that leadership move have
   * already fired by the time the frame is lost.
   *
   * The region then stayed silently *unregistered*, which is worse than being
   * refused (#633).  Unregistered means no ack and no refusal, so a region
   * that was hosting shards under the previous leader kept every one of them
   * and kept routing to them, while the new coordinator — which may govern the
   * type with a different `numShards` — never got the chance to say no.  The
   * retry is what makes the refusal reachable at all in the case it exists
   * for.
   *
   * Bounded by an answer rather than by a count: {@link onRegisterAcknowledgment}
   * and {@link onRegisterRefused} both cancel the timer, and a refusal
   * additionally stops {@link ensureRegistered} from re-entering here.
   */
  private register(): void {
    const message: RegisterRegion = {
      kind: 'sharding.Register',
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
      proxy: this.config.proxy,
      hostedShards: Array.from(this.localShards),
      numShards: this.config.numShards,
    };
    this.tellCoordinator(message);
    // Re-ask for every buffered shard's home.  The queries waiting on the
    // coordinator are asked again on the acknowledgment instead — see
    // `askAgainForPendingQueries` for why not here.
    for (const shardId of this.buffer.keys()) this.askCoordinator(shardId);
    this.scheduleRegisterRetry();
  }

  private tellCoordinator(message: ShardingMessage): void {
    if (!this.coordinatorRef) { this.ensureRegistered(); return; }
    this.tellCoordinatorRef(this.coordinatorRef, message);
  }

  /**
   * Send a frame to the coordinator, stamping this node's own identity on the
   * local leg.
   *
   * The coordinator honours a region's claims only when they arrive attributed
   * to the node making them (#712), and the remote leg gets that for free — the
   * receiving node's per-path envelope handler stamps the connection's peer on
   * the way in.  A bare local `tell` gets nothing, and is byte-identical to what
   * an attacker's frame produces after the generic path walk, so the local leg
   * has to build the wrapper itself.  Exactly the mirror of what
   * `ShardCoordinator.replyTo` already does in the other direction (#584);
   * without it a leader-hosted region — every region on a single-node cluster —
   * could not register at all.
   */
  private tellCoordinatorRef(ref: ActorRef<ShardingMessage>, message: ShardingMessage): void {
    const coordinator = this.coordinatorNode;
    if (coordinator === null || !coordinator.equals(this.config.cluster.selfAddress)) {
      ref.tell(message);
      return;
    }
    (ref as ActorRef<ShardingMessage | AuthenticatedShardingMessage>)
      .tell(new AuthenticatedShardingMessage(this.config.cluster.selfAddress, message));
  }

  /**
   * Ask the coordinator where `shardId` lives.
   *
   * Silent while the registration stands refused (#633).  A refused region's
   * ids come from a different modulus, so an answer would place the same
   * entity a second time — which is why `ShardCoordinator.onGetShardHome`
   * drops the request at the other end regardless.  Not sending it is what
   * turns "buffer until the configuration agrees" into a quiet stall instead
   * of one frame per message aimed at the leader, and it costs nothing:
   * {@link register} re-asks for every buffered shard the moment a leader
   * change clears the refusal.
   */
  private askCoordinator(shardId: number): void {
    if (this.registerRefused) return;
    const getShardHome: GetShardHome = {
      kind: 'sharding.GetShardHome',
      shardId,
      requester: this.self.path.toString(),
      requesterNode: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(getShardHome);
  }

  /* ---------------------------- Sharding msgs -------------------------- */

  /**
   * @param peer the node whose authenticated connection the frame arrived on,
   *   or `null` for a frame that reached the mailbox unattributed — a plain
   *   local `tell`, or an inbound envelope that dodged the per-path handler.
   *   The coordinator-only arms refuse the second case outright.
   */
  private handleShardingMessage(message: ShardingMessage, peer: NodeAddress | null): void {
    match(message)
      .with({ kind: 'sharding.RegisterAcknowledgment' }, (m) => this.onRegisterAcknowledgment(m, peer))
      .with({ kind: 'sharding.RegisterRefused' }, (m) => this.onRegisterRefused(m, peer))
      .with({ kind: 'sharding.RegionEvicted' }, (m) => this.onRegionEvicted(m, peer))
      .with({ kind: 'sharding.ShardHome' }, (m) => this.onShardHome(m, peer))
      .with({ kind: 'sharding.HandOff' }, (m) => this.onHandOff(m, peer))
      .with({ kind: 'sharding.RememberedEntities' }, (m) => this.onRememberedEntities(m, peer))
      .with({ kind: 'sharding.Envelope' }, (m) => this.onShardEnvelope(m))
      .with({ kind: 'sharding.Reply' }, (m) => this.onShardReply(m))
      // An EntityRef addressed one of our entities by id.
      .with({ kind: 'sharding.EntityEnvelope' }, (m) => this.onEntityEnvelope(m))
      // Someone on another node told a ref to one of our shards.
      .with({ kind: 'sharding.ToShard' }, (m) => this.onToShard(m))
      // Lifecycle reports coming up from our own shards.
      .with({ kind: 'sharding.EntityStarted' }, (m) => this.onEntityStarted(m))
      .with({ kind: 'sharding.EntityStopped' }, (m) => this.onEntityStopped(m))
      // Introspection — node-local queries plus the coordinator's fan-out.
      .with({ kind: 'sharding.GetShards' }, (m) => this.onGetShards(m))
      .with({ kind: 'sharding.GetShardLocation' }, (m) => this.onGetShardLocation(m))
      .with({ kind: 'sharding.GetShardRegionStats' }, (m) => this.onGetShardRegionStats(m))
      .with({ kind: 'sharding.ClusterShardingStats' }, (m) => this.onClusterShardingStats(m))
      .with({ kind: 'sharding.ShardMapUpdate' }, (m) => this.onShardMapUpdate(m, peer))
      // Every other `sharding.` kind — see `onUnhandled` for what that is.
      .otherwise((m) => this.onUnhandled(m));
  }

  /**
   * A `sharding.` kind no arm above claims.  Three things land here, none of
   * them for a region: a kind only the coordinator handles, from a peer or a
   * local caller; a kind this build does not know at all, since
   * `isShardingMessage` admits anything with the `sharding.` prefix and a
   * newer member's protocol therefore arrives here intact; and a shard message
   * — `sharding.StartEntity`, `sharding.GetShardStats` — told to the region
   * instead of to a shard ref, which the region does not forward.
   *
   * Declined through `unhandled`, so it is a dead letter naming this region
   * and a tick of `actor_unhandled_total{class="ShardRegion"}` — the drift
   * signal a rolling upgrade produces.  On the peer path the letter carries no
   * sender: the frame was re-enqueued without one, and the peer survives only
   * as the wrapper's attribution, which is not a ref.  Healthy traffic never
   * reaches this arm — `tests/multi-node/ShardingUnhandledArms.test.ts` holds
   * the counter at zero across every kind of it.
   */
  private onUnhandled(message: ShardingMessage): void { this.unhandled(message); }

  /**
   * Whether a coordinator directive may be honoured.
   *
   * Everything the coordinator tells a region is destructive to some degree —
   * `HandOff` stops every entity under a shard, `RegionEvicted` stops every
   * entity under *every* shard, `ShardHome` moves ownership, `ShardMapUpdate`
   * publishes an allocation map to every local subscriber — and until #584 the
   * region applied all of it on nothing but the `kind` string.  Two conditions
   * have to hold: the frame arrived inside an
   * {@link AuthenticatedShardingMessage}, which the wire cannot mint, *and* the
   * peer that sent it is the node this region currently believes hosts the
   * coordinator.  The second half is not redundant — an authenticated peer is
   * any cluster member, and the wrapper alone would let any of them issue
   * directives.
   *
   * Refusing is safe: the region re-registers and re-asks for every buffered
   * shard on the next leader/membership event, so a directive dropped during a
   * leadership handover is re-requested rather than lost.
   */
  private fromCoordinator(message: ShardingMessage, peer: NodeAddress | null): boolean {
    if (peer !== null && this.coordinatorNode !== null && peer.equals(this.coordinatorNode)) return true;
    this.log.warn(
      `[sharding] refusing '${message.kind}' for '${this.config.typeName}' from `
      + `${peer ?? 'an unauthenticated sender'} — only the coordinator's node `
      + `(${this.coordinatorNode ?? 'not yet known'}) may issue it`,
    );
    return false;
  }

  private onShardEnvelope(message: ShardEnvelope): void {
    const senderRef =
      message.correlationId !== null && message.originRegion !== null && message.originNode !== null
        ? new ShardSenderRef(
            NodeAddress.fromJSON(message.originNode),
            message.originRegion,
            message.correlationId,
            this.config.cluster,
            (path) => this.config.localResolver(path),
          )
        : null;
    // The payload may itself be an EntityEnvelope — an EntityRef whose entity
    // turned out to live on this node.  routeMessage sorts that out.
    this.routeMessage(message.message as RoutableMessage<TMessage>, senderRef);
  }

  private onEntityEnvelope(message: EntityEnvelope): void {
    this.routeMessage(message, this.sender.toNullable());
  }

  /**
   * A shard ref was told something — a {@link RemoteShardRef} on another node,
   * or a {@link RelayedShardRef} this region handed out.  We own the shard, so
   * we are the only one who can guarantee an actor exists to take it —
   * `ensureShard` re-creates a shard that had passivated (#901).
   *
   * Not while the shard cannot take it, though: a frame for a shard handing
   * off, passivating or backing off waits like a routed message
   * ({@link holdForAbsentShard}), since `ensureShard` would hand it to an actor
   * already told to stop.  And a frame for a shard that is no longer ours — a
   * ref handed out before the shard moved, or a peer that still believes it
   * lives here — goes where the shard went ({@link relayToShardElsewhere}).
   *
   * The sender travels through, so an `ask` against a remote shard ref gets
   * its reply the same way a local one does.
   */
  private onToShard(message: ToShard): void {
    if (this.config.proxy) return;
    if (!this.localShards.has(message.shardId)) {
      this.relayToShardElsewhere(message);
      return;
    }
    if (this.shardCannotTakeMessages(message.shardId)) {
      this.holdForAbsentShard(message);
      return;
    }
    this.ensureShard(message.shardId).tell(message.message as never, this.sender.toNullable());
  }

  /**
   * A shard ref was told something while its shard cannot take it — handing
   * off, passivating, or backing off after a failure (#1437).
   *
   * An entity envelope waits in the region buffer like a routed message, which
   * is what it is: the replay routes it by its entity, the only way anything
   * in the buffer comes back out.  Every other message a shard ref can carry —
   * a start, a stats query — names no entity to route by, so it goes to dead
   * letters with its sender rather than to the stopping actor, or re-creating
   * a backing-off shard to receive it.
   */
  private holdForAbsentShard(message: ToShard): void {
    const sender = this.sender.toNullable();
    if (isEntityEnvelope(message.message)) {
      this.bufferShard(message.shardId, message.message, sender);
      return;
    }
    this.system.deadLetters.tell(new DeadLetter(message.message, sender, this.self));
  }

  /**
   * A shard ref was told something for a shard that is not ours any more.
   *
   * An entity envelope is routed by its entity, like any message, so it finds
   * the shard's current home — buffered while that is being looked up.  What
   * made this reachable is a relayed ref handed out during a hand-off: it has
   * to keep working after the shard has gone, the way a ref to a remote shard
   * does.  Anything else goes to dead letters with its sender; it used to be
   * dropped without a trace.
   */
  private relayToShardElsewhere(message: ToShard): void {
    const sender = this.sender.toNullable();
    if (isEntityEnvelope(message.message)) {
      this.routeMessage(message.message, sender);
      return;
    }
    this.system.deadLetters.tell(new DeadLetter(message.message, sender, this.self));
  }

  private onShardReply(message: ShardReply): void {
    const entry = this.pendingAsks.get(message.correlationId);
    if (!entry) return;
    this.pendingAsks.delete(message.correlationId);
    entry.sender.tell(message.message as never);
  }

  private onRegisterAcknowledgment(message: RegisterAcknowledgment, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    this.log.debug(`[sharding] region '${this.config.typeName}' registered with coordinator`);
    this.registerRefused = false;
    this.registerTimer?.cancel();
    this.registerTimer = null;
    this.askAgainForPendingQueries();
    // Published only on the transition — see the field's own note.  It goes on
    // the node-local bus like `ShardMapChanged`, because it describes what
    // happened on this node; `cluster.eventStream.bridge(...)` is how a
    // watcher collects every node's.
    if (this.registrationAnnounced) return;
    this.registrationAnnounced = true;
    this.config.cluster._publishClusterEvent(
      new ShardRegionRegistered(this.config.typeName, this.config.proxy),
    );
  }

  /**
   * Ask the coordinator again for every `shards()` and `shardRefFor()` query
   * still waiting, now that one has acknowledged this region (#1436).
   *
   * A query made before the region registered went nowhere.  With no
   * coordinator ref yet the request was never sent, and with a ref to a leader
   * that has not started the type it reached a path nobody serves and was
   * dropped — while a message routed in the same window was buffered and
   * re-asked for by {@link register}.  So the query timed out and the message
   * arrived, which is not what "exactly what a first message would have done"
   * promises.
   *
   * Asked here rather than in {@link register}, for two reasons.  An
   * acknowledgment proves a coordinator is there to answer.  And it arrives on
   * the region's own turn, while `register` also runs from the register retry
   * timer and the cluster-event callback, beside the mailbox: reading these two
   * tables there would hand them to exactly the off-turn access the asks sweep
   * runs on a tick to avoid.
   *
   * Every acknowledgment asks, a leader change's included, so a query in
   * flight to a coordinator that went away is asked of its successor too.  A
   * query whose first request did arrive is answered twice at most; the second
   * answer finds nobody waiting and is dropped.
   */
  private askAgainForPendingQueries(): void {
    for (const shardId of this.pendingLocationAsks.keys()) this.askCoordinator(shardId);
    for (const [correlationId, pending] of this.pendingStatsAsks) {
      this.askCoordinatorForStats(correlationId, pending.timeoutMs);
    }
  }

  /**
   * The coordinator rejected this region's configuration (#633).
   *
   * Logged at error rather than thrown: `start()` has long returned by the
   * time a coordinator answers, and throwing here would only restart the
   * region into the same rejection.  The region stays up and keeps buffering,
   * which is the fail-stop the alternative lacks — an accepted mismatch routes
   * the same entity id into two different shards and runs two live instances
   * of it, one per node, at paths that never collide.
   *
   * Buffering is only half of the fail-stop, though, and the other half is
   * {@link releaseShardsAfterRefusal}: refusing a registration closes the
   * front door, and a region that was *already* hosting shards when the
   * refusal arrived has to be emptied through the back one.
   *
   * This message *is* the whole of the issue's "clear rejection" criterion, and
   * it named a HOCON key that does not exist — `actor-ts.sharding.num-shards`,
   * against a `reference.conf` that ships `number-of-shards`.  It is built from
   * {@link ConfigKeys} now rather than spelled out, because that is the one
   * source of truth for a key path and no test can catch a wrong string in a
   * free-text log line: `NoDeadConfigKeys` walks `reference.conf` →
   * `ConfigKeys`, so an *invented* key is outside its direction of travel.
   */
  private onRegisterRefused(message: RegisterRefused, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    this.registerRefused = true;
    // A refused region is not registered, whatever it was a moment ago: the
    // shards it held are released below, and nothing more will be allocated to
    // it.  Clearing this is also what makes a later acknowledgment a real
    // transition again rather than a silent one.
    this.registrationAnnounced = false;
    this.registerTimer?.cancel();
    this.registerTimer = null;
    this.log.error(
      `[sharding] the coordinator refused to register region '${this.config.typeName}': `
      + `numShards must match across the cluster, but this node is configured with `
      + `${message.regionNumShards} and the coordinator governs the type with ${message.numShards}. `
      + `No shard will be allocated here and messages for this type will keep buffering until the `
      + `configuration agrees. Set the same numShards on every node that starts or proxies this type `
      + `(explicitly, or via ${ConfigKeys.sharding.numberOfShards}).`,
    );
    // The log line above was the *whole* of the operator-visible signal, and a
    // log line is not something an alert can be built on (#1300).  The counter
    // follows the label shape of `cluster_gossip_records_refused_total`, which
    // is the exact analogue one layer up; the event is what a supervisor or a
    // readiness probe can react to without scraping.
    metricsOf(this.system).counter(
      'cluster_sharding_registrations_refused_total',
      { type: this.config.typeName, reason: 'num-shards-mismatch' },
      { help: 'Cumulative count of shard-region registrations a coordinator refused.' },
    ).inc();
    this.config.cluster._publishClusterEvent(
      new ShardRegionRegistrationRefused(
        this.config.typeName,
        'num-shards-mismatch',
        message.regionNumShards,
        message.numShards,
      ),
    );
    this.releaseShardsAfterRefusal();
  }

  /**
   * Give up every shard this region still hosts, because the coordinator that
   * governs the type has refused it (#633).
   *
   * A refusal used to leave the region's own ownership untouched, which made
   * it a fix only for a region that had nothing yet.  One accepted by leader N
   * and refused by leader N+1 — what a rolling deploy that changes `numShards`
   * produces the moment leadership reaches an already-updated node — kept the
   * `shardHomes` and `localShards` the first coordinator gave it, kept
   * delivering straight out of that cache in {@link route}, and could never be
   * relieved of them: `ShardCoordinator.beginHandOff` only writes to regions it
   * has in `regions`, and a refused one is not there.  So the split routing the
   * refusal exists to prevent survived, reached through a leadership move
   * rather than a fresh start.
   *
   * The mechanics are {@link releaseEverything}'s, shared with the staleness
   * eviction (#853); what is specific to a refusal is that nothing here comes
   * back on its own, which is what the log line has to say.
   */
  private releaseShardsAfterRefusal(): void {
    const released = this.releaseEverything();
    if (released === 0) return;
    this.log.warn(
      `[sharding] giving up the ${released} shard(s) of '${this.config.typeName}' this refused `
      + `region was still hosting; their entities stop here and stay stopped until the configured `
      + `numShards agrees with the coordinator's`,
    );
  }

  /**
   * The coordinator removed this region from its registry and re-homed the
   * shards it held (#853).
   *
   * There are two ways a region stops being registered without having asked,
   * and this is the second one.  A refusal (#633) is a verdict about the
   * region's *configuration* and latches: nothing it can do makes it welcome
   * again until an operator changes `numShards`.  An eviction is a verdict
   * about its *liveness*, reached from the absence of a beat, and the region
   * receiving this frame is by construction evidence the verdict was wrong —
   * a region that is really gone or wedged never gets here, and the eviction
   * simply stands.
   *
   * So the release is the same and the sequel is the opposite: register again,
   * immediately.  Standing down without re-registering would trade the
   * double-hosting for a live node in the cluster hosting nothing — nothing
   * else would put it back, since `ensureRegistered` re-enters only from a
   * leader or membership change and the register retry was cancelled by the
   * acknowledgment this eviction has just annulled.
   *
   * The re-registration cannot loop.  `ShardCoordinator.onRegister` carries
   * `lastHeartbeatAtMs` across only a *surviving* entry, so the rebuilt one has
   * never beaten to that coordinator and is not a sweep candidate at all until
   * a beat of this region's actually arrives.
   */
  private onRegionEvicted(message: RegionEvicted, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    const released = this.releaseEverything();
    // `stale-after` is named in prose, and this region reads neither leaf —
    // `readShardingOptionsFromConfig` does.
    this.log.warn(
      `[sharding] the coordinator evicted this region of '${this.config.typeName}' after hearing `
      + `nothing from it for ${message.silentForMs} ms and re-homed its shards; giving up the `
      + `${released} shard(s) still hosted here and registering again. A node that is plainly `
      + `healthy seeing this is beating every ${this.config.regionHeartbeatIntervalMs} ms into a `
      + `stale-after that is too tight for it, or its beats are being lost on the way.`,
    );
    // The region is unregistered as of now, so the next acknowledgment is a
    // real transition again rather than a silent one — same reason as the
    // refusal path — and `ClusterSharding.isRegistered` stops saying otherwise
    // until that acknowledgment lands (#1465).
    this.registrationAnnounced = false;
    this.config.onRegistrationLost?.();
    this.ensureRegistered();
  }

  /**
   * Drop every shard this region hosts and every cached home it routes by, and
   * report how many shard actors were stopped.
   *
   * Shared by the two paths that take a region's registration away from it
   * without its consent — a `numShards` refusal (#633) and a staleness eviction
   * (#853).  The caller logs, because what an operator should do about the two
   * could not be more different, and only the caller knows which happened.
   *
   * The release is unilateral and tells the coordinator nothing, because there
   * is nothing to tell: it does not believe this region owns anything, so a
   * `HandOffComplete` would name a shard it has already given to somebody else.
   *
   * Order is what keeps it loss-free, and it is the order {@link onHandOff} and
   * {@link passivateShard} already use — ownership goes *synchronously*, before
   * a single `stop()`, so nothing routed from here on can land in a mailbox
   * that is already draining; it finds no home and buffers instead.  The shard
   * actors then go through their own stop rather than being dropped, so the
   * entities beneath them run `postStop` and a persistent one flushes, and
   * {@link completeShardRelease} closes the loop when the `Terminated` watch
   * reports them gone.
   */
  private releaseEverything(): number {
    this.shardHomes.clear();
    this.shardHomeNodes.clear();
    this.localShards.clear();
    this.shardState.clear();
    this.registriesHeldThroughPassivation.clear();
    // A backing-off shard has no actor to stop, so the loop below never sees
    // it — but it is given up all the same, and its wait with it (#1437).
    for (const shardId of Array.from(this.shardFailures.keys())) this.dropShardFailure(shardId);
    const hosted = Array.from(this.shards.entries());
    for (const [shardId, shard] of hosted) {
      // A shard already on its way out for another reason is still ours to
      // release, and the release supersedes both: neither outcome — a handoff
      // acknowledged to the coordinator, or ownership kept across a
      // passivation — is available to a region the coordinator does not know.
      this.handingOff.delete(shardId);
      this.passivatingShards.delete(shardId);
      this.releasingShards.add(shardId);
      this.forgetShardEntities(shardId);
      shard.stop();
    }
    return hosted.length;
  }

  /**
   * A shard id is `hash(entityId) % numShards`, so anything outside the range
   * did not come from an honest allocation.  It matters here more than
   * elsewhere because `ensureShard` turns the id into a **child actor name**:
   * an out-of-range or non-integer id minted a permanent child under an
   * attacker-chosen name, and the region has no way to tell it apart from a
   * real shard afterwards (#569).
   */
  private isKnownShardId(shardId: number): boolean {
    if (this.isShardIdInRange(shardId)) return true;
    this.log.warn(
      `[sharding] ignoring shard id ${shardId} for '${this.config.typeName}' — `
      + `outside 0..${this.config.numShards - 1}`,
    );
    return false;
  }

  /**
   * Whether `shardId` can be a shard of this type at all — an integer in
   * `0..numShards - 1`.  The predicate under {@link isKnownShardId}, without
   * its warning: a caller's own bad argument is answered, not logged.
   */
  private isShardIdInRange(shardId: number): boolean {
    return Number.isInteger(shardId) && shardId >= 0 && shardId < this.config.numShards;
  }

  /**
   * Whether a `HandOff` for `shardId` has anything to hand off (#584).
   *
   * The origin gate answers *who* may order a handoff; this answers *what* one
   * can be ordered for, and the arm had neither an ownership nor an idempotence
   * precondition.  A `HandOff` for a shard this region does not own still marked
   * it `'handing-off'`, acknowledged, and — since `shards.get(shardId)` was
   * `undefined` — fell straight into `completeHandOff`, which deletes
   * `shardHomes`, `shardHomeNodes` and `shardState` for the id and announces a
   * `HandOffComplete`.  That is a routing-cache eviction for a shard the region
   * was never handing off, reachable by replaying one authentic frame: the
   * coordinator issues `HandOff` once per rebalance, but `Transport` flushes
   * frames buffered before a handshake completed, so a genuine one can also
   * land *late*, long after the coordinator's `handOffTimeoutMs` already
   * force-reallocated the shard.
   *
   * `localShards`, deliberately not `shards`: a shard whose actor has passivated
   * (#901) has no `shards` entry and is still legitimately owned, so it must
   * still hand off.  `handingOff` covers the window in between — the shard actor
   * is stopping and `handleShardTerminated` will complete the handoff, so a
   * second directive has nothing left to add.
   *
   * The cost of refusing is bounded and self-healing: the coordinator only ever
   * sends `HandOff` to the region its own `shardHome` names, so a refusal means
   * the two disagree about ownership — and the `handOffTimeoutMs` fallback
   * (`ShardCoordinator.beginHandOff`) exists for exactly that, force-reallocating
   * the shard instead of waiting forever.
   */
  private ownsShardToHandOff(shardId: number): boolean {
    if (this.handingOff.has(shardId)) {
      this.log.debug(
        `[sharding] shard ${shardId} of '${this.config.typeName}' is already handing off; `
        + `ignoring the duplicate directive`,
      );
      return false;
    }
    if (this.localShards.has(shardId)) return true;
    this.log.warn(
      `[sharding] refusing to hand off shard ${shardId} of '${this.config.typeName}' — `
      + `this region does not own it, so there is nothing to give up`,
    );
    return false;
  }

  private onShardHome(message: ShardHome, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    // A placement that crossed the refusal in flight is the split routing
    // itself, arriving a moment late — taking it would re-host precisely what
    // `releaseShardsAfterRefusal` just gave up (#633).  Dropping it loses
    // nothing: `register()` re-asks for every buffered shard as soon as a
    // leader change clears the refusal.
    if (this.registerRefused) return;
    if (!this.isKnownShardId(message.shardId)) return;
    const node = NodeAddress.fromJSON(message.node);
    const local = node.equals(this.config.cluster.selfAddress) && message.region === this.self.path.toString();
    this.log.debug(
      `[sharding] shard ${message.shardId} of '${this.config.typeName}' home=${node} (${local ? 'LOCAL' : 'remote'})`,
    );
    this.shardHomes.set(message.shardId, message.region);
    this.shardHomeNodes.set(message.shardId, node);
    if (local) {
      this.localShards.add(message.shardId);
      // A shard backing off stays down until its tick (#1437): a placement the
      // coordinator repeats — a leader change re-registers every region — is no
      // reason to re-create a shard that keeps failing.  Whoever waits for its
      // location still gets an answer, a ref that relays through this region.
      if (this.shardState.get(message.shardId) === 'backing-off') {
        this.flushLocationAsks(message.shardId);
        return;
      }
      this.shardState.set(message.shardId, 'owned');
      if (!this.config.proxy) this.ensureShard(message.shardId);
    } else {
      this.localShards.delete(message.shardId);
      this.shardState.delete(message.shardId);
      // Moved away: a backoff it was under is not this region's to finish, and
      // what waited for it flushes to the new home below.
      this.dropShardFailure(message.shardId);
    }
    // Order matters: the shard actor has to exist before anyone is handed a
    // ref to it, and the ref answers before the buffered traffic replays.
    this.flushLocationAsks(message.shardId);
    this.flushBuffer(message.shardId);
  }

  /* ---------------------------- Introspection --------------------------- */

  /**
   * `ClusterSharding.shards()` asking its own region.  The region is an actor
   * with a resolvable path, so it can do the cross-node half through the
   * coordinator and hand the answer back to the in-process asker — which is
   * why the public API is a method on a plain object and still works from
   * any node.
   */
  private onGetShards(message: GetShards): void {
    const asker = this.sender.toNullable();
    if (!asker) return;
    const correlationId = ++this.nextStatsCorrelation;
    this.pendingStatsAsks.set(correlationId, {
      asker,
      expireAt: this.system.clock.now() + this.asksTtlMs,
      timeoutMs: message.timeoutMs,
    });
    this.askCoordinatorForStats(correlationId, message.timeoutMs);
  }

  private askCoordinatorForStats(correlationId: number, timeoutMs: number): void {
    this.tellCoordinator({
      kind: 'sharding.GetClusterShardingStats',
      correlationId,
      requester: this.self.path.toString(),
      requesterNode: this.config.cluster.selfAddress.toJSON(),
      timeoutMs,
    });
  }

  private onClusterShardingStats(message: ClusterShardingStats): void {
    const pending = this.pendingStatsAsks.get(message.correlationId);
    if (!pending) return;
    this.pendingStatsAsks.delete(message.correlationId);
    pending.asker.tell(message.shards.map((location) => this.toShardInfo(location)) as never);
  }

  /**
   * `ClusterSharding.shardRefFor()`.  An unplaced shard is not an error — ask
   * the coordinator, which allocates it exactly as a normal message would,
   * and answer once its home is known.
   *
   * An id that cannot be a shard of this type is, and it is answered at once
   * (#1436).  The coordinator drops a request for it, so queueing the caller
   * only made it wait out its whole timeout for an `AskTimeoutError` that said
   * nothing about the id, and kept it in {@link pendingLocationAsks} until the
   * sweep.  A `RangeError` told to an ask's reply ref rejects the ask with it.
   */
  private onGetShardLocation(message: GetShardLocation): void {
    const asker = this.sender.toNullable();
    if (!asker) return;
    if (!this.isShardIdInRange(message.shardId)) {
      asker.tell(new RangeError(
        `[sharding] shard id ${message.shardId} cannot be a shard of '${this.config.typeName}', `
        + `whose shard ids are the integers 0..${this.config.numShards - 1}`,
      ) as never);
      return;
    }
    const ref = this.knownShardRef(message.shardId);
    if (ref) { asker.tell(ref as never); return; }
    let waiting = this.pendingLocationAsks.get(message.shardId);
    if (!waiting) { waiting = []; this.pendingLocationAsks.set(message.shardId, waiting); }
    waiting.push({ asker, expireAt: this.system.clock.now() + this.asksTtlMs });
    this.askCoordinator(message.shardId);
  }

  private flushLocationAsks(shardId: number): void {
    const waiting = this.pendingLocationAsks.get(shardId);
    if (!waiting) return;
    const ref = this.knownShardRef(shardId);
    if (!ref) return;
    this.pendingLocationAsks.delete(shardId);
    for (const { asker } of waiting) asker.tell(ref as never);
  }

  /**
   * Republish the coordinator's allocation map as a local cluster event.
   *
   * The coordinator runs only on the leader, so it is the region — which
   * exists on every node — that puts `ShardMapChanged` in front of local
   * subscribers.  Without this leg the event would fire on one node out of N,
   * which is no use to a per-node DevTools panel or an application listener.
   */
  private onShardMapUpdate(message: ShardMapUpdate, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    this.config.cluster._publishClusterEvent(new ShardMapChanged(
      message.typeName,
      new Map(message.shards),
      message.version,
      message.regions,
    ));
  }

  /** The coordinator's fan-out leg: what this node hosts, and how full. */
  private onGetShardRegionStats(message: GetShardRegionStats): void {
    const shards = Array.from(this.localShards).map((shardId) => ({
      shardId,
      entityCount: this.shardEntities.get(shardId)?.size ?? 0,
      // Allocated here either way; `resident` is what separates a shard that
      // is running and empty from one that passivated (#901).
      resident: this.shards.has(shardId),
    }));
    const reply: ShardRegionStats = {
      kind: 'sharding.ShardRegionStats',
      queryId: message.queryId,
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
      shards,
    };
    this.replyToPath(message.requester, message.requesterNode, reply);
  }

  private toShardInfo(location: ShardLocation): ShardInfo {
    const node = NodeAddress.fromJSON(location.node);
    return {
      shardId: location.shardId,
      node,
      regionPath: location.regionPath,
      entityCount: location.entityCount,
      resident: location.resident,
      local: node.equals(this.config.cluster.selfAddress),
      ref: this.shardRef(location.shardId, node, location.regionPath),
    };
  }

  /** A ref for a shard whose home we already know; `null` if we don't. */
  private knownShardRef(shardId: number): ActorRef<ShardMessage> | null {
    const regionPath = this.shardHomes.get(shardId);
    const node = this.shardHomeNodes.get(shardId);
    if (!regionPath || !node) return null;
    return this.shardRef(shardId, node, regionPath);
  }

  /**
   * The real shard actor when we host it, a {@link RemoteShardRef} otherwise.
   *
   * Both halves have to survive the shard actor not being up at this instant,
   * because since #892 an empty one is stopped and re-created on demand.  Here
   * we can simply materialise it; for a shard on another node only its own
   * region can, which is what `RemoteShardRef` delegates to.  A shard of ours
   * that cannot take a message now — handing off, passivating, backing off —
   * gets the same treatment as a remote one, see {@link RelayedShardRef}: the
   * actor registered for it is stopping, or there is none, and handing out the
   * stopping one made everything told to the ref a dead letter.
   */
  private shardRef(shardId: number, node: NodeAddress, regionPath: string): ActorRef<ShardMessage> {
    if (node.equals(this.config.cluster.selfAddress)) {
      if (this.localShards.has(shardId) && !this.config.proxy && this.shardCannotTakeMessages(shardId)) {
        return new RelayedShardRef(this.self as unknown as ActorRef<ShardingMessage>, shardId);
      }
      const local = this.shards.get(shardId);
      if (local) return local as unknown as ActorRef<ShardMessage>;
      // Ours, but the actor is not up — passivated, or allocated and never
      // needed.  A path ref would be a dead ref: nothing resolves that path
      // until the shard exists.  So materialise it, which is also the honest
      // reading of "give me a handle on this shard".  `ensureShard` restarts
      // the idle clock, so asking buys it a full window.
      if (this.localShards.has(shardId) && !this.config.proxy) {
        return this.ensureShard(shardId) as unknown as ActorRef<ShardMessage>;
      }
    }
    return new RemoteShardRef(node, regionPath, shardId, this.config.cluster);
  }

  /**
   * Send a sharding message to an arbitrary region/coordinator path — today
   * only the statistics fan-out's answer, back to the coordinator that asked.
   *
   * That asker refuses a frame which reached its mailbox unattributed (#712), so
   * the local leg carries the same wrapper `tellCoordinatorRef` builds, for the
   * same reason.
   */
  private replyToPath(path: string, nodeData: NodeAddressData, message: ShardingMessage): void {
    const node = NodeAddress.fromJSON(nodeData);
    if (node.equals(this.config.cluster.selfAddress)) {
      const local = this.config.localResolver(path) as
        ActorRef<ShardingMessage | AuthenticatedShardingMessage> | null;
      local?.tell(new AuthenticatedShardingMessage(this.config.cluster.selfAddress, message));
      return;
    }
    new RemoteActorRef<ShardingMessage>(node, path, this.config.cluster).tell(message);
  }

  /* --------------------------- Entity lifecycle ------------------------- */

  /**
   * A shard reports a spawn.  The region mirrors the per-shard entity index
   * because it owns the passivation policies and answers stats queries, and
   * relays the event to the coordinator when entities are remembered.
   */
  private onEntityStarted(message: EntityStarted): void {
    let entityIds = this.shardEntities.get(message.shardId);
    if (!entityIds) { entityIds = new Set(); this.shardEntities.set(message.shardId, entityIds); }
    entityIds.add(message.entityId);
    // No longer empty, so the shard sweep has nothing to measure.
    this.shardEmptySince.delete(message.shardId);
    // Whatever started it — a recovery batch, a shard ref, the shard replaying
    // what arrived during a passivation — a paced recovery owes it nothing any
    // more (#851).  Routing drops the entry earlier, in `recordActivity`; this
    // is the path that sees every other way an entity comes to exist.
    this.entityRecoveryQueued.delete(message.entityId);
    if (!this.entityActivity.has(message.entityId)) {
      // Remembered entities are pre-created without ever being routed to, so
      // this is the *only* place the cap sees them — and until #848 it did not:
      // the index was written straight past `admitEntity`, and a node handed a
      // large registry silently exceeded `maxEntities` by the size of it.
      this.admitEntity(message.shardId, message.entityId);
      this.entityActivity.set(message.entityId, { shardId: message.shardId, lastActivity: Date.now() });
    }
    if (this.config.rememberEntities) this.tellCoordinator(message);
  }

  private onEntityStopped(message: EntityStopped): void {
    this.shardEntities.get(message.shardId)?.delete(message.entityId);
    if ((this.shardEntities.get(message.shardId)?.size ?? 0) === 0) {
      // That was the last one — the shard's own idle window starts here.
      this.shardEmptySince.set(message.shardId, Date.now());
    }
    this.entityActivity.delete(message.entityId);
    this.passivating.delete(message.entityId);
    this.passivationStrategy?.remove(message.entityId);
    if (this.config.rememberEntities) this.tellCoordinator(message);
  }

  /**
   * Give a shard up.  Stopping the shard actor terminates its entities
   * underneath it, and the runtime only reports `Terminated` once they are
   * all gone — so `HandOffComplete` now genuinely means "nothing of this
   * shard is running here any more", which the previous fire-and-forget
   * entity stop could not promise.
   */
  private onHandOff(message: HandOff, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    // `onShardHome` has had the #569 range check since it was added; this arm
    // never got it, so an out-of-range id still walked into `completeHandOff`
    // and deleted cache entries under a shard that cannot exist.
    if (!this.isKnownShardId(message.shardId)) return;
    if (!this.ownsShardToHandOff(message.shardId)) return;
    const shardId = message.shardId;
    const entityIds = Array.from(this.shardEntities.get(shardId) ?? []);
    this.log.debug(
      `[sharding] handing off shard ${shardId} of '${this.config.typeName}' (stopping ${entityIds.length} entit(ies))`,
    );
    this.shardState.set(shardId, 'handing-off');
    const ack: BeginHandOffAcknowledgment = { kind: 'sharding.BeginHandOffAcknowledgment', shardId };
    this.tellCoordinator(ack);

    // Deliberately no `EntityStopped`, the same way an unexpected shard death
    // sends none (#894).  These entities are not being forgotten — they are
    // moving, and the coordinator's registry is the record that has to survive
    // the move so `tryAllocate` can ship it to the new owner.  Announcing them
    // as stopped emptied that registry mid-rebalance, so the new owner started
    // with nothing and `rememberEntities` lost precisely what it exists to
    // keep (#632).  Local bookkeeping still goes, below: those entities really
    // are gone *from this node*.
    this.forgetShardEntities(shardId);

    const shard = this.shards.get(shardId);
    if (!shard) { this.completeHandOff(shardId); return; }
    this.handingOff.add(shardId);
    shard.stop();
  }

  private completeHandOff(shardId: number): void {
    this.handingOff.delete(shardId);
    // A handoff can land on a shard we were already passivating; the handoff
    // wins, so clear the passivation bookkeeping with it — a registry held for
    // the shard's return included, since it travels with the shard now.
    this.passivatingShards.delete(shardId);
    this.registriesHeldThroughPassivation.delete(shardId);
    this.shardEmptySince.delete(shardId);
    // A shard handed off mid-backoff completes at once — it has no actor to
    // stop — and its wait goes with it: the shard is the new owner's (#1437).
    this.dropShardFailure(shardId);
    this.shards.delete(shardId);
    this.localShards.delete(shardId);
    this.shardHomes.delete(shardId);
    this.shardHomeNodes.delete(shardId);
    this.shardState.delete(shardId);

    const complete: HandOffComplete = {
      kind: 'sharding.HandOffComplete',
      shardId,
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(complete);

    // Anything that arrived while the shard was handing off is still queued,
    // and clearing `shardHomes` above means nothing will replay it: the
    // coordinator sends `ShardHome` to the *new* owner and to regions with an
    // outstanding `GetShardHome`, and we are neither.  Ask, so the reply
    // flushes the buffer through `onShardHome` like any other placement.
    // Either ordering works — arriving before the `HandOffComplete` just
    // parks us in the coordinator's `pending` until it reallocates.
    if (this.buffer.has(shardId)) this.askCoordinator(shardId);
  }

  /**
   * A shard we passivated is gone.  Unlike a handoff this gives nothing up:
   * the shard is still ours, still local, still routable — only the actor
   * went.  So `route` keeps recognising it and anything buffered during the
   * stop re-creates it on the way through.
   */
  private completeShardPassivation(shardId: number): void {
    this.passivatingShards.delete(shardId);
    this.shards.delete(shardId);
    this.forgetShardEntities(shardId);
    // A `ShardHome` naming a different owner can land mid-stop, and then the
    // shard is not ours to mark owned again.  Clearing the state either way
    // matters: a stuck `'passivating'` would buffer for this shard forever.
    if (this.localShards.has(shardId)) this.shardState.set(shardId, 'owned');
    else this.shardState.delete(shardId);
    this.flushBuffer(shardId);
    this.startRegistryHeldThroughPassivation(shardId);
  }

  /**
   * A released shard is gone (#633, #853).  Nothing is restored and nobody is
   * told: {@link releaseEverything} dropped the ownership in the same step it
   * ordered the stop, so whatever arrived during the stop stays buffered.
   *
   * How long it stays there is the one difference between the two callers.
   * While a refusal stands, {@link route} finds no home and
   * {@link askCoordinator} does not go looking for one, so the buffer holds
   * until the counts agree — the whole point of that release.  After an
   * eviction the region registers again at once, and the buffer flushes to
   * whichever region the coordinator's answer names, which may well be this
   * one.
   */
  private completeShardRelease(shardId: number): void {
    this.releasingShards.delete(shardId);
    this.shards.delete(shardId);
    this.shardEmptySince.delete(shardId);
  }

  /**
   * Drop every entity bookkeeping entry belonging to `shardId`.
   *
   * The replacement order goes with it, and that answers the question #848
   * raised about a rebalance: an entity's position — its recency, its segment,
   * its access count — is **reset**, not carried, when its shard moves away.
   * It has to be. The ordering is a fact about this node's traffic, the entity
   * is now somebody else's, and a stale entry for an entity that is not here
   * would occupy a slot of the cap that nothing could ever release.  What
   * survives is only the frequency sketch, which is keyed by hash rather than
   * by residency and ages out on its own — so an entity that comes back after a
   * short absence is still recognised as one that used to be hot.
   */
  private forgetShardEntities(shardId: number): void {
    for (const entityId of this.shardEntities.get(shardId) ?? []) {
      this.entityActivity.delete(entityId);
      this.passivating.delete(entityId);
      this.passivationStrategy?.remove(entityId);
    }
    this.shardEntities.delete(shardId);
    this.shardEmptySince.delete(shardId);
  }

  private onRememberedEntities(message: RememberedEntities, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    // Pre-create entities we've been told about but haven't materialised yet.
    if (!this.localShards.has(message.shardId)) return;
    if (this.config.proxy) return;
    // A shard backing off stays down until its tick, under either strategy —
    // the paced one would materialise it to queue the entities — and the tick
    // asks for this registry again once the shard is back (#1437).
    if (this.shardState.get(message.shardId) === 'backing-off') return;
    if (this.config.entityRecoveryStrategy === 'constant-rate') {
      this.queueEntityRecovery(message);
      return;
    }
    // The two rules the paced drain applies to an entry, for the same reasons.
    // A shard handing off is giving its entities to a new owner, which the
    // coordinator ships the registry to.  A passivating one stays this
    // region's, so its entities wait for the shard `ensureShard` re-creates
    // instead of going behind the stop in the old one's mailbox (#851).
    const state = this.shardState.get(message.shardId);
    if (state === 'handing-off') return;
    if (state === 'passivating') {
      this.holdThroughPassivation(message);
      return;
    }
    const startEntities: ShardMessage = {
      kind: 'sharding.StartEntities',
      entityIds: message.entityIds,
    };
    this.ensureShard(message.shardId).tell(startEntities);
  }

  /** Keep a passivating shard's registry for its return — see {@link registriesHeldThroughPassivation}. */
  private holdThroughPassivation(message: RememberedEntities): void {
    let held = this.registriesHeldThroughPassivation.get(message.shardId);
    if (!held) { held = new Set(); this.registriesHeldThroughPassivation.set(message.shardId, held); }
    for (const entityId of message.entityIds) held.add(entityId);
  }

  /**
   * Start what was held for `shardId` through its passivation, in the shard
   * that replaces the stopped one.  Nothing is started when the shard moved
   * away during the stop: the registry travels with it to the new owner.
   */
  private startRegistryHeldThroughPassivation(shardId: number): void {
    const held = this.registriesHeldThroughPassivation.get(shardId);
    if (held === undefined) return;
    this.registriesHeldThroughPassivation.delete(shardId);
    if (!this.localShards.has(shardId) || this.config.proxy) return;
    const startEntities: ShardMessage = { kind: 'sharding.StartEntities', entityIds: [...held] };
    this.ensureShard(shardId).tell(startEntities);
  }

  /* -------------------------- Paced entity recovery --------------------- */

  /**
   * Hold a shard's remembered entities for the paced drain instead of starting
   * them (#851).
   *
   * An entity that already exists is never queued: the region learns of every
   * spawn through `EntityStarted` and stamps `entityActivity` for it, and one
   * that traffic materialised on demand needs no recovery.  One that starts
   * any other way *after* it was queued leaves the queue at that moment — see
   * {@link entityRecoveryQueued}.  That is also the half of the contract that
   * keeps pacing off the routing path — `route` still creates an entity the
   * moment a message for it arrives, and only the recovery burst waits.
   */
  private queueEntityRecovery(message: RememberedEntities): void {
    // Materialise the shard now rather than at drain time: ownership is what
    // creates it (`onShardHome` does the same), and an empty shard that is
    // owned must be addressable before anything is started in it.
    this.ensureShard(message.shardId);
    let queued = 0;
    for (const entityId of message.entityIds) {
      if (this.entityActivity.has(entityId)) continue;
      if (this.entityRecoveryQueued.has(entityId)) continue;
      this.entityRecoveryQueued.add(entityId);
      this.entityRecoveryQueue.push({ shardId: message.shardId, entityId });
      queued++;
    }
    if (queued === 0) return;
    this.log.debug(
      `[sharding] queued ${queued} remembered entities of shard ${message.shardId} `
      + `in '${this.config.typeName}' for paced recovery `
      + `(${this.config.entityRecoveryConstantRateNumberOfEntities} every `
      + `${this.config.entityRecoveryConstantRateFrequencyMs}ms, region-wide)`,
    );
    // Run the first batch on this turn rather than one window from now.  The
    // key configures a *rate*, and idling for a window before the first entity
    // comes back is latency nobody asked for — most visibly where the whole
    // registry fits in one batch and pacing should then cost nothing at all.
    // A registry that arrives while the timer is already armed just joins the
    // queue, so a region handed twenty shards still starts one batch, not
    // twenty.
    if (this.entityRecoveryTimer === null) this.onEntityRecoveryTick();
  }

  /**
   * Arm the next batch, unless one is already armed.
   *
   * The timer is a one-shot re-armed by each drain rather than a fixed rate,
   * so a region with nothing to recover — which is every region, almost all of
   * the time — holds no timer at all.
   */
  private armEntityRecovery(): void {
    if (this.entityRecoveryTimer) return;
    this.entityRecoveryTimer = this.system.scheduler.scheduleOnceFunction(
      this.config.entityRecoveryConstantRateFrequencyMs,
      // Only ever *sends*: the drain reads and mutates the queue, so it has to
      // run on the region's turn and not in the scheduler's callback (#952).
      () => { this.self.tell(ENTITY_RECOVERY_TICK); },
    );
  }

  /**
   * Start one batch, then re-arm while anything is left.
   *
   * Two kinds of entry are dropped without spending a slot in the batch, and
   * both are ordinary rather than exceptional: one whose shard is no longer
   * this region's to start it in — moved away, or handing off to its new
   * owner, a rebalance during a long recovery — and one that something else
   * started while it waited.  Charging either to the budget would make the
   * configured rate mean "at most N", which is not what it says.  Dropping
   * the first kind loses nothing: the registry travels with the shard, and the
   * coordinator ships it to whoever gets it next.
   *
   * The second kind is recognised by its id having left
   * {@link entityRecoveryQueued}, not by whether the entity exists *now*.
   * Existence at drain time is the wrong question: an entity that traffic
   * started and that passivated before its slot came round no longer exists,
   * and judging its stale entry by that started it a second time — and, under
   * `rememberEntities`, recorded it as started all over again.
   *
   * An entry whose shard is *passivating* is the one kind that is kept.  The
   * shard is still this region's, so the entity is still owed a start here,
   * but its actor is on its way out and whatever it is told now is dropped
   * with its mailbox — the start would be lost after the entry had been spent.
   * So it goes to the back of the queue, costs the batch nothing, and starts
   * once {@link completeShardPassivation} has marked the shard owned again,
   * in the shard `ensureShard` then re-creates.  The empty-shard sweep never
   * stops a shard that is still owed a start ({@link sweepEmptyShards}), so
   * what reaches this branch is a registry that arrived while the shard was
   * already stopping — a coordinator re-shipping registries after a leader
   * change.  Each batch that meets the stop re-queues the held entries once,
   * and stopping an empty shard takes a turn or two.
   */
  private onEntityRecoveryTick(): void {
    this.entityRecoveryTimer = null;
    // Only what is queued now.  An entry held back below goes to the back of
    // the queue, and must not come round again inside the same batch.
    const end = this.entityRecoveryQueue.length;
    let started = 0;
    while (
      started < this.config.entityRecoveryConstantRateNumberOfEntities
      && this.entityRecoveryHead < end
    ) {
      const pending = this.entityRecoveryQueue[this.entityRecoveryHead++]!;
      // Not owed any more: the entity was started some other way since it was queued.
      if (!this.entityRecoveryQueued.has(pending.entityId)) continue;
      const state = this.shardState.get(pending.shardId);
      if (state === 'passivating') {
        this.entityRecoveryQueue.push(pending);
        continue;
      }
      this.entityRecoveryQueued.delete(pending.entityId);
      // A backing-off shard is dropped like one handing off rather than held
      // like a passivating one: its tick asks for the registry again, which
      // queues the entity anew, and starting it now would re-create the shard
      // inside its wait (#1437).
      if (!this.localShards.has(pending.shardId) || state === 'handing-off' || state === 'backing-off') continue;
      const startEntity: ShardMessage = {
        kind: 'sharding.StartEntity',
        entityId: pending.entityId,
      };
      this.ensureShard(pending.shardId).tell(startEntity);
      started++;
    }
    if (this.entityRecoveryHead >= this.entityRecoveryQueue.length) {
      // Drained: release the backing array rather than letting it grow to the
      // high-water mark of every burst the region ever saw.
      this.entityRecoveryQueue.length = 0;
      this.entityRecoveryHead = 0;
      return;
    }
    this.armEntityRecovery();
  }

  /* ----------------------------- Passivation --------------------------- */

  /**
   * An entity's parent is its shard, so `Passivate` normally never reaches
   * the region.  Code that kept a region ref from before the shard level
   * existed can still send one here — forward it to the shard that hosts the
   * entity, derived from the entity ref's own path.
   */
  private handlePassivate(message: Passivate): void {
    const candidate = message.entity ?? this.sender.toNullable();
    if (!candidate) return;
    const shardId = shardIdFromEntityPath(candidate.path.toString());
    const shard = shardId === null ? undefined : this.shards.get(shardId);
    if (!shard) {
      this.log.warn(
        `[sharding] Passivate for '${candidate.path}' reached the region but no local shard owns it`,
      );
      return;
    }
    shard.tell(message as never, candidate);
  }

  /**
   * A shard actor stopped.  Expected during handoff — that is how we learn
   * the entities are really gone — expected after a passivation, where it is
   * how we learn the shard is clear to be re-created, and expected after a
   * release (a refusal, or a staleness eviction), where it is how we learn
   * nothing of the shard is running here any more.  Otherwise the shard died:
   * drop it, keep the ownership so buffered work is not thrown away, and back
   * it off before it is re-created — see {@link backOffShard}.
   */
  private handleShardTerminated(t: Terminated): void {
    for (const [shardId, ref] of this.shards) {
      if (!ref.equals(t.actor)) continue;
      // Ahead of the other two: a release can overtake a handoff or a
      // passivation already in flight, and it is the one that must win —
      // acknowledging a handoff or reclaiming ownership would both put this
      // region back in a position the coordinator has taken away from it.
      if (this.releasingShards.has(shardId)) { this.completeShardRelease(shardId); return; }
      if (this.handingOff.has(shardId)) { this.completeHandOff(shardId); return; }
      if (this.passivatingShards.has(shardId)) { this.completeShardPassivation(shardId); return; }
      this.shards.delete(shardId);
      this.forgetShardEntities(shardId);
      // Deliberately no `EntityStopped`: under `rememberEntities` those
      // entities are meant to come back, and the coordinator's registry is
      // still the record of them.  Nothing re-ships that registry on its own,
      // since ownership did not move (#894) — the respawn tick asks for it.
      this.backOffShard(shardId);
      return;
    }
  }

  /**
   * Keep a shard that died down for a while before re-creating it (#1437).
   *
   * Without the wait the next message re-created it, and under
   * `rememberEntities` no message was needed: the region asked for the
   * shard's registry on the death and re-created the shard on the answer, so
   * a shard whose entity failed its start looped as fast as it could fail —
   * thousands of times a second, with a `started` write to the store each.
   *
   * Ownership stays: the shard is still this region's, what is routed to it
   * waits in the buffer against `buffer-size`, and the coordinator's registry
   * is still the record of its entities.  What changes is that nothing
   * re-creates it but {@link onShardRespawnTick} — not a message, not a shard
   * ref, not a placement or a registry.  Each death in a row doubles the wait,
   * and a shard that went `reset-after` without failing since it came back
   * starts the count over — see {@link ShardFailureRecord} for why that is
   * measured from its return — so a shard that fails once a day comes back
   * after the first wait while one that fails on every start costs a few
   * re-creations a minute.
   */
  private backOffShard(shardId: number): void {
    if (!this.localShards.has(shardId)) {
      // A shard the coordinator already moved away has nothing to come back to
      // here; whatever waited for it flushed to its new home with the move.
      this.dropShardFailure(shardId);
      this.log.warn(
        `[sharding] shard ${shardId} of '${this.config.typeName}' stopped unexpectedly; `
        + `it is no longer this region's, so it is not re-created here`,
      );
      return;
    }
    let record = this.shardFailures.get(shardId);
    if (record === undefined) {
      record = { attempts: 0, upSince: null, timer: null };
      this.shardFailures.set(shardId, record);
    } else if (
      record.upSince !== null
      && this.system.clock.now() - record.upSince >= this.config.shardFailureBackoffResetAfterMs
    ) {
      record.attempts = 0;
    }
    const delayMs = this.shardFailureBackoff!.delayFor(record.attempts);
    record.attempts++;
    record.upSince = null;
    this.shardState.set(shardId, 'backing-off');
    const armedFor = record;
    record.timer = this.system.scheduler.scheduleOnceFunction(
      delayMs,
      // Only ever *sends*: the shard is re-created on the region's turn — see
      // `ShardRespawnTick`.
      () => { this.self.tell(new ShardRespawnTick(shardId, armedFor)); },
    );
    this.log.warn(
      `[sharding] shard ${shardId} of '${this.config.typeName}' stopped unexpectedly `
      + `(failure ${record.attempts} in a row); re-creating it in ${Math.round(delayMs)} ms`,
    );
  }

  /**
   * A backing-off shard's wait is over: re-create it, replay what waited for
   * it, and under `rememberEntities` ask the coordinator for its registry — the
   * question the death itself used to ask (#894, #1437).
   *
   * A tick for a record the shard no longer has is stale and does nothing: a
   * hand-off, a release or a move can drop the record after its timer fired
   * and before the tick is read.
   */
  private onShardRespawnTick(tick: ShardRespawnTick): void {
    const shardId = tick.shardId;
    if (this.shardFailures.get(shardId) !== tick.record) return;
    if (this.shardState.get(shardId) !== 'backing-off' || !this.localShards.has(shardId)) return;
    tick.record.timer = null;
    // The clock `reset-after` reads: from here the shard counts as up, and a
    // passivation later on stops a healthy shard, so it does not restart it.
    tick.record.upSince = this.system.clock.now();
    this.shardState.set(shardId, 'owned');
    this.ensureShard(shardId);
    this.flushBuffer(shardId);
    if (this.config.rememberEntities) {
      this.tellCoordinator({ kind: 'sharding.GetRememberedEntities', shardId });
    }
  }

  /** Forget a shard's run of deaths and disarm its wait: it is not this region's to re-create. */
  private dropShardFailure(shardId: number): void {
    const record = this.shardFailures.get(shardId);
    if (record === undefined) return;
    record.timer?.cancel();
    this.shardFailures.delete(shardId);
  }

  /**
   * The sweep timer fired.  Both sweeps run here, on the region's turn, so
   * everything that reached the region's mailbox before the tick — a message
   * that stamps an entity active, a handoff, a spawn report — has already been
   * applied when they decide.
   *
   * That is the region's view, and for the empty-shard sweep it is not the
   * whole story: what the region handed a shard is applied in the *shard*, and
   * the region hears of an entity it created only from the shard's report,
   * which can still be on its way — a first message routed just ahead of the
   * tick is exactly that case (#1441).  So the empty-shard sweep only asks, and
   * the shard decides; see {@link passivateShard}.
   */
  private onPassivationSweepTick(): void {
    this.sweepIdleEntities();
    this.sweepEmptyShards();
  }

  private sweepIdleEntities(): void {
    if (this.config.passivationIdleMs <= 0) return;
    const now = Date.now();
    for (const [entityId, activity] of this.entityActivity) {
      if (this.passivating.has(entityId)) continue;
      if (now - activity.lastActivity < this.config.passivationIdleMs) continue;
      this.requestPassivation(entityId, activity.shardId);
    }
  }

  /**
   * Stop shards that have stood empty for a whole window (#892).  Without it a
   * shard outlives its entities indefinitely: it appears when the coordinator
   * allocates it here, and apart from a handoff nothing ever stops it again —
   * so a long-running node accumulates one empty shard per `numShards` as ids
   * spread over the hash space.
   *
   * Ownership is untouched, so this costs only the actor: `route` still sees
   * the shard as local and the next message re-creates it.  An empty shard has
   * no state to lose, which is what makes stopping it safe at all; a shard
   * with buffered traffic is skipped, because that traffic is about to bring
   * it back regardless.
   *
   * So is a shard a paced recovery still owes a start (#851).  It is empty
   * only because its remembered entities are waiting their turn, and behind a
   * long queue the wait can outlast the window — at the shipped five per
   * 100 ms, fifteen thousand entries ahead of it are five minutes.  Stopping
   * it then buys nothing, since the recovery re-creates it, and a batch that
   * lands while the actor is on its way out has to be held back for it.
   *
   * What passes all of that is still only a candidate: the shard itself
   * confirms it has nothing to lose before it stops, because this index is
   * the region's and lags the shard — the batch that spends a shard's last
   * owed start hands it the start well before its spawn report comes back
   * (#851, #1441).
   */
  private sweepEmptyShards(): void {
    if (this.config.shardPassivationIdleMs <= 0 || this.config.proxy) return;
    const now = Date.now();
    // Computed at most once a sweep, and only for a shard that would otherwise go.
    let owedRecovery: ReadonlySet<number> | null = null;
    // `passivateShard` only touches shardState/passivatingShards, never
    // `shards` itself — the deletion happens later, on Terminated — so
    // iterating the live map here is safe.
    for (const shardId of this.shards.keys()) {
      if (!this.localShards.has(shardId)) continue;
      if (this.handingOff.has(shardId) || this.passivatingShards.has(shardId)) continue;
      if ((this.shardEntities.get(shardId)?.size ?? 0) > 0) continue;
      if (this.buffer.has(shardId)) continue;
      const emptySince = this.shardEmptySince.get(shardId);
      if (emptySince === undefined) continue;
      if (now - emptySince < this.config.shardPassivationIdleMs) continue;
      owedRecovery ??= this.shardsOwedRecovery();
      if (owedRecovery.has(shardId)) continue;
      this.passivateShard(shardId);
    }
  }

  /**
   * The shards a paced recovery still owes at least one start (#851).
   *
   * A scan of the queue rather than a count kept per shard, deliberately.  It
   * runs at most once a sweep, only for a shard that would otherwise be
   * stopped, and against a queue that is empty almost all of the time; a count
   * would have to stay right across every way an entry stops being owed — a
   * batch, a spawn report, routing, a shard moving away.
   */
  private shardsOwedRecovery(): Set<number> {
    const shards = new Set<number>();
    for (let index = this.entityRecoveryHead; index < this.entityRecoveryQueue.length; index++) {
      const pending = this.entityRecoveryQueue[index]!;
      if (this.entityRecoveryQueued.has(pending.entityId)) shards.add(pending.shardId);
    }
    return shards;
  }

  /**
   * Ask an empty shard to go away.  Mirrors {@link onHandOff}: mark it so
   * `route` buffers instead of delivering, then ask it to stop and let the
   * `Terminated` watch close the loop.  Marking and asking in the *same*
   * synchronous step is what makes this loss-free — nothing the region routes
   * can slip into a mailbox that is already on its way out.
   *
   * Asked rather than told, because "empty" is this region's index talking,
   * and the index lags the shard (#1441).  A first message routed to the shard
   * ahead of the sweep's tick has created its entity there by the time the
   * shard reads the request, while the region learns of it only from the
   * spawn report behind the tick; the same goes for a remembered entity a
   * recovery batch has just started, and nothing at all reports what a shard
   * holds for an entity backing off (#1437).  A `PoisonPill` went in behind
   * that work and took it down with the shard.  The shard stops only if it has
   * nothing to lose, and otherwise declines — {@link onShardPassivationDeclined}.
   */
  private passivateShard(shardId: number): void {
    const shard = this.shards.get(shardId);
    if (!shard) return;
    this.log.debug(
      `[sharding] passivating empty shard ${shardId} of '${this.config.typeName}'`,
    );
    this.passivatingShards.add(shardId);
    this.shardState.set(shardId, 'passivating');
    shard.tell(new ShardPassivationRequest(shardId));
  }

  /**
   * A shard asked to passivate still had work, so it kept running: route to it
   * again, hand it what arrived meanwhile, and leave it to a later sweep
   * (#1441).
   *
   * Its empty clock is left alone.  A shard that declined because it runs an
   * entity sent that entity's spawn report ahead of the answer, and the report
   * took the clock away; the entity's stop starts it again.  One that declined
   * because an entity of it is backing off (#1437) stays empty in this index,
   * so each sweep asks again until that entity's wait is over: one round trip
   * per sweep interval, for no longer than the wait.
   *
   * At most one request per shard is ever out — the sweep skips a passivating
   * shard — so the answer belongs to the request still standing, if any.  A
   * hand-off or a release that overtook it has sent its own stop, and its
   * `Terminated` settles both.  A shard moved elsewhere meanwhile is not this
   * region's to keep: it is stopped as the request would have stopped it, and
   * its `Terminated` flushes what waited for it to the new home.
   */
  private onShardPassivationDeclined(message: ShardPassivationDeclined): void {
    const shardId = message.shardId;
    if (!this.passivatingShards.has(shardId) || this.handingOff.has(shardId)) return;
    const shard = this.shards.get(shardId);
    if (shard === undefined) return;
    if (!this.localShards.has(shardId)) {
      shard.stop();
      return;
    }
    this.log.debug(
      `[sharding] shard ${shardId} of '${this.config.typeName}' still had work, so it stays`,
    );
    this.passivatingShards.delete(shardId);
    this.shardState.set(shardId, 'owned');
    this.flushBuffer(shardId);
    this.startRegistryHeldThroughPassivation(shardId);
  }

  /* -------------------------------- Buffer ----------------------------- */

  /**
   * Hold a message until its shard has a home — but only up to `bufferSize`
   * across the whole region (#849, #461).
   *
   * "No home yet" is normally momentary, which is why buffering is the right
   * answer at all: it is what makes a rebalance and a handoff loss-free.  What
   * is not bounded is how long it can last.  Two of the three `route` branches
   * that land here mean "the coordinator has not answered", and a coordinator
   * that never answers is a reachable state — no leader, an unacquirable
   * lease, or a registration the coordinator refused while the region keeps
   * running and keeps accepting traffic.  Remote peers can drive it too, since
   * an inbound envelope reaches `routeMessage` through `onRemoteEnvelope`.
   * Unbounded, that is a memory leak that ends the process; bounded, it is
   * message loss that says so in the log and on the dead-letter stream.
   *
   * Drops the *newest* rather than evicting the oldest, for the reason
   * {@link ClusterSingletonProxy} already writes down: the buffer exists to
   * preserve the order a caller sent in, and dropping from the front hands the
   * shard a torn prefix of it.
   *
   * `bufferSize = 0` is a real setting — never buffer, dead-letter at once —
   * and the `>=` is what expresses it.
   */
  private bufferShard(shardId: number, message: RoutableMessage<TMessage>, sender: ActorRef | null): void {
    if (this.bufferedCount >= this.config.bufferSize) {
      this.warnBufferFull();
      this.system.deadLetters.tell(new DeadLetter(message, sender, this.self));
      return;
    }
    let queue = this.buffer.get(shardId);
    if (!queue) { queue = []; this.buffer.set(shardId, queue); }
    queue.push({ message, sender });
    this.bufferedCount++;
  }

  /**
   * One line per overflow episode, naming both ways to raise the cap — and the
   * three reasons the region buffers, since a full buffer is the symptom each
   * of them ends in: no home yet, a shard in transition, and a shard backing
   * off after a failure (#1437), where raising the cap only holds more of what
   * the failing shard will not take.
   */
  private warnBufferFull(): void {
    if (this.warnedBufferFull) return;
    this.warnedBufferFull = true;
    const situation = this.config.bufferSize === 0
      ? 'buffering is off (`buffer-size = 0`)'
      : `the routing buffer is full (${this.config.bufferSize} messages across every shard)`;
    this.log.warn(
      `[sharding] region '${this.config.typeName}': ${situation} — dropping to dead letters `
      + 'until a shard home arrives or a backing-off shard is back.  Raise the cap with '
      + '`StartShardingOptions.withBufferSize(n)` or `actor-ts.sharding.buffer-size` if this is '
      + 'a long rebalance, check why the coordinator is not placing shards, or look for a shard '
      + 'this region keeps reporting as stopped unexpectedly.',
    );
  }

  private flushBuffer(shardId: number): void {
    const queue = this.buffer.get(shardId);
    if (!queue || queue.length === 0) return;
    this.buffer.delete(shardId);
    // Discounted *before* the replay, not after: `routeMessage` can put the
    // same message straight back — a shard whose home is still unknown, or one
    // handing off again — and a decrement afterwards would subtract entries
    // that are already in the map a second time.
    this.bufferedCount -= queue.length;
    for (const { message, sender } of queue) this.routeMessage(message, sender);
    // Unlatched only once the region genuinely holds nothing, and only after
    // the replay, so a flush that immediately re-fills does not report the
    // same episode twice.
    if (this.bufferedCount === 0) this.warnedBufferFull = false;
  }

  /* -------------------------------- Misc ------------------------------ */

  private onLeaderChanged(): void {
    this.coordinatorRef = null;
    // Nobody is believed to host the coordinator until `ensureRegistered`
    // re-reads the leader — a directive arriving in that gap has no authority
    // to check against and is refused rather than trusted on the old belief.
    this.coordinatorNode = null;
    // The coordinator moved, so the count it governs the type with may have
    // moved with it; a refusal from the previous leader says nothing about
    // this one.
    this.registerRefused = false;
    this.ensureRegistered();
  }

  private onMemberRemoved(event: MemberRemoved): void {
    this.invalidateHomesOnNode(event.member.address);
    this.ensureRegistered();
  }

  private onMemberUp(): void {
    this.ensureRegistered();
  }

  private onOtherClusterEvent(): void {
    /* other events irrelevant here */
  }

  /**
   * When a node is removed from the cluster, any shards we thought lived
   * there are now orphans — drop the cache entries so the next message
   * re-asks the coordinator for the new owner.
   */
  private invalidateHomesOnNode(node: NodeAddress): void {
    for (const [shardId, addr] of Array.from(this.shardHomeNodes.entries())) {
      if (addr.equals(node)) {
        this.shardHomes.delete(shardId);
        this.shardHomeNodes.delete(shardId);
        this.shardState.delete(shardId);
      }
    }
  }
}

export function coordinatorPath(systemName: string, typeName: string): string {
  // Resolvable both locally (via localResolver) and remotely by path.
  return systemActorPath(
    systemName,
    SystemGroups.clusterSharding,
    shardCoordinatorName(typeName),
  );
}

/** Child name of the shard actor for `shardId` under its region. */
export function shardName(shardId: number): string {
  return `shard-${shardId}`;
}

/** Full path of a shard actor, given the path of the region that hosts it. */
export function shardPath(regionPath: string, shardId: number): string {
  return `${regionPath}/${shardName(shardId)}`;
}

/**
 * The {@link ShardConfig} a region hands the shard `shardId` it spawns.
 *
 * A function of the region's resolved config alone, so what reaches a shard is
 * pinned without a running region.  Every safety bound goes down whole — the
 * region's `bufferSize`, which a shard applies per shard to what it holds for
 * its backing-off entities, and the four entity restart backoff values — so a
 * configured value never stops at the region (#1437).
 */
export function shardConfigFor<TMessage>(config: ShardRegionConfig<TMessage>, shardId: number): ShardConfig {
  return {
    typeName: config.typeName,
    shardId,
    entityActor: config.entityActor as ActorClassOrFactory<unknown>,
    entityOptions: config.entityOptions as ActorOptions<unknown> | undefined,
    passivationStopTimeoutMs: config.passivationStopTimeoutMs,
    bufferSize: config.bufferSize,
    entityRestartBackoffMinMs: config.entityRestartBackoffMinMs,
    entityRestartBackoffMaxMs: config.entityRestartBackoffMaxMs,
    entityRestartBackoffRandomFactor: config.entityRestartBackoffRandomFactor,
    entityRestartBackoffResetAfterMs: config.entityRestartBackoffResetAfterMs,
  };
}

/**
 * Recover the shard id from the path of an entity (or of the shard itself).
 * `null` when the path does not run through a shard — which, since entities
 * became grandchildren of the region, only happens for foreign refs.
 */
function shardIdFromEntityPath(path: string): number | null {
  const matched = path.match(/\/shard-(\d+)(?:\/|$)/);
  if (!matched) return null;
  const shardId = Number(matched[1]);
  return Number.isFinite(shardId) ? shardId : null;
}

/**
 * A shard hosted on another node.
 *
 * Its `path` is the shard's own — that is the identity callers see, compare
 * and log — but delivery goes to the **owning region**, wrapped in a
 * {@link ToShard}.  Addressing the shard path directly is what #901 was: since
 * #892 an empty shard is stopped and re-created on demand, so between those
 * two moments nothing resolves that path and the receiving node drops the
 * message.  The region is always up and materialises the shard first.
 *
 * This mirrors the entity path, where {@link ShardEnvelope} has likewise
 * always been addressed to the region rather than to the entity.
 */
export class RemoteShardRef extends ActorRef<ShardMessage> {
  readonly path: ActorPath;
  private readonly region: RemoteActorRef<ShardingMessage>;

  constructor(
    node: NodeAddress,
    regionPath: string,
    private readonly shardId: number,
    cluster: Cluster,
  ) {
    super();
    this.path = remoteActorPath(shardPath(regionPath, shardId), node.systemName);
    this.region = new RemoteActorRef<ShardingMessage>(node, regionPath, cluster);
  }

  override tell(message: ShardMessage, sender: ActorRef | null = null): void {
    this.region.tell({ kind: 'sharding.ToShard', shardId: this.shardId, message }, sender);
  }

  /**
   * @internal Borrowed from the region ref, which already holds the cluster —
   * the constructor's `cluster` is handed straight to it and not kept (#863).
   */
  override _defaultAskTimeoutMs(): number {
    return this.region._defaultAskTimeoutMs();
  }

  override _virtualScheduler(): Scheduler | null { return this.region._virtualScheduler(); }

  /** The shard's path, not the region's — the region is only the delivery route. */
  override toString(): string { return this.path.toString(); }
}

/**
 * The handle a region gives out for a shard of its own that cannot take a
 * message now: one backing off after a failure (#1437), or one whose actor has
 * been told to stop for a hand-off or a passivation.
 *
 * There is no actor worth pointing at.  A backing-off shard has none, and
 * materialising one to be handed out would re-create a shard that keeps
 * failing — the loop the backoff exists to end; a stopping one has an actor
 * whose mailbox goes to dead letters with it.  So, like {@link RemoteShardRef},
 * its path is the shard's own and its tells go to the owning region as a
 * {@link ToShard}, which holds an entity envelope until the shard can take it.
 * It stays valid after that: the region then forwards to the live shard, or —
 * when the hand-off has moved the shard away — routes the envelope to its new
 * home, one hop longer than a direct ref would be.
 */
class RelayedShardRef extends ActorRef<ShardMessage> {
  readonly path: ActorPath;

  constructor(
    private readonly region: ActorRef<ShardingMessage>,
    private readonly shardId: number,
  ) {
    super();
    this.path = region.path.child(shardName(shardId));
  }

  override tell(message: ShardMessage, sender: ActorRef | null = null): void {
    this.region.tell({ kind: 'sharding.ToShard', shardId: this.shardId, message }, sender);
  }

  override _defaultAskTimeoutMs(): number { return this.region._defaultAskTimeoutMs(); }

  override _virtualScheduler(): Scheduler | null { return this.region._virtualScheduler(); }
}

/**
 * Synthetic sender ref given to entities whose messages arrived over the
 * wire.  Any reply tells a {@link ShardReply} back to the origin region,
 * which demultiplexes using the correlation id.  Exported for tests/typing.
 */
export class ShardSenderRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  constructor(
    readonly originNode: NodeAddress,
    readonly originRegion: string,
    readonly correlationId: number,
    private readonly cluster: Cluster,
    private readonly localResolver: (path: string) => ActorRef | null,
  ) {
    super();
    const lastSeg = originRegion.split('/').pop() ?? 'region';
    this.path = new ActorPath(
      `shard-reply-${lastSeg}-${correlationId}`,
      null,
      originNode.systemName,
    );
  }

  override tell(message: unknown): void {
    const reply: ShardReply = {
      kind: 'sharding.Reply',
      correlationId: this.correlationId,
      message,
    };
    if (this.originNode.equals(this.cluster.selfAddress)) {
      const local = this.localResolver(this.originRegion) as ActorRef<ShardingMessage> | null;
      if (local) local.tell(reply);
      return;
    }
    new RemoteActorRef<ShardingMessage>(this.originNode, this.originRegion, this.cluster).tell(reply);
  }

  /**
   * @internal This node's `actor-ts.actor.ask-timeout` (#863) — the node
   * hosting the entity, which is the one that would be waiting.
   */
  override _defaultAskTimeoutMs(): number {
    return this.cluster.system._defaultAskTimeoutMs;
  }

  override _virtualScheduler(): Scheduler | null { return this.cluster.system._virtualScheduler; }
}
