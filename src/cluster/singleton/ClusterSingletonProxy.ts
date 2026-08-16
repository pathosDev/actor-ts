import { match, P } from 'ts-pattern';
import { ActorPath } from '../../ActorPath.js';
import { ActorRef } from '../../ActorRef.js';
import type { Cluster } from '../Cluster.js';
import { NodeAddress } from '../NodeAddress.js';
import { singletonProxyName } from '../../internal/SystemPaths.js';
import {
  changesSingletonHost,
  singletonHost,
  singletonManagerPath,
  type SingletonDeliver,
} from './ClusterSingletonManager.js';
import { DEFAULT_BUFFER_SIZE } from './StartSingletonOptions.js';
import type { SingletonKey } from './SingletonKey.js';

/**
 * Location-transparent handle to a cluster-wide singleton.  Every call to
 * `tell` looks up the current host and forwards to that node's
 * ClusterSingletonManager (via direct `tell` if local, via envelope if
 * remote).  Messages sent before the cluster has a host are buffered and
 * drained on the first cluster event that can have produced one — see
 * {@link changesSingletonHost}.
 *
 * The proxy extends ActorRef<T> so it can be passed anywhere an ActorRef is
 * expected (e.g. as a sender for ask patterns).  It is not backed by a real
 * actor — it is a thin forwarder.
 */

export class ClusterSingletonProxy<TCommand> extends ActorRef<TCommand> {
  readonly path: ActorPath;
  private buffer: TCommand[] = [];
  private unsubscribe: (() => void) | null = null;
  private forwarding = true;
  private warnedMissingHost = false;
  private warnedBufferFull = false;
  /** Messages dropped because the no-host buffer was full — useful for metrics. */
  droppedCount = 0;

  constructor(
    private readonly cluster: Cluster,
    private readonly key: SingletonKey<TCommand>,
    /**
     * This node's manager, resolved per delivery rather than captured.  A
     * proxy handed out by `ClusterSingleton.ref` predates any local `start()`
     * — and a `start()` may follow on this node later — so a captured ref
     * would either be impossible to obtain or permanently stale.
     */
    private readonly localManager: () => ActorRef | null,
    /**
     * Role restriction, if any — must be the same one the managers were
     * started with, or this proxy and they disagree about who hosts.
     * Defaults to the key's, which is why the key carries it.
     */
    private role: string | undefined = key.role,
    /** Cap on the no-host buffer.  See {@link DEFAULT_BUFFER_SIZE}. */
    private readonly bufferSize: number = DEFAULT_BUFFER_SIZE,
  ) {
    super();
    // Synthetic — no actor is spawned here.  The path exists so logs and dead
    // letters name the proxy somewhere plausible, alongside the manager it
    // fronts.
    this.path = new ActorPath('', null, cluster.system.name)
      .child('system').child('cluster').child('singleton')
      .child(singletonProxyName(key.typeName));
    this.unsubscribe = cluster.subscribe((evt) =>
      match(evt)
        .with(P.when(changesSingletonHost), () => this.onSingletonHostMayHaveChanged())
        .otherwise(() => this.onOtherClusterEvent()),
    );
    // Drain in case a leader is already known by the time we start.
    queueMicrotask(() => this.drainBuffer());
  }

  override tell(message: TCommand, _sender: ActorRef | null = null): void {
    if (!this.forwarding) return;
    const hostOpt = singletonHost(this.cluster, this.role);
    if (hostOpt.isNone()) {
      this.bufferUntilHosted(message);
      return;
    }
    this.deliver(message, hostOpt.value.address);
  }

  /**
   * Hold a message until a host appears — but only up to `bufferSize`.
   *
   * "No host yet" is normally momentary, which is why buffering is the right
   * answer at all.  What is not bounded is how long it can last: unreachable
   * seeds, or a partition in which this node sees nobody, hold the cluster
   * there for the length of the outage while the application keeps sending.
   * Unbounded, that is a memory leak that ends the process; bounded, it is
   * message loss that says so in the log.
   *
   * Drops the *newest* rather than evicting the oldest: the buffer exists to
   * preserve the order a caller sent in, and dropping from the front would
   * hand the singleton a torn prefix of it.
   */
  private bufferUntilHosted(message: TCommand): void {
    if (this.buffer.length >= this.bufferSize) {
      this.droppedCount++;
      if (!this.warnedBufferFull) {
        this.warnedBufferFull = true;
        this.cluster.system.log.warn(
          `singleton '${this.key.typeName}': no node is hosting it and the proxy buffer is full `
          + `(${this.bufferSize}) — dropping to dead letters until a host appears.  Raise the cap `
          + 'with `StartSingletonOptions.withBufferSize(n)` if this is a long election, or check '
          + 'why the cluster has no host.',
        );
      }
      this.cluster.system.deadLetters.tell(message as never);
      return;
    }
    this.buffer.push(message);
  }

  /**
   * A singleton is not stopped by poisoning its proxy — the proxy is a
   * forwarder, not the actor.  `ActorRef.stop()` means "send a PoisonPill to
   * the target" everywhere else, and doing that here would kill whatever the
   * current leader happens to be hosting.  Overridden to say so instead.
   */
  override stop(): void {
    this.cluster.system.log.warn(
      `singleton '${this.key.typeName}': stop() on the ref is a no-op — `
      + 'use `cluster.singleton.stop(key)` to take this node out of rotation',
    );
  }

  /**
   * @internal Learn the role from a later, better-informed caller.
   *
   * A proxy is memoised per `typeName`, so the first caller wins the
   * construction — and that may be a bare `ref('name')`, which knows no role,
   * ahead of the `start()` that does.  Learning it late is the difference
   * between routing at the right node and silently routing at the leader.
   *
   * `undefined` never *erases* a known role, for the mirror-image reason: a
   * later bare `ref()` is uninformed, not authoritative.  Two different roles
   * is a genuine misconfiguration — one singleton cannot be restricted two
   * ways — so it warns and keeps the first.
   */
  _adoptRole(role: string | undefined): void {
    if (role === undefined || role === this.role) return;
    if (this.role === undefined) { this.role = role; return; }
    this.cluster.system.log.warn(
      `singleton '${this.key.typeName}': already addressed with role '${this.role}', `
      + `ignoring conflicting role '${role}' — one singleton cannot be restricted to two roles`,
    );
  }

  /** @internal Stop forwarding and unsubscribe from cluster events. */
  _stopForwarding(): void {
    this.forwarding = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** True if at least one message is currently buffered. */
  hasPending(): boolean { return this.buffer.length > 0; }

  private deliver(message: TCommand, hostAddress: NodeAddress): void {
    if (!hostAddress.equals(this.cluster.selfAddress)) {
      this.cluster._sendEnvelope(hostAddress, {
        kind: 'envelope',
        to: singletonManagerPath(this.cluster.system.name, this.key.typeName),
        from: null,
        body: message,
        tag: 'Singleton',
      });
      return;
    }
    const manager = this.localManager();
    if (manager) {
      const payload: SingletonDeliver = { kind: 'singleton-deliver', body: message };
      manager.tell(payload as never);
      return;
    }
    this.onMissingHost(message);
  }

  /**
   * This node is the elected host but runs no manager, so nothing anywhere is
   * hosting the singleton.  Dead-letter rather than buffer: unlike "no host
   * yet" — which the buffer above handles and a host-changing event drains —
   * this state does not heal on its own, it heals when someone changes the
   * deployment, so a buffer would just grow.  The warning is latched so a hot
   * path cannot flood the log.
   */
  private onMissingHost(message: TCommand): void {
    if (!this.warnedMissingHost) {
      this.warnedMissingHost = true;
      const scope = this.role === undefined
        ? 'every node that may become leader'
        : `every node carrying role '${this.role}'`;
      this.cluster.system.log.warn(
        `singleton '${this.key.typeName}': this node is the elected host but never called `
        + '`cluster.singleton.start(...)`, so no node is hosting the singleton and messages are '
        + `dead-lettering — a ref() proxy cannot host.  Call start() on ${scope}.`,
      );
    }
    this.cluster.system.deadLetters.tell(message as never);
  }

  /**
   * A host-changing event landed, so whatever is buffered may be routable now.
   *
   * This used to be `LeaderChanged` alone, which left a buffer that never
   * drained rather than one that drained late (#637): a role-restricted
   * singleton on a cluster whose only member is a role-less leader buffers
   * every `tell`, and the first role-carrying member to join changes no
   * leader — so nothing fired, and those messages sat there indefinitely
   * while every `tell` sent afterwards routed normally.
   */
  private onSingletonHostMayHaveChanged(): void {
    this.drainBuffer();
  }

  private onOtherClusterEvent(): void {
    /* Not "nothing else can move the host": `MemberUnreachable` can, and is
       deliberately not acted on — draining to a host the managers have not
       promoted would hand every buffered message to a node that will
       dead-letter it.  See `changesSingletonHost`. */
  }

  private drainBuffer(): void {
    const hostOpt = singletonHost(this.cluster, this.role);
    if (hostOpt.isNone() || this.buffer.length === 0) return;
    const hostAddress = hostOpt.value.address;
    const drained = this.buffer.splice(0, this.buffer.length);
    // The overflow warning latches so a hot path cannot flood the log, but the
    // condition it reports genuinely recovers — unlatch it here so a second,
    // later outage is reported too rather than passing silently.
    this.warnedBufferFull = false;
    for (const message of drained) this.deliver(message, hostAddress);
  }
}
