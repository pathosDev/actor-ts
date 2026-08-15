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
