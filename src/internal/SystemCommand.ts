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

export type WatchNotifyCommand = {
  readonly kind: 'watchNotify';
  readonly target: ActorRef;
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
