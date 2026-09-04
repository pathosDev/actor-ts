import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { DeadLetter } from '../SystemMessages.js';

/**
 * Count one declined message without producing a dead letter.
 *
 * The half of {@link recordUnhandled} that something which is not an `Actor`
 * can still use.  `Cluster` is the only caller today: a wire frame no handler
 * claimed has no recipient ref to name — `DeadLetter.recipient` is
 * non-nullable, and naming the dead-letter office itself would record
 * "something, somewhere, did not handle this", which is not a diagnosis.  The
 * *rate* of such frames is the whole protocol-drift signal, and it survives
 * without a letter.
 *
 * The registry is read off `system._metricsRegistry` rather than through
 * `metricsOf`, whose own JSDoc reserves that accessor for once-per-event
 * sites: an actor whose `.otherwise` arm fires under a drift storm makes this
 * per-message, and `metricsOf` is a `Map.get` plus two calls through the
 * extension chain (#411).  `null` does not mean "use the noop registry" — it
 * means "do not build the arguments", the same distinction `ActorCell` makes
 * for its own counters.
 *
 * **`class` is the only label, deliberately.**  It is a constructor name, so
 * its values are bounded by the program rather than by traffic.  A `path` or
 * a `kind` would be minted by the messages themselves — one permanent series
 * per anonymous actor or per frame kind a peer invents — which is the exact
 * defect #745 removed from `actor_dead_letters_total`.  The label tuple is
 * written literally at the call because the inventory scan in
 * `tests/unit/metrics/StockMetrics.test.ts` reads it out of this source.
 */
export function countUnhandled(system: ActorSystem, className: string): void {
  const metrics = system._metricsRegistry;
  if (metrics === null) return;
  metrics.counter(
    'actor_unhandled_total', { class: className },
    { help: 'Cumulative count of messages an actor was handed and declined.' },
  ).inc();
}

/**
 * The one place the framework records "this actor was handed this message and
 * declined it".
 *
 * A declined message becomes a `DeadLetter` rather than an event class of its
 * own, because that is what the framework already decided — in code
 * (`TypedActor`'s `unhandled` sentinel), in the docs (dead letters list "a
 * behavior that answered `unhandled`" among their causes) and in a test.  A
 * second event class would also miss everything hanging off the dead-letter
 * ref: the durable sink, `list`/`replay`, the throttled log #1000 added, and
 * whatever cap #1179 puts on the stream.
 *
 * `recipient` is the actor that declined, never the dead-letter office — the
 * reasoning is written out at `TypedActor.forwardToDeadLetters` and applies
 * verbatim here.
 *
 * **The counter is not redundant with the dead letter.**
 * `actor_dead_letters_total` is incremented inside `DeadLetterQueue._capture`,
 * which returns immediately while the store is `off` — and `off` is both the
 * built-in default and the shipped `reference.conf` default.  On a system
 * nobody configured, `deadLetters.tell(...)` ticks nothing, so
 * `actor_unhandled_total` is the only rate signal that is there by default.
 * It is counted first for the same reason `DeadLetterRef` captures before it
 * publishes: an event-stream subscriber, or the logger behind it, is a third
 * party, and a throw there must not cost the count.
 *
 * **#867 owns the log line at this exact site.**  Its `actor-ts.diagnostics`
 * block gains an `unhandled` toggle, resolved once on the `ActorSystem`
 * beside `_actorThroughput` — a cell reads no `Config` per message, and
 * neither may this — and read here as a plain boolean:
 * `if (system._diagnostics.unhandled) system.log.debug(…)`.  Nothing is
 * shipped for it here on purpose: a field nothing sets is dead code, and a
 * key nothing reads fails `NoDeadConfigKeys.test.ts`.
 */
export function recordUnhandled(
  system: ActorSystem,
  recipient: ActorRef,
  className: string,
  sender: ActorRef | null,
  message: unknown,
): void {
  countUnhandled(system, className);
  system.deadLetters.tell(new DeadLetter(message, sender, recipient));
}
