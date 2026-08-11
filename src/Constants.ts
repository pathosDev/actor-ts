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
