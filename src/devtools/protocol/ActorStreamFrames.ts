/**
 * Payloads of the `actors` and `mailboxes` streams (#204).
 *
 * The actor tree is delivered as one snapshot followed by deltas: a
 * full re-send on every spawn would be O(actors) per event, and a
 * busy system spawns constantly.  The server subscribes to lifecycle
 * events BEFORE walking the tree and de-duplicates by path, so no
 * actor can slip through the gap between snapshot and first delta.
 */

/** Lifecycle state of an actor cell, mirrored from the runtime. */
export type ActorCellState =
  | 'creating'
  | 'running'
  | 'suspended'
  | 'terminating'
  | 'terminated';

/** One node of the actor tree. */
export interface ActorNode {
  /** Full path, e.g. `actor-ts://system/user/orders/order-42`. */
  readonly path: string;
  /** Path of the parent, or `null` for the root guardian. */
  readonly parentPath: string | null;
  /** Last path segment. */
  readonly name: string;
  /** Constructor name of the actor instance, or `'?'` before creation. */
  readonly className: string;
  readonly cellState: ActorCellState;
  readonly mailboxSize: number;
  readonly stashSize: number;
  readonly suspended: boolean;
  /** Dispatcher id, or `null` when the cell uses the system default. */
  readonly dispatcher: string | null;
  readonly childCount: number;
}

/** Mailbox depth of one actor at sample time. */
export interface MailboxDepthEntry {
  readonly path: string;
  readonly size: number;
  readonly stashSize: number;
  readonly suspended: boolean;
}

/** Full tree, sent once per `actors` subscription. */
export interface ActorTreeSnapshotPayload {
  readonly kind: 'actor-tree-snapshot';
  readonly atMs: number;
  readonly actors: ReadonlyArray<ActorNode>;
}

/** An actor was created. */
export interface ActorStartedPayload {
  readonly kind: 'actor-started';
  readonly atMs: number;
  readonly actor: ActorNode;
}

/**
 * A live actor whose inspected state moved since it was last reported.
 *
 * `actor-started` describes an actor at birth and nothing re-described
 * it afterwards, so a cell that later suspended or filled its stash kept
 * claiming to be a healthy `running` for the rest of the session.  The
 * tap re-inspects on its sampling interval and sends only what changed.
 */
export interface ActorChangedPayload {
  readonly kind: 'actor-changed';
  readonly atMs: number;
  readonly actor: ActorNode;
}

/** An actor terminated; its subtree is gone with it. */
export interface ActorStoppedPayload {
  readonly kind: 'actor-stopped';
  readonly atMs: number;
  readonly path: string;
}

/** An actor was restarted by its supervisor. */
export interface ActorRestartedPayload {
  readonly kind: 'actor-restarted';
  readonly atMs: number;
  readonly path: string;
  readonly reason: string;
}

/** Periodic top-N mailbox depths — the `mailboxes` stream. */
export interface MailboxSamplePayload {
  readonly kind: 'mailbox-sample';
  readonly atMs: number;
  /** Deepest mailboxes first, capped by `mailboxSampleTopN`. */
  readonly entries: ReadonlyArray<MailboxDepthEntry>;
  /** Total actors sampled, so the UI can say "top 50 of 3 120". */
  readonly sampled: number;
}

/** Payloads carried by the `actors` stream. */
export type ActorStreamPayload =
  | ActorTreeSnapshotPayload
  | ActorStartedPayload
  | ActorChangedPayload
  | ActorStoppedPayload
  | ActorRestartedPayload;

/** Payloads carried by the `mailboxes` stream. */
export type MailboxStreamPayload = MailboxSamplePayload;

/** @internal */
export function actorTreeSnapshotPayload(
  atMs: number,
  actors: ReadonlyArray<ActorNode>,
): ActorTreeSnapshotPayload {
  return { kind: 'actor-tree-snapshot', atMs, actors };
}

/** @internal */
export function actorStartedPayload(atMs: number, actor: ActorNode): ActorStartedPayload {
  return { kind: 'actor-started', atMs, actor };
}

/** @internal */
export function actorChangedPayload(atMs: number, actor: ActorNode): ActorChangedPayload {
  return { kind: 'actor-changed', atMs, actor };
}

/** @internal */
export function actorStoppedPayload(atMs: number, path: string): ActorStoppedPayload {
  return { kind: 'actor-stopped', atMs, path };
}

/** @internal */
export function actorRestartedPayload(
  atMs: number,
  path: string,
  reason: string,
): ActorRestartedPayload {
  return { kind: 'actor-restarted', atMs, path, reason };
}

/** @internal */
export function mailboxSamplePayload(
  atMs: number,
  entries: ReadonlyArray<MailboxDepthEntry>,
  sampled: number,
): MailboxSamplePayload {
  return { kind: 'mailbox-sample', atMs, entries, sampled };
}
