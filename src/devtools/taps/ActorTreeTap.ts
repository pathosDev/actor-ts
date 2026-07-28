/**
 * The `actors` stream (#204) — the live actor tree.
 *
 * Snapshot-then-delta rather than periodic full dumps: a busy system
 * spawns constantly, and re-sending every actor on every spawn is
 * O(actors) per event.  The subscription is opened BEFORE the tree is
 * walked, so an actor born during the walk produces a delta the client
 * can reconcile; the client keys by path, which makes a duplicate
 * `actor-started` a harmless overwrite.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import { ActorLifecycleEvent, ActorRestarted, ActorStarted, ActorStopped } from '../../SystemMessages.js';
import type { CellInspection } from '../../internal/Instrumentation.js';
import { match, P } from 'ts-pattern';
import {
  actorChangedPayload,
  actorRestartedPayload,
  actorStartedPayload,
  actorStoppedPayload,
  actorTreeSnapshotPayload,
  type ActorNode,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
} from '../protocol/index.js';
import type { DevToolsTap } from '../DevToolsServer.js';
import { subscribeToEventStream, type EventStreamProbe } from '../internal/EventStreamProbe.js';

export class ActorTreeTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'actors';

  private probe: EventStreamProbe | null = null;
  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private ticker: Cancellable | null = null;
  /** Last state reported per path, so a tick only sends what moved. */
  private readonly lastSeen = new Map<string, ActorNode>();

  constructor(
    private readonly system: ActorSystem,
    private readonly intervalMs: number,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    this.probe = subscribeToEventStream(
      this.system,
      ActorLifecycleEvent,
      (event) => this.onLifecycleEvent(event, emit),
      'devtools-actor-tree',
    );
  }

  uninstall(): void {
    this.stopTicking();
    this.probe?.stop();
    this.probe = null;
    this.lastSeen.clear();
    this.emit = null;
  }

  subscribersChanged(count: number): void {
    if (count > 0) this.startTicking();
    else this.stopTicking();
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    const actors = this.system._inspectTree().map(toActorNode);
    for (const actor of actors) this.lastSeen.set(actor.path, actor);
    return [actorTreeSnapshotPayload(Date.now(), actors)];
  }

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = this.system.scheduler.scheduleAtFixedRateFunction(
      this.intervalMs,
      this.intervalMs,
      () => this.emitChanges(),
    );
  }

  private stopTicking(): void {
    this.ticker?.cancel();
    this.ticker = null;
  }

  /**
   * Re-inspect the tree and report the cells that moved.
   *
   * Lifecycle events describe births, deaths and restarts; nothing
   * announces a suspension or a growing stash, so without this pass a
   * node kept the state it was born with forever.  Sending only the
   * difference keeps a quiet system's tick empty.
   */
  private emitChanges(): void {
    const emit = this.emit;
    if (emit === null) return;
    const atMs = Date.now();
    const alive = new Set<string>();
    for (const cell of this.system._inspectTree()) {
      const actor = toActorNode(cell);
      alive.add(actor.path);
      const previous = this.lastSeen.get(actor.path);
      if (previous !== undefined && !hasMoved(previous, actor)) continue;
      this.lastSeen.set(actor.path, actor);
      emit(actorChangedPayload(atMs, actor));
    }
    // Departed cells are announced by `actor-stopped`; drop them here so
    // the map cannot outgrow the tree it mirrors.
    for (const path of this.lastSeen.keys()) {
      if (!alive.has(path)) this.lastSeen.delete(path);
    }
  }

  private onLifecycleEvent(
    event: ActorLifecycleEvent,
    emit: (payload: DevToolsStreamPayload) => void,
  ): void {
    match(event)
      .with(P.instanceOf(ActorStarted), (e) => this.onActorStarted(e, emit))
      .with(P.instanceOf(ActorStopped), (e) => this.onActorStopped(e, emit))
      .with(P.instanceOf(ActorRestarted), (e) => this.onActorRestarted(e, emit))
      .otherwise(() => this.onUnknownEvent());
  }

  private onActorStarted(event: ActorStarted, emit: (payload: DevToolsStreamPayload) => void): void {
    // Re-inspect rather than trust the event: by the time this is
    // handled the actor may already have a mailbox backlog, and the
    // panel wants the live figures, not the ones from birth.
    const cell = this.inspect(event.actor.path.toString());
    if (cell !== null) this.lastSeen.set(cell.path, cell);
    emit(actorStartedPayload(Date.now(), cell ?? {
      path: event.actor.path.toString(),
      parentPath: event.parentPath,
      name: event.actor.path.name,
      className: event.className,
      cellState: 'running',
      mailboxSize: 0,
      stashSize: 0,
      suspended: false,
      dispatcher: null,
      childCount: 0,
    }));
  }

  private onActorStopped(event: ActorStopped, emit: (payload: DevToolsStreamPayload) => void): void {
    const path = event.actor.path.toString();
    this.lastSeen.delete(path);
    emit(actorStoppedPayload(Date.now(), path));
  }

  private onActorRestarted(event: ActorRestarted, emit: (payload: DevToolsStreamPayload) => void): void {
    emit(actorRestartedPayload(Date.now(), event.actor.path.toString(), event.cause.message));
  }

  /** A lifecycle variant added after this build — ignore it. */
  private onUnknownEvent(): void {}

  private inspect(path: string): ActorNode | null {
    // A linear scan is fine here: this runs once per spawn, and the
    // alternative (a live index) would have to be invalidated on every
    // mailbox change to stay truthful.
    const found = this.system._inspectTree().find((cell) => cell.path === path);
    return found === undefined ? null : toActorNode(found);
  }
}

/**
 * Did anything the panel renders change?
 *
 * Only the mutable fields are compared — path, parent, name, class and
 * dispatcher are fixed for a cell's lifetime, so reading them would only
 * cost time.
 */
function hasMoved(previous: ActorNode, current: ActorNode): boolean {
  return previous.cellState !== current.cellState
    || previous.mailboxSize !== current.mailboxSize
    || previous.stashSize !== current.stashSize
    || previous.suspended !== current.suspended
    || previous.childCount !== current.childCount;
}

/**
 * `CellInspection` and `ActorNode` are structurally identical today,
 * but they answer to different owners — one to the runtime, one to the
 * wire protocol.  The explicit copy is what keeps a field added to the
 * runtime from silently becoming part of the published protocol.
 */
function toActorNode(cell: CellInspection): ActorNode {
  return {
    path: cell.path,
    parentPath: cell.parentPath,
    name: cell.name,
    className: cell.className,
    cellState: cell.cellState,
    mailboxSize: cell.mailboxSize,
    stashSize: cell.stashSize,
    suspended: cell.suspended,
    dispatcher: cell.dispatcher,
    childCount: cell.childCount,
  };
}

/** @internal Shared with the mailbox and stats taps. */
export { toActorNode };
