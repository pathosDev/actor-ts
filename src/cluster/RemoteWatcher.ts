import { match, P } from 'ts-pattern';
import { parsePathSegments, type ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import { LocalActorRef } from '../internal/LocalActorRef.js';
import type { Logger } from '../Logger.js';
import { Terminated } from '../SystemMessages.js';
import type { Cluster } from './Cluster.js';
import { MemberDown, MemberRemoved, type ClusterEvent } from './ClusterEvents.js';
import type { NodeAddress } from './NodeAddress.js';
import type { UnwatchMessage, WatchMessage, WatchTerminatedMessage } from './Protocol.js';
import { RemoteActorRef, remoteActorPath } from './RemoteActorRef.js';

/**
 * Death watch across a node boundary (#918).
 *
 * `ActorCell.registerWatch` only ever knew how to watch a `LocalActorRef`: it
 * put itself into the target cell's watcher set and the target's
 * `finalizeTermination` told it.  A `RemoteActorRef` has no cell on this
 * node, so the same call recorded the subject and did nothing else — the
 * JSDoc promised a `Terminated` unconditionally, and across the wire one
 * never came.  This class is the other half, one instance per `Cluster`,
 * playing both roles at once because every node is a watcher of some actors
 * and the home of others.
 *
 * **Watcher side.**  `watch` sends a `watch` frame to the target's node and
 * remembers who asked, keyed by that node and the target's path.  The reply
 * — a `watch-terminated` frame, now or later — is turned into a
 * `watchNotify` system command on the watching cell, which is what produces
 * the *branded* `Terminated` the dispatch gate accepts (#769).  That command
 * existed, unreachable, for exactly this: the cell already knew how to
 * accept a death it had not witnessed, it just had no source for one.
 *
 * **Watchee side.**  `onWatch` resolves the path the peer named and puts a
 * proxy ref into the target cell's watcher set through `_addWatcher` — so
 * the target's own termination path, unchanged, hands the proxy a
 * `Terminated`, and the proxy's `tell` is the wire send.  A target that
 * does not exist is answered at once, with `existenceConfirmed` false; a
 * target that has already stopped is answered by `_addWatcher` itself.
 *
 * **Node loss.**  A node that goes away sends nothing, and this is the half
 * death watch is *for*: on `MemberRemoved` or `MemberDown` every watcher of
 * an actor on that node gets a `Terminated` with `addressTerminated` set,
 * synthesised here from membership, and every proxy that node had planted
 * in a local cell is withdrawn.
 *
 * **The watchee path is peer-chosen**, exactly as an envelope's target is,
 * so it goes through the same `EnvelopeTrust` policy before anything
 * resolves it (#877, #964): `/system/…` is never watchable by name, and
 * `untrusted-mode` narrows `/user` the same way.  A refusal is answered
 * like nonexistence — `existenceConfirmed: false` — so the peer cannot tell
 * a refused path from an absent one, and a watcher never hangs on a refusal
 * it cannot see.
 */
export class RemoteWatcher {
  /**
   * What this node watches elsewhere: peer → watchee path → the ref the
   * caller passed (handed back in the `Terminated`, so the watcher's own
   * `_watching` key matches) and every local cell that asked.
   */
  private readonly outbound = new Map<string, Map<string, OutboundWatch>>();
  /**
   * Who watches actors on this node: watchee path → (peer, watcher path) →
   * the proxy planted in the watchee's cell, so `unwatch` and node loss can
   * pull it out again.
   */
  private readonly inbound = new Map<string, Map<string, InboundWatch>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly cluster: Cluster,
    private readonly log: Logger,
  ) {}

  /** Subscribe to membership, so node loss can synthesise notifications. */
  start(): void {
    this.unsubscribe = this.cluster.subscribe((event) => this.onClusterEvent(event));
  }

  /**
   * Withdraw every proxy this node planted for others and forget every watch
   * it holds elsewhere.  Called from `leave()`: the local watchers' actors are
   * on their way down with the system, so they are not notified.
   */
  shutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const byWatcher of this.inbound.values()) {
      for (const entry of byWatcher.values()) entry.cell.getCell()._removeWatcher(entry.proxy);
    }
    this.inbound.clear();
    this.outbound.clear();
  }

  /* ----------------------------- watcher side ----------------------------- */

  /**
   * Start watching `subject` on behalf of `watcher`.  Returns `false` when
   * `subject` is not a remote ref — the cell then reports the unsupported
   * shape itself, because it is the cell that knows what it was handed.
   */
  watch(watcher: ActorRef, subject: ActorRef): boolean {
    // `instanceof` rather than a `LocalActorRef` parameter: the cell's `self`
    // is `LocalActorRef<TMessage>`, and the generic is invariant through the
    // behavior stack, so the narrowing is the only spelling that type-checks
    // without a cast at every call site.
    if (!(watcher instanceof LocalActorRef) || !(subject instanceof RemoteActorRef)) return false;
    const peer = subject.targetNode;
    const byPath = this.outbound.get(peer.toString()) ?? new Map<string, OutboundWatch>();
    this.outbound.set(peer.toString(), byPath);
    const existing = byPath.get(subject.targetPath);
    if (existing) {
      existing.watchers.set(watcher.path.toString(), watcher);
      return true;
    }
    // One frame per (peer, path) however many local cells watch it; the far
    // side keys its proxy by the watcher path this frame names, so `unwatch`
    // has to name the same one — see `announcedWatcher`.
    const announcedWatcher = watcher.path.toString();
    byPath.set(subject.targetPath, {
      subject,
      announcedWatcher,
      watchers: new Map([[announcedWatcher, watcher]]),
    });
    const frame: WatchMessage = {
      kind: 'watch',
      watcher: announcedWatcher,
      watchee: subject.targetPath,
    };
    this.cluster._sendWire(peer, frame);
    return true;
  }

  /** Stop watching `subject` for `watcher`; the last watcher off a path sends `unwatch`. */
  unwatch(watcher: ActorRef, subject: ActorRef): void {
    if (!(watcher instanceof LocalActorRef) || !(subject instanceof RemoteActorRef)) return;
    const peerKey = subject.targetNode.toString();
    const byPath = this.outbound.get(peerKey);
    const entry = byPath?.get(subject.targetPath);
    if (!byPath || !entry) return;
    entry.watchers.delete(watcher.path.toString());
    if (entry.watchers.size > 0) return;
    byPath.delete(subject.targetPath);
    if (byPath.size === 0) this.outbound.delete(peerKey);
    const frame: UnwatchMessage = {
      kind: 'unwatch',
      watcher: entry.announcedWatcher,
      watchee: subject.targetPath,
    };
    this.cluster._sendWire(subject.targetNode, frame);
  }

  /** A watching actor stopped: drop every remote watch it held. */
  unwatchAll(watcher: ActorRef): void {
    if (!(watcher instanceof LocalActorRef)) return;
    for (const byPath of this.outbound.values()) {
      for (const entry of byPath.values()) {
        if (entry.watchers.has(watcher.path.toString())) this.unwatch(watcher, entry.subject);
      }
    }
  }

  /** The far node reports a watched actor gone. */
  onWatchTerminated(from: NodeAddress, message: WatchTerminatedMessage): void {
    const byPath = this.outbound.get(from.toString());
    const entry = byPath?.get(message.watchee);
    if (!byPath || !entry) return;
    byPath.delete(message.watchee);
    if (byPath.size === 0) this.outbound.delete(from.toString());
    for (const watcher of entry.watchers.values()) {
      this.notify(watcher, entry.subject, { existenceConfirmed: message.existenceConfirmed, addressTerminated: false });
    }
  }

  /* ----------------------------- watchee side ----------------------------- */

  /** A peer wants to watch an actor here. */
  onWatch(from: NodeAddress, message: WatchMessage): void {
    const segments = parsePathSegments(message.watchee);
    const refusal = segments.length > 0 ? this.cluster._envelopeTrust.refusalFor(segments) : null;
    if (refusal !== null) {
      this.cluster._envelopeTrust.report(from, 'watch', refusal);
      this.answerGone(from, message, false);
      return;
    }
    const resolved = segments.length > 0 ? this.cluster.system._resolvePath(segments) : null;
    const target = resolved !== null && resolved.isSome() ? resolved.value : null;
    if (!(target instanceof LocalActorRef)) {
      this.answerGone(from, message, false);
      return;
    }
    const proxy = new RemoteWatcherRef(from, message.watcher, message.watchee, (frame) => this.cluster._sendWire(from, frame));
    const byWatcher = this.inbound.get(message.watchee) ?? new Map<string, InboundWatch>();
    this.inbound.set(message.watchee, byWatcher);
    const key = inboundKey(from, message.watcher);
    const previous = byWatcher.get(key);
    if (previous) target.getCell()._removeWatcher(previous.proxy);
    byWatcher.set(key, { cell: target, proxy });
    // `_addWatcher` answers an already-terminated target on the spot, through
    // the proxy — so a watch that races the death still gets its reply.
    target.getCell()._addWatcher(proxy);
  }

  /** A peer stopped watching an actor here. */
  onUnwatch(from: NodeAddress, message: UnwatchMessage): void {
    const byWatcher = this.inbound.get(message.watchee);
    const entry = byWatcher?.get(inboundKey(from, message.watcher));
    if (!byWatcher || !entry) return;
    entry.cell.getCell()._removeWatcher(entry.proxy);
    byWatcher.delete(inboundKey(from, message.watcher));
    if (byWatcher.size === 0) this.inbound.delete(message.watchee);
  }

  /* ------------------------------- node loss ------------------------------ */

  private onClusterEvent(event: ClusterEvent): void {
    // One arm for both: `MemberDown` and `MemberRemoved` are structurally the
    // same `{ member }` shape, so two `P.instanceOf` arms in a row would narrow
    // the second to the *rest* of the union rather than to `MemberDown`.
    match(event)
      .with(
        P.union(P.instanceOf(MemberRemoved), P.instanceOf(MemberDown)),
        (e) => this.onMemberDownOrRemoved(e),
      )
      .otherwise(() => this.onUnrelatedEvent());
  }

  private onMemberDownOrRemoved(event: MemberDown | MemberRemoved): void {
    this.onMemberGone(event.member.address);
  }

  private onUnrelatedEvent(): void {
    /* membership churn that does not end a node is not a death */
  }

  /**
   * A node left for good.  Idempotent: `MemberDown` and `MemberRemoved` both
   * arrive for a downed node, and the first one empties the maps.
   */
  private onMemberGone(address: NodeAddress): void {
    const key = address.toString();
    const byPath = this.outbound.get(key);
    if (byPath) {
      this.outbound.delete(key);
      for (const entry of byPath.values()) {
        for (const watcher of entry.watchers.values()) {
          this.notify(watcher, entry.subject, { existenceConfirmed: true, addressTerminated: true });
        }
      }
    }
    for (const [watchee, byWatcher] of this.inbound) {
      for (const [entryKey, entry] of byWatcher) {
        if (!entry.proxy.peer.equals(address)) continue;
        entry.cell.getCell()._removeWatcher(entry.proxy);
        byWatcher.delete(entryKey);
      }
      if (byWatcher.size === 0) this.inbound.delete(watchee);
    }
  }

  /* ------------------------------- internals ------------------------------ */

  private notify(
    watcher: LocalActorRef,
    subject: RemoteActorRef,
    flags: { existenceConfirmed: boolean; addressTerminated: boolean },
  ): void {
    try {
      watcher.getCell().enqueueSystem({ kind: 'watchNotify', target: subject, ...flags });
    } catch (error) {
      this.log.warn(`could not deliver Terminated(${subject.targetPath}) to ${watcher.path}`, error);
    }
  }

  private answerGone(from: NodeAddress, message: WatchMessage, existenceConfirmed: boolean): void {
    const frame: WatchTerminatedMessage = {
      kind: 'watch-terminated',
      watcher: message.watcher,
      watchee: message.watchee,
      existenceConfirmed,
    };
    this.cluster._sendWire(from, frame);
  }
}

type OutboundWatch = {
  readonly subject: RemoteActorRef;
  /** The watcher path the `watch` frame carried — the far side's key for this watch. */
  readonly announcedWatcher: string;
  readonly watchers: Map<string, LocalActorRef>;
};

type InboundWatch = {
  readonly cell: LocalActorRef;
  readonly proxy: RemoteWatcherRef;
};

function inboundKey(peer: NodeAddress, watcherPath: string): string {
  return `${peer.toString()}|${watcherPath}`;
}

/**
 * Stands in a local cell's watcher set for a watcher on another node.
 *
 * The cell's termination path hands every watcher a `Terminated` through
 * `_notifyWatcher`, which for anything that is not a `LocalActorRef` is a
 * plain guarded `tell` — so a `tell` that turns the signal into a
 * `watch-terminated` frame is all the far side needs.  Anything else told to
 * it is dropped: this ref is not an address, it is a callback with a path.
 */
class RemoteWatcherRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  constructor(
    readonly peer: NodeAddress,
    private readonly watcherPath: string,
    private readonly watcheePath: string,
    private readonly sendFrame: (frame: WatchTerminatedMessage) => void,
  ) {
    super();
    this.path = remoteActorPath(watcherPath, peer.systemName);
  }

  tell(message: unknown): void {
    if (!(message instanceof Terminated)) return;
    this.sendFrame({
      kind: 'watch-terminated',
      watcher: this.watcherPath,
      watchee: this.watcheePath,
      existenceConfirmed: message.existenceConfirmed,
    });
  }
}
