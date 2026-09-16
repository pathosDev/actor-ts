package comparison

import akka.actor.typed.scaladsl.AskPattern.*
import akka.actor.typed.{ActorRef, ActorSystem, Scheduler}
import akka.util.Timeout
import java.nio.file.Path
import scala.concurrent.Await
import scala.concurrent.duration.{Duration, DurationInt}

/**
 * The Scala-binding JVM arm: the same framework at the same version as
 * `../akka-java`, driven through its Scala API in the idiomatic functional
 * style, so the pair prices the language binding and nothing else.
 *
 * The workload constants below are duplicated from `js/workload.ts` because a
 * JVM arm cannot import TypeScript. That duplication is safe only because
 * `report.ts` re-checks every one of them and fails the run if any has drifted.
 *
 *   ./mill --ticker false run
 */
object Main:

  /** Mirrors js/workload.ts. Verified by report.ts on every run. */
  private val SpawnIterations = 100
  private val SpawnBatch = 100
  private val SpawnWarmup = 50
  private val TellSmallIterations = 100
  private val TellSmallBatch = 1_000
  private val TellSmallWarmup = 50
  private val TellLargeIterations = 30
  private val TellLargeBatch = 10_000
  private val TellLargeWarmup = 15
  private val AskIterations = 5_000
  private val AskWarmup = 2_000
  private val PingPongIterations = 20
  private val PingPongExchanges = 10_000
  private val PingPongWarmup = 10
  private val ParallelLightIterations = 200
  private val ParallelLightWarmup = 100
  private val ParallelLightRounds = 5_000
  private val ParallelHeavyIterations = 50
  private val ParallelHeavyWarmup = 20
  private val ParallelHeavyRounds = 100_000

  private val ParallelNote =
    "Sixty-four actors on the default dispatcher, which spreads them over every core; " +
      "the sixty-four asks per iteration are issued from the driver thread and joined."

  /** Generous by design: this turns a deadlock into a failure, not a bound on a measurement. */
  private given Timeout = Timeout(60.seconds)

  /**
   * The note carried by every row whose number the functional style can move.
   *
   * Byte-identical to the string the Pekko-Scala arm uses, deliberately: the
   * report deduplicates footnotes by exact text, so one note serves both arms
   * rather than printing the same paragraph twice.
   */
  private val FunctionalStyleNote =
    "Idiomatic functional style: state advances by returning a new behavior per message, " +
      "which is what the native-language API leads with — so each message carries a behavior " +
      "allocation the mutable Java-API arm beside it does not."

  def main(args: Array[String]): Unit =
    val system = ActorSystem(Actors.guardian, "comparison-akka-scala")
    given Scheduler = system.scheduler

    try
      val refs = ask[Actors.Refs, Actors.GuardianCommand](system, Actors.GuardianCommand.GetRefs.apply)

      val results = Seq(
        Harness.measure(
          "spawn", "batch=100", "actor",
          SpawnIterations, SpawnBatch, SpawnWarmup,
          Some(
            "One operation is the full lifecycle: spawn, confirmed start, stop, confirmed " +
              "termination. Akka Typed only lets an actor spawn actors, so the batch is " +
              "driven through a guardian."
          ),
        ) { () =>
          ask[Int, Actors.GuardianCommand](system, Actors.GuardianCommand.SpawnBatch(SpawnBatch, _)).toLong
        },

        Harness.measure(
          "tell-throughput", "batch=1k", "msg",
          TellSmallIterations, TellSmallBatch, TellSmallWarmup, Some(FunctionalStyleNote),
        ) { () => tellBatch(refs.counter, TellSmallBatch) },

        Harness.measure(
          "tell-throughput", "batch=10k", "msg",
          TellLargeIterations, TellLargeBatch, TellLargeWarmup, Some(FunctionalStyleNote),
        ) { () => tellBatch(refs.counter, TellLargeBatch) },

        Harness.measure(
          "ask-round-trip", "sequential", "ask",
          AskIterations, 1, AskWarmup,
          Some(
            "Driven from a non-actor thread, where the JVM offers no non-blocking wait: each " +
              "round trip parks and unparks a thread on an awaited Future. The .NET arms await " +
              "instead and land ~5x higher on this row, so read it as the cost of asking from " +
              "outside the actor system on this runtime, not as the framework's messaging speed."
          ),
        ) { () =>
          val reply = ask[String, Actors.Echo](refs.echo, Actors.Echo("hi", _))
          if reply == "echo:hi" then 1L else 0L
        },

        Harness.measure(
          "ping-pong", "exchanges=10k", "exchange",
          PingPongIterations, PingPongExchanges, PingPongWarmup, Some(FunctionalStyleNote),
        ) { () =>
          ask[Int, Actors.VolleyCommand](
            refs.ping, Actors.VolleyCommand.StartVolley(PingPongExchanges, _)
          ).toLong
        },

        parallelCase(refs.parallelWorkers, "load=light",
          ParallelLightIterations, ParallelLightWarmup, ParallelLightRounds),
        parallelCase(refs.parallelWorkers, "load=heavy",
          ParallelHeavyIterations, ParallelHeavyWarmup, ParallelHeavyRounds),
      )

      if Harness.SmokeMode then
        println(
          s"  smoke mode - ${results.size} case(s) executed, results NOT written " +
            "(one unwarmed iteration measures the JIT, not the framework)"
        )
      else ResultFile.write(outputPath(), EnvironmentBlock.fromDriver(), results)
    finally system.terminate()
  end main

  /**
   * One `parallel-workload` row: every call sends one message to each of the
   * sixty-four workers, joins the replies, and counts the ones that carry the
   * result the work must produce.  The checksum over every reply — warmup
   * included — is published with the row, and report.ts recomputes it from
   * js/workload.ts (#1565).
   */
  private def parallelCase(
      workers: Vector[ActorRef[Actors.Work]],
      caseName: String,
      iterations: Int,
      warmup: Int,
      rounds: Int,
  )(using Timeout, Scheduler): Harness.ScenarioResult =
    var messageIndex = 0
    var checksum = 0L
    val measured = Harness.measure(
      "parallel-workload", caseName, "msg",
      iterations, Actors.ParallelActors, warmup, Some(ParallelNote),
    ) { () =>
      val message = messageIndex
      messageIndex += 1
      val replies = workers.zipWithIndex.map: (worker, actor) =>
        val seed = Actors.workSeed(actor, message)
        worker.ask[Int](replyTo => Actors.Work(seed, rounds, replyTo))
      var correct = 0L
      replies.zipWithIndex.foreach: (reply, actor) =>
        val value = Await.result(reply, Duration.Inf)
        if value == Actors.workRounds(Actors.workSeed(actor, message), rounds) then correct += 1
        checksum = (checksum + Integer.toUnsignedLong(value)) & 0xFFFFFFFFL
      correct
    }
    measured.copy(actorCount = Some(Actors.ParallelActors), workIterationsPerMessage = Some(rounds), checksum = Some(checksum))

  private def tellBatch(counter: ActorRef[Actors.CounterCommand], batch: Int)(using
      Scheduler
  ): Long =
    // Hoisted out of the loop, exactly as the Java arm hoists its single
    // `new Increment()`: the message side of the pair must allocate identically
    // or the binding comparison measures the send loop instead.
    val increment = Actors.CounterCommand.Increment
    var sent = 0
    while sent < batch do
      counter ! increment
      sent += 1
    ask[Int, Actors.CounterCommand](counter, Actors.CounterCommand.ReadAndReset.apply).toLong

  /**
   * Blocking on purpose, and the same shape as the Java arm's `.join()`: the
   * harness measures from a plain thread, so both sides pay for parking it.
   * The ask timeout bounds the wait; `Duration.Inf` here only says the harness
   * itself adds no second, shorter deadline.
   */
  private def ask[T, M](target: ActorRef[M], message: ActorRef[T] => M)(using
      Timeout,
      Scheduler,
  ): T =
    Await.result(target.ask(message), Duration.Inf)

  /**
   * Where the result file goes.
   *
   * With `ACTOR_TS_COMPARISON_ROUND` set it lands in `results/.rounds/` under a
   * round-suffixed name, exactly like the JavaScript arms, so the driver's mean
   * merge picks it up unchanged.
   *
   * **This name is written twice.** It is spelled out here, and it is derived
   * independently by `resultFileName()` in `js/result-file.ts` as
   * `slug(framework.name)-slug(runtime.name)` — which is what the round merge
   * uses. They have to agree: if they do not, the rounds land under one name and
   * the merged file appears under another, and nothing complains.
   * `framework.name` is `akka-scala` in [[ResultFile]] and `runtime.name` is
   * `jvm`, so this reads `akka-scala-jvm`.
   */
  private def outputPath(): Path =
    val results = Path.of(System.getProperty("user.dir")).resolve("..").resolve("results").normalize()
    val round = System.getenv("ACTOR_TS_COMPARISON_ROUND")
    if round == null || round.isBlank then results.resolve("akka-scala-jvm.json")
    else results.resolve(".rounds").resolve(s"akka-scala-jvm-r$round.json")

end Main
