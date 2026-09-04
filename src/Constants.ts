/**
 * Tuned values shared by the root-level modules (`ActorSystem`,
 * `Dispatcher`, …) — the ones that have no subsystem directory of their own.
 *
 * A constant lives here when it is a cap, bound, timeout or size that more
 * than one root module reads, and it is not the built-in default of an
 * options field (that belongs in the matching `XOptions.ts`).  Values shared
 * across *subsystems* go one level further out, to
 * `src/util/Constants.ts`.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * Queued units a `ThroughputDispatcher` processes synchronously before it
 * yields to the event loop.
 *
 * There is no `ActorSystemOptions` field behind this, so it is not an
 * options default — it is the number three separate entry points had to
 * agree on: `new ThroughputDispatcher()`, `Dispatchers.Throughput()`, and
 * the HOCON path in `ActorSystem` when
 * `actor-ts.dispatcher.throughput` is unset.  All three carried their own
 * `16`, so the answer to "what is the default throughput?" depended on how
 * you got there.
 *
 * Mirrors `actor-ts.dispatcher.throughput = 16` in `reference.conf`.  Sized
 * as a compromise: high enough to amortise scheduling overhead across a
 * burst of small messages, low enough that a busy actor cannot starve the
 * event loop between yields.
 */
export const DEFAULT_DISPATCHER_THROUGHPUT = 16;

/**
 * User messages one actor handles per dispatcher turn before it yields.
 *
 * **Not the same knob as {@link DEFAULT_DISPATCHER_THROUGHPUT}**, and the two
 * living one config block apart is deliberate.  A dispatcher's throughput
 * bounds how many queued *units* it drains per tick, and those units belong to
 * different actors; this one bounds how many *messages* a single actor takes
 * in the one unit it is allowed to have queued at a time.  Before #409 only
 * the first existed, which is why the tuning docs' promise that a
 * `ThroughputDispatcher` lets "the heavy actor process 100 messages, yield,
 * process 100 more" was never true of any actor: a cell re-queues itself only
 * from the `finally` of an `async` turn, a microtask after the synchronous
 * drain loop that would have picked it up has already found the queue empty.
 * A per-actor `ThroughputDispatcher` was the worst case — its queue can never
 * hold a second unit for its only actor, so its batch was provably always 1.
 *
 * 16 for the same reason the dispatcher's default is: the `setImmediate` round
 * trip it amortises is ~2.4 µs against a handler that is typically far
 * cheaper, so the first few messages buy most of the win — measured here as
 * ~246k -> ~604k msg/s at batch=1k — while the tail of a large batch buys
 * little and costs fairness, since nothing else on the event loop runs until
 * the actor yields.  Raise it for a throughput-bound pipeline, lower it toward
 * 1 to restore pre-#409 interleaving.
 *
 * Not an options default in the `XOptions.ts` sense: `ActorOptions.throughput`
 * unset means "not set" and falls through to `actor-ts.actor.throughput`, so
 * this is the value `ActorSystem` resolves when the HOCON key is absent, not
 * one the builder writes.
 */
export const DEFAULT_ACTOR_THROUGHPUT = 16;

/**
 * Units a {@link HybridDispatcher} schedules as microtasks before it spends one
 * on a macrotask to let the event loop breathe.
 *
 * The hybrid exists because the two obvious schedulers are each wrong half the
 * time.  `setImmediate` is fair and slow: it costs ~2.4 µs, which an actor
 * flooded with messages amortises over its 16-message batch and an actor
 * answering one message at a time cannot amortise at all — an alternating
 * volley pays it per message, and measured 8.1 µs per round trip of which
 * roughly 4.8 µs was the two hops.  `queueMicrotask` is fast and unfair: it
 * measured 3.99x on the same volley, and starves timers and I/O outright,
 * because a microtask queue that refills itself never lets the loop advance.
 *
 * The budget buys the second one's speed and bounds its unfairness.  A unit is
 * one actor's turn, itself up to {@link DEFAULT_ACTOR_THROUGHPUT} messages, so
 * 64 units is at most ~1024 messages between yields — the same order as a busy
 * event-loop tick, and the worst case degrades to exactly what the `immediate`
 * dispatcher always did rather than to something new.
 *
 * The count lives on the dispatcher, not on the cell, and that is the whole
 * design: the microtask chain is the union across every actor scheduled on it,
 * so a per-cell counter would read 1 for each of two actors volleying forever
 * — undercounting in precisely the case the budget exists to bound.
 *
 * Not an options default in the `XOptions.ts` sense; it is the value both
 * `new HybridDispatcher()` and `Dispatchers.Hybrid()` fall back to.
 */
export const DEFAULT_HYBRID_DISPATCHER_YIELD_UNITS = 64;

/**
 * Default per-phase timeout in the `CoordinatedShutdown` pipeline.
 * A phase that overruns it is abandoned so the next one still gets
 * to run — 5 s balances letting a slow task finish against blocking
 * shutdown indefinitely.  Overridable globally, per phase, or via
 * `actor-ts.coordinated-shutdown.default-phase-timeout`.
 *
 * Not an options default: `CoordinatedShutdown` has no `XOptions` type —
 * `defaultPhaseTimeoutMs` is a mutable field on the class, seeded from this
 * value and then overwritten from HOCON if the key is set.
 */
export const DEFAULT_PHASE_TIMEOUT_MS = 5_000;

/**
 * Status the process exits with once the `CoordinatedShutdown` pipeline
 * finishes and `actor-ts.coordinated-shutdown.exit-process` is on.
 *
 * `0` because the pipeline running to the end *is* the success case: the
 * phases were walked, the tasks were given their budget, and a task that
 * overran was logged.  A non-zero value is for a deployment that wants the
 * supervisor to tell an orderly stop apart from a planned one — a Kubernetes
 * `preStop` drain that must not be mistaken for a crash loop, say — which is
 * why the value is configurable at all rather than being the literal it was.
 *
 * Not an options default, for the same reason as
 * {@link DEFAULT_PHASE_TIMEOUT_MS}: `CoordinatedShutdown` has no `XOptions`
 * type, and the four scalar leaves are read inline in its constructor.
 */
export const DEFAULT_SHUTDOWN_EXIT_CODE = 0;

/**
 * Largest status `actor-ts.coordinated-shutdown.exit-code` may carry.
 *
 * A wait status keeps eight bits for the exit code, so `process.exit(256)`
 * is reported as `0` and `process.exit(-1)` as `255` — a configured failure
 * that the supervisor reads as a clean stop.  The read rejects anything
 * outside the range rather than passing on a number the operating system
 * will quietly rewrite.
 */
export const MAX_PROCESS_EXIT_CODE = 255;

/**
 * How long `ActorSystem.terminate()` lets the `/user` subtree finish the work
 * it already has before the stop cascade begins (#663).
 *
 * Deliberately **under** {@link DEFAULT_PHASE_TIMEOUT_MS}, and that is the
 * whole reason it is not 5 s too.  `CoordinatedShutdown`'s last phase is a
 * task that awaits `terminate()`, bounded by the phase timeout; a drain
 * budget equal to it could burn the entire phase before a single actor had
 * been told to stop, and the phase would then be abandoned with the system
 * still up.  2 s leaves the teardown itself three, and still gives a backlog
 * a real chance — the drain returns the moment the tree goes quiet, so a
 * system that is already idle pays a tick, not a budget.
 *
 * Not an options default: like `actor-ts.logger.close-timeout`, the drain
 * budget is HOCON-only (`actor-ts.system.shutdown-drain-timeout`) — it is an
 * operational knob for a deployment, not something the code that constructs
 * the system should have to restate.
 */
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;

/**
 * First gap between two quiescence probes while `terminate()` drains.
 *
 * One millisecond because the overwhelmingly common case is an idle system —
 * or one message in flight — and the probe has to yield at least one macrotask
 * for the pending turn to run at all.  The scheduler clamps a zero-delay
 * timer to roughly this anyway.
 */
export const QUIESCENCE_POLL_INTERVAL_MS = 1;

/**
 * Ceiling the quiescence probe backs off to.
 *
 * Each probe walks the `/user` subtree, so a fixed 1 ms would cost a full
 * tree walk per millisecond for the whole budget on the one system that
 * needs the budget — a deep tree that is genuinely busy.  Doubling up to
 * this bound keeps the idle case as fast as it was while making the busy
 * case cost tens of walks rather than thousands.
 */
export const QUIESCENCE_POLL_MAX_INTERVAL_MS = 25;

/**
 * How often the keep-alive timer inside `ActorSystem.runUntilTerminated()`
 * fires while it waits to be signalled.
 *
 * Nothing observes the tick — the timer exists for its *reference* on the
 * event loop, not for its callback — so the interval is arbitrary in every
 * respect but two.
 *
 * It must not be absent.  Node's signal handles are unref'd, so
 * `process.on('SIGTERM', …)` does not keep a Node process alive: a service
 * whose only remaining reason to run was that handler drains its loop and
 * exits instead of waiting for the signal (with a top-level `await`, Node
 * says so and exits 13).  Bun refs its handles and Deno's
 * `Deno.addSignalListener` has no `unref` at all, which is why those two
 * waited correctly and only Node's smoke arm ever failed (#549).
 *
 * And it must stay under 2^31-1 ms: a larger delay silently wraps to 1 ms on
 * Node, turning the keep-alive into a timer that fires a thousand times a
 * second — a worse failure than the one it fixes.  An hour is far below that
 * ceiling and still costs 24 wakeups a day.
 */
export const EVENT_LOOP_KEEPALIVE_INTERVAL_MS = 3_600_000;
