/**
 * Child-process fixture for `tests/unit/pattern/GracefulStop.test.ts`.
 *
 * Asks for a graceful stop of a ref with no local cell, with a budget that
 * never runs out, does not await it, and returns.  Nothing can ever confirm
 * that stop and the budget never ends it, so the promise never settles — and
 * the whole assertion is whether this process exits anyway.  A timer armed
 * for that budget re-arms a referenced 24.9-day link forever, with no handle
 * anyone could cancel it through, and keeps the process alive until something
 * kills it.  Observable from a parent and from nowhere inside the process,
 * which is why this lives in a file of its own rather than in the test.
 */
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { gracefulStop } from '../../../src/pattern/GracefulStop.js';

/** A ref with no cell behind it, which is every ref `gracefulStop` cannot watch. */
class RemoteLikeRef extends ActorRef<unknown> {
  readonly path = new ActorPath('remote-like');
  readonly received: unknown[] = [];
  tell(message: unknown): void { this.received.push(message); }
}

const ref = new RemoteLikeRef();
void gracefulStop(ref, Number.POSITIVE_INFINITY);
// Printed so a parent can tell "exited early without running" from "ran and
// exited" — the exit code alone cannot.
console.log(`stop-delivered=${ref.received.length === 1}`);
