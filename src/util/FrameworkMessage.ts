/**
 * The mark that tells the message-boundary check (#1386) a class instance is
 * the framework's own — `PoisonPill`, `Terminated`, a cluster event, a
 * receptionist `Listing` — and not an application message that would lose
 * its prototype on a worker hop.
 *
 * The framework's messages are class instances by design, and they cross the
 * boundaries they need to cross by their own mechanisms: `PoisonPill` by its
 * tag, `Terminated` as a `watch-terminated` frame, a cluster event because it
 * is published per node and never sent.  So they are exactly the instances
 * the check must not report, and a marker on the prototype is the one test
 * that survives every delivery path — an event-stream publish, a `stop()`,
 * a reply — without the check having to know which path it is on.
 *
 * A global-registry symbol, so two copies of the framework in one process
 * (a bundled worker beside `node_modules`) agree on it.  No dependencies, so
 * any module that defines a message class can import it.
 */
export const FRAMEWORK_MESSAGE: unique symbol = Symbol.for('actor-ts.framework-message') as never;

type Markable = { prototype: object };

/** Stamp every class given; called once per module, at the bottom, for the classes it exports. */
export function markFrameworkMessage(...classes: ReadonlyArray<Markable>): void {
  for (const target of classes) {
    Object.defineProperty(target.prototype, FRAMEWORK_MESSAGE, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

export function isFrameworkMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as { [FRAMEWORK_MESSAGE]?: unknown })[FRAMEWORK_MESSAGE] === true;
}
