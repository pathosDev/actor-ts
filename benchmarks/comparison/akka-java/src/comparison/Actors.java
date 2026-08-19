package comparison;

import akka.actor.typed.ActorRef;
import akka.actor.typed.Behavior;
import akka.actor.typed.Terminated;
import akka.actor.typed.javadsl.AbstractBehavior;
import akka.actor.typed.javadsl.ActorContext;
import akka.actor.typed.javadsl.Behaviors;
import akka.actor.typed.javadsl.Receive;

import java.util.ArrayList;
import java.util.List;

/**
 * The four scenarios expressed in the Akka Typed Java API.
 *
 * <p>The shapes mirror {@code benchmarks/comparison/js/actor-ts.ts} as closely
 * as the two APIs allow; where they cannot, the difference is recorded as a note
 * on the row rather than smoothed over.
 *
 * <p>The one structural difference worth naming: in Akka Typed only an actor may
 * spawn actors, so the spawn scenario runs through a guardian that spawns the
 * batch, counts confirmed starts, stops them and counts confirmed terminations.
 * That is the same "started and stopped, both observed" contract every other arm
 * implements — the batch simply amortises the single ask it costs to drive it
 * from outside.
 */
public final class Actors {

    private Actors() {}

    /* ------------------------------- counter ------------------------------- */

    public sealed interface CounterCommand permits Increment, ReadAndReset {}

    public record Increment() implements CounterCommand {}

    public record ReadAndReset(ActorRef<Integer> replyTo) implements CounterCommand {}

    public static Behavior<CounterCommand> counter() {
        return Behaviors.setup(Counter::new);
    }

    private static final class Counter extends AbstractBehavior<CounterCommand> {
        private int count;

        Counter(ActorContext<CounterCommand> context) {
            super(context);
        }

        @Override
        public Receive<CounterCommand> createReceive() {
            return newReceiveBuilder()
                    .onMessage(Increment.class, this::onIncrement)
                    .onMessage(ReadAndReset.class, this::onReadAndReset)
                    .build();
        }

        private Behavior<CounterCommand> onIncrement(Increment message) {
            count++;
            return this;
        }

        private Behavior<CounterCommand> onReadAndReset(ReadAndReset message) {
            message.replyTo().tell(count);
            count = 0;
            return this;
        }
    }

    /* -------------------------------- echo --------------------------------- */

    public record Echo(String value, ActorRef<String> replyTo) {}

    public static Behavior<Echo> echo() {
        return Behaviors.receive(Echo.class)
                .onMessage(Echo.class, message -> {
                    message.replyTo().tell("echo:" + message.value());
                    return Behaviors.same();
                })
                .build();
    }

    /* ------------------------------ ping-pong ------------------------------ */

    public sealed interface VolleyCommand permits StartVolley, Pong {}

    public record StartVolley(int exchanges, ActorRef<Integer> replyTo) implements VolleyCommand {}

    public record Pong() implements VolleyCommand {}

    public record Ping(ActorRef<VolleyCommand> replyTo) {}

    public static Behavior<Ping> pong() {
        return Behaviors.receive(Ping.class)
                .onMessage(Ping.class, message -> {
                    message.replyTo().tell(new Pong());
                    return Behaviors.same();
                })
                .build();
    }

    public static Behavior<VolleyCommand> ping(ActorRef<Ping> partner) {
        return Behaviors.setup(context -> new PingActor(context, partner));
    }

    private static final class PingActor extends AbstractBehavior<VolleyCommand> {
        private final ActorRef<Ping> partner;
        private int exchanges;
        private int completed;
        private ActorRef<Integer> replyTo;

        PingActor(ActorContext<VolleyCommand> context, ActorRef<Ping> partner) {
            super(context);
            this.partner = partner;
        }

        @Override
        public Receive<VolleyCommand> createReceive() {
            return newReceiveBuilder()
                    .onMessage(StartVolley.class, this::onStartVolley)
                    .onMessage(Pong.class, this::onPong)
                    .build();
        }

        private Behavior<VolleyCommand> onStartVolley(StartVolley message) {
            exchanges = message.exchanges();
            completed = 0;
            replyTo = message.replyTo();
            partner.tell(new Ping(getContext().getSelf()));
            return this;
        }

        private Behavior<VolleyCommand> onPong(Pong message) {
            completed++;
            if (completed >= exchanges) {
                replyTo.tell(completed);
                return this;
            }
            partner.tell(new Ping(getContext().getSelf()));
            return this;
        }
    }

    /* ------------------------------- guardian ------------------------------ */

    public sealed interface GuardianCommand permits GetRefs, SpawnBatch, ChildStarted {}

    public record GetRefs(ActorRef<Refs> replyTo) implements GuardianCommand {}

    public record SpawnBatch(int count, ActorRef<Integer> replyTo) implements GuardianCommand {}

    public record ChildStarted() implements GuardianCommand {}

    public record Refs(
            ActorRef<CounterCommand> counter,
            ActorRef<Echo> echo,
            ActorRef<VolleyCommand> ping) {}

    public static Behavior<GuardianCommand> guardian() {
        return Behaviors.setup(Guardian::new);
    }

    private static final class Guardian extends AbstractBehavior<GuardianCommand> {
        private final Refs refs;
        private final List<ActorRef<Object>> batch = new ArrayList<>();
        private int expected;
        private int started;
        private int stopped;
        private int spawnGeneration;
        private ActorRef<Integer> spawnReplyTo;

        Guardian(ActorContext<GuardianCommand> context) {
            super(context);
            ActorRef<CounterCommand> counterRef = context.spawn(counter(), "counter");
            ActorRef<Echo> echoRef = context.spawn(echo(), "echo");
            ActorRef<Ping> pongRef = context.spawn(pong(), "pong");
            ActorRef<VolleyCommand> pingRef = context.spawn(ping(pongRef), "ping");
            this.refs = new Refs(counterRef, echoRef, pingRef);
        }

        @Override
        public Receive<GuardianCommand> createReceive() {
            return newReceiveBuilder()
                    .onMessage(GetRefs.class, this::onGetRefs)
                    .onMessage(SpawnBatch.class, this::onSpawnBatch)
                    .onMessage(ChildStarted.class, this::onChildStarted)
                    .onSignal(Terminated.class, this::onTerminated)
                    .build();
        }

        private Behavior<GuardianCommand> onGetRefs(GetRefs message) {
            message.replyTo().tell(refs);
            return this;
        }

        private Behavior<GuardianCommand> onSpawnBatch(SpawnBatch message) {
            expected = message.count();
            started = 0;
            stopped = 0;
            spawnReplyTo = message.replyTo();
            batch.clear();
            // Each batch gets its own generation: a stopped actor's name is not
            // immediately reusable in Akka, so reusing plain indices would fail
            // on the second iteration rather than the first.
            int generation = spawnGeneration++;
            ActorRef<GuardianCommand> self = getContext().getSelf();
            for (int i = 0; i < expected; i++) {
                ActorRef<Object> child = getContext().spawn(probe(self), "probe-" + generation + "-" + i);
                getContext().watch(child);
                batch.add(child);
            }
            return this;
        }

        private Behavior<GuardianCommand> onChildStarted(ChildStarted message) {
            started++;
            if (started == expected) {
                for (ActorRef<Object> child : batch) {
                    getContext().stop(child);
                }
            }
            return this;
        }

        private Behavior<GuardianCommand> onTerminated(Terminated signal) {
            stopped++;
            if (stopped == expected && spawnReplyTo != null) {
                spawnReplyTo.tell(Math.min(started, stopped));
                spawnReplyTo = null;
            }
            return this;
        }

        /**
         * The probe reports its own start from {@code Behaviors.setup}, which runs
         * when the actor actually starts — the Akka analogue of the {@code preStart}
         * the actor-ts arm waits for. Its stop is observed through {@code watch}.
         */
        private static Behavior<Object> probe(ActorRef<GuardianCommand> guardian) {
            return Behaviors.setup(context -> {
                guardian.tell(new ChildStarted());
                return Behaviors.receive(Object.class)
                        .onAnyMessage(message -> Behaviors.same())
                        .build();
            });
        }
    }
}
