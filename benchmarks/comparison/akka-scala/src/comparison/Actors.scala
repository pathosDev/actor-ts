package comparison

import akka.actor.typed.scaladsl.Behaviors
import akka.actor.typed.{ActorRef, Behavior, Terminated}
import scala.collection.immutable.Vector

/**
 * The four scenarios, in the idiomatic functional Scala style.
 *
 * **This is the arm's whole subject, so it is worth being explicit about.** The
 * sibling `../akka-java` arm uses `AbstractBehavior` subclasses with mutable
 * fields, which is the idiomatic Java shape. Here state is carried in behavior
 * parameters and advanced by returning a new behavior, which is the idiomatic
 * Scala shape and the one the framework's own style guide leads with.
 *
 * Transliterating the Java shape into Scala would have measured javadsl idioms
 * spoken with a Scala accent and answered nothing the Java arm does not already
 * answer. Measuring the idiom people actually write is the point.
 *
 * The consequence is real and is not hidden: a counter that recurses allocates
 * a behavior and a closure per message where a mutable field allocates nothing.
 * The rows where that can move a number carry a note saying so, and the
 * comparison README explains it once at length rather than five times in
 * footnotes.
 *
 * Everything else is held identical to the Java arm on purpose — same message
 * counts, same payloads, same probe-naming rule, same completion accounting.
 * A pair that differs in two things measures neither.
 */
object Actors:

  /* ------------------------------- counter ------------------------------- */

  enum CounterCommand:
    case Increment
    case ReadAndReset(replyTo: ActorRef[Int])

  /**
   * Recursion carries the count.
   *
   * `Increment` is a parameterless enum case and so a singleton — and the Java
   * arm hoists a single `new Increment()` out of its send loop for exactly the
   * same effect, so the message side of the two arms allocates identically.
   * The difference between them is on the *receiving* side and is one-way: this
   * returns a fresh behavior per message where a mutable field returns `this`.
   */
  def counter(count: Int = 0): Behavior[CounterCommand] =
    Behaviors.receiveMessage:
      case CounterCommand.Increment =>
        counter(count + 1)
      case CounterCommand.ReadAndReset(replyTo) =>
        replyTo ! count
        counter(0)

  /* -------------------------------- echo --------------------------------- */

  final case class Echo(value: String, replyTo: ActorRef[String])

  /** Stateless, so there is nothing for the recursion to carry. */
  def echo: Behavior[Echo] =
    Behaviors.receiveMessage: message =>
      message.replyTo ! s"echo:${message.value}"
      Behaviors.same

  /* ------------------------------ ping-pong ------------------------------ */

  enum VolleyCommand:
    case StartVolley(exchanges: Int, replyTo: ActorRef[Int])
    case Pong

  final case class Ping(replyTo: ActorRef[VolleyCommand])

  def pong: Behavior[Ping] =
    Behaviors.receiveMessage: message =>
      message.replyTo ! VolleyCommand.Pong
      Behaviors.same

  /** Idle between volleys; a `StartVolley` opens one. */
  def ping(partner: ActorRef[Ping]): Behavior[VolleyCommand] =
    Behaviors.receive: (context, message) =>
      message match
        case VolleyCommand.StartVolley(exchanges, replyTo) =>
          partner ! Ping(context.self)
          volleying(partner, exchanges, 0, replyTo)
        // No volley is in flight, so there is nothing to count. Unreachable
        // from the harness, which always opens a volley first.
        case VolleyCommand.Pong => Behaviors.same

  private def volleying(
      partner: ActorRef[Ping],
      exchanges: Int,
      completed: Int,
      replyTo: ActorRef[Int],
  ): Behavior[VolleyCommand] =
    Behaviors.receive: (context, message) =>
      message match
        case VolleyCommand.Pong =>
          val done = completed + 1
          if done >= exchanges then
            replyTo ! done
            ping(partner)
          else
            partner ! Ping(context.self)
            volleying(partner, exchanges, done, replyTo)
        // A fresh volley restarts the count, exactly as the mutable arm does
        // by overwriting its fields.
        case VolleyCommand.StartVolley(next, nextReplyTo) =>
          partner ! Ping(context.self)
          volleying(partner, next, 0, nextReplyTo)

  /* ------------------------------- guardian ------------------------------ */

  enum GuardianCommand:
    case GetRefs(replyTo: ActorRef[Refs])
    case SpawnBatch(count: Int, replyTo: ActorRef[Int])
    case ChildStarted

  final case class Refs(
      counter: ActorRef[CounterCommand],
      echo: ActorRef[Echo],
      ping: ActorRef[VolleyCommand],
  )

  /** A spawn batch in flight: what was asked for, and what has been observed. */
  private final case class Batch(
      expected: Int,
      started: Int,
      stopped: Int,
      children: Vector[ActorRef[Any]],
      replyTo: Option[ActorRef[Int]],
  )

  def guardian: Behavior[GuardianCommand] =
    Behaviors.setup: context =>
      val refs = Refs(
        context.spawn(counter(), "counter"),
        context.spawn(echo, "echo"),
        context.spawn(ping(context.spawn(pong, "pong")), "ping"),
      )
      running(refs, generation = 0, batch = None)

  private def running(
      refs: Refs,
      generation: Int,
      batch: Option[Batch],
  ): Behavior[GuardianCommand] =
    // Bound first, then the signal handler is chained onto it. Under indentation
    // syntax a fewer-braces argument cannot be followed by a `.method` call, so
    // the two halves have to be separate expressions.
    val onMessage = Behaviors.receive[GuardianCommand]: (context, message) =>
      message match
        case GuardianCommand.GetRefs(replyTo) =>
          replyTo ! refs
          Behaviors.same

        case GuardianCommand.SpawnBatch(count, replyTo) =>
          // Each batch gets its own generation: a stopped actor's name is not
          // immediately reusable in Akka, so reusing plain indices would fail
          // on the second iteration rather than the first.
          val children = Vector.tabulate(count): i =>
            val child = context.spawn(probe(context.self), s"probe-$generation-$i")
            context.watch(child)
            child
          running(refs, generation + 1, Some(Batch(count, 0, 0, children, Some(replyTo))))

        case GuardianCommand.ChildStarted =>
          batch match
            case None => Behaviors.same
            case Some(current) =>
              val started = current.started + 1
              if started == current.expected then current.children.foreach(context.stop)
              running(refs, generation, Some(current.copy(started = started)))

    onMessage.receiveSignal:
      case (_, Terminated(_)) =>
        batch match
          case None => Behaviors.same
          case Some(current) =>
            val stopped = current.stopped + 1
            if stopped == current.expected then
              // `min` rather than `stopped`: the harness is told what was
              // observed on both ends, so a batch that half-started cannot be
              // published as a full one.
              current.replyTo.foreach(_ ! math.min(current.started, stopped))
              running(refs, generation, Some(current.copy(stopped = stopped, replyTo = None)))
            else running(refs, generation, Some(current.copy(stopped = stopped)))

  /**
   * The probe reports its own start from `Behaviors.setup`, which runs when the
   * actor actually starts — the Akka analogue of the `preStart` the actor-ts arm
   * waits for. Its stop is observed through `watch`.
   */
  private def probe(guardian: ActorRef[GuardianCommand]): Behavior[Any] =
    Behaviors.setup: _ =>
      guardian ! GuardianCommand.ChildStarted
      Behaviors.receiveMessage(_ => Behaviors.same)

end Actors
