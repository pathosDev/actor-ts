using Akka.Actor;

namespace Comparison;

/// <summary>
/// The four scenarios expressed in the classic actor API.
/// </summary>
/// <remarks>
/// <para>Classic rather than the newer typed API on purpose: it is what this
/// framework's own documentation leads with, so it is what a user would
/// reach for.</para>
///
/// <para>One structural note. Unlike the typed JVM APIs, actors can be created
/// from outside an actor here — but the spawn scenario still routes the batch
/// through a coordinator, so that confirmed starts and confirmed stops are
/// counted the same way in every cross-language arm rather than three ways.</para>
/// </remarks>
internal static class Actors
{
    /* ------------------------------- messages ------------------------------ */

    internal sealed record Increment;

    internal sealed record ReadAndReset;

    internal sealed record Echo(string Value);

    internal sealed record StartVolley(int Exchanges);

    internal sealed record Ping;

    internal sealed record Pong;

    internal sealed record SpawnBatch(int Count);

    internal sealed record ChildStarted;

    /* -------------------------------- counter ------------------------------ */

    internal sealed class CounterActor : ReceiveActor
    {
        private int _count;

        public CounterActor()
        {
            Receive<Increment>(_ => _count++);
            Receive<ReadAndReset>(_ =>
            {
                Sender.Tell(_count);
                _count = 0;
            });
        }
    }

    /* --------------------------------- echo -------------------------------- */

    internal sealed class EchoActor : ReceiveActor
    {
        public EchoActor() => Receive<Echo>(message => Sender.Tell($"echo:{message.Value}"));
    }

    /* ------------------------------- ping-pong ----------------------------- */

    internal sealed class PongActor : ReceiveActor
    {
        public PongActor() => Receive<Ping>(_ => Sender.Tell(new Pong()));
    }

    internal sealed class PingActor : ReceiveActor
    {
        private readonly IActorRef _partner;
        private int _exchanges;
        private int _completed;
        private IActorRef? _replyTo;

        public PingActor(IActorRef partner)
        {
            _partner = partner;

            Receive<StartVolley>(message =>
            {
                _exchanges = message.Exchanges;
                _completed = 0;
                _replyTo = Sender;
                _partner.Tell(new Ping(), Self);
            });

            Receive<Pong>(_ =>
            {
                _completed++;
                if (_completed >= _exchanges)
                {
                    _replyTo?.Tell(_completed);
                    return;
                }
                _partner.Tell(new Ping(), Self);
            });
        }
    }

    /* ------------------------------ spawn batch ---------------------------- */

    /// <summary>
    /// The probe reports its own start from <c>PreStart</c> — which runs when
    /// the actor actually starts, the analogue of the lifecycle signal every
    /// other arm waits for. Its stop is observed through <c>Context.Watch</c>.
    /// </summary>
    internal sealed class ProbeActor : ReceiveActor
    {
        private readonly IActorRef _coordinator;

        public ProbeActor(IActorRef coordinator)
        {
            _coordinator = coordinator;
            ReceiveAny(_ => { });
        }

        protected override void PreStart() => _coordinator.Tell(new ChildStarted());
    }

    internal sealed class SpawnCoordinator : ReceiveActor
    {
        private readonly List<IActorRef> _batch = [];
        private int _expected;
        private int _started;
        private int _stopped;
        private int _generation;
        private IActorRef? _replyTo;

        public SpawnCoordinator()
        {
            Receive<SpawnBatch>(message =>
            {
                _expected = message.Count;
                _started = 0;
                _stopped = 0;
                _replyTo = Sender;
                _batch.Clear();

                // Each batch gets its own generation: a stopped actor's name is
                // not immediately reusable, so plain indices would fail on the
                // second iteration rather than the first.
                var generation = _generation++;
                for (var i = 0; i < _expected; i++)
                {
                    var child = Context.ActorOf(
                        Props.Create(() => new ProbeActor(Self)), $"probe-{generation}-{i}");
                    Context.Watch(child);
                    _batch.Add(child);
                }
            });

            Receive<ChildStarted>(_ =>
            {
                _started++;
                if (_started != _expected) return;
                foreach (var child in _batch) Context.Stop(child);
            });

            Receive<Terminated>(_ =>
            {
                _stopped++;
                if (_stopped != _expected || _replyTo is null) return;
                _replyTo.Tell(Math.Min(_started, _stopped));
                _replyTo = null;
            });
        }
    }
}
