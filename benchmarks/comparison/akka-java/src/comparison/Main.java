package comparison;

import akka.actor.typed.ActorRef;
import akka.actor.typed.ActorSystem;
import akka.actor.typed.javadsl.AskPattern;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The JVM arm's entry point (#27).
 *
 * <p>Runs the same four scenarios as every other arm, at the same batch sizes
 * and iteration counts, and writes a result file in the schema
 * {@code benchmarks/comparison/report.ts} validates. The workload constants are
 * mirrored from {@code benchmarks/comparison/js/workload.ts} — they cannot be
 * imported across the language boundary, so the report generator cross-checks
 * every one of them and fails the run if any has drifted. That check is the
 * whole reason duplicating them here is safe.
 *
 *   ./mvnw -q compile exec:java
 */
public final class Main {

    /** Mirrors js/workload.ts. Verified by report.ts on every run. */
    private static final int SPAWN_ITERATIONS = 100;
    private static final int SPAWN_BATCH = 100;
    private static final int SPAWN_WARMUP = 50;
    private static final int TELL_SMALL_ITERATIONS = 100;
    private static final int TELL_SMALL_BATCH = 1_000;
    private static final int TELL_SMALL_WARMUP = 50;
    private static final int TELL_LARGE_ITERATIONS = 30;
    private static final int TELL_LARGE_BATCH = 10_000;
    private static final int TELL_LARGE_WARMUP = 15;
    private static final int ASK_ITERATIONS = 5_000;
    private static final int ASK_WARMUP = 2_000;
    private static final int PING_PONG_ITERATIONS = 20;
    private static final int PING_PONG_EXCHANGES = 10_000;
    private static final int PING_PONG_WARMUP = 10;

    /** Generous by design: this turns a deadlock into a failure, not a bound on a measurement. */
    private static final Duration REPLY_TIMEOUT = Duration.ofSeconds(60);

    private Main() {}

    public static void main(String[] args) throws Exception {
        ActorSystem<Actors.GuardianCommand> system =
                ActorSystem.create(Actors.guardian(), "comparison-akka-java");

        try {
            Actors.Refs refs = ask(system, system, Actors.GetRefs::new);
            List<Harness.ScenarioResult> results = new ArrayList<>();

            results.add(Harness.measure("spawn", "batch=100", "actor",
                    SPAWN_ITERATIONS, SPAWN_BATCH, SPAWN_WARMUP,
                    "One operation is the full lifecycle: spawn, confirmed start, stop, confirmed "
                    + "termination. Akka Typed only lets an actor spawn actors, so the batch is "
                    + "driven through a guardian.",
                    () -> {
                        // Bound to an Integer local on purpose: `Operation.run()`
                        // returns `long`, which would otherwise drive the ask's
                        // type variable to Long before the reply type is known.
                        Integer completed = ask(system, system,
                                replyTo -> new Actors.SpawnBatch(SPAWN_BATCH, replyTo));
                        return completed.longValue();
                    }));

            results.add(Harness.measure("tell-throughput", "batch=1k", "msg",
                    TELL_SMALL_ITERATIONS, TELL_SMALL_BATCH, TELL_SMALL_WARMUP, null,
                    () -> tellBatch(system, refs.counter(), TELL_SMALL_BATCH)));

            results.add(Harness.measure("tell-throughput", "batch=10k", "msg",
                    TELL_LARGE_ITERATIONS, TELL_LARGE_BATCH, TELL_LARGE_WARMUP, null,
                    () -> tellBatch(system, refs.counter(), TELL_LARGE_BATCH)));

            results.add(Harness.measure("ask-round-trip", "sequential", "ask",
                    ASK_ITERATIONS, 1, ASK_WARMUP,
                    "Driven from a non-actor thread, where Java has no non-blocking wait: each round trip "
                    + "parks and unparks a thread on a CompletableFuture. The .NET arms await "
                    + "instead and land ~5x higher on this row, so read it as the cost of asking "
                    + "from outside the actor system on this runtime, not as the framework's "
                    + "messaging speed — its tell throughput is the highest in the table.",
                    () -> {
                        String reply = ask(system, refs.echo(), replyTo -> new Actors.Echo("hi", replyTo));
                        return "echo:hi".equals(reply) ? 1 : 0;
                    }));

            results.add(Harness.measure("ping-pong", "exchanges=10k", "exchange",
                    PING_PONG_ITERATIONS, PING_PONG_EXCHANGES, PING_PONG_WARMUP, null,
                    () -> {
                        Integer completed = ask(system, refs.ping(),
                                replyTo -> new Actors.StartVolley(PING_PONG_EXCHANGES, replyTo));
                        return completed.longValue();
                    }));

            if (Harness.SMOKE_MODE) {
                System.out.println("  smoke mode - " + results.size()
                        + " case(s) executed, results NOT written (one unwarmed iteration "
                        + "measures the JIT, not the framework)");
            } else {
                ResultFile.write(results, EnvironmentBlock.fromDriver(), outputPath());
            }
        } finally {
            system.terminate();
        }
    }

    private static long tellBatch(ActorSystem<?> system, ActorRef<Actors.CounterCommand> counter, int batch) {
        Actors.Increment increment = new Actors.Increment();
        for (int i = 0; i < batch; i++) {
            counter.tell(increment);
        }
        return ask(system, counter, Actors.ReadAndReset::new);
    }

    private static <T, M> T ask(
            ActorSystem<?> system,
            ActorRef<M> target,
            java.util.function.Function<ActorRef<T>, M> message) {
        return AskPattern.<M, T>ask(target, message::apply, REPLY_TIMEOUT, system.scheduler())
                .toCompletableFuture()
                .join();
    }

    /**
     * Where the result file goes.
     *
     * <p>With {@code ACTOR_TS_COMPARISON_ROUND} set it lands in
     * {@code results/.rounds/} under a round-suffixed name, exactly like the
     * JavaScript arms, so the driver's median merge picks it up unchanged.
     *
     * <p><b>This name is written twice.</b>  It is spelled out here, and it is
     * derived independently by {@code resultFileName()} in
     * {@code js/result-file.ts} as {@code slug(framework.name)-slug(runtime.name)}
     * — which is what the round merge uses.  They have to agree: if they do not,
     * the rounds land under one name and the merged file appears under another,
     * and nothing complains.  {@code framework.name} is {@code akka-java} in
     * {@link ResultFile} and {@code runtime.name} is {@code jvm}, so this reads
     * {@code akka-java-jvm}.
     */
    private static Path outputPath() {
        Path results = Path.of(System.getProperty("user.dir")).resolve("..").resolve("results").normalize();
        String round = System.getenv("ACTOR_TS_COMPARISON_ROUND");
        return round == null || round.isBlank()
                ? results.resolve("akka-java-jvm.json")
                : results.resolve(".rounds").resolve("akka-java-jvm-r" + round + ".json");
    }
}
