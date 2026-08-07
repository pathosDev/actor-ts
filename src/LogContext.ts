/**
 * Mapped Diagnostic Context (MDC) — a per-async-call-stack key-value
 * store that the {@link Logger} reads automatically and that
 * propagates through actor `tell` / `ask` hops, including across
 * cluster nodes.  The classic use case: stamp a `correlationId` (or
 * `userId`, `requestId`, …) at the entry point of a request and have
 * every log line emitted further down the call stack — by any actor,
 * on any node — carry the same id, so a multi-hop trail stitches
 * together in your log aggregator.
 *
 *   import { LogContext } from 'actor-ts';
 *
 *   LogContext.run({ correlationId: 'abc-123' }, () => {
 *     this.log.info('processing payment');     // includes correlationId
 *     paymentRouter.tell({ kind: 'charge' });   // ctx travels with the tell
 *   });
 *
 * **Mechanism.**  Backed by Node's `AsyncLocalStorage` (also
 * available in Bun and Deno).  Every `tell` snapshots the current
 * context and stores it on the envelope; the receiving actor's
 * `onReceive` runs under a fresh `run(envelope.context, ...)`
 * scope, so the next tell from inside that handler picks up the
 * same context.  Across cluster nodes, the snapshot rides along
 * with the wire envelope.
 *
 * **Defensive default.**  Outside any `run` call, `get()` returns
 * an empty object — the logger receives no spurious fields.  Every
 * `run` opens a NEW scope; nesting merges the parent ctx with the
 * child via `with()`.
 *
 * **Crossing a tenant boundary.**  `AsyncLocalStorage` binds a store
 * when an async resource is *created*, not when it runs.  So work
 * that outlives the turn which started it — an un-awaited promise, a
 * batch drained later, a queue consumer — keeps whatever context was
 * ambient at creation time and stamps it onto every `tell` it makes.
 * Where that work serves a *different* principal than the one that
 * started it, the stale context is a data leak, not just a confusing
 * log line.  Two primitives close that hole: {@link LogContext.runFresh}
 * drops the ambient context entirely, and {@link LogContext.runEach}
 * restores each item's own captured context.
 *
 * **Out of scope (vs #10 OpenTelemetry).**  This is the lower-level
 * primitive — string/number/boolean kv pairs, no spans, no
 * sampling, no exporter.  OTel sits on top: it can use the same
 * AsyncLocalStorage to attach span IDs that downstream actors then
 * see in their `LogContext.get()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Shape of a context.  Values are intentionally constrained to JSON-safe
 * primitives so the context can ride along with cluster-wire envelopes
 * without bespoke codecs.  Use `JSON.stringify` to serialise more
 * complex values yourself.
 */
export type LogContextData = Readonly<Record<string, string | number | boolean>>;

/**
 * One queued item paired with the context that was current when it was
 * enqueued — the input to {@link LogContext.runEach}.  Deliberately a
 * plain structural shape rather than a class: callers build it inline
 * (`{ context: LogContext.get(), item }`) and never need to name the
 * type, which matters because only `LogContextData` is re-exported
 * from the package root.
 */
export type LogContextEntry<TItem> = {
  readonly context: LogContextData;
  readonly item: TItem;
};

/** Single shared storage so every reader sees the same context. */
const storage = new AsyncLocalStorage<LogContextData>();

/** Empty context returned when no `run` is active.  Frozen for safety. */
const EMPTY: LogContextData = Object.freeze({});

/**
 * The `LogContext` namespace exposes the MDC operations.  The class-
 * style `LogContext.run(...)` shape follows the MDC pattern — a
 * scoped, thread-local-like map of diagnostic context that
 * propagates through every log line inside `fn` — and keeps the
 * public API tight without exporting the underlying
 * `AsyncLocalStorage` instance.
 */
export const LogContext = {
  /**
   * Run `fn` with `context` as the current context.  The previous context
   * (if any) is shadowed for the duration of the call and restored
   * automatically.  Sync and async `fn` both work — `AsyncLocalStorage`
   * preserves the binding across awaits.
   */
  run<T>(context: LogContextData, fn: () => T): T {
    return storage.run(context, fn);
  },

  /**
   * Run `fn` with the context explicitly emptied, shadowing whatever
   * was ambient.  The inverse of {@link LogContext.with}: where `with`
   * inherits, this deliberately does not.
   *
   * Reach for it at the seam where work stops belonging to the caller
   * that happened to start it — a background drain loop, a retry timer,
   * a queue consumer, anything kicked off with a bare un-awaited
   * promise.  Without it, `AsyncLocalStorage` hands that work the
   * context of whichever turn created it, and every `tell` it makes
   * stamps that context onto the envelope; if the work then serves
   * another tenant, the first tenant's identifiers travel with it.
   * Starting from empty is cheaper to reason about than remembering to
   * strip individual keys, and it fails safe: a field nobody set cannot
   * leak.
   */
  runFresh<T>(fn: () => T): T {
    return storage.run(EMPTY, fn);
  },

  /**
   * Process `entries` sequentially, each under the context captured
   * when that entry was enqueued.
   *
   * This is the batching counterpart to {@link LogContext.runFresh}.
   * `runFresh` is right when the deferred work belongs to nobody;
   * `runEach` is right when it belongs to *someone specific per item* —
   * a mailbox drained in one turn, a flush of buffered writes, a batch
   * of requests coalesced across tenants.  Handling such a batch under
   * one ambient context attributes every item to whichever request
   * happened to trigger the flush.
   *
   * The capture must happen at enqueue time, since that is the only
   * moment the item's own context is still current:
   *
   *   queue.push({ context: LogContext.get(), item: job });
   *   // ...later, in some other turn:
   *   await LogContext.runEach(queue.splice(0), (job) => this.handle(job));
   *
   * **Returns `Promise<void>` by design.**  Collecting results would
   * make this read like `Promise.all` and invite callers to treat it as
   * a concurrency helper, which it is not — the ordering and the
   * one-scope-per-item guarantee are the product, and the payload of
   * each call is a side effect (a log line, a downstream `tell`).
   * Anything worth returning is worth writing where the batch was
   * built.
   *
   * **Errors propagate immediately** and abandon the remaining
   * entries.  Swallowing them would be a supervision policy, and that
   * decision does not belong to a diagnostics primitive; a caller who
   * wants per-item isolation puts the `try`/`catch` inside `fn`, where
   * it still runs under the right context.
   */
  async runEach<TItem>(
    entries: Iterable<LogContextEntry<TItem>>,
    fn: (item: TItem) => unknown,
  ): Promise<void> {
    for (const entry of entries) {
      // `run` returns `fn`'s value synchronously, but an async `fn`'s
      // continuation keeps the store it was created under — so awaiting
      // outside the scope still completes the item under its context.
      await storage.run(entry.context, () => fn(entry.item));
    }
  },

  /**
   * Read the current context.  Returns the frozen empty object when
   * called outside any `run` — never `undefined`, never `null`, so
   * callers can `.entries()` over it without guarding.
   */
  get(): LogContextData {
    return storage.getStore() ?? EMPTY;
  },

  /**
   * Run `fn` with `extra` fields merged into the current context.
   * Equivalent to `run({ ...get(), ...extra }, fn)` but a touch
   * shorter at call sites that just want to add a field.
   */
  with<T>(extra: LogContextData, fn: () => T): T {
    const merged = { ...this.get(), ...extra };
    return storage.run(merged, fn);
  },

  /**
   * Capture the current context as a plain (mutable-by-the-caller)
   * object — useful when you need to pass the context through a
   * boundary that strips `Readonly` (e.g. a JSON serialiser).
   * Returns a fresh copy every call.
   */
  snapshot(): Record<string, string | number | boolean> {
    return { ...this.get() };
  },
};
