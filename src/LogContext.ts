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
   * Run `fn` with `ctx` as the current context.  The previous context
   * (if any) is shadowed for the duration of the call and restored
   * automatically.  Sync and async `fn` both work — `AsyncLocalStorage`
   * preserves the binding across awaits.
   */
  run<T>(ctx: LogContextData, fn: () => T): T {
    return storage.run(ctx, fn);
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
