import type { ActorRef } from '../ActorRef.js';

export interface CreateCommand {
  readonly kind: 'create';
}

export interface TerminateCommand {
  readonly kind: 'terminate';
}

export interface RecreateCommand {
  readonly kind: 'recreate';
  readonly cause: Error;
}

export interface SuspendCommand {
  readonly kind: 'suspend';
}

export interface ResumeCommand {
  readonly kind: 'resume';
}

export interface FailureCommand {
  readonly kind: 'failure';
  readonly cause: Error;
  readonly child: ActorRef;
  readonly message: unknown;
}

export interface ChildTerminatedCommand {
  readonly kind: 'childTerminated';
  readonly child: ActorRef;
}

export interface WatchNotifyCommand {
  readonly kind: 'watchNotify';
  readonly target: ActorRef;
}

export interface ReceiveTimeoutCommand {
  readonly kind: 'receiveTimeout';
}

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
