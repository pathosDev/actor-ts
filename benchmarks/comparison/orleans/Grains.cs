using Orleans.Concurrency;

namespace Comparison;

/// <summary>
/// The four scenarios expressed as grains — and the places where a grain is not
/// an actor in the sense the other arms mean.
/// </summary>
/// <remarks>
/// <para>Three mappings are approximations, and each row carries a note saying
/// so:</para>
/// <list type="bullet">
/// <item><description><b>spawn</b> — there is no caller-visible create or stop.
/// A grain activates when it is first called and deactivates on its own
/// schedule, so the row measures first-call activation, and the requested
/// deactivation is not awaited because nothing surfaces its completion to the
/// caller.</description></item>
/// <item><description><b>tell</b> — <c>[OneWay]</c> is the nearest thing to
/// fire-and-forget, but it is a one-way <em>RPC</em>, not a mailbox send.</description></item>
/// <item><description><b>ping-pong</b> — a driven chain of awaited grain calls
/// rather than two mailboxes volleying. It is deadlock-free and completion is
/// built in, which is why it is the shape used.</description></item>
/// </list>
/// </remarks>
public interface INoopGrain : IGrainWithStringKey
{
    /// <summary>Forces activation and confirms the grain is live.</summary>
    Task<int> Touch();

    /// <summary>Requests deactivation. Completion is not observable to the caller.</summary>
    Task Release();
}

public interface ICounterGrain : IGrainWithStringKey
{
    /// <summary>Fire-and-forget by Orleans' own definition: a one-way RPC.</summary>
    [OneWay]
    Task Increment();

    Task<int> ReadAndReset();
}

public interface IEchoGrain : IGrainWithStringKey
{
    Task<string> Echo(string value);
}

public interface IPongGrain : IGrainWithStringKey
{
    Task Pong();
}

public interface IPingGrain : IGrainWithStringKey
{
    /// <summary>Drives <paramref name="exchanges"/> awaited round trips to the pong grain.</summary>
    Task<int> Volley(int exchanges);
}

internal sealed class NoopGrain : Grain, INoopGrain
{
    public Task<int> Touch() => Task.FromResult(1);

    public Task Release()
    {
        DeactivateOnIdle();
        return Task.CompletedTask;
    }
}

internal sealed class CounterGrain : Grain, ICounterGrain
{
    private int _count;

    public Task Increment()
    {
        _count++;
        return Task.CompletedTask;
    }

    public Task<int> ReadAndReset()
    {
        var observed = _count;
        _count = 0;
        return Task.FromResult(observed);
    }
}

internal sealed class EchoGrain : Grain, IEchoGrain
{
    public Task<string> Echo(string value) => Task.FromResult($"echo:{value}");
}

internal sealed class PongGrain : Grain, IPongGrain
{
    public Task Pong() => Task.CompletedTask;
}

internal sealed class PingGrain : Grain, IPingGrain
{
    public async Task<int> Volley(int exchanges)
    {
        var pong = GrainFactory.GetGrain<IPongGrain>("pong");
        var completed = 0;
        for (var i = 0; i < exchanges; i++)
        {
            await pong.Pong();
            completed++;
        }
        return completed;
    }
}
