using System.Diagnostics;

namespace Comparison;

/// <summary>
/// The measurement protocol, mirrored by hand from
/// <c>benchmarks/lib/harness.ts</c> and <c>benchmarks/lib/stats.ts</c>.
/// </summary>
/// <remarks>
/// <para>"Mirrored by hand" is the honest description, and the reason the
/// published tables keep cross-language rows in their own section: the
/// JavaScript arms all run through <em>literally the same</em> harness code,
/// while this one only reproduces its behaviour.</para>
///
/// <para>Deliberately not BenchmarkDotNet. That is the better microbenchmark
/// harness by a wide margin, but it measures differently — its own warmup
/// policy, its own iteration strategy, separate processes per case — and a
/// comparison whose two sides use different methodologies cannot be read as
/// one table. Symmetry beats sophistication here.</para>
///
/// <para>Everything below matches the TypeScript original exactly, including
/// the percentile rule (<c>sorted[floor(n * p)]</c>, clamped) and the
/// population — not sample — standard deviation. Diverging on either would
/// move numbers for reasons that have nothing to do with the frameworks.</para>
/// </remarks>
internal static class Harness
{
    /// <summary>
    /// Smoke mode collapses every case to a single unwarmed iteration and
    /// suppresses the result file, matching the JavaScript side.
    /// </summary>
    /// <remarks>
    /// The JVM arms shipped without this at first, and the consequence was not
    /// cosmetic: a smoke run executed the full workload and then overwrote a
    /// nine-round median with a single unwarmed sample. A cross-language arm
    /// has to honour the flag or the flag is a trap rather than a check.
    /// </remarks>
    internal static readonly bool SmokeMode =
        Environment.GetEnvironmentVariable("ACTOR_TS_BENCH_SMOKE") == "1";

    /// <summary>One measured row, shaped exactly like the JSON the JavaScript arms write.</summary>
    internal sealed record ScenarioResult(
        string Scenario, string Case, string Unit,
        int Iterations, int OpsPerIteration, int WarmupIterations,
        long TotalNs, double OpsPerSecond, double PerOperationNs,
        double MeanNs, double StddevNs, double MinNs, double MaxNs,
        double P50Ns, double P95Ns, double P99Ns,
        long ExpectedOperations, long CompletedOperations,
        string? Notes);

    /// <summary>
    /// Warm up, then measure, asserting after every single call that the system
    /// completed exactly the work it was asked for.
    /// </summary>
    /// <remarks>
    /// That assert is the point of the whole exercise. A published figure from
    /// this project was once roughly 10x too high because a harness counted the
    /// work it requested rather than the work that happened (#1027), and nothing
    /// about a foreign framework makes it immune.
    /// </remarks>
    internal static async Task<ScenarioResult> MeasureAsync(
        string scenario, string caseName, string unit,
        int iterations, int opsPerIteration, int warmupIterations, string? notes,
        Func<Task<long>> operation)
    {
        if (SmokeMode)
        {
            iterations = 1;
            warmupIterations = 0;
        }

        for (var i = 0; i < warmupIterations; i++)
        {
            RequireComplete(scenario, caseName, opsPerIteration, await operation());
        }

        GC.Collect();
        GC.WaitForPendingFinalizers();

        var samples = new long[iterations];
        long observedTotal = 0;
        var totalStart = Stopwatch.GetTimestamp();
        for (var i = 0; i < iterations; i++)
        {
            var started = Stopwatch.GetTimestamp();
            var completed = await operation();
            samples[i] = ToNanoseconds(Stopwatch.GetTimestamp() - started);
            observedTotal += RequireComplete(scenario, caseName, opsPerIteration, completed);
        }
        var totalNs = ToNanoseconds(Stopwatch.GetTimestamp() - totalStart);

        var totalOps = (long)iterations * opsPerIteration;
        var perOperationNs = (double)totalNs / totalOps;
        var opsPerSecond = 1e9 / perOperationNs;

        var sorted = (long[])samples.Clone();
        Array.Sort(sorted);
        double mean = 0;
        foreach (var s in sorted) mean += s;
        mean /= sorted.Length;
        double variance = 0;
        foreach (var s in sorted) variance += (s - mean) * (s - mean);
        variance /= sorted.Length;

        return new ScenarioResult(
            scenario, caseName, unit, iterations, opsPerIteration, warmupIterations,
            totalNs, opsPerSecond, perOperationNs,
            mean, Math.Sqrt(variance), sorted[0], sorted[^1],
            Percentile(sorted, 0.50), Percentile(sorted, 0.95), Percentile(sorted, 0.99),
            totalOps, observedTotal, notes);
    }

    /// <summary>
    /// `Stopwatch` counts in its own ticks, which are not the 100 ns of
    /// `DateTime` — converting through its frequency is what makes this the
    /// same unit the other arms report.
    /// </summary>
    private static long ToNanoseconds(long ticks) =>
        (long)(ticks * (1_000_000_000.0 / Stopwatch.Frequency));

    private static long RequireComplete(string scenario, string caseName, int expected, long completed)
    {
        if (completed != expected)
        {
            throw new InvalidOperationException(
                $"orleans / {scenario} / {caseName}: completed {completed} of {expected} "
                + "operations. A comparison row may not be published for work that did not "
                + "happen (#1027).");
        }
        return completed;
    }

    /// <summary><c>sorted[floor(n * p)]</c>, clamped — the rule `stats.ts` uses.</summary>
    private static double Percentile(long[] sorted, double p) =>
        sorted[Math.Min(sorted.Length - 1, (int)Math.Floor(sorted.Length * p))];
}
