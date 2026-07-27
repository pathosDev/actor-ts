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
import { ActorLifecycleEvent, ActorRestarted, ActorStarted, ActorStopped } from '../../SystemMessages.js';
import type { CellInspection } from '../../internal/Instrumentation.js';
import { match, P } from 'ts-pattern';
import {
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

  constructor(private readonly system: ActorSystem) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.probe = subscribeToEventStream(
      this.system,
      ActorLifecycleEvent,
      (event) => this.onLifecycleEvent(event, emit),
      'devtools-actor-tree',
    );
  }

  uninstall(): void {
    this.probe?.stop();
    this.probe = null;
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [actorTreeSnapshotPayload(Date.now(), this.system._inspectTree().map(toActorNode))];
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
    emit(actorStoppedPayload(Date.now(), event.actor.path.toString()));
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
