import type { Actor, ActorClassOrFactory } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { actorFactoryOf } from '../../internal/ActorBlueprint.js';
import { SystemGroups, assertSpawnedAt, singletonManagerName } from '../../internal/SystemPaths.js';
import { extensionId, type Extension, type ExtensionId } from '../../Extension.js';
import type { Logger } from '../../Logger.js';
import { DeadLetter } from '../../SystemMessages.js';
import type { Cluster } from '../Cluster.js';
import type { NodeAddress } from '../NodeAddress.js';
import type { EnvelopeMessage } from '../Protocol.js';
import { fromNullable, type Option } from '../../util/Option.js';
import {
  ClusterSingletonManager,
  singletonManagerPath,
  type SingletonDeliver,
} from './ClusterSingletonManager.js';
import { AuthenticatedSingletonMessage, isSingletonMessage } from './SingletonProtocol.js';
import type { SingletonHandOverAcknowledgment, SingletonMessage } from './SingletonProtocol.js';
import { ClusterSingletonManagerOptions } from './ClusterSingletonManagerOptions.js';
import { StartSingletonOptionsValidator } from './StartSingletonOptions.js';
import type { StartSingletonOptions, StartSingletonOptionsType } from './StartSingletonOptions.js';
import { ClusterSingletonProxy } from './ClusterSingletonProxy.js';
import {
  SingletonKey,
  singletonKeyOf,
  type SingletonActorClass,
  type SingletonKeyedClass,
  type SingletonReference,
} from './SingletonKey.js';

/**
 * Extension that manages every cluster singleton declared in this process.
 *
 * Reach it through {@link Cluster.singleton}; `start` hands back the
 * location-transparent `ActorRef` directly, so a singleton is addressed
 * exactly like any other actor:
 *
 * ```ts
 * class JobSchedulerActor extends Actor<SchedulerCommand> {
 *   static readonly singleton = SingletonKey.of<SchedulerCommand>('job-scheduler');
 *   onReceive(command: SchedulerCommand): void { … }
 * }
 *
 * const scheduler = cluster.singleton.start(JobSchedulerActor);
 * scheduler.tell({ kind: 'schedule', jobId: '42' });
 * ```
 *
 * `start` is get-or-create per `typeName` on this node, so calling it from
 * several modules is safe and no `getOrCreate` wrapper is needed.  Nodes that
 * only need to *talk* to the singleton call {@link ref} instead and never host
 * a manager.
 */
export class ClusterSingleton implements Extension {
  /** Local manager per typeName — only on nodes that called {@link start}. */
  private readonly managers = new Map<string, ActorRef>();
  /** Forwarding proxy per typeName — after {@link start} OR {@link ref}. */
  private readonly proxies = new Map<string, ClusterSingletonProxy<never>>();
  /**
   * Envelope-router claim on each singleton's manager path, by typeName — see
   * {@link claimManagerPath} for why it belongs to the extension and not to the
   * manager actor.
   */
  private readonly envelopeHandlers = new Map<string, () => void>();
  /** Latch for {@link deadLetterWithoutManager}'s warning, one per typeName. */
  private readonly warnedNoManager = new Set<string>();
  private cluster: Cluster | null = null;
  private readonly log: Logger;

  constructor(private readonly system: ActorSystem) {
    this.log = system.log.withSource('cluster/singleton');
  }

  /**
   * Explicit counterpart to `cluster.singleton`, mirroring
   * `ClusterSharding.get(system, cluster)` — for callers that hold the system
   * and the cluster separately.
   */
  static get(system: ActorSystem, cluster: Cluster): ClusterSingleton {
    const extension = system.extension(ClusterSingletonId);
    extension._bind(cluster);
    return extension;
  }

  /**
   * @internal Bind to a Cluster.  Idempotent for the same one; a second,
   * different Cluster throws — the manager registry and every live proxy are
   * keyed to this one's leader view, so silently re-pointing them would route
   * messages at the wrong node.
   */
  _bind(cluster: Cluster): void {
    if (this.cluster === cluster) return;
    if (this.cluster) throw new Error('ClusterSingleton is already bound to a different cluster');
    this.cluster = cluster;
  }

  /**
   * Start (or look up) the singleton and return the ref to address it with.
   *
   * ```ts
   * // The class declares its own key and takes no constructor arguments.
   * const scheduler = cluster.singleton.start(JobSchedulerActor);
   *
   * // Same, but the actor needs dependencies.
   * const users = cluster.singleton.start(UserRepositoryActor, () => new UserRepositoryActor(shard));
   *
   * // A bare key, for an actor that does not declare one.
   * const cron = cluster.singleton.start(SingletonKey.of<CronCommand>('cron'), CronActor);
   *
   * // Full form — needed for `role` / `lease`, and combinable with the above.
   * const ingress = cluster.singleton.start(
   *   StartSingletonOptions.create<IngressCommand>()
   *     .withTypeName('http-ingress')
   *     .withActor(() => new HttpIngressActor(port)),
   * );
   * ```
   *
   * Idempotent per `typeName` on this node: a repeat call returns the same ref
   * and ignores the new options.  Every node that may host the singleton has to
   * call this — {@link ref} alone never hosts.
   */
  start<TCommand>(
    actorClass: SingletonActorClass<TCommand>,
    options?: StartSingletonOptions<TCommand>,
  ): ActorRef<TCommand>;
  start<TCommand>(
    actorClass: SingletonKeyedClass<TCommand>,
    factory: () => Actor<TCommand>,
    options?: StartSingletonOptions<TCommand>,
  ): ActorRef<TCommand>;
  start<TCommand>(
    key: SingletonKey<TCommand>,
    actor: ActorClassOrFactory<TCommand>,
    options?: StartSingletonOptions<TCommand>,
  ): ActorRef<TCommand>;
  start<TCommand>(options: StartSingletonOptions<TCommand>): ActorRef<TCommand>;
  start<TCommand>(arg1: unknown, arg2?: unknown, arg3?: unknown): ActorRef<TCommand> {
    const options = this.resolveStartOptions<TCommand>(arg1, arg2, arg3);
    new StartSingletonOptionsValidator<TCommand>().validate(options);
    this.ensureManager(options);
    // The role goes onto the key so the proxy resolves the same host the
    // managers do.  Options win over a key-declared role, and the shorthand
    // forms have already folded the class's key into `options` — so reading it
    // back off `options` covers every calling shape with one line.
    return this.proxyFor(
      SingletonKey.of<TCommand>(options.typeName, options.role),
      options.bufferSize,
    );
  }

  /**
   * A ref to the singleton **without hosting it** — the counterpart to
   * `ClusterSharding.startProxy`.
   *
   * Works on a node that never calls {@link start}: messages route to whichever
   * node currently hosts the singleton.  If that node later calls `start`, the
   * same ref begins delivering through the local mailbox instead of over the
   * wire — the manager is resolved per delivery, not captured.
   */
  ref<TCommand>(key: SingletonKey<TCommand> | SingletonKeyedClass<TCommand>): ActorRef<TCommand>;
  ref<TCommand>(typeName: string): ActorRef<TCommand>;
  ref<TCommand>(reference: SingletonReference<TCommand>): ActorRef<TCommand> {
    return this.proxyFor(singletonKeyOf(reference));
  }

  /**
   * Take this node out of rotation: stop the local manager (and with it the
   * singleton, if this node was hosting) and drop the local proxy.
   *
   * Stopping is asynchronous — the manager releases its lease and its envelope
   * path in `postStop`.  Starting the same singleton again on this node has to
   * wait for that to settle.
   */
  stop(reference: SingletonReference): void {
    const { typeName } = singletonKeyOf(reference);
    this.proxies.get(typeName)?._stopForwarding();
    this.proxies.delete(typeName);
    this.managers.get(typeName)?.stop();
    this.managers.delete(typeName);
  }

  /**
   * This node's manager, if it called {@link start}.  Diagnostics and tests —
   * application code addresses the singleton through the ref, not the manager.
   */
  managerFor(reference: SingletonReference): Option<ActorRef> {
    return fromNullable(this.managers.get(singletonKeyOf(reference).typeName));
  }

  /** True if this node runs a manager for `reference` — i.e. it can become the host. */
  isStarted(reference: SingletonReference): boolean {
    return this.managers.has(singletonKeyOf(reference).typeName);
  }

  /**
   * Normalize the four calling shapes into one options object.
   *
   * The three runtime forms are mutually exclusive: a `SingletonKey` instance,
   * a function (the actor class), or an object (a builder or a plain options
   * object — both read identically, since a builder *is* its settings).  The
   * shorthands assemble a COMPLETE options object before validation runs, so
   * the validator sees the same shape whichever door the caller came through.
   */
  private resolveStartOptions<TCommand>(
    arg1: unknown,
    arg2: unknown,
    arg3: unknown,
  ): StartSingletonOptionsType<TCommand> {
    if (arg1 instanceof SingletonKey) {
      return this.shorthandOptions(
        arg1,
        arg2 as ActorClassOrFactory<TCommand>,
        arg3 as StartSingletonOptions<TCommand> | undefined,
      );
    }
    if (typeof arg1 === 'function') {
      const key = (arg1 as Partial<SingletonKeyedClass<TCommand>>).singleton;
      if (!(key instanceof SingletonKey)) {
        throw new Error(
          `${(arg1 as { name?: string }).name ?? 'The actor class'} does not declare a singleton key — `
          + 'add `static readonly singleton = SingletonKey.of<Command>(\'type-name\')`, '
          + 'or pass the key explicitly as the first argument',
        );
      }
      // `start(TheClass, factory, options?)` vs `start(TheClass, options?)`: only
      // the DI form puts a function in the second slot, and a zero-argument class
      // is its own factory.
      const hasFactory = typeof arg2 === 'function';
      return this.shorthandOptions(
        key,
        (hasFactory ? arg2 : arg1) as ActorClassOrFactory<TCommand>,
        (hasFactory ? arg3 : arg2) as StartSingletonOptions<TCommand> | undefined,
      );
    }
    return arg1 as StartSingletonOptionsType<TCommand>;
  }

  private shorthandOptions<TCommand>(
    key: SingletonKey<TCommand>,
    actor: ActorClassOrFactory<TCommand>,
    options: StartSingletonOptions<TCommand> | undefined,
  ): StartSingletonOptionsType<TCommand> {
    const explicit = options as Partial<StartSingletonOptionsType<TCommand>> | undefined;
    return {
      // A key-declared role has to land in the options the manager is built
      // from, or this node would host on plain leadership while a `ref()`-only
      // node — which reads the role straight off the key — targets the
      // role-restricted host.  Options still win, so `withRole` overrides it.
      ...(key.role !== undefined ? { role: key.role } : {}),
      ...explicit,
      typeName: key.typeName,
      actor: actorFactoryOf(actor),
    } as StartSingletonOptionsType<TCommand>;
  }

  /** Spawn this node's manager for `options`, unless one is already running. */
  private ensureManager<TCommand>(options: StartSingletonOptionsType<TCommand>): void {
    const { typeName } = options;
    if (this.managers.has(typeName)) {
      // First call wins.  Worth saying out loud: with the key declared on the
      // actor class it is easy for two modules to start the same singleton with
      // different dependencies, and the second one's options are dropped.
      this.log.debug(`singleton '${typeName}' is already started on this node — ignoring these options`);
      return;
    }
    const cluster = this.clusterOrThrow();

    // Claim the manager path *before* spawning, so a proxy that fires during
    // the spawn window is not answered as if this node were not hosting.
    const claimedHere = !this.envelopeHandlers.has(typeName);
    this.claimManagerPath(typeName);

    let managerRef: ActorRef = null as unknown as ActorRef;
    const managerActor = () => {
      const managerOptions = ClusterSingletonManagerOptions.create<TCommand>()
        .withCluster(cluster)
        .withTypeName(typeName)
        .withSingletonActor(options.actor);
      if (options.actorOptions !== undefined) managerOptions.withSingletonActorOptions(options.actorOptions);
      if (options.role !== undefined) managerOptions.withRole(options.role);
      if (options.lease !== undefined) managerOptions.withLease(options.lease);
      if (options.acquireRetryIntervalMs !== undefined) {
        managerOptions.withAcquireRetryIntervalMs(options.acquireRetryIntervalMs);
      }
      // This copy is field-by-field and silently drops anything not listed, so
      // a new `StartSingletonOptions` field is not wired until it appears here.
      if (options.handOverTimeoutMs !== undefined) {
        managerOptions.withHandOverTimeoutMs(options.handOverTimeoutMs);
      }
      if (options.restartOnTermination !== undefined) {
        managerOptions.withRestartOnTermination(options.restartOnTermination);
      }
      const manager = new ClusterSingletonManager<TCommand>(managerOptions);
      // Keep the registry derived from actor liveness: a manager that dies to
      // supervision or system shutdown never goes through `stop()`, and
      // without this the entry would outlive it and be handed to the next
      // caller as if it were alive.  Guarded by identity — a manager's
      // `postStop` can land after a replacement has already registered, and an
      // unguarded delete would then evict the live one.
      manager._onStopped = () => {
        if (this.managers.get(typeName) === managerRef) this.managers.delete(typeName);
      };
      return manager;
    };
    try {
      managerRef = this.system._spawnSystemActor(
        managerActor,
        SystemGroups.clusterSingleton,
        singletonManagerName(typeName),
      );
    } catch (cause) {
      // Only give the path back if this call is what claimed it — a `ref()`
      // that came first owns a claim this failure has no business revoking.
      if (claimedHere) this.releaseManagerPath(typeName);
      throw this.describeSpawnFailure(typeName, cause);
    }
    // The handler above is keyed on the well-known path; a drift between it
    // and where the manager actually landed would route inbound envelopes
    // past the `singleton-deliver` wrapping instead of failing.
    assertSpawnedAt(singletonManagerPath(this.system.name, typeName), managerRef);
    this.managers.set(typeName, managerRef);
  }

  /**
   * Claim this singleton's manager path on the envelope router, once per
   * `typeName` — from {@link start} **or** from {@link ref}, whichever comes
   * first.
   *
   * It used to belong to the manager, released in its `postStop`.  It has to
   * outlive any single manager, and to exist on nodes that never host at all,
   * because of what the hand-over protocol asks of a peer (#949): an incoming
   * host waits for *every* eligible node to confirm it is not running an
   * instance, and a node with nothing registered here cannot confirm anything —
   * it is indistinguishable from one that is unreachable, so every host move
   * would pay the full `handOverTimeoutMs`.  A `ref()`-only node answering
   * "not hosting" is both true and instant.
   *
   * Deliberately **not** released by {@link stop}, for the same reason: a node
   * taken out of rotation is still an `up` member, so it is still asked, and it
   * still has a truthful answer.
   */
  private claimManagerPath(typeName: string): void {
    if (this.envelopeHandlers.has(typeName)) return;
    const cluster = this.clusterOrThrow();
    const release = cluster._registerEnvelopeHandler(
      singletonManagerPath(this.system.name, typeName),
      (envelope, from) => this.onRemoteEnvelope(typeName, envelope, from),
    );
    this.envelopeHandlers.set(typeName, release);
  }

  private releaseManagerPath(typeName: string): void {
    this.envelopeHandlers.get(typeName)?.();
    this.envelopeHandlers.delete(typeName);
  }

  /**
   * An envelope addressed to this node's manager for `typeName`, from a peer
   * whose identity the transport authenticated.
   *
   * The manager is resolved per delivery rather than captured, exactly as the
   * proxy resolves it: this handler can predate the local `start()` and can
   * outlive it.
   */
  private onRemoteEnvelope(typeName: string, envelope: EnvelopeMessage, from: NodeAddress): void {
    const manager = this.managers.get(typeName) ?? null;
    // A hand-over frame is a directive about *who hosts*, so it must reach the
    // manager stamped with the peer this connection authenticated — and must
    // not be force-wrapped as a user payload, which is what this handler used
    // to do to every body it saw, `from` included (#949).  The `singleton.`
    // namespace is reserved for that: an application message may not use it.
    if (isSingletonMessage(envelope.body)) {
      if (manager) {
        manager.tell(new AuthenticatedSingletonMessage(from, envelope.body) as never);
        return;
      }
      this.answerNoManagerHere(typeName, from, envelope.body);
      return;
    }
    if (manager) {
      // Through the manager's own mailbox so it is processed on the manager's
      // dispatcher rather than on the transport's callback.
      manager.tell({ kind: 'singleton-deliver', body: envelope.body } as SingletonDeliver as never);
      return;
    }
    this.deadLetterWithoutManager(typeName, envelope.body);
  }

  /**
   * A peer asked this node to hand the singleton over, and this node runs no
   * manager for it — so the answer is already true and needs no actor.
   *
   * Silence would be read as "unreachable" and cost the requester its whole
   * `handOverTimeoutMs`, after which it hosts anyway with a warning about an
   * invariant it could not prove.  Answering turns that into one round trip.
   */
  private answerNoManagerHere(typeName: string, peer: NodeAddress, body: SingletonMessage): void {
    if (body.kind !== 'singleton.HandOverRequest') return;
    const acknowledgment: SingletonHandOverAcknowledgment = {
      kind: 'singleton.HandOverAcknowledgment',
      typeName,
    };
    // `peer.systemName`, not this node's: the manager path embeds the hosting
    // system's name, and a cluster's members do not have to share one — see
    // `ClusterSingletonManager.sendToPeer` for what addressing it with the
    // sender's name costs.
    this.clusterOrThrow()._sendEnvelope(peer, {
      kind: 'envelope',
      to: singletonManagerPath(peer.systemName, typeName),
      from: null,
      body: acknowledgment,
      tag: 'Singleton',
    });
  }

  /**
   * A user message was routed to this node as the singleton's host, and this
   * node runs no manager — the `ref()`-only misconfiguration, seen from the
   * far end of the wire.
   *
   * To `deadLetters` rather than dropped in a log line, for the reason
   * `ClusterSingletonManager.onSingletonDeliver` gives on the neighbouring
   * path: it is the same event — a message the singleton will never receive —
   * and only the dead-letter stream makes it a metric, a DevTools entry and
   * something a test can assert.  The warning is latched per `typeName`,
   * because the condition lasts as long as the deployment mistake does.
   */
  private deadLetterWithoutManager(typeName: string, body: unknown): void {
    if (!this.warnedNoManager.has(typeName)) {
      this.warnedNoManager.add(typeName);
      this.log.warn(
        `singleton '${typeName}': a peer routed a message here, but this node never called `
        + '`cluster.singleton.start(...)` — a ref() proxy cannot host, so the message is going to '
        + 'dead letters.  Call start() on every node that may become the elected host.',
      );
    }
    // The local proxy is the recipient, mirroring `ClusterSingletonProxy`'s own
    // `onMissingHost` on the sending side: it is the one `ActorRef` that names
    // *which* singleton could not be delivered to, and its synthetic path says
    // which node.  It always exists here — the only way to claim this path
    // without a manager is through `proxyFor`.
    const recipient = this.proxies.get(typeName) ?? this.system.deadLetters;
    this.system.deadLetters.tell(new DeadLetter(body, null, recipient));
  }

  /**
   * The memoised proxy for `key`.
   *
   * Memoisation is not an optimisation: every proxy subscribes to cluster
   * events for the lifetime of the process, and that subscription is released
   * only through the unsubscribe closure it holds.  Handing out a fresh proxy
   * per call would leak one listener — and one buffer — per call.
   */
  private proxyFor<TCommand>(
    key: SingletonKey<TCommand>,
    /**
     * Only `start()` has one.  A `ref()`-only proxy takes the default — unlike
     * the role, a buffer cap is a local resource bound, so nodes disagreeing
     * about it costs nothing.
     */
    bufferSize?: number,
  ): ActorRef<TCommand> {
    // Every door into this singleton claims the manager path, `ref()` included:
    // a node that only talks to the singleton is still asked to stand down when
    // the host moves, and "I run no manager" is an answer it can give at once.
    this.claimManagerPath(key.typeName);
    const existing = this.proxies.get(key.typeName);
    if (existing) {
      // The memo is keyed on typeName alone, so a proxy taken earlier from a
      // bare `ref('name')` — which carries no role — can predate the `start()`
      // that knows the singleton is role-restricted.  Left alone it would keep
      // routing at the plain leader while the managers host elsewhere.
      existing._adoptRole(key.role);
      return existing as unknown as ActorRef<TCommand>;
    }
    const proxy = new ClusterSingletonProxy<TCommand>(
      this.clusterOrThrow(),
      key,
      // Resolved per delivery, not captured: a proxy handed out by `ref()`
      // predates any local `start()`, and a `start()` may follow on this node
      // later — a captured ref would be impossible to obtain or permanently stale.
      () => this.managers.get(key.typeName) ?? null,
      key.role,
      bufferSize,
    );
    this.proxies.set(key.typeName, proxy as unknown as ClusterSingletonProxy<never>);
    return proxy;
  }

  /**
   * Turn a failed manager spawn into something actionable.
   *
   * The realistic cause is a re-`start()` that raced the previous manager's
   * teardown: stopping is asynchronous, and the child slot stays taken in the
   * parent's children map until termination settles — well after `postStop`.
   * Renaming the way DevTools does is not available here, because the manager
   * sits at a well-known path that remote proxies address by name and
   * `assertSpawnedAt` checks.
   */
  private describeSpawnFailure(typeName: string, cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes('is not unique')) return cause instanceof Error ? cause : new Error(message);
    return new Error(
      `singleton '${typeName}' is still stopping on this node — stopping a singleton is `
      + 'asynchronous; await a turn before starting it again',
      { cause },
    );
  }

  private clusterOrThrow(): Cluster {
    if (!this.cluster) {
      throw new Error(
        'ClusterSingleton is not bound to a cluster — reach it through `cluster.singleton`, '
        + 'or bind it explicitly with `ClusterSingleton.get(system, cluster)`',
      );
    }
    return this.cluster;
  }
}

export const ClusterSingletonId: ExtensionId<ClusterSingleton> = extensionId<ClusterSingleton>(
  'actor-ts/cluster/singleton',
  (system) => new ClusterSingleton(system),
);
