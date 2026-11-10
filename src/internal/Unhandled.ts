import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { DeadLetter } from '../SystemMessages.js';
import { classNameOf } from '../util/ClassName.js';

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
 * **The log line #867 reserved is below**, gated on
 * `actor-ts.diagnostics.debug.unhandled` and resolved once on the
 * `ActorSystem` beside `_actorThroughput`, exactly as that reservation said:
 * a cell reads no `Config` per message and neither does this, so the read is
 * a plain boolean on an already-decided field.  The only departure is the
 * field's name — `debugUnhandled` and not `unhandled`, because the key ships
 * nested under `diagnostics.debug` to say which log level it needs, and the
 * options family keeps its fields in lockstep with the leaves.
 *
 * **Why the record is worth having at all, given the other two.**  The
 * counter carries a class name and a rate; the dead letter carries the
 * recipient and reaches the dead-letter queue, whose store is `off` by
 * default.  Neither names the *sender*, and "who is still sending this"
 * is the question a declined message actually raises.  Off by default for
 * the reason every per-message record is: a protocol drift drives this at
 * traffic rate.
 *
 * `countUnhandled`'s own caller — a wire frame no handler claimed — gets no
 * record.  It has no recipient to name, which is the reason it does not
 * produce a dead letter either, and a line saying "something, somewhere,
 * declined this" is not a diagnosis.
 */
export function recordUnhandled(
  system: ActorSystem,
  recipient: ActorRef,
  className: string,
  sender: ActorRef | null,
  message: unknown,
): void {
  countUnhandled(system, className);
  if (system._diagnostics.debugUnhandled) {
    // Deliberately the same shape and the same words as `DeadLetterRef`'s
    // record — recipient path, message class, sender when there is one — so
    // an operator reading both does not have to learn two vocabularies for
    // one message.  The payload is never in it, the same data-protection rule
    // that keeps it out of that record and makes `dead-letters.store` `off`.
    //
    // `classNameOf(message)` and not `className`: the parameter is the
    // *actor's* constructor name, because it is the metric's `class` label,
    // and the actor is already named by the path.  What the reader does not
    // otherwise have is what was sent.
    //
    // Built inside the guard: two path renders and a class lookup are the
    // expensive half of this function, and the switch is off by default.
    system.log.debug(
      `unhandled message at ${recipient.path.toString()}: ${classNameOf(message)}`
      + (sender === null ? '' : ` from ${sender.path.toString()}`),
    );
  }
  system.deadLetters.tell(new DeadLetter(message, sender, recipient));
}
