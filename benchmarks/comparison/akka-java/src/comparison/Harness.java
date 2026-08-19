package comparison;

import java.util.Arrays;

/**
 * The measurement protocol, mirrored by hand from
 * {@code benchmarks/lib/harness.ts} and {@code benchmarks/lib/stats.ts}.
 *
 * <p>"Mirrored by hand" is the honest description and the reason the published
 * tables keep cross-language rows in their own section: the JavaScript arms all
 * run through <em>literally the same</em> harness code, while this one only
 * reproduces its behaviour. Deliberately not JMH — JMH is a better microbenchmark
 * harness than this will ever be, but it measures differently (forked JVMs,
 * blackholes, its own warmup policy), and a comparison whose two sides use
 * different methodologies cannot be read as one table. Symmetry beats
 * sophistication here.
 *
 * <p>Everything below matches the TypeScript original exactly, including the
 * percentile rule ({@code sorted[floor(n * p)]}, clamped) and the population —
 * not sample — standard deviation. Diverging on either would move numbers for
 * reasons that have nothing to do with the frameworks.
 */
public final class Harness {

    private Harness() {}

    /**
     * Smoke mode collapses every case to a single unwarmed iteration, matching
     * `ACTOR_TS_BENCH_SMOKE` on the JavaScript side.
     *
     * <p>Without this the flag reached this arm and did nothing: the process ran
     * the full workload and then overwrote a real measurement with it. That is
     * the failure the JavaScript side guards against by refusing to write at
     * all in smoke mode, and a cross-language arm has to honour the same rule
     * or the flag is a trap rather than a check.
     */
    public static final boolean SMOKE_MODE = "1".equals(System.getenv("ACTOR_TS_BENCH_SMOKE"));

    /** One iteration of work; returns the operations the system was OBSERVED to complete. */
    @FunctionalInterface
    public interface Operation {
        long run() throws Exception;
    }

    /** One measured row, shaped exactly like the JSON the JavaScript arms write. */
    public record ScenarioResult(
            String scenario, String caseName, String unit,
            int iterations, int opsPerIteration, int warmupIterations,
            long totalNs, double opsPerSecond, double perOperationNs,
            double meanNs, double stddevNs, double minNs, double maxNs,
            double p50Ns, double p95Ns, double p99Ns,
            long expectedOperations, long completedOperations,
            String notes) {}

    /**
     * Warm up, then measure, asserting after every single call that the system
     * completed exactly the work it was asked for.
     *
     * <p>That assert is the point of the whole exercise. A published figure from
     * this project was once roughly 10x too high because a harness counted the
     * work it requested rather than the work that happened (#1027), and nothing
     * about a foreign framework makes it immune — every runtime here has queues
     * that can drop and futures that can time out.
     */
    public static ScenarioResult measure(
            String scenario, String caseName, String unit,
            int iterations, int opsPerIteration, int warmupIterations, String notes,
            Operation operation) throws Exception {

        if (SMOKE_MODE) {
            iterations = 1;
            warmupIterations = 0;
        }

        // Warmup comes from the workload rather than a formula. A JIT-compiled
        // runtime measured after a handful of iterations is measured
        // mid-compilation: raising this arm's warmup from 100 to 3 000 moved its
        // ask rate by 33 % and its tell rate by 11 %.
        for (int i = 0; i < warmupIterations; i++) {
            requireComplete(scenario, caseName, opsPerIteration, operation.run());
        }

        System.gc();

        long[] samples = new long[iterations];
        long observedTotal = 0;
        long totalStart = System.nanoTime();
        for (int i = 0; i < iterations; i++) {
            long started = System.nanoTime();
            long completed = operation.run();
            samples[i] = System.nanoTime() - started;
            observedTotal += requireComplete(scenario, caseName, opsPerIteration, completed);
        }
        long totalNs = System.nanoTime() - totalStart;

        long totalOps = (long) iterations * opsPerIteration;
        double perOperationNs = (double) totalNs / totalOps;
        double opsPerSecond = 1e9 / perOperationNs;

        long[] sorted = samples.clone();
        Arrays.sort(sorted);
        double mean = 0;
        for (long s : sorted) mean += s;
        mean /= sorted.length;
        double variance = 0;
        for (long s : sorted) variance += (s - mean) * (s - mean);
        variance /= sorted.length;

        return new ScenarioResult(
                scenario, caseName, unit, iterations, opsPerIteration,
                warmupIterations, totalNs, opsPerSecond, perOperationNs,
                mean, Math.sqrt(variance), sorted[0], sorted[sorted.length - 1],
                percentile(sorted, 0.50), percentile(sorted, 0.95), percentile(sorted, 0.99),
                totalOps, observedTotal, notes);
    }

    private static long requireComplete(String scenario, String caseName, int expected, long completed) {
        if (completed != expected) {
            throw new IllegalStateException(
                    "akka / " + scenario + " / " + caseName + ": completed " + completed
                    + " of " + expected + " operations. A comparison row may not be published "
                    + "for work that did not happen (#1027).");
        }
        return completed;
    }

    /** {@code sorted[floor(n * p)]}, clamped — the rule `stats.ts` uses. */
    private static double percentile(long[] sorted, double p) {
        int index = Math.min(sorted.length - 1, (int) Math.floor(sorted.length * p));
        return sorted[index];
    }
}
