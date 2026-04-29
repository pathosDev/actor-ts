import type { PersistentEvent } from './JournalTypes.js';

/**
 * Optional in-process notification capability that a `Journal` MAY
 * expose.  When present, the read-side query layer
 * (`PersistenceQuery`) subscribes here and emits events the moment
 * they're appended — no polling latency.  When absent (e.g. for
 * cross-process backends like Cassandra), the query layer falls
 * back to its `pollIntervalMs`-driven loop.
 *
 * Cross-process delivery is **out of scope** — this bus only
 * notifies subscribers in the same JS process.  Networked backends
 * that need cross-process push would layer their own protocol on
 * top (Postgres LISTEN/NOTIFY, Redis pub/sub, …).
 */
export interface JournalEventBus {
  /**
   * Notify every subscriber that an event has been appended.  The
   * journal calls this AFTER the underlying write has succeeded;
   * subscribers therefore see only events that are durably on disk
   * (modulo whatever fsync semantics the journal itself promises).
   */
  publish(event: PersistentEvent<unknown>): void;

  /**
   * Register a handler.  Returns an unsubscribe function — call it
   * to detach.  Handlers run synchronously inside `publish`; throwing
   * is caught + logged-to-console-warn so one bad subscriber doesn't
   * stop deliveries to the rest.
   */
  subscribe(listener: (event: PersistentEvent<unknown>) => void): () => void;

  /** Test hook — current subscriber count.  Useful for asserting that
   *  cancellation actually detaches.  Not part of the contract that
   *  custom journals have to honour. */
  subscriberCount?(): number;
}

/**
 * Reference implementation.  Plain `Set<listener>`; one
 * try/catch per delivery so a misbehaving subscriber doesn't break
 * the bus for the others.  Used by every journal implementation
 * that ships with the framework.
 */
export class InProcessJournalEventBus implements JournalEventBus {
  private readonly listeners = new Set<(event: PersistentEvent<unknown>) => void>();

  publish(event: PersistentEvent<unknown>): void {
    for (const l of this.listeners) {
      try { l(event); } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('JournalEventBus: subscriber threw on publish', err);
      }
    }
  }

  subscribe(listener: (event: PersistentEvent<unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscriberCount(): number { return this.listeners.size; }
}
