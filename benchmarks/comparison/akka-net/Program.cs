using Akka.Actor;
using Akka.Configuration;

namespace Comparison;

/// <summary>
/// The .NET arm's entry point (#27).
/// </summary>
/// <remarks>
/// <para>Runs the same four scenarios as every other arm, at the same batch
/// sizes, iteration counts and warmup, and writes a result file in the schema
/// <c>benchmarks/comparison/report.ts</c> validates. The workload constants are
/// mirrored from <c>benchmarks/comparison/js/workload.ts</c> — they cannot be
/// imported across the language boundary, so the report generator cross-checks
/// every one of them and fails the run if any has drifted. That check is the
/// whole reason duplicating them here is safe.</para>
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
    private const int ParallelLightIterations = 200;
    private const int ParallelLightWarmup = 100;
    private const int ParallelLightRounds = 5_000;
    private const int ParallelHeavyIterations = 50;
    private const int ParallelHeavyWarmup = 20;
    private const int ParallelHeavyRounds = 100_000;

    private const string ParallelNote =
        "Sixty-four actors on the default dispatcher, which spreads them over every core; "
        + "the sixty-four asks per iteration are issued from the driver and awaited together.";

    /// <summary>Generous by design: turns a deadlock into a failure, not a bound on a measurement.</summary>
    private static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Logging off, for the same reason every other arm turns it off: an arm
    /// that writes log lines is measuring its logger.
    /// </summary>
    private const string LoggingOff = """
        akka {
          loglevel = "OFF"
          stdout-loglevel = "OFF"
          log-dead-letters = 0
          log-dead-letters-during-shutdown = off
        }
        """;

    private static async Task<int> Main()
    {
        var system = ActorSystem.Create("comparison-akka-net", ConfigurationFactory.ParseString(LoggingOff));

        try
        {
            var counter = system.ActorOf(Props.Create(() => new Actors.CounterActor()), "counter");
            var echo = system.ActorOf(Props.Create(() => new Actors.EchoActor()), "echo");
            var pong = system.ActorOf(Props.Create(() => new Actors.PongActor()), "pong");
            var ping = system.ActorOf(Props.Create(() => new Actors.PingActor(pong)), "ping");
            var coordinator = system.ActorOf(Props.Create(() => new Actors.SpawnCoordinator()), "spawn");
            var parallelWorkers = new IActorRef[Actors.ParallelActors];
            for (var i = 0; i < parallelWorkers.Length; i++)
            {
                parallelWorkers[i] = system.ActorOf(Props.Create(() => new Actors.ParallelWorkerActor()), $"parallel-{i}");
            }

            var results = new List<Harness.ScenarioResult>
            {
                await Harness.MeasureAsync("spawn", "batch=100", "actor",
                    SpawnIterations, SpawnBatchSize, SpawnWarmup,
                    "One operation is the full lifecycle: spawn, confirmed start, stop, confirmed "
                    + "termination, driven through a coordinator actor so the counting matches the "
                    + "other cross-language arms.",
                    async () => await coordinator.Ask<int>(new Actors.SpawnBatch(SpawnBatchSize), ReplyTimeout)),

                await Harness.MeasureAsync("tell-throughput", "batch=1k", "msg",
                    TellSmallIterations, TellSmallBatch, TellSmallWarmup, null,
                    () => TellBatchAsync(counter, TellSmallBatch)),

                await Harness.MeasureAsync("tell-throughput", "batch=10k", "msg",
                    TellLargeIterations, TellLargeBatch, TellLargeWarmup, null,
                    () => TellBatchAsync(counter, TellLargeBatch)),

                await Harness.MeasureAsync("ask-round-trip", "sequential", "ask",
                    AskIterations, 1, AskWarmup, null,
                    async () =>
                    {
                        var reply = await echo.Ask<string>(new Actors.Echo("hi"), ReplyTimeout);
                        return reply == "echo:hi" ? 1 : 0;
                    }),

                await Harness.MeasureAsync("ping-pong", "exchanges=10k", "exchange",
                    PingPongIterations, PingPongExchanges, PingPongWarmup, null,
                    async () => await ping.Ask<int>(new Actors.StartVolley(PingPongExchanges), ReplyTimeout)),

                await ParallelCaseAsync(parallelWorkers, "load=light",
                    ParallelLightIterations, ParallelLightWarmup, ParallelLightRounds),
                await ParallelCaseAsync(parallelWorkers, "load=heavy",
                    ParallelHeavyIterations, ParallelHeavyWarmup, ParallelHeavyRounds),
            };

            if (Harness.SmokeMode)
            {
                Console.WriteLine($"  smoke mode - {results.Count} case(s) executed, results NOT "
                                  + "written (one unwarmed iteration measures the JIT, not the framework)");
            }
            else
            {
                ResultFile.Write(results, "akka.net", AkkaNetVersion(), "Apache-2.0",
                    ResultFile.OutputPath("akka-net-dotnet"));
            }
        }
        finally
        {
            await system.Terminate();
        }

        return 0;
    }

    /// <summary>
    /// One <c>parallel-workload</c> row: every call sends one message to each of
    /// the sixty-four workers, awaits the replies together, and counts the ones
    /// that carry the result the work must produce.  The checksum over every
    /// reply — warmup included — is published with the row, and report.ts
    /// recomputes it from js/workload.ts (#1565).
    /// </summary>
    private static async Task<Harness.ScenarioResult> ParallelCaseAsync(
        IActorRef[] workers, string caseName, int iterations, int warmup, int rounds)
    {
        var messageIndex = 0;
        var checksum = 0L;
        var measured = await Harness.MeasureAsync("parallel-workload", caseName, "msg",
            iterations, Actors.ParallelActors, warmup, ParallelNote,
            async () =>
            {
                var message = messageIndex++;
                var replies = new Task<int>[workers.Length];
                for (var actor = 0; actor < workers.Length; actor++)
                {
                    replies[actor] = workers[actor].Ask<int>(new Actors.Work(Actors.WorkSeed(actor, message), rounds), ReplyTimeout);
                }
                var results = await Task.WhenAll(replies);
                var correct = 0L;
                for (var actor = 0; actor < results.Length; actor++)
                {
                    if (results[actor] == Actors.WorkRounds(Actors.WorkSeed(actor, message), rounds)) correct++;
                    checksum = (checksum + unchecked((uint)results[actor])) & 0xFFFFFFFFL;
                }
                return correct;
            });
        return measured with { ActorCount = Actors.ParallelActors, WorkIterationsPerMessage = rounds, Checksum = checksum };
    }

    private static async Task<long> TellBatchAsync(IActorRef counter, int batch)
    {
        var increment = new Actors.Increment();
        for (var i = 0; i < batch; i++) counter.Tell(increment);
        return await counter.Ask<int>(new Actors.ReadAndReset(), ReplyTimeout);
    }

    /// <summary>Read from the assembly the runtime actually loaded, not from the project file.</summary>
    private static string AkkaNetVersion()
    {
        var version = typeof(ActorSystem).Assembly.GetName().Version;
        return version is null ? "unknown" : $"{version.Major}.{version.Minor}.{version.Build}";
    }
}
