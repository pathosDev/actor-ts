import { ActorRef } from '../ActorRef.js';
import { ActorPath } from '../ActorPath.js';
import { DeadLetter } from '../SystemMessages.js';
import type { EventStream } from '../EventStream.js';
import type { Logger } from '../Logger.js';
import { classNameOf } from '../util/ClassName.js';

/**
 * Receives a dead letter and does something durable with it before anyone
 * else sees it — see {@link DeadLetterRef._setSink}.
 */
export type DeadLetterSink = (deadLetter: DeadLetter) => void;

/**
 * Everything the ref needs to announce a dead letter: the resolved
 * `actor-ts.diagnostics.*` settings, somewhere to write them, and the two
 * collaborators it deliberately does not hold outright.
 *
 * `isTerminating` is a predicate rather than the `ActorSystem` itself, so the
 * dead-letter office keeps no reference back to the thing that owns it — the
 * ref is built at `ActorSystem.ts` before the guardians exist, and handing it
 * the half-built system would be a cycle for the sake of one boolean.
 *
 * `nowMs` is injectable for one reason: the suspension window is measured, not
 * scheduled, so the only way to test its far edge is to move the clock.  A
 * five-minute `sleep` in a test is not an alternative (#1399).
 */
export type DeadLetterLogging = {
  /** Where the record goes — the system logger, already sourced. */
  readonly log: Logger;
  /** Full records before logging suspends.  `0` logs nothing at all. */
  readonly logDeadLetters: number;
  /** Log the burst `terminate()`'s mailbox drain produces. */
  readonly logDeadLettersDuringShutdown: boolean;
  /** How long logging stays suspended after the cap.  `0` never suspends. */
  readonly logDeadLettersSuspendDurationMs: number;
  /** True from the moment `ActorSystem.terminate()` starts tearing down. */
  readonly isTerminating: () => boolean;
  /** Milliseconds clock.  Defaults to `Date.now`. */
  readonly nowMs?: () => number;
};

/**
 * Wraps every incoming message in a DeadLetter, logs it, and publishes it on
 * the system event stream.  This lets applications subscribe to undeliverable
 * messages for debugging and monitoring — and, since #1000, lets an operator
 * who subscribed to nothing still find out that a message vanished.
 */
export class DeadLetterRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  private sink: DeadLetterSink | null = null;

  /* ------------------------- throttle state -------------------------- */
  /* Three numbers and no timer.  The window is evaluated lazily, on the  */
  /* next letter, so a system that stops producing dead letters arms      */
  /* nothing and holds nothing open.                                      */

  /** Full records emitted since the window opened. */
  private loggedInWindow = 0;
  /** Letters dropped by the throttle since the window opened. */
  private suppressedInWindow = 0;
  /** When suspension began, or `0` while logging is live. */
  private suspendedAtMs = 0;

  constructor(
    systemName: string,
    private readonly eventStream: EventStream,
    /**
     * Omitted only where there is no system to log through — a
     * `DeadLetterRef` a test builds by hand.  `ActorSystem` always supplies
     * it, so the default posture of a real system is "logging on".
     */
    private readonly logging: DeadLetterLogging | null = null,
  ) {
    super();
    this.path = new ActorPath('deadLetters', null, systemName);
  }

  /**
   * @internal Install the capturing sink, or clear it with `null`.
   *
   * One slot, not a list: this is the seam a *durable* record hangs on, and
   * two of those would each hold half the letters.  Anything that merely
   * wants to observe subscribes to the event stream, which is what the
   * stream is for.
   */
  _setSink(sink: DeadLetterSink | null): void {
    this.sink = sink;
  }

  tell(message: unknown, sender: ActorRef | null = null): void {
    // A DeadLetter wrapping another DeadLetter is the signature of a
    // delivery loop: publishing a dead letter reached a subscriber that
    // has terminated without unsubscribing, whose cell then wrapped it
    // again and sent it back here.  Re-publishing would hand it to the
    // same dead subscriber forever, so the nested one is dropped —
    // there is nowhere further to send an undeliverable dead letter.
    // (A single wrap is the NORMAL path: cells wrap before calling.)
    if (message instanceof DeadLetter && message.message instanceof DeadLetter) return;

    const deadLetter = message instanceof DeadLetter
      ? message
      : new DeadLetter(message, sender, this);
    // Capture first, publish second, and deliberately in that order.  The
    // sink is the durable record; publication is an observation with no
    // guaranteed audience.  Anything that later wants to rate-limit, sample
    // or suppress the dead-letter stream (#1179) belongs on the publish
    // side of this line — a gate in front of the sink would silently turn
    // a complete record into a lossy one.
    this.sink?.(deadLetter);
    this.eventStream.publish(deadLetter);
    // Logging is last, and that ordering is the same argument one rung
    // further down: it is the only one of the three that is throttled, and
    // it is the only one whose implementation is a third party's (`Logger`
    // is a documented extension point).  A sink that throws must not cost
    // the subscribers their event, and a logger that throws must not cost
    // them either.
    this.logDeadLetter(deadLetter);
  }

  /**
   * Announce one dead letter, subject to the throttle.
   *
   * **The record never carries the payload** — recipient path, sender when
   * there is one, and the message's class name, nothing else.  Same reasoning
   * that makes `DEFAULT_DEAD_LETTER_STORE` `off`: retaining or printing an
   * undeliverable message is a data-protection decision, and observing that
   * one happened is not.  A path cannot smuggle a newline into the log either
   * — `assertValidName` rejects control characters in actor names.
   *
   * **Level is `info` for the record and `warn` for the suspension notice.**
   * A dead letter on its own is information about the system rather than a
   * fault: an ask that timed out, a message racing a stop, a name that moved.
   * Losing *visibility* is the part that is wrong — after the notice the
   * operator is blind to this class of event for the whole window — so that
   * one line, and only that one, is a warning.
   *
   * Two honest limits, both consequences of gating on `_terminating`:
   * an individual `system.stop(ref)` drains that actor's mailbox to dead
   * letters and **still logs**, correctly, because the system is not
   * terminating; and letters produced during `CoordinatedShutdown`'s earlier
   * phases are logged too, because `_terminating` is only set once
   * `terminate()` itself runs.
   */
  private logDeadLetter(deadLetter: DeadLetter): void {
    const logging = this.logging;
    if (logging === null || logging.logDeadLetters <= 0) return;
    if (!logging.logDeadLettersDuringShutdown && logging.isTerminating()) return;

    const nowMs = (logging.nowMs ?? Date.now)();
    if (this.suspendedAtMs !== 0) {
      // `0` means "never suspend", so a window that was never opened cannot
      // be waited out — the branch above is the only way in, and it is
      // guarded by the same setting.
      if (nowMs - this.suspendedAtMs < logging.logDeadLettersSuspendDurationMs) {
        this.suppressedInWindow += 1;
        return;
      }
      this.resumeLogging(logging.log);
    }

    logging.log.info(
      `dead letter to ${deadLetter.recipient.path.toString()}: `
      + `${classNameOf(deadLetter.message)}`
      + (deadLetter.sender === null ? '' : ` from ${deadLetter.sender.path.toString()}`),
    );
    this.loggedInWindow += 1;
    if (
      this.loggedInWindow >= logging.logDeadLetters
      && logging.logDeadLettersSuspendDurationMs > 0
    ) {
      this.suspendedAtMs = nowMs;
      logging.log.warn(
        `dead-letter logging suspended after ${this.loggedInWindow} records; `
        + `further dead letters are not logged for `
        + `${logging.logDeadLettersSuspendDurationMs}ms `
        + '(they are still captured and published on the event stream)',
      );
    }
  }

  /**
   * Close a suspension window and report what it cost.
   *
   * The tally lands here rather than in the suspension notice because the
   * notice is emitted *before* anything has been suppressed — at that moment
   * the count is zero and would say nothing.  Folding it into the resumption
   * keeps the promise of exactly one extra line per window while still naming
   * the number an operator wants: how much they did not see.
   */
  private resumeLogging(log: Logger): void {
    if (this.suppressedInWindow > 0) {
      log.warn(
        `dead-letter logging resumed; ${this.suppressedInWindow} dead letters `
        + 'were suppressed while it was silent',
      );
    }
    this.suspendedAtMs = 0;
    this.loggedInWindow = 0;
    this.suppressedInWindow = 0;
  }
}
