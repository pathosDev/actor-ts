import type { ActorRef } from '../ActorRef.js';

export type CreateCommand = {
  readonly kind: 'create';
};

export type TerminateCommand = {
  readonly kind: 'terminate';
};

export type RecreateCommand = {
  readonly kind: 'recreate';
  readonly cause: Error;
};

export type SuspendCommand = {
  readonly kind: 'suspend';
};

export type ResumeCommand = {
  readonly kind: 'resume';
};

export type FailureCommand = {
  readonly kind: 'failure';
  readonly cause: Error;
  readonly child: ActorRef;
  readonly message: unknown;
};

export type ChildTerminatedCommand = {
  readonly kind: 'childTerminated';
  readonly child: ActorRef;
};

/**
 * A death the watcher's own node did not witness — the far node reported it,
 * or membership took the whole node away (#918).  The remote watcher enqueues
 * this on the watching cell, which is what turns a wire frame into the
 * branded `Terminated` the dispatch gate accepts.
 */
export type WatchNotifyCommand = {
  readonly kind: 'watchNotify';
  readonly target: ActorRef;
  /** `false` when the far node never saw the watched actor exist. */
  readonly existenceConfirmed?: boolean;
  /** `true` when the far node itself left the cluster. */
  readonly addressTerminated?: boolean;
};

export type ReceiveTimeoutCommand = {
  readonly kind: 'receiveTimeout';
};

/**
 * System commands flow through the priority queue of every mailbox and
 * always take precedence over user messages.
 */
export type SystemCommand =
  | CreateCommand
  | TerminateCommand
  | RecreateCommand
  | SuspendCommand
  | ResumeCommand
  | FailureCommand
  | ChildTerminatedCommand
  | WatchNotifyCommand
  | ReceiveTimeoutCommand;
