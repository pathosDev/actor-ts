using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Comparison;

/// <summary>
/// The virtual-actor arm's entry point (#27).
/// </summary>
/// <remarks>
/// <para>Runs the same four scenarios as every other arm, at the same batch
/// sizes, iteration counts and warmup, and writes a result file in the schema
/// <c>benchmarks/comparison/report.ts</c> validates. The workload constants are
/// mirrored from <c>benchmarks/comparison/js/workload.ts</c>; the report
/// generator cross-checks every one of them, which is what makes duplicating
/// them across a language boundary safe.</para>
///
/// <para>A single-silo localhost cluster: the comparison is about the actor
/// runtime, and adding a network would measure the network. That is the same
/// reason no other arm is clustered here.</para>
///
/// <para><c>dotnet run -c Release</c></para>
/// </remarks>
internal static class Program
{
    /* Mirrors js/workload.ts.  Verified by report.ts on every run. */
    private const int SpawnIterations = 100;
    private const int SpawnBatchSize = 100;
    private const int SpawnWarmup = 50;
    private const int TellSmallIterations = 100;
    private const int TellSmallBatch = 1_000;
    private const int TellSmallWarmup = 50;
    private const int TellLargeIterations = 30;
    private const int TellLargeBatch = 10_000;
    private const int TellLargeWarmup = 15;
    private const int AskIterations = 5_000;
    private const int AskWarmup = 2_000;
    private const int PingPongIterations = 20;
    private const int PingPongExchanges = 10_000;
    private const int PingPongWarmup = 10;

    private const string ActivationNote =
        "Orleans has no caller-visible create or stop: a grain activates on first call and "
        + "deactivates on its own schedule. This row is first-call activation latency for a batch "
        + "of fresh grain identities; deactivation is requested but not awaited, because nothing "
        + "surfaces its completion to the caller.";

    private const string OneWayNote =
        "[OneWay] is the nearest equivalent of a fire-and-forget send, but it is a one-way RPC "
        + "rather than a mailbox enqueue.";

    private const string VolleyNote =
        "A driven chain of awaited grain calls rather than two mailboxes volleying — the closest "
        + "deadlock-free analogue in a virtual-actor model.";

    private static async Task<int> Main()
    {
        var builder = Host.CreateApplicationBuilder();
        // Logging off, for the same reason every other arm turns it off: an arm
        // that writes log lines is measuring its logger.
        builder.Logging.ClearProviders();
        builder.Logging.SetMinimumLevel(LogLevel.None);
        builder.UseOrleans(silo => silo.UseLocalhostClustering());

        using var host = builder.Build();
        await host.StartAsync();

        try
        {
            var grains = host.Services.GetRequiredService<IGrainFactory>();
            var counter = grains.GetGrain<ICounterGrain>("counter");
            var echo = grains.GetGrain<IEchoGrain>("echo");
            var ping = grains.GetGrain<IPingGrain>("ping");

            var activation = 0;

            var results = new List<Harness.ScenarioResult>
            {
                await Harness.MeasureAsync("spawn", "batch=100", "actor",
                    SpawnIterations, SpawnBatchSize, SpawnWarmup, ActivationNote,
                    async () => await ActivateBatchAsync(grains, SpawnBatchSize, activation++)),

                await Harness.MeasureAsync("tell-throughput", "batch=1k", "msg",
                    TellSmallIterations, TellSmallBatch, TellSmallWarmup, OneWayNote,
                    () => TellBatchAsync(counter, TellSmallBatch)),

                await Harness.MeasureAsync("tell-throughput", "batch=10k", "msg",
                    TellLargeIterations, TellLargeBatch, TellLargeWarmup, OneWayNote,
                    () => TellBatchAsync(counter, TellLargeBatch)),

                await Harness.MeasureAsync("ask-round-trip", "sequential", "ask",
                    AskIterations, 1, AskWarmup, null,
                    async () => await echo.Echo("hi") == "echo:hi" ? 1 : 0),

                await Harness.MeasureAsync("ping-pong", "exchanges=10k", "exchange",
                    PingPongIterations, PingPongExchanges, PingPongWarmup, VolleyNote,
                    async () => await ping.Volley(PingPongExchanges)),
            };

            if (Harness.SmokeMode)
            {
                Console.WriteLine($"  smoke mode - {results.Count} case(s) executed, results NOT "
                                  + "written (one unwarmed iteration measures the JIT, not the framework)");
            }
            else
            {
                ResultFile.Write(results, "orleans", OrleansVersion(), "MIT",
                    ResultFile.OutputPath("orleans-dotnet"));
            }
        }
        finally
        {
            await host.StopAsync();
        }

        return 0;
    }

    /// <summary>
    /// Activate a batch of grain identities nothing has touched before, then ask
    /// each to release itself.
    /// </summary>
    /// <remarks>
    /// The identities must be fresh per iteration: calling an already-activated
    /// grain measures a warm dispatch rather than an activation, which is the
    /// row's whole subject.
    /// </remarks>
    private static async Task<long> ActivateBatchAsync(IGrainFactory grains, int batch, int generation)
    {
        var activated = 0;
        var references = new List<INoopGrain>(batch);
        for (var i = 0; i < batch; i++)
        {
            var grain = grains.GetGrain<INoopGrain>($"probe-{generation}-{i}-{Guid.NewGuid():N}");
            activated += await grain.Touch();
            references.Add(grain);
        }
        foreach (var grain in references) await grain.Release();
        return activated;
    }

    private static async Task<long> TellBatchAsync(ICounterGrain counter, int batch)
    {
        for (var i = 0; i < batch; i++) await counter.Increment();
        return await counter.ReadAndReset();
    }

    /// <summary>
    /// Read from the assembly the runtime actually loaded, not from the project
    /// file — and from its <em>informational</em> version, because the assembly
    /// version here is major-only (10.0.0) and would misreport the package.
    /// </summary>
    private static string OrleansVersion()
    {
        var assembly = typeof(IGrainFactory).Assembly;
        var informational = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            // Take the leading version and drop whatever the build appended.
            // This package's informational version is
            // "10.2.2. Commit Hash: a5758887..." — neither the `+metadata` form
            // nor a bare version, so a `+` split leaves the commit in the
            // published table.
            var match = Regex.Match(informational, @"^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?");
            if (match.Success) return match.Value;
        }
        var version = assembly.GetName().Version;
        return version is null ? "unknown" : $"{version.Major}.{version.Minor}.{version.Build}";
    }
}
