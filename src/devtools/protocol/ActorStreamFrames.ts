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
export type ActorNode = {
  /**
   * Cluster address of the node this actor lives on, or `'local'`.
   *
   * Paths are not unique across a cluster — every node runs the same
   * system name, so `/user/orders` exists on all of them.  The address
   * is what tells two of them apart.
   */
  readonly nodeAddress: string;
  /** Full path, e.g. `actor-ts://system/user/orders/order-42`. */
  readonly path: string;
  /** Path of the parent, or `null` for the root guardian. */
  readonly parentPath: string | null;
  /** Last path segment. */
  readonly name: string;
  /** Constructor name of the actor instance, or `'?'` before creation. */
  readonly className: string;
  /**
   * Human-readable label from `Actor.displayName()` (#891), or `null`
   * when the actor never named itself.  `null` rather than "the path",
   * because the path is already `path` here and a row deep in the tree
   * reads better labelled `order-42` than
   * `actor-ts://system/user/orders/order-42`.
   *
   * Cosmetic — `path` stays the key on both sides of the socket.  It is
   * also the one field here that can change without the actor moving,
   * since a display name may be derived from state.
   */
  readonly displayName: string | null;
  readonly cellState: ActorCellState;
  readonly mailboxSize: number;
  readonly stashSize: number;
  readonly suspended: boolean;
  /** Dispatcher id, or `null` when the cell uses the system default. */
  readonly dispatcher: string | null;
  readonly childCount: number;
  /**
   * DevTools' own actors, so the panel can hide them without guessing
   * from names — a guess that missed their children, and a DevTools
   * websocket connection is a child of the DevTools hub.
   */
  readonly internal: boolean;
};

/** Mailbox depth of one actor at sample time. */
export type MailboxDepthEntry = {
  readonly path: string;
  readonly size: number;
  readonly stashSize: number;
  readonly suspended: boolean;
};

/** Full tree, sent once per `actors` subscription. */
export type ActorTreeSnapshotPayload = {
  readonly kind: 'actor-tree-snapshot';
  readonly atMs: number;
  readonly actors: ReadonlyArray<ActorNode>;
};

/** An actor was created. */
export type ActorStartedPayload = {
  readonly kind: 'actor-started';
  readonly atMs: number;
  readonly actor: ActorNode;
};

/**
 * A live actor whose inspected state moved since it was last reported.
 *
 * `actor-started` describes an actor at birth and nothing re-described
 * it afterwards, so a cell that later suspended or filled its stash kept
 * claiming to be a healthy `running` for the rest of the session.  The
 * tap re-inspects on its sampling interval and sends only what changed.
 */
export type ActorChangedPayload = {
  readonly kind: 'actor-changed';
  readonly atMs: number;
  readonly actor: ActorNode;
};

/**
 * The complete tree of one *other* node.
 *
 * Peers report whole trees rather than deltas: a remote node has no
 * channel to push a spawn down as it happens, and reconstructing deltas
 * from two snapshots on the sending side would duplicate work the client
 * already does.  Replaces everything known about that node.
 */
export type ActorNodeTreePayload = {
  readonly kind: 'actor-node-tree';
  readonly atMs: number;
  readonly address: string;
  /**
   * The node has stopped answering, so this tree is the last one it
   * sent.  Without saying so the panel would show a dead node's actors
   * as cheerfully running.
   */
  readonly stale: boolean;
  /** When the tree was received — how old "last known" actually is. */
  readonly receivedAtMs: number;
  readonly actors: ReadonlyArray<ActorNode>;
};

/** An actor terminated; its subtree is gone with it. */
export type ActorStoppedPayload = {
  readonly kind: 'actor-stopped';
  readonly atMs: number;
  /** Which node's tree this path belongs to — paths repeat across nodes. */
  readonly nodeAddress: string;
  readonly path: string;
};

/** An actor was restarted by its supervisor. */
export type ActorRestartedPayload = {
  readonly kind: 'actor-restarted';
  readonly atMs: number;
  readonly nodeAddress: string;
  readonly path: string;
  readonly reason: string;
};

/** Periodic top-N mailbox depths — the `mailboxes` stream. */
export type MailboxSamplePayload = {
  readonly kind: 'mailbox-sample';
  readonly atMs: number;
  /** Deepest mailboxes first, capped by `mailboxSampleTopN`. */
  readonly entries: ReadonlyArray<MailboxDepthEntry>;
  /** Total actors sampled, so the UI can say "top 50 of 3 120". */
  readonly sampled: number;
};

/** Payloads carried by the `actors` stream. */
export type ActorStreamPayload =
  | ActorTreeSnapshotPayload
  | ActorStartedPayload
  | ActorChangedPayload
  | ActorNodeTreePayload
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
export function actorNodeTreePayload(
  atMs: number,
  address: string,
  actors: ReadonlyArray<ActorNode>,
  stale: boolean,
  receivedAtMs: number,
): ActorNodeTreePayload {
  return { kind: 'actor-node-tree', atMs, address, stale, receivedAtMs, actors };
}

/** @internal */
export function actorStoppedPayload(
  atMs: number,
  nodeAddress: string,
  path: string,
): ActorStoppedPayload {
  return { kind: 'actor-stopped', atMs, nodeAddress, path };
}

/** @internal */
export function actorRestartedPayload(
  atMs: number,
  nodeAddress: string,
  path: string,
  reason: string,
): ActorRestartedPayload {
  return { kind: 'actor-restarted', atMs, nodeAddress, path, reason };
}

/** @internal */
export function mailboxSamplePayload(
  atMs: number,
  entries: ReadonlyArray<MailboxDepthEntry>,
  sampled: number,
): MailboxSamplePayload {
  return { kind: 'mailbox-sample', atMs, entries, sampled };
}
