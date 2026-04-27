import type { ActorRef } from '../ActorRef.js';

/**
 * System commands flow through the priority queue of every mailbox and
 * always take precedence over user messages.
 */
export type SystemCommand =
  | { readonly kind: 'create' }
  | { readonly kind: 'terminate' }
  | { readonly kind: 'recreate'; readonly cause: Error }
  | { readonly kind: 'suspend' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'failure'; readonly cause: Error; readonly child: ActorRef; readonly message: unknown }
  | { readonly kind: 'childTerminated'; readonly child: ActorRef }
  | { readonly kind: 'watchNotify'; readonly target: ActorRef }
  | { readonly kind: 'receiveTimeout' };
