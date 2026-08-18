using System.Text.Json;

namespace Comparison;

/// <summary>
/// Emits the result file in the schema defined by
/// <c>benchmarks/comparison/js/result-file.ts</c>, and the environment block
/// the driver injects.
/// </summary>
/// <remarks>
/// <para>The schema is a specification rather than a consequence of the
/// TypeScript implementation, which is exactly why this arm can satisfy it by
/// hand. <c>report.ts</c> refuses a file whose <c>schemaVersion</c> it does not
/// recognise, whose completed work disagrees with what was requested, or whose
/// workload constants disagree with <c>js/workload.ts</c> — so a mistake here
/// fails the publication step rather than reaching a table.</para>
///
/// <para><c>Utf8JsonWriter</c> is from the base class library, so the only
/// third-party code in this arm remains the framework under test.</para>
/// </remarks>
internal static class ResultFile
{
    private const int SchemaVersion = 1;

    /// <summary>
    /// Hardware and tree identity, supplied by the driver rather than
    /// discovered here: every arm of a run executes on the same machine in the
    /// same session, so two arms describing it differently would be a reporting
    /// bug with no upside.
    /// </summary>
    private static string Env(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    internal static void Write(
        IReadOnlyList<Harness.ScenarioResult> results,
        string frameworkName,
        string frameworkVersion,
        string license,
        string path)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        using var stream = File.Create(path);
        using var json = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true });

        json.WriteStartObject();
        json.WriteNumber("schemaVersion", SchemaVersion);

        json.WriteStartObject("framework");
        json.WriteString("name", frameworkName);
        json.WriteString("version", frameworkVersion);
        json.WriteString("language", "C#");
        json.WriteString("license", license);
        json.WriteEndObject();

        json.WriteStartObject("runtime");
        json.WriteString("name", "dotnet");
        json.WriteString("version", Environment.Version.ToString());
        json.WriteEndObject();

        json.WriteStartObject("environment");
        json.WriteString("cpuModel", Env("ACTOR_TS_COMPARISON_CPU", "unknown"));
        json.WriteNumber("logicalCores",
            int.Parse(Env("ACTOR_TS_COMPARISON_CORES", Environment.ProcessorCount.ToString())));
        json.WriteNumber("memoryBytes", long.Parse(Env("ACTOR_TS_COMPARISON_MEMORY_BYTES", "0")));
        json.WriteString("os", Env("ACTOR_TS_COMPARISON_OS", Environment.OSVersion.ToString()));
        json.WriteString("date", Env("ACTOR_TS_COMPARISON_DATE",
            DateTime.UtcNow.ToString("yyyy-MM-dd")));
        json.WriteString("actorTsVersion", Env("ACTOR_TS_COMPARISON_VERSION", "unknown"));
        json.WriteString("actorTsCommit", Env("ACTOR_TS_COMPARISON_COMMIT", "unknown"));
        json.WriteEndObject();

        json.WriteStartArray("scenarios");
        foreach (var result in results)
        {
            json.WriteStartObject();
            json.WriteString("scenario", result.Scenario);
            json.WriteString("case", result.Case);
            json.WriteString("unit", result.Unit);
            json.WriteNumber("iterations", result.Iterations);
            json.WriteNumber("opsPerIteration", result.OpsPerIteration);
            json.WriteNumber("warmupIterations", result.WarmupIterations);
            json.WriteNumber("totalNs", result.TotalNs);
            json.WriteNumber("opsPerSecond", result.OpsPerSecond);
            json.WriteNumber("perOperationNs", result.PerOperationNs);
            json.WriteNumber("meanNs", result.MeanNs);
            json.WriteNumber("stddevNs", result.StddevNs);
            json.WriteNumber("minNs", result.MinNs);
            json.WriteNumber("maxNs", result.MaxNs);
            json.WriteNumber("p50Ns", result.P50Ns);
            json.WriteNumber("p95Ns", result.P95Ns);
            json.WriteNumber("p99Ns", result.P99Ns);
            json.WriteNumber("expectedOperations", result.ExpectedOperations);
            json.WriteNumber("completedOperations", result.CompletedOperations);
            // ΔRSS is deliberately absent: a CLR heap against a JavaScript heap
            // measures the collector's appetite, not the framework's footprint.
            if (result.Notes is not null) json.WriteString("notes", result.Notes);
            json.WriteEndObject();
        }
        json.WriteEndArray();

        json.WriteStartArray("skippedScenarios");
        json.WriteEndArray();

        json.WriteEndObject();
        json.Flush();

        Console.WriteLine($"  wrote {path}");
    }

    /// <summary>
    /// Where the result file goes.  With <c>ACTOR_TS_COMPARISON_ROUND</c> set it
    /// lands in <c>results/.rounds/</c> under a round-suffixed name, exactly
    /// like every other arm, so the driver's median merge picks it up unchanged.
    /// </summary>
    internal static string OutputPath(string fileStem)
    {
        var results = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "results"));
        var round = Environment.GetEnvironmentVariable("ACTOR_TS_COMPARISON_ROUND");
        return string.IsNullOrWhiteSpace(round)
            ? Path.Combine(results, $"{fileStem}.json")
            : Path.Combine(results, ".rounds", $"{fileStem}-r{round}.json");
    }
}
